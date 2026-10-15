import type { SiteScript, Proposal } from '../shared/types';
import { validateScript, matchesUrl } from '../shared/validation';
import { installRuntime, scriptSource } from '../content/runtime';

export async function userScriptsAvailable() {
  try {
    await chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}
export async function requireUserScripts() {
  if (!(await userScriptsAvailable()))
    throw new Error(
      'Enable “Allow User Scripts” in chrome://extensions → Open Extension → Details, then retry.',
    );
}
export class ScriptStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private report: (message: string) => void = () => {}) {}
  async list(): Promise<SiteScript[]> {
    return ((await chrome.storage.local.get('scripts')).scripts as SiteScript[]) || [];
  }
  private registration(script: SiteScript): chrome.userScripts.RegisteredUserScript {
    return {
      id: `site-${script.id}`,
      matches: script.matches,
      world: script.world,
      js: [
        {
          code: scriptSource(`site-${script.id}`, String(script.revision), script.code),
        },
      ],
      runAt: 'document_idle',
      allFrames: false,
    };
  }
  async restore() {
    return this.change(() => this.restoreNow());
  }
  private async restoreNow() {
    if (!(await userScriptsAvailable())) return;
    const scripts = (await this.list()).filter((script) => script.enabled);
    const current = await chrome.userScripts.getScripts();
    const wanted = new Set(scripts.map((script) => `site-${script.id}`));
    const stale = current
      .filter((script) => script.id.startsWith('site-') && !wanted.has(script.id))
      .map((script) => script.id);
    if (stale.length) await chrome.userScripts.unregister({ ids: stale });
    for (const script of scripts) {
      const registration = this.registration(script);
      if (current.some((item) => item.id === registration.id))
        await chrome.userScripts.update([registration]);
      else await chrome.userScripts.register([registration]);
    }
  }
  change(work: () => Promise<unknown>): Promise<any> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  async save(input: SiteScript, proposal?: Proposal): Promise<SiteScript> {
    return this.change(async () => {
      await requireUserScripts();
      const list = await this.list(),
        existing = list.find((item) => item.id === input.id);
      const script = validateScript({
        ...input,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
        revision: (existing?.revision || 0) + 1,
      });
      const id = `site-${script.id}`,
        registration = this.registration(script);
      // Chrome parses the code before storage is committed. Invalid code leaves the old revision intact.
      const registered = (await chrome.userScripts.getScripts({ ids: [id] })).length > 0;
      if (script.enabled) {
        if (registered) await chrome.userScripts.update([registration]);
        else await chrome.userScripts.register([registration]);
      } else if (registered) await chrome.userScripts.unregister({ ids: [id] });
      try {
        await chrome.storage.local.set({
          scripts: [...list.filter((item) => item.id !== script.id), script],
        });
      } catch (error) {
        await this.restoreNow();
        throw error;
      }
      const tabs = await chrome.tabs.query({});
      const results = await Promise.allSettled(
        tabs
          .filter(
            (tab) =>
              tab.id &&
              [script, ...(existing ? [existing] : [])].some((item) =>
                item.matches.some((pattern) => matchesUrl(pattern, tab.url || '')),
              ),
          )
          .map(async (tab) => {
            if (proposal && tab.id === proposal.tabId)
              for (const experiment of proposal.experimentIds)
                await this.cleanup(tab.id!, experiment, 'MAIN');
            if (existing) await this.cleanup(tab.id!, `site-${existing.id}`, existing.world);
            if (
              script.enabled &&
              script.matches.some((pattern) => matchesUrl(pattern, tab.url || ''))
            )
              await this.inject(tab.id!, script, true);
          }),
      );
      this.reportFailures(results, script.name);
      return script;
    });
  }
  async remove(id: string) {
    return this.change(async () => {
      const scripts = await this.list(),
        script = scripts.find((item) => item.id === id);
      if (!script) return;
      await requireUserScripts();
      await chrome.userScripts.unregister({ ids: [`site-${id}`] });
      await chrome.storage.local.set({
        scripts: scripts.filter((item) => item.id !== id),
      });
      const results = await Promise.allSettled(
        (await chrome.tabs.query({}))
          .filter(
            (tab) => tab.id && script.matches.some((pattern) => matchesUrl(pattern, tab.url || '')),
          )
          .map((tab) => this.cleanup(tab.id!, `site-${id}`, script.world)),
      );
      this.reportFailures(results, script.name);
    });
  }
  async cleanup(tabId: number, id: string, world: 'MAIN' | 'USER_SCRIPT') {
    if (!(await userScriptsAvailable())) return;
    const results = await chrome.userScripts.execute({
      target: { tabId, frameIds: [0] },
      world,
      js: [
        {
          code: `globalThis.__openExtension_v1?.dispose(${JSON.stringify(id)})`,
        },
      ],
    });
    if (results[0]?.error) throw new Error(results[0].error);
  }
  async inject(tabId: number, script: SiteScript, force = false) {
    const result = await chrome.userScripts.execute({
      target: { tabId, frameIds: [0] },
      world: script.world,
      js: [
        {
          code: scriptSource(`site-${script.id}`, String(script.revision), script.code, force),
        },
      ],
    });
    if (result[0]?.error) throw new Error(result[0].error);
    return result[0]?.result;
  }
  async reconcileTab(tabId: number, url: string, force = false) {
    return this.change(() => this.reconcileNow(tabId, url, force));
  }
  private async reconcileNow(tabId: number, url: string, force = false) {
    if (!(await userScriptsAvailable()) || !/^https?:/.test(url)) return;
    const scripts = await this.list();
    for (const script of scripts) {
      if (script.enabled && script.matches.some((pattern) => matchesUrl(pattern, url)))
        await this.inject(tabId, script, force).catch((error) =>
          this.report(`“${script.name}” could not run on this page: ${String(error)}`),
        );
      else
        await this.cleanup(tabId, `site-${script.id}`, script.world).catch((error) =>
          this.report(`“${script.name}” could not be cleaned up on this page: ${String(error)}`),
        );
    }
  }
  async resetExperiments(tabId: number) {
    await requireUserScripts();
    const results = await chrome.userScripts.execute({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      js: [{ code: `(${installRuntime.toString()})().resetExperiments()` }],
    });
    if (results[0]?.error) throw new Error(results[0].error);
  }
  private reportFailures(results: PromiseSettledResult<unknown>[], name: string) {
    const failures = results.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    if (failures.length)
      this.report(
        `“${name}” was saved, but ${failures.length} open page(s) could not apply or clean up the script: ${String(failures[0].reason)}. Reload the affected page after checking the script.`,
      );
  }
}
