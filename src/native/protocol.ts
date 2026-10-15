import packageInfo from '../../package.json' with { type: 'json' };
export const NATIVE_PLUGIN_ID = 'open-extension.native';
export const NATIVE_RPC_ID = 'open-extension.browser';
export const NATIVE_PROTOCOL = 1;
export const NATIVE_PLUGIN_VERSION = packageInfo.version;
export const NATIVE_PLUGIN_PATH = '.opencode/plugins/open-extension.js';
export type BrowserCommand = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};
