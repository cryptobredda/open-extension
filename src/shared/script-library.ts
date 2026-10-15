import type { SiteScript } from './types';
import { matchesUrl } from './validation';

export type ScriptSort = 'website' | 'name' | 'updated';
export function siteHostname(url?: string): string {
  try {
    const value = new URL(url || '');
    return /^https?:$/.test(value.protocol) ? value.hostname : '';
  } catch {
    return '';
  }
}
export function scriptWebsites(script: SiteScript): string[] {
  return [...new Set(script.matches.map((pattern) => pattern.split('/')[2] || pattern))].sort();
}
/** Library scope is the website, including scripts limited to a different route on it. */
export function scriptMatchesSite(script: SiteScript, url?: string): boolean {
  if (!siteHostname(url)) return false;
  return script.matches.some((pattern) =>
    matchesUrl(pattern.replace(/(\*|https?):\/\/([^/]+)\/.*$/, '*://$2/*'), url!),
  );
}
export function filterScripts(
  scripts: SiteScript[],
  options: {
    query: string;
    site?: string;
    status: 'all' | 'enabled' | 'disabled';
    sort: ScriptSort;
  },
): SiteScript[] {
  const words = options.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return scripts
    .filter((script) => {
      if (options.site && !scriptMatchesSite(script, options.site)) return false;
      if (options.status !== 'all' && script.enabled !== (options.status === 'enabled'))
        return false;
      const haystack =
        `${script.name} ${script.description} ${scriptWebsites(script).join(' ')}`.toLocaleLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => {
      if (options.sort === 'updated') return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
      if (options.sort === 'website') {
        const domains = scriptWebsites(a).join(',').localeCompare(scriptWebsites(b).join(','));
        if (domains) return domains;
      }
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
}
