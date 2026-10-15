import { describe, expect, it, vi } from 'vitest';
import { localUrl, matchesUrl, validateScript } from '../../src/shared/validation';
import { readSSE } from '../../src/shared/sse';
import { reduceConversation } from '../../src/shared/conversation';
import { OpenCode, discover } from '../../src/background/opencode';
import { DEFAULT_SETTINGS } from '../../src/shared/types';

describe('connection and matcher boundaries', () => {
  it('accepts loopback and configured mDNS origins, rejects credential redirects and remote URLs', () => {
    expect(localUrl('http://127.0.0.1:49374/')).toBe('http://127.0.0.1:49374');
    expect(localUrl('http://[::1]:4096')).toBe('http://[::1]:4096');
    expect(localUrl('http://opencode.local:4096')).toBe('http://opencode.local:4096');
    for (const url of [
      'https://example.com',
      'http://opencode:password@localhost:4096',
      'file:///etc/passwd',
      'http://localhost:4096/other',
      'http://localhost:4096/?url=evil',
    ])
      expect(() => localUrl(url)).toThrow();
  });
  it('matches exact domains and subdomains without matching lookalikes', () => {
    expect(matchesUrl('*://*.example.com/*', 'https://example.com/a')).toBe(true);
    expect(matchesUrl('*://*.example.com/*', 'https://app.example.com/a')).toBe(true);
    expect(matchesUrl('*://*.example.com/*', 'https://evilexample.com/a')).toBe(false);
    expect(matchesUrl('https://example.com/work/*', 'http://example.com/work/a')).toBe(false);
    expect(matchesUrl('*://localhost/*', 'http://localhost:1234/a')).toBe(true);
    expect(matchesUrl('*://example.com/work/*', 'https://example.com/other')).toBe(false);
    expect(matchesUrl('*://*/*', 'chrome://extensions/')).toBe(false);
  });
  it('blocks invalid persistent script IDs, patterns and missing code', () => {
    const script: any = {
      id: 'test',
      name: 'Test',
      description: '',
      matches: ['*://example.com/*'],
      code: 'api.hide(".ad")',
      world: 'USER_SCRIPT',
    };
    expect(validateScript(script).name).toBe('Test');
    expect(() => validateScript({ ...script, matches: ['<all_urls>'] })).toThrow();
    expect(() => validateScript({ ...script, id: '../foo' })).toThrow();
    expect(() => validateScript({ ...script, code: '' })).toThrow();
  });
});
describe('stream and shared message state', () => {
  it('parses UTF-8 characters split across chunks, CRLF, multiline data and event IDs', async () => {
    const bytes = new TextEncoder().encode(
      ': heartbeat\r\nid: one\r\ndata: {"text":\r\ndata: "héllo"}\r\n\r\ndata: {"next":true}\n\n',
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    });
    const results = [];
    for await (const item of readSSE(body)) results.push(item);
    expect(results).toEqual([
      { id: 'one', data: '{"text":\n"héllo"}' },
      { id: 'one', data: '{"next":true}' },
    ]);
  });
  it('merges server IDs, deltas, full updates and removals without duplicating content', () => {
    let state: any[] = [];
    const info = {
      id: 'm1',
      sessionID: 's1',
      role: 'assistant',
      time: { created: 1 },
    };
    const apply = (type: string, properties: any) =>
      (state = reduceConversation(state, { type, properties }));
    apply('message.updated', { info });
    apply('message.updated', { info });
    apply('message.part.updated', {
      part: { id: 'p1', messageID: 'm1', type: 'text', text: 'Hello' },
    });
    apply('message.part.delta', {
      messageID: 'm1',
      partID: 'p1',
      field: 'text',
      delta: ' world',
    });
    expect(state).toHaveLength(1);
    expect(state[0].parts[0].text).toBe('Hello world');
    apply('message.part.updated', {
      part: { id: 'p1', messageID: 'm1', type: 'text', text: 'Hello world' },
    });
    expect(state[0].parts).toHaveLength(1);
    apply('message.part.removed', { partID: 'p1' });
    expect(state[0].parts).toHaveLength(0);
    apply('message.removed', { messageID: 'm1' });
    expect(state).toHaveLength(0);
  });
});
describe('credential proxy', () => {
  it('sends Basic Auth through the worker and refuses requests to other origins', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    try {
      const api = new OpenCode({ ...DEFAULT_SETTINGS, password: 'pässword' });
      await api.fetch('http://127.0.0.1:49374/session');
      const request = fetch.mock.calls[0][0] as Request;
      expect(request.headers.get('Authorization')).toBe(
        `Basic ${Buffer.from('opencode:pässword').toString('base64')}`,
      );
      expect(request.redirect).toBe('error');
      expect(request.credentials).toBe('omit');
      await expect(api.fetch('https://example.com/session')).rejects.toThrow('outside');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('never sends stored credentials while scanning unrelated local ports', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    try {
      const results = await discover({
        ...DEFAULT_SETTINGS,
        password: 'existing-secret',
      });
      expect(results.length).toBeGreaterThan(0);
      for (const [, init] of fetch.mock.calls) expect(init.headers).toBeUndefined();
      expect(results.every((item) => item.authRequired && !item.verified)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
