import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Auto-registration feature flags in src/config.ts.
 *
 * config.ts resolves these at module load from process.env (readEnvFile reads a
 * real .env from cwd; the repo root has none, so only process.env + defaults are
 * exercised here). We reset the module registry and re-import per scenario so
 * each env value is read fresh — mirroring config-backend.test.ts.
 */

const FLAG_KEYS = [
  'SIGNAL_AUTO_REGISTER_GROUPS',
  'WHATSAPP_AUTO_REGISTER_GROUPS',
  'TELEGRAM_AUTO_REGISTER_GROUPS',
] as const;

type ConfigModule = typeof import('./config.js');

async function loadConfig(
  env: Partial<Record<(typeof FLAG_KEYS)[number], string>>,
): Promise<ConfigModule> {
  for (const k of FLAG_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v as string;
  vi.resetModules();
  return import('./config.js');
}

describe('SIGNAL_AUTO_REGISTER_GROUPS', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of FLAG_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of FLAG_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    vi.resetModules();
  });

  it('defaults to off when unset (parity with WhatsApp/Telegram)', async () => {
    const c = await loadConfig({});
    expect(c.SIGNAL_AUTO_REGISTER_GROUPS).toBe(false);
    expect(c.WHATSAPP_AUTO_REGISTER_GROUPS).toBe(false);
    expect(c.TELEGRAM_AUTO_REGISTER_GROUPS).toBe(false);
  });

  it("is enabled only by the exact string 'true'", async () => {
    expect(
      (await loadConfig({ SIGNAL_AUTO_REGISTER_GROUPS: 'true' }))
        .SIGNAL_AUTO_REGISTER_GROUPS,
    ).toBe(true);
    for (const v of ['false', 'TRUE', '1', 'yes', '']) {
      expect(
        (await loadConfig({ SIGNAL_AUTO_REGISTER_GROUPS: v }))
          .SIGNAL_AUTO_REGISTER_GROUPS,
      ).toBe(false);
    }
  });

  it('is independent of the WhatsApp/Telegram flags', async () => {
    const c = await loadConfig({
      SIGNAL_AUTO_REGISTER_GROUPS: 'true',
      WHATSAPP_AUTO_REGISTER_GROUPS: 'false',
      TELEGRAM_AUTO_REGISTER_GROUPS: 'false',
    });
    expect(c.SIGNAL_AUTO_REGISTER_GROUPS).toBe(true);
    expect(c.WHATSAPP_AUTO_REGISTER_GROUPS).toBe(false);
    expect(c.TELEGRAM_AUTO_REGISTER_GROUPS).toBe(false);
  });
});
