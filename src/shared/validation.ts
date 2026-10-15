import type { SiteScript, Settings } from './types';

export function localUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a complete local URL, for example http://127.0.0.1:49374.');
  }
  const host = url.hostname.toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Use an HTTP(S) server origin without a path, query, or embedded credentials.');
  if (!(
    host === 'localhost' ||
    host === '[::1]' ||
    /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(host) ||
    /^10\.(\d{1,3}\.){2}\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host.endsWith('.local')
  ))
    throw new Error('Use localhost, loopback, a private LAN address, or a .local server.');
  return url.origin;
}

export function pairingLink(value: string): { origin: string; code: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Paste the complete, fresh link printed by opencode pair.');
  }
  const match = url.pathname.match(/^\/auth\/connect\/([^/]+)\/?$/);
  if (!match || url.username || url.password || url.search || url.hash)
    throw new Error('Use the full /auth/connect/... link printed by opencode pair.');
  const origin = localUrl(url.origin);
  const code = decodeURIComponent(match[1]);
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(code))
    throw new Error(
      'The pairing link contains an invalid code. Generate a new link with opencode pair.',
    );
  return { origin, code };
}

export function validateSettings(input: Settings): Settings {
  const value = {
    ...input,
    serverUrl: localUrl(input.serverUrl),
    bridgeUrl: localUrl(input.bridgeUrl),
  };
  if (!value.username || value.username.includes(':'))
    throw new Error('Basic Auth username must be nonempty and cannot contain a colon.');
  if (value.directory.length > 4096 || value.bridgeToken.length > 512)
    throw new Error('Settings value is too long.');
  return value;
}

export function validatePattern(pattern: string): string {
  // Only HTTP(S) match patterns; no file://, chrome://, or <all_urls>.
  if (!/^(\*|https?):\/\/(\*|(?:\*\.)?(?:[a-z0-9-]+\.)*[a-z0-9-]+|\[::1\])\/[^\s]*$/i.test(pattern))
    throw new Error(
      `Invalid domain matcher: ${pattern}. Use *://example.com/* or *://*.example.com/*.`,
    );
  return pattern;
}

export function matchesUrl(pattern: string, value: string): boolean {
  try {
    validatePattern(pattern);
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const [, scheme, host, path] = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/)!;
    if (scheme !== '*' && url.protocol !== `${scheme}:`) return false;
    const hostname = url.hostname.toLowerCase(),
      domain = host.toLowerCase();
    if (
      domain !== '*' &&
      !(domain.startsWith('*.')
        ? hostname === domain.slice(2) || hostname.endsWith(domain.slice(1))
        : hostname === domain)
    )
      return false;
    const escaped = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(url.pathname + url.search);
  } catch {
    return false;
  }
}

export function validateScript(input: SiteScript): SiteScript {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.id)) throw new Error('Invalid script ID.');
  if (!input.name.trim() || input.name.length > 100)
    throw new Error('Give the script a name of up to 100 characters.');
  if (typeof input.description !== 'string' || input.description.length > 500)
    throw new Error('Keep the description under 500 characters.');
  if (!input.matches.length || input.matches.length > 20)
    throw new Error('Add between 1 and 20 domain matchers.');
  input.matches.forEach(validatePattern);
  if (!input.code.trim() || input.code.length > 100_000)
    throw new Error('Script code must be between 1 and 100,000 characters.');
  if (!['MAIN', 'USER_SCRIPT'].includes(input.world)) throw new Error('Invalid execution world.');
  return {
    ...input,
    name: input.name.trim(),
    matches: [...new Set(input.matches)],
  };
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  const item = error as any;
  return (
    item?.data?.message ||
    item?.message ||
    'The operation failed. Check the local server and try again.'
  );
}
