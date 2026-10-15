import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTools } from '../../src/background/browser';
import type { Proposal } from '../../src/shared/types';
import type { ScriptStore } from '../../src/background/scripts';

afterEach(() => vi.unstubAllGlobals());
describe('active-tab capability', () => {
  it('rechecks revocation after an asynchronous browser query, even on the same URL', async () => {
    let release: (tabs: unknown[]) => void = () => {};
    vi.stubGlobal('chrome', {
      tabs: {
        query: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    });
    const tools = new BrowserTools({} as ScriptStore, async () => {});
    tools.lease = {
      token: 'current',
      sessionID: 'ses_test',
      tabId: 1,
      url: 'https://example.com/',
      expires: Date.now() + 10000,
      experimentIds: [],
    };
    const pending = tools.guard('current');
    tools.revoke();
    release([{ id: 1, windowId: 1, url: 'https://example.com/', title: 'Example' }]);
    await expect(pending).rejects.toThrow('changed');
  });
  it('refuses expired capabilities before accessing a tab', async () => {
    const query = vi.fn();
    vi.stubGlobal('chrome', { tabs: { query } });
    const tools = new BrowserTools({} as ScriptStore, async () => {});
    tools.lease = {
      token: 'expired',
      sessionID: 'ses_test',
      tabId: 1,
      url: 'https://example.com/',
      expires: Date.now() - 1,
      experimentIds: [],
    };
    await expect(tools.guard('expired')).rejects.toThrow('not authorized');
    expect(query).not.toHaveBeenCalled();
  });
  it('defaults saved proposals to every route of this website and rejects other domains', async () => {
    vi.stubGlobal('chrome', {
      tabs: {
        query: async () => [
          { id: 1, windowId: 1, url: 'https://x.com/person/post', title: 'Post' },
        ],
        sendMessage: async () => ({ ok: true, data: { url: 'https://x.com/person/post' } }),
      },
    });
    const propose = vi.fn(async (_proposal: Proposal) => {});
    const tools = new BrowserTools({ list: async () => [] } as unknown as ScriptStore, propose);
    const { token } = await tools.authorize('ses_test');
    tools.lease!.experimentIds.push('experiment-observed');
    await tools.call({ id: 'observe', name: 'browser_observe', args: { context: token } });
    const args = {
      context: token,
      name: 'People',
      description: 'Remove the people section',
      code: 'api.remove("aside");',
    };
    await tools.call({ id: 'proposal', name: 'site_script_propose', args: { ...args } });
    expect(propose.mock.calls[0][0].matches).toEqual(['*://x.com/*']);
    await expect(
      tools.call({
        id: 'bad',
        name: 'site_script_propose',
        args: { ...args, matches: ['*://x.com/*', '*://another.com/*'] },
      }),
    ).rejects.toThrow('Other domains');
    expect(propose).toHaveBeenCalledTimes(1);
  });
});
