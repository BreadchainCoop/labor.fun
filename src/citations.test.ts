import { describe, it, expect } from 'vitest';
import {
  channelFromFolder,
  kbDeepLink,
  resolveCitationUrl,
  formatSources,
  type Citation,
} from './citations.js';

const BASE = 'https://kb.example.com';

describe('channelFromFolder', () => {
  it('maps known prefixes', () => {
    expect(channelFromFolder('slack_main')).toBe('slack');
    expect(channelFromFolder('telegram_alice')).toBe('telegram');
    expect(channelFromFolder('whatsapp_ops')).toBe('whatsapp');
    expect(channelFromFolder('discord_general')).toBe('discord');
  });
  it('defaults to cli for unknown / empty', () => {
    expect(channelFromFolder('cli_local')).toBe('cli');
    expect(channelFromFolder('')).toBe('cli');
    expect(channelFromFolder(undefined)).toBe('cli');
  });
  it('is case-insensitive', () => {
    expect(channelFromFolder('SLACK_Main')).toBe('slack');
  });
});

describe('kbDeepLink', () => {
  it('builds a deep-link for a top-level doc', () => {
    expect(kbDeepLink('people/jane-doe.md', BASE)).toBe(
      `${BASE}/doc/people/jane-doe.md`,
    );
  });
  it('strips a leading context/ prefix', () => {
    expect(kbDeepLink('context/tasks/TASK-123.md', BASE)).toBe(
      `${BASE}/doc/tasks/TASK-123.md`,
    );
  });
  it('encodes nested separators in the file segment', () => {
    expect(kbDeepLink('artifacts/equipment/laptop.md', BASE)).toBe(
      `${BASE}/doc/artifacts/equipment%2Flaptop.md`,
    );
  });
  it('trims a trailing slash on the base url', () => {
    expect(kbDeepLink('tasks/TASK-1.md', `${BASE}/`)).toBe(
      `${BASE}/doc/tasks/TASK-1.md`,
    );
  });
  it('returns null when no dashboard url is configured', () => {
    expect(kbDeepLink('people/x.md', undefined)).toBeNull();
    expect(kbDeepLink('people/x.md', '')).toBeNull();
  });
  it('returns null for a path outside a served category', () => {
    expect(kbDeepLink('secrets/x.md', BASE)).toBeNull();
  });
  it('returns null for a category with no file', () => {
    expect(kbDeepLink('people', BASE)).toBeNull();
  });
});

describe('resolveCitationUrl', () => {
  it('prefers an explicit url', () => {
    const c: Citation = {
      title: 'X',
      url: 'https://ex.com',
      kbPath: 'people/x.md',
    };
    expect(resolveCitationUrl(c, BASE)).toBe('https://ex.com');
  });
  it('derives a KB deep-link from kbPath', () => {
    const c: Citation = { title: 'Jane', kbPath: 'people/jane.md' };
    expect(resolveCitationUrl(c, BASE)).toBe(`${BASE}/doc/people/jane.md`);
  });
  it('returns null when neither url nor a linkable kbPath resolves', () => {
    const c: Citation = { title: 'Jane', kbPath: 'people/jane.md' };
    expect(resolveCitationUrl(c, undefined)).toBeNull();
  });
});

describe('formatSources', () => {
  const kbDoc: Citation = { title: 'Jane Doe', kbPath: 'people/jane-doe.md' };
  const web: Citation = {
    title: 'Anthropic docs',
    url: 'https://docs.anthropic.com',
  };
  const gh: Citation = {
    title: 'labor.fun#42',
    url: 'https://github.com/BreadchainCoop/labor.fun/issues/42',
  };

  it('returns empty string for no citations', () => {
    expect(formatSources([], 'slack', BASE)).toBe('');
  });

  it('renders Slack mrkdwn links with <url|title>', () => {
    const out = formatSources([kbDoc, web], 'slack', BASE);
    expect(out).toContain('*Sources*');
    expect(out).toContain(`• <${BASE}/doc/people/jane-doe.md|Jane Doe>`);
    expect(out).toContain('• <https://docs.anthropic.com|Anthropic docs>');
  });

  it('renders Telegram markdown [title](url) links', () => {
    const out = formatSources([kbDoc, gh], 'telegram', BASE);
    expect(out).toContain('• [Jane Doe](' + BASE + '/doc/people/jane-doe.md)');
    expect(out).toContain(
      '• [labor.fun#42](https://github.com/BreadchainCoop/labor.fun/issues/42)',
    );
  });

  it('renders Discord with markdown bold header and dash bullets', () => {
    const out = formatSources([web], 'discord', BASE);
    expect(out).toContain('**Sources**');
    expect(out).toContain('- [Anthropic docs](https://docs.anthropic.com)');
  });

  it('renders WhatsApp as "Title (url)" since it has no link markup', () => {
    const out = formatSources([web], 'whatsapp', BASE);
    expect(out).toContain('• Anthropic docs (https://docs.anthropic.com)');
  });

  it('falls back to "Title (path)" when no dashboard is configured', () => {
    const out = formatSources([kbDoc], 'slack', undefined);
    // No link markup — keep the path visible so it stays traceable.
    expect(out).toContain('• Jane Doe (people/jane-doe.md)');
    expect(out).not.toContain('<http');
  });

  it('shows just the path when a KB doc has no distinct title', () => {
    const out = formatSources(
      [{ title: 'people/jane-doe.md', kbPath: 'people/jane-doe.md' }],
      'slack',
      undefined,
    );
    expect(out).toContain('• people/jane-doe.md');
  });

  it('deduplicates by resolved url', () => {
    const dup: Citation = {
      title: 'Jane (again)',
      kbPath: 'context/people/jane-doe.md',
    };
    const out = formatSources([kbDoc, dup], 'slack', BASE);
    const count = (out.match(/jane-doe\.md/g) || []).length;
    expect(count).toBe(1);
  });
});
