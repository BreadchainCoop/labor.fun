import { describe, expect, it } from 'vitest';

import { mergePluginConfig } from './config.js';

/**
 * The per-plugin CONFIG merge (M2a). `mergePluginConfig(profilePluginConfig,
 * envRaw)` is the pure core behind the `PLUGIN_CONFIG` export: it merges the
 * profile's `pluginConfig` (base) and the `PLUGIN_CONFIG_JSON` env (over) at the
 * PLUGIN-ID level — env's entry for an id replaces the profile's entry for that
 * id wholesale (no deep merge). Malformed inputs throw loudly.
 */
describe('mergePluginConfig', () => {
  it('(a) env overrides the profile per id (id-level, wholesale replace)', () => {
    const profile = {
      'weekly-agenda': { facilitatorPool: ['alice', 'bob'], maxNudges: 3 },
      'admin-email': { recipients: ['ops@x.com'] },
    };
    const env = JSON.stringify({
      // Replaces the whole weekly-agenda entry — maxNudges from the profile is
      // GONE (id-level replace, not a deep merge).
      'weekly-agenda': { facilitatorPool: ['carol'] },
    });
    const merged = mergePluginConfig(profile, env);
    expect(merged['weekly-agenda']).toEqual({ facilitatorPool: ['carol'] });
    // admin-email had no env override → passes through from the profile.
    expect(merged['admin-email']).toEqual({ recipients: ['ops@x.com'] });
  });

  it('(b) a profile-only id passes through untouched when env is absent', () => {
    const profile = { 'weekly-agenda': { facilitatorPool: ['alice'] } };
    expect(mergePluginConfig(profile, undefined)).toEqual(profile);
    expect(mergePluginConfig(profile, '')).toEqual(profile);
    expect(mergePluginConfig(profile, '   ')).toEqual(profile);
  });

  it('(b2) an env-only id is added when the profile has none', () => {
    const merged = mergePluginConfig(
      undefined,
      JSON.stringify({ foo: { a: 1 } }),
    );
    expect(merged).toEqual({ foo: { a: 1 } });
  });

  it('(c) malformed PLUGIN_CONFIG_JSON throws loudly (not silently ignored)', () => {
    expect(() => mergePluginConfig({}, '{ not json')).toThrow(
      /PLUGIN_CONFIG_JSON.*not valid JSON/,
    );
  });

  it('(c2) a non-object PLUGIN_CONFIG_JSON (array/string) throws', () => {
    expect(() => mergePluginConfig({}, '["a","b"]')).toThrow(
      /must be a JSON object keyed by plugin id/,
    );
    expect(() => mergePluginConfig({}, '"just-a-string"')).toThrow(
      /must be a JSON object keyed by plugin id/,
    );
  });

  it('(c3) a non-object profile pluginConfig throws', () => {
    expect(() => mergePluginConfig(['not', 'an', 'object'], undefined)).toThrow(
      /pluginConfig.*must be an object keyed by plugin id/,
    );
    expect(() => mergePluginConfig('nope', undefined)).toThrow(
      /pluginConfig.*must be an object keyed by plugin id/,
    );
  });

  it('empty everywhere → {}', () => {
    expect(mergePluginConfig(undefined, undefined)).toEqual({});
    expect(mergePluginConfig({}, '{}')).toEqual({});
  });
});
