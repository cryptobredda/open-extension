import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeTools } from '../../src/background/native-tools';
import type { OpenCode } from '../../src/background/opencode';

function fixture() {
  const call = vi.fn(async (input: any): Promise<any> => ({
    output:
      input.method === 'command'
        ? { id: input.input.requestID, name: 'browser_observe', args: { context: 'turn' } }
        : { protocol: 1 },
  }));
  const backend = {
    protocol: 'v2',
    settings: { directory: '' },
    native: { rpc: { call } },
  } as unknown as OpenCode;
  const execute = vi.fn(async () => ({ observed: true })),
    state = vi.fn(),
    revoke = vi.fn();
  const transport = new NativeTools(backend, execute, state, revoke);
  const control = () => {
    const binding = call.mock.calls.find(([input]) => input.method === 'attach')![0].input;
    return {
      type: 'rpc.open-extension.browser.control',
      properties: { type: 'command', connectionID: binding.connectionID, requestID: 'request-1' },
    };
  };
  return { transport, call, execute, state, revoke, control };
}
afterEach(() => vi.useRealTimers());
describe('native Chrome transport', () => {
  it('deduplicates replayed SSE commands and returns their result over the existing API', async () => {
    const f = fixture();
    try {
      await f.transport.attach('ses_test', 'turn');
      f.transport.handle(f.control());
      f.transport.handle(f.control());
      await vi.waitFor(() =>
        expect(f.call.mock.calls.some(([input]) => input.method === 'result')).toBe(true),
      );
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(
        f.call.mock.calls.find(([input]) => input.method === 'result')![0].input,
      ).toMatchObject({
        sessionID: 'ses_test',
        requestID: 'request-1',
        ok: true,
        data: { observed: true },
      });
      expect(f.call.mock.calls.every(([input]) => input.rpcID === 'open-extension.browser')).toBe(
        true,
      );
    } finally {
      f.transport.close();
    }
  });
  it('ignores other attachments and refuses a command fetched after cancellation', async () => {
    const f = fixture();
    let release: (value: any) => void = () => {};
    try {
      await f.transport.attach('ses_test', 'turn');
      f.transport.handle({
        ...f.control(),
        properties: { ...f.control().properties, connectionID: 'another-panel' },
      });
      expect(f.execute).not.toHaveBeenCalled();
      f.call.mockImplementation(async (input: any) =>
        input.method === 'command'
          ? new Promise((resolve) => {
              release = resolve;
            })
          : { output: { protocol: 1 } },
      );
      f.transport.handle(f.control());
      f.transport.handle({
        ...f.control(),
        properties: { ...f.control().properties, type: 'cancel' },
      });
      release({ output: { id: 'request-1', name: 'browser_observe', args: { context: 'turn' } } });
      await Promise.resolve();
      await Promise.resolve();
      expect(f.revoke).toHaveBeenCalledTimes(1);
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      f.transport.close();
    }
  });
  it('detaches a connection whose authorization changed while attaching', async () => {
    const f = fixture();
    let release: (value: any) => void = () => {};
    f.call.mockImplementation(async (input: any) =>
      input.method === 'attach'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : { output: { protocol: 1 } },
    );
    const pending = f.transport.attach('ses_test', 'turn');
    f.transport.close();
    release({ output: { protocol: 1 } });
    await expect(pending).rejects.toThrow('connection changed');
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.call.mock.calls.some(([input]) => input.method === 'detach')).toBe(true);
  });
});
