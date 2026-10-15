import { afterEach, describe, expect, it, vi } from 'vitest';
import plugin from '../../src/native/plugin';
import { BROWSER_TOOLS } from '../../src/shared/browser-context';

const directory = '/project';
async function fixture() {
  let handlers: Record<string, (input: any) => Promise<any>> = {};
  const tools: any[] = [];
  const emit = vi.fn(async (_name: string, _data: any) => {});
  const cleanup = await plugin.setup({
    location: { directory },
    rpc: {
      register: vi.fn(async (_definition, methods) => {
        handlers = methods as any;
        return { events: { emit }, dispose: vi.fn(async () => {}) };
      }),
    },
    session: { get: vi.fn(async () => ({ location: { directory } })) },
    tool: {
      transform: vi.fn(async (edit) => {
        edit({ namespace: vi.fn(), add: (tool: any) => tools.push(tool) } as any);
        return { dispose: vi.fn(async () => {}) };
      }),
    },
  } as any);
  const identity = { sessionID: 'ses_test', connectionID: 'private-connection' };
  const attach = () => handlers.attach({ ...identity, protocol: 1, context: 'turn-capability' });
  return { handlers, tools, emit, cleanup, identity, attach };
}
afterEach(() => vi.useRealTimers());
describe('native OpenCode plugin', () => {
  it('registers only the seven DOM tools in native Code Mode', async () => {
    const f = await fixture();
    try {
      expect(f.tools.map((t) => t.name)).toEqual(BROWSER_TOOLS);
      for (const tool of f.tools) {
        expect(tool.options).toEqual({
          namespace: 'open_extension',
          permission: `open-extension.dom.${tool.name}`,
          codemode: true,
          pinned: true,
        });
        expect(tool.output).toEqual({});
      }
    } finally {
      await f.cleanup?.();
    }
  });
  it('keeps command arguments out of SSE and binds results to the authenticated session attachment', async () => {
    const f = await fixture();
    try {
      await f.attach();
      const promise = f.tools[0].execute(
        { context: 'turn-capability', selector: 'main' },
        { sessionID: 'ses_test', signal: new AbortController().signal },
      );
      await vi.waitFor(() => expect(f.emit).toHaveBeenCalled());
      const control = f.emit.mock.calls[0][1];
      expect(control).toEqual({
        type: 'command',
        connectionID: 'private-connection',
        requestID: expect.any(String),
      });
      expect(control).not.toHaveProperty('args');
      await expect(
        f.handlers.command({ ...f.identity, sessionID: 'ses_other', requestID: control.requestID }),
      ).rejects.toThrow('no longer attached');
      await expect(
        f.handlers.result({
          ...f.identity,
          connectionID: 'other',
          requestID: control.requestID,
          ok: true,
        }),
      ).rejects.toThrow('no longer attached');
      const command = await f.handlers.command({ ...f.identity, requestID: control.requestID });
      expect(command.args.selector).toBe('main');
      await f.handlers.result({
        ...f.identity,
        requestID: control.requestID,
        ok: true,
        data: { title: 'Observed website' },
      });
      expect((await promise).output).toEqual({ title: 'Observed website' });
      await expect(
        f.handlers.command({ ...f.identity, requestID: control.requestID }),
      ).rejects.toThrow('no longer pending');
    } finally {
      await f.cleanup?.();
    }
  });
  it('rejects stale capabilities, other sessions and competing panels', async () => {
    const f = await fixture();
    try {
      await f.attach();
      await expect(
        f.tools[0].execute(
          { context: 'old-turn' },
          { sessionID: 'ses_test', signal: new AbortController().signal },
        ),
      ).rejects.toThrow('no longer authorized');
      await expect(
        f.tools[0].execute(
          { context: 'turn-capability' },
          { sessionID: 'ses_other', signal: new AbortController().signal },
        ),
      ).rejects.toThrow('no longer authorized');
      await expect(
        f.handlers.attach({
          ...f.identity,
          protocol: 1,
          context: 'other-turn',
          connectionID: 'other-panel',
        }),
      ).rejects.toThrow('Another Open Extension panel');
      await f.handlers.detach(f.identity);
      await expect(f.handlers.heartbeat(f.identity)).rejects.toThrow('no longer attached');
    } finally {
      await f.cleanup?.();
    }
  });
  it('expires disconnected panels and cancels in-flight tools on detach', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      await f.attach();
      const promise = f.tools[0].execute(
        { context: 'turn-capability' },
        { sessionID: 'ses_test', signal: new AbortController().signal },
      );
      const rejected = expect(promise).rejects.toThrow('disconnected');
      await f.handlers.detach(f.identity);
      await rejected;
      await f.attach();
      await vi.advanceTimersByTimeAsync(46000);
      await expect(f.handlers.heartbeat(f.identity)).rejects.toThrow('no longer attached');
    } finally {
      await f.cleanup?.();
    }
  });
});
