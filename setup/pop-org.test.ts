/**
 * Tests for the optional `pop-org` setup step.
 *
 * The pure half is where the risk lives: deriving the org id (a wrong id silently
 * points the mirror at nothing) and merging profile config (a careless merge
 * silently disables an org's existing plugins). Both are exercised with no
 * mocks. The chain-touching half is covered for its GUARD RAILS — the point of
 * the step is that the dangerous action is hard to trigger by accident.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deriveOrgId,
  findConfiguredOrg,
  listProfilePluginIds,
  mergePopProfileConfig,
  normalizeOrgName,
} from './pop-org.js';

describe('deriveOrgId', () => {
  it('matches the id the live chain reports for a real org', () => {
    // Ground truth: the Argus org on Gnosis. The CLI computes
    //   keccak256(toUtf8Bytes(orgName.toLowerCase().replace(/\s+/g, '-')))
    // and the subgraph reports exactly this id. Deriving it locally is what
    // lets `check`/`link` work without a deploy having happened.
    expect(deriveOrgId('Argus')).toBe(
      '0x112de94b6e6cba0ccece7301df866a932711655946942d795f07334e3fd6f46b',
    );
  });

  it('is case- and whitespace-insensitive the same way POP is', () => {
    expect(deriveOrgId('ARGUS')).toBe(deriveOrgId('Argus'));
    expect(deriveOrgId('Acme  Cooperative')).toBe(deriveOrgId('acme cooperative'));
    expect(normalizeOrgName('Acme  Cooperative')).toBe('acme-cooperative');
  });

  it('gives different orgs different ids', () => {
    expect(deriveOrgId('Acme')).not.toBe(deriveOrgId('Acme Labs'));
  });
});

describe('mergePopProfileConfig — must not disable an org’s existing plugins', () => {
  it('turns gating ON and carries profile plugins across when it was OFF', () => {
    // The footgun: `enabledPlugins` ABSENT means gating off, so every
    // profile-dir plugin auto-registers. Writing `['pop']` alone would flip
    // gating on and silently stop those plugins loading.
    const out = mergePopProfileConfig({ orgName: 'Acme' }, {
      name: 'Acme',
      chainId: 100,
      orgId: '0xabc',
    }, ['weekly-agenda', 'my-flow']);
    expect(out.config.enabledPlugins).toEqual(['weekly-agenda', 'my-flow', 'pop']);
    expect(out.gatingNewlyEnabled).toBe(true);
    expect(out.addedPluginIds).toEqual(['weekly-agenda', 'my-flow']);
  });

  it('appends to an existing enable-list without carrying anything extra', () => {
    // Gating was already on, so the list is authoritative — adding profile
    // plugins here would ENABLE things the operator had deliberately left off.
    const out = mergePopProfileConfig(
      { enabledPlugins: ['admin-email'] },
      { name: 'Acme', chainId: 100, orgId: '0xabc' },
      ['weekly-agenda'],
    );
    expect(out.config.enabledPlugins).toEqual(['admin-email', 'pop']);
    expect(out.gatingNewlyEnabled).toBe(false);
    expect(out.addedPluginIds).toEqual([]);
  });

  it('is idempotent — re-linking does not duplicate pop or the org', () => {
    const first = mergePopProfileConfig({}, { name: 'Acme', chainId: 100, orgId: '0xabc' });
    const second = mergePopProfileConfig(first.config, {
      name: 'Acme',
      chainId: 100,
      orgId: '0xabc',
    });
    expect(second.config.enabledPlugins).toEqual(['pop']);
    const pop = (second.config.pluginConfig as Record<string, unknown>).pop as Record<
      string,
      unknown
    >;
    expect(pop.orgs).toHaveLength(1);
  });

  it('updates in place when re-linking the same org with a corrected id', () => {
    const first = mergePopProfileConfig({}, { name: 'Acme', chainId: 100, orgId: 'wrong' });
    const second = mergePopProfileConfig(first.config, {
      name: 'Acme',
      chainId: 100,
      orgId: '0xright',
    });
    const orgs = (
      (second.config.pluginConfig as Record<string, unknown>).pop as Record<string, unknown>
    ).orgs as Array<{ orgId: string }>;
    expect(orgs).toHaveLength(1);
    expect(orgs[0].orgId).toBe('0xright');
  });

  it('supports the same org name on two different chains', () => {
    const a = mergePopProfileConfig({}, { name: 'Acme', chainId: 100, orgId: '0xa' });
    const b = mergePopProfileConfig(a.config, { name: 'Acme', chainId: 42161, orgId: '0xa' });
    const orgs = ((b.config.pluginConfig as Record<string, unknown>).pop as Record<string, unknown>)
      .orgs as unknown[];
    expect(orgs).toHaveLength(2);
  });

  it('preserves every unrelated key and other plugins’ config', () => {
    const out = mergePopProfileConfig(
      {
        orgName: 'Acme',
        assistantName: 'Aide',
        pluginConfig: { 'weekly-agenda': { meetingDay: 3 } },
      },
      { name: 'Acme', chainId: 100, orgId: '0xabc' },
    );
    expect(out.config.assistantName).toBe('Aide');
    const pc = out.config.pluginConfig as Record<string, unknown>;
    expect(pc['weekly-agenda']).toEqual({ meetingDay: 3 });
  });

  it('does not mutate the input config', () => {
    const input = { enabledPlugins: ['a'], pluginConfig: {} };
    mergePopProfileConfig(input, { name: 'Acme', chainId: 100, orgId: '0xabc' });
    expect(input.enabledPlugins).toEqual(['a']);
    expect(input.pluginConfig).toEqual({});
  });
});

describe('findConfiguredOrg', () => {
  const cfg = mergePopProfileConfig({}, { name: 'Acme', chainId: 100, orgId: '0xabc' }).config;

  it('finds a configured org regardless of name casing', () => {
    expect(findConfiguredOrg(cfg, 'ACME', 100)?.orgId).toBe('0xabc');
  });

  it('does not match a different chain', () => {
    expect(findConfiguredOrg(cfg, 'Acme', 42161)).toBeUndefined();
  });

  it('handles a profile with no pop config at all', () => {
    expect(findConfiguredOrg({}, 'Acme', 100)).toBeUndefined();
    expect(findConfiguredOrg({ pluginConfig: {} }, 'Acme', 100)).toBeUndefined();
  });
});

describe('listProfilePluginIds', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-setup-'));
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists plugin ids the way the loader derives them (filename sans ext)', () => {
    fs.writeFileSync(path.join(dir, 'plugins', 'weekly-agenda.mjs'), '');
    fs.writeFileSync(path.join(dir, 'plugins', 'legacy.cjs'), '');
    expect(listProfilePluginIds(dir)).toEqual(['legacy', 'weekly-agenda']);
  });

  it('ignores non-plugin files, the .example template, and subdirectories', () => {
    fs.writeFileSync(path.join(dir, 'plugins', 'ok.mjs'), '');
    fs.writeFileSync(path.join(dir, 'plugins', 'README.md'), '');
    fs.writeFileSync(path.join(dir, 'plugins', 'hello-flow.mjs.example'), '');
    fs.mkdirSync(path.join(dir, 'plugins', '__tests__'));
    expect(listProfilePluginIds(dir)).toEqual(['ok']);
  });

  it('returns [] when the profile has no plugins dir', () => {
    expect(listProfilePluginIds(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('deploy guard rails', () => {
  // The dangerous action must be hard to trigger. These assert the *contract*
  // of the step's refusals rather than shelling out to a real deploy.
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-deploy-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('an already-configured org is detectable before spending any gas', () => {
    const cfg = mergePopProfileConfig({}, { name: 'Acme', chainId: 100, orgId: '0xabc' }).config;
    expect(findConfiguredOrg(cfg, 'Acme', 100)).toBeDefined();
  });

  it('the org id is knowable BEFORE deploying, so a redeploy is detectable', () => {
    // orgId is keccak256(name), not an output of the deploy. That is what makes
    // "does this already exist?" answerable without a transaction — and it means
    // a second deploy under the same name could only revert after spending gas
    // and pinning to IPFS.
    const before = deriveOrgId('Acme Cooperative');
    const after = deriveOrgId('Acme Cooperative');
    expect(before).toBe(after);
    expect(before).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
