import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startBridge } from './server';

const directory = join(
  process.env.APPDATA || process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'open-extension',
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const tokenPath = join(directory, 'bridge-token');
let token = process.env.OPEN_EXTENSION_BRIDGE_TOKEN;
if (!token) {
  try {
    token = (await readFile(tokenPath, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex');
    await writeFile(tokenPath, token, { mode: 0o600, flag: 'wx' });
  }
}
const port = Number(process.env.OPEN_EXTENSION_BRIDGE_PORT || 49375);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid OPEN_EXTENSION_BRIDGE_PORT.');
const bridge = await startBridge({ port, token });
console.log(
  `Open Extension browser bridge · http://127.0.0.1:${bridge.port}\n\nPairing token (paste into the extension’s Connection settings):\n${token}\n\nThis process provides browser tools only. Your existing OpenCode service owns all AI and chat history.\nKeep this terminal open, or run this command through your service manager.`,
);
const shutdown = async () => {
  await bridge.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
