import { describe, expect, it } from 'vitest';
import { filterScripts, scriptMatchesSite } from '../../src/shared/script-library';
import { DEFAULT_SETTINGS, type SiteScript } from '../../src/shared/types';
import { validateSettings } from '../../src/shared/validation';
const script = (id: string, matches: string[], enabled = true): SiteScript => ({
  id,
  name: id,
  description: `Description for ${id}`,
  matches,
  enabled,
  code: 'api.hide(".ad");',
  world: 'USER_SCRIPT',
  revision: 1,
  createdAt: 1,
  updatedAt: id === 'Zulu' ? 10 : 1,
});
describe('website script library', () => {
  it('finds the exact website across routes and handles explicit subdomain matchers', () => {
    expect(scriptMatchesSite(script('x', ['*://x.com/specific/*']), 'https://x.com/home')).toBe(
      true,
    );
    expect(scriptMatchesSite(script('x', ['https://x.com/private/*']), 'http://x.com/home')).toBe(
      true,
    );
    expect(scriptMatchesSite(script('x', ['*://x.com/*']), 'https://evilx.com')).toBe(false);
    expect(scriptMatchesSite(script('x', ['*://x.com/*']), 'https://sub.x.com')).toBe(false);
    expect(scriptMatchesSite(script('x', ['*://*.x.com/*']), 'https://sub.x.com')).toBe(true);
    expect(scriptMatchesSite(script('x', ['*://*/*']), 'chrome://extensions')).toBe(false);
  });
  it('combines website, keyword and status filtering and stable sorting', () => {
    const scripts = [
      script('Zulu', ['*://x.com/*']),
      script('Alpha', ['*://example.com/*']),
      script('Beta', ['*://x.com/elsewhere/*'], false),
    ];
    expect(
      filterScripts(scripts, { query: '', status: 'all', sort: 'website' }).map((s) => s.id),
    ).toEqual(['Alpha', 'Beta', 'Zulu']);
    expect(
      filterScripts(scripts, {
        query: 'description x.com',
        site: 'https://x.com/home',
        status: 'disabled',
        sort: 'name',
      }).map((s) => s.id),
    ).toEqual(['Beta']);
    expect(filterScripts(scripts, { query: '', status: 'all', sort: 'updated' })[0].id).toBe(
      'Zulu',
    );
  });
  it('discards the obsolete bridge secret while preserving connection preferences', () => {
    const migrated = validateSettings({
      ...DEFAULT_SETTINGS,
      bridgeUrl: 'http://127.0.0.1:49375',
      bridgeToken: 'obsolete-secret',
      model: 'provider/model',
    } as any);
    expect(migrated).not.toHaveProperty('bridgeToken');
    expect(migrated).not.toHaveProperty('bridgeUrl');
    expect(migrated.model).toBe('provider/model');
  });
});
