import type { Proposal, TabInfo, ToolCall } from '../shared/types';
import { scriptSource } from '../content/runtime';
import { requireUserScripts, ScriptStore } from './scripts';
import { matchesUrl, validatePattern } from '../shared/validation';
import { domainPattern } from '../shared/browser-context';
import { scriptMatchesSite } from '../shared/script-library';

export async function activeTab(): Promise<TabInfo> {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab?.id) throw new Error('No active browser tab.');
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || '',
    title: tab.title || 'Untitled tab',
    supported:
      /^https?:\/\//.test(tab.url || '') &&
      !/^https:\/\/(chromewebstore.google.com|chrome.google.com\/webstore)/.test(tab.url || ''),
  };
}

export class BrowserTools {
  lease?: {
    token: string;
    sessionID: string;
    tabId: number;
    url: string;
    expires: number;
    experimentIds: string[];
    scriptId?: string;
  };
  private verified = new Map<number, { url: string; at: number; experiments: string[] }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private store: ScriptStore,
    private propose: (proposal: Proposal) => Promise<void>,
  ) {}
  revoke() {
    this.lease = undefined;
    this.verified.clear();
  }
  navigated(tabId: number) {
    if (this.lease?.tabId === tabId) this.revoke();
    this.verified.delete(tabId);
  }
  async resetExperiments(tabId: number) {
    await this.store.resetExperiments(tabId);
    if (this.lease?.tabId === tabId) this.lease.experimentIds = [];
    this.verified.delete(tabId);
  }
  async authorize(sessionID: string, scriptId?: string) {
    const tab = await activeTab();
    if (!tab.supported)
      throw new Error(
        'Open a regular HTTP(S) website to use browser tools. Chrome internal pages and the Chrome Web Store are protected.',
      );
    this.verified.delete(tab.id);
    this.lease = {
      token: crypto.randomUUID(),
      sessionID,
      tabId: tab.id,
      url: tab.url,
      expires: Date.now() + 30 * 60_000,
      experimentIds: [],
      scriptId,
    };
    return { tab, token: this.lease.token };
  }
  async guard(context: string) {
    const lease = this.lease;
    if (!lease || lease.token !== context || Date.now() > lease.expires)
      throw new Error(
        'Browser control is not authorized for this turn. Send a new message from Open Extension.',
      );
    const tab = await activeTab();
    if (this.lease !== lease || tab.id !== lease.tabId || tab.url !== lease.url || !tab.supported)
      throw new Error(
        'The active tab or its URL changed. Send a new message to authorize the current page.',
      );
    return tab;
  }
  async observe(tab: TabInfo, options: Record<string, unknown> = {}) {
    const [current] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (current?.id !== tab.id || current.url !== tab.url)
      throw new Error('The active page changed before observation.');
    let response;
    try {
      response = await chrome.tabs.sendMessage(
        tab.id,
        { type: 'observe', options },
        { frameId: 0 },
      );
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        files: ['content.js'],
      });
      response = await chrome.tabs.sendMessage(
        tab.id,
        { type: 'observe', options },
        { frameId: 0 },
      );
    }
    if (!response?.ok) throw new Error(response?.error || 'The page could not be observed.');
    if (response.data.url !== tab.url) throw new Error('The page navigated while being observed.');
    return response.data;
  }
  call(call: ToolCall): Promise<unknown> {
    const work = this.queue.then(() => this.perform(call));
    this.queue = work.catch(() => {});
    return work;
  }
  private async perform(call: ToolCall) {
    const args = call.args;
    const tab = await this.guard(args.context);
    if (call.name === 'browser_observe') {
      const observation = await this.observe(tab, args);
      await this.guard(args.context);
      this.verified.set(tab.id, {
        url: tab.url,
        at: Date.now(),
        experiments: [...this.lease!.experimentIds],
      });
      return observation;
    }
    if (call.name === 'site_scripts_list') {
      const saved = (await this.store.list()).filter((script) =>
        scriptMatchesSite(script, tab.url),
      );
      return args.includeCode ? saved : saved.map(({ code, ...script }) => script);
    }
    if (call.name === 'site_script_propose') {
      args.matches ??= [domainPattern(tab.url)];
      args.scriptId ??= this.lease!.scriptId;
      const verification = this.verified.get(tab.id);
      if (
        !verification ||
        verification.url !== tab.url ||
        Date.now() - verification.at > 5 * 60_000 ||
        !verification.experiments.length
      )
        throw new Error(
          'Apply and observe an experimental change on this page before proposing a site script.',
        );
      if (
        !args.name ||
        !args.description ||
        !args.code ||
        typeof args.code !== 'string' ||
        args.code.length > 100_000
      )
        throw new Error('Provide a name, description and self-contained code.');
      if (!Array.isArray(args.matches) || !args.matches.length)
        throw new Error('Provide domain matchers.');
      args.matches.forEach(validatePattern);
      if (args.matches.some((pattern: string) => pattern !== domainPattern(tab.url)))
        throw new Error(
          `Save this change for the whole current website using ${domainPattern(tab.url)}. Other domains are not authorized by this browser turn.`,
        );
      if (!args.matches.some((pattern: string) => matchesUrl(pattern, tab.url)))
        throw new Error('The script must match the verified page.');
      if (
        args.scriptId &&
        !(await this.store.list()).some(
          (script) => script.id === args.scriptId && scriptMatchesSite(script, tab.url),
        )
      )
        throw new Error('The script to update must belong to the current website.');
      const proposal: Proposal = {
        id: crypto.randomUUID(),
        sessionID: this.lease!.sessionID,
        tabId: tab.id,
        url: tab.url,
        name: String(args.name).slice(0, 100),
        description: String(args.description).slice(0, 500),
        code: args.code,
        matches: args.matches,
        world: args.world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT',
        scriptId: args.scriptId,
        experimentIds: verification.experiments,
        verifiedAt: verification.at,
      };
      await this.propose(proposal);
      return {
        proposed: true,
        proposalId: proposal.id,
        status:
          'Waiting for the user to review and approve “Update site script?” in the side panel. Nothing is saved yet.',
      };
    }
    if (call.name === 'browser_reset') {
      await this.resetExperiments(tab.id);
      return { reset: true, observation: await this.observe(tab) };
    }
    let code: string;
    const selector = JSON.stringify(args.selector || '');
    switch (call.name) {
      case 'browser_execute':
        if (typeof args.code !== 'string' || args.code.length > 100_000)
          throw new Error('Provide JavaScript code under 100,000 characters.');
        code = args.code;
        break;
      case 'browser_css':
        code = `api.css(${JSON.stringify(String(args.css))}); return {cssApplied:true};`;
        break;
      case 'browser_elements':
        if (!['hide', 'remove', 'text', 'attribute', 'scroll', 'click'].includes(args.action))
          throw new Error('Invalid element action.');
        code =
          `const nodes = api.queryAll(${selector}); if (!nodes.length) throw new Error('No elements match.');\n` +
          (
            {
              hide: `api.hide(${selector});`,
              remove: `api.remove(${selector});`,
              text: `api.text(${selector},${JSON.stringify(String(args.value ?? ''))});`,
              attribute: `api.attr(${selector},${JSON.stringify(args.attribute)},${JSON.stringify(args.value ?? null)});`,
              scroll: `nodes[0].scrollIntoView({block:'center',behavior:'instant'});`,
              click: `nodes[0].click();`,
            } as Record<string, string>
          )[args.action] +
          `return {matched:nodes.length,action:${JSON.stringify(args.action)}};`;
        break;
      default:
        throw new Error(`Unknown browser tool: ${call.name}`);
    }
    await requireUserScripts();
    await this.guard(args.context);
    const id = `experiment-${crypto.randomUUID()}`;
    // Pin injection to the observed document; a navigation race cannot execute on a new document.
    const frame = await chrome.webNavigation.getFrame({
      tabId: tab.id,
      frameId: 0,
    });
    if (!frame?.documentId || frame.url !== tab.url)
      throw new Error('The page navigated before execution.');
    const results = await chrome.userScripts.execute({
      target: { tabId: tab.id, documentIds: [frame.documentId] },
      world: 'MAIN',
      js: [{ code: scriptSource(id, '1', code) }],
    });
    const first = results.find((result) => result.frameId === 0);
    if (!first || first.error)
      throw new Error(first?.error || 'Page execution returned no result.');
    this.verified.delete(tab.id);
    await this.guard(args.context);
    this.lease!.experimentIds.push(id);
    const observation = await this.observe(tab, {
      selector: args.verifySelector || undefined,
      html: Boolean(args.html),
      limit: 12_000,
    });
    await this.guard(args.context);
    this.verified.set(tab.id, {
      url: tab.url,
      at: Date.now(),
      experiments: [...this.lease!.experimentIds],
    });
    return {
      result: first.result,
      experimentId: id,
      observation,
      verification:
        'Fresh DOM observation attached. Compare it against the requested outcome; execution success alone does not prove the outcome.',
    };
  }
}
