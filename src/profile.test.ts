import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadProfileConfig } from './profile.js';

describe('loadProfileConfig', () => {
  const tmpDirs: string[] = [];

  function makeProfile(config?: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-test-'));
    tmpDirs.push(dir);
    if (config !== undefined) {
      fs.writeFileSync(
        path.join(dir, 'profile.config.json'),
        JSON.stringify(config),
      );
    }
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('merges profile values over framework defaults', () => {
    const dir = makeProfile({
      assistantName: 'Aide',
      orgName: 'Acme',
      githubOrg: 'acme-coop',
    });
    const cfg = loadProfileConfig(dir);
    expect(cfg.assistantName).toBe('Aide');
    expect(cfg.orgName).toBe('Acme');
    expect(cfg.githubOrg).toBe('acme-coop');
    // Unset optional fields fall back to the framework default.
    expect(cfg.sharedKbGroup).toBe('slack_main');
  });

  it('falls back to defaults when profile.config.json is missing', () => {
    const dir = makeProfile(); // no config file written
    const cfg = loadProfileConfig(dir);
    expect(cfg.assistantName).toBe('labor.fun');
    expect(cfg.orgName).toBe('Your Organization');
    expect(cfg.sharedKbGroup).toBe('slack_main');
  });

  it('falls back to defaults on malformed JSON instead of throwing', () => {
    const dir = makeProfile();
    fs.writeFileSync(path.join(dir, 'profile.config.json'), '{ not json');
    const cfg = loadProfileConfig(dir);
    expect(cfg.assistantName).toBe('labor.fun');
  });

  it('lets a profile override the shared KB group', () => {
    const dir = makeProfile({ sharedKbGroup: 'discord_main' });
    expect(loadProfileConfig(dir).sharedKbGroup).toBe('discord_main');
  });
});
