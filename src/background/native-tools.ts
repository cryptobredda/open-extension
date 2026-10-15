import type { BackendEvent, BrowserConnectionState, ToolCall } from '../shared/types';
import { errorText } from '../shared/validation';
import { OpenCode } from './opencode';
import {
  NATIVE_PLUGIN_ID,
  NATIVE_PLUGIN_PATH,
  NATIVE_PROTOCOL,
  NATIVE_RPC_ID,
} from '../native/protocol';

/** Browser tool transport over the same authenticated OpenCode HTTP/event connection. */
export class NativeTools {
  private bound?: { sessionID: string; connectionID: string; context: string };
  private heartbeat?: ReturnType<typeof setInterval>;
  private generation = 0;
  private seen = new Set<string>();
  private cancelled = new Set<string>();
  constructor(
    private backend: OpenCode,
    private execute: (call: ToolCall) => Promise<unknown>,
    private state: (value: BrowserConnectionState) => void,
    private revoke: () => void,
  ) {}
  private async rpc(method: string, input: Record<string, any> = {}) {
    const result = await this.backend.native.rpc.call({
      rpcID: NATIVE_RPC_ID,
      method,
      input,
      ...(this.backend.settings.directory
        ? { location: { directory: this.backend.settings.directory } }
        : {}),
    });
    return result.output;
  }
  async check() {
    const generation = this.generation;
    if (this.backend.protocol !== 'v2') {
      this.state({
        state: 'disconnected',
        registered: false,
        error: 'Native browser tools require OpenCode 2.0.29 or later.',
      });
      return false;
    }
    try {
      const info = await this.rpc('status');
      if (generation !== this.generation) return false;
      if (info?.protocol !== NATIVE_PROTOCOL)
        throw new Error('Update the native tools plugin using Enable native browser tools.');
      this.state({ state: 'connected', registered: true });
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.state({
        state: 'disconnected',
        registered: false,
        error: `Enable native browser tools for this OpenCode project. ${errorText(error)}`,
      });
      return false;
    }
  }
  async install() {
    if (this.backend.protocol !== 'v2')
      throw new Error('Native browser tools require OpenCode 2.0.29 or later.');
    const active = await this.backend.native.session.active();
    if (Object.keys(active).length)
      throw new Error(
        'Wait for OpenCode’s active turns to finish before installing the native tools plugin.',
      );
    const response = await fetch(chrome.runtime.getURL('open-extension-plugin.js'));
    if (!response.ok)
      throw new Error('The bundled native tools plugin is missing. Reload the extension build.');
    const source = new Uint8Array(await response.arrayBuffer());
    try {
      const existing = await this.backend.native.file.read({
        path: NATIVE_PLUGIN_PATH,
        ...(this.backend.settings.directory
          ? { location: { directory: this.backend.settings.directory } }
          : {}),
      });
      if (!new TextDecoder().decode(existing).includes(NATIVE_PLUGIN_ID))
        throw new Error(
          `An unrelated file already exists at ${NATIVE_PLUGIN_PATH}. Move it before enabling native browser tools.`,
        );
    } catch (error) {
      if ((error as any)?._tag !== 'FileNotFoundError') throw error;
    }
    const result = await this.backend.native.file.write({
      path: NATIVE_PLUGIN_PATH,
      payload: source,
      ...(this.backend.settings.directory
        ? { location: { directory: this.backend.settings.directory } }
        : {}),
    });
    this.close();
    await this.backend.native.location.reload();
    for (let n = 0; n < 50; n++) {
      if (await this.check()) return result.data.path;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(
      'OpenCode did not activate the native plugin. Check its plugin diagnostics and reconnect.',
    );
  }
  async attach(sessionID: string, context: string) {
    this.close();
    const binding = { sessionID, connectionID: crypto.randomUUID(), context };
    this.bound = binding;
    const generation = this.generation;
    try {
      const info = await this.rpc('attach', { ...binding, protocol: NATIVE_PROTOCOL });
      if (this.generation !== generation || this.bound !== binding) {
        await this.rpc('detach', { sessionID, connectionID: binding.connectionID }).catch(() => {});
        throw new Error('The browser connection changed. Send your message again.');
      }
      if (info?.protocol !== NATIVE_PROTOCOL)
        throw new Error('Native browser protocol mismatch. Update the native tools plugin.');
      this.heartbeat = setInterval(() => {
        if (this.bound !== binding) return;
        void this.rpc('heartbeat', { sessionID, connectionID: binding.connectionID }).catch(
          (error) => {
            if (this.bound !== binding) return;
            this.close();
            this.revoke();
            this.state({ state: 'disconnected', registered: false, error: errorText(error) });
          },
        );
      }, 15000);
      this.state({ state: 'connected', registered: true });
    } catch (error) {
      if (this.bound === binding) this.close();
      throw error;
    }
  }
  close() {
    this.generation++;
    clearInterval(this.heartbeat);
    const binding = this.bound;
    this.bound = undefined;
    this.seen.clear();
    this.cancelled.clear();
    if (binding)
      void this.rpc('detach', {
        sessionID: binding.sessionID,
        connectionID: binding.connectionID,
      }).catch(() => {});
  }
  handle(event: BackendEvent) {
    if (event.type !== `rpc.${NATIVE_RPC_ID}.control`) return;
    const binding = this.bound,
      data = event.properties;
    if (!binding || data.connectionID !== binding.connectionID) return;
    if (data.type === 'cancel') {
      this.cancelled.add(data.requestID);
      this.revoke();
      return;
    }
    if (
      data.type !== 'command' ||
      typeof data.requestID !== 'string' ||
      this.seen.has(data.requestID)
    )
      return;
    this.seen.add(data.requestID);
    void this.run(binding, data.requestID);
  }
  private async run(binding: NonNullable<NativeTools['bound']>, requestID: string) {
    const identity = {
      sessionID: binding.sessionID,
      connectionID: binding.connectionID,
      requestID,
    };
    try {
      const command = await this.rpc('command', identity);
      if (this.bound !== binding || this.cancelled.has(requestID)) return;
      if (command?.id !== requestID || command.args?.context !== binding.context)
        throw new Error('OpenCode returned a browser command for a different turn.');
      const data = await this.execute(command);
      if (this.bound === binding && !this.cancelled.has(requestID))
        await this.rpc('result', { ...identity, ok: true, data });
    } catch (error) {
      if (this.bound === binding && !this.cancelled.has(requestID))
        await this.rpc('result', { ...identity, ok: false, error: errorText(error) }).catch(
          () => {},
        );
    }
  }
}
