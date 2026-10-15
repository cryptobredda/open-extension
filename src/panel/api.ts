import type { Envelope } from '../shared/types';
export async function rpc<T = any>(method: string, args?: unknown): Promise<T> {
  const result: Envelope<T> = await chrome.runtime.sendMessage({
    type: 'rpc',
    method,
    args,
  });
  if (!result) throw new Error('The extension worker is restarting. Please retry.');
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
