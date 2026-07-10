import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const configMock = vi.hoisted(() => ({ STORE_DIR: '' }));
vi.mock('../config.js', () => configMock);

vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// controlPlaneConfig is imported from control-plane-sync — mock it directly so
// tests control whether "hosted mode" is on.
const cpMock = vi.hoisted(() => ({
  cfg: null as { url: string; token: string } | null,
}));
vi.mock('./control-plane-sync.js', () => ({
  controlPlaneConfig: vi.fn(() => cpMock.cfg),
}));

// runPairingSession is the baileys layer — replace with a controllable stub so
// tests never touch the network / a real socket.
const sessionMock = vi.hoisted(() => ({
  // Resolves the session's `done` promise; set per-test.
  resolveDone: null as
    | ((v: 'authenticated' | { failed: number | 'unknown' }) => void)
    | null,
  requestPairingCode: vi.fn(),
  onPairingCode: null as ((code: string) => void) | null,
  close: vi.fn(),
}));
vi.mock('../whatsapp-pairing.js', () => ({
  runPairingSession: vi.fn(async (opts: { onPairingCode?: (c: string) => void }) => {
    sessionMock.onPairingCode = opts.onPairingCode ?? null;
    const done = new Promise((resolve) => {
      sessionMock.resolveDone = resolve as (v: unknown) => void;
    });
    return {
      done,
      requestPairingCode: sessionMock.requestPairingCode,
      close: sessionMock.close,
    };
  }),
}));

import {
  pairingPhone,
  whatsappCredsExist,
  pairingBrokerInputs,
  postPairingCode,
  postPaired,
  runWhatsAppPairingBroker,
} from './whatsapp-pairing-broker.js';
import { readEnvFile } from '../env.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-broker-test-'));
  configMock.STORE_DIR = tmpDir;
  cpMock.cfg = null;
  sessionMock.resolveDone = null;
  sessionMock.onPairingCode = null;
  sessionMock.requestPairingCode.mockReset().mockResolvedValue('ABCD-1234');
  sessionMock.close.mockReset();
  delete process.env.WHATSAPP_PAIRING_PHONE;
  vi.mocked(readEnvFile).mockReturnValue({});
  vi.restoreAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeCreds() {
  const authDir = path.join(tmpDir, 'auth');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'creds.json'), '{}');
}

describe('pairingPhone', () => {
  it('strips non-digits from WHATSAPP_PAIRING_PHONE', () => {
    process.env.WHATSAPP_PAIRING_PHONE = '+1 (415) 555-1234';
    expect(pairingPhone()).toBe('14155551234');
  });

  it('returns empty string when unset', () => {
    expect(pairingPhone()).toBe('');
  });

  it('falls back to .env via readEnvFile', () => {
    vi.mocked(readEnvFile).mockReturnValue({
      WHATSAPP_PAIRING_PHONE: '14155559999',
    });
    expect(pairingPhone()).toBe('14155559999');
  });
});

describe('whatsappCredsExist', () => {
  it('is false with no creds file', () => {
    expect(whatsappCredsExist()).toBe(false);
  });
  it('is true once creds.json exists under <STORE_DIR>/auth', () => {
    makeCreds();
    expect(whatsappCredsExist()).toBe(true);
  });
});

describe('pairingBrokerInputs (trigger conditions)', () => {
  it('null when no pairing phone', () => {
    cpMock.cfg = { url: 'https://cp', token: 't' };
    expect(pairingBrokerInputs()).toBeNull();
  });

  it('null when control plane not configured', () => {
    process.env.WHATSAPP_PAIRING_PHONE = '14155551234';
    cpMock.cfg = null;
    expect(pairingBrokerInputs()).toBeNull();
  });

  it('null when creds already exist (already paired)', () => {
    process.env.WHATSAPP_PAIRING_PHONE = '14155551234';
    cpMock.cfg = { url: 'https://cp', token: 't' };
    makeCreds();
    expect(pairingBrokerInputs()).toBeNull();
  });

  it('returns inputs when phone + control plane set and no creds', () => {
    process.env.WHATSAPP_PAIRING_PHONE = '14155551234';
    cpMock.cfg = { url: 'https://cp', token: 'secret' };
    expect(pairingBrokerInputs()).toEqual({
      phone: '14155551234',
      url: 'https://cp',
      token: 'secret',
    });
  });
});

describe('postPairingCode / postPaired (payload + auth shape)', () => {
  it('POSTs the pairing code with Bearer auth and correct body', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await postPairingCode('https://cp', 'tok', 'AB12-CD34', '14155551234');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cp/api/instance/whatsapp/pairing-code');
    const i = init as RequestInit;
    expect(i.method).toBe('POST');
    expect((i.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
    expect((i.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
    expect(JSON.parse(i.body as string)).toEqual({
      code: 'AB12-CD34',
      phone: '14155551234',
    });
  });

  it('POSTs the paired notification with phone body', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await postPaired('https://cp', 'tok', '14155551234');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cp/api/instance/whatsapp/paired');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      phone: '14155551234',
    });
  });

  it('never throws on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await expect(
      postPairingCode('https://cp', 'tok', 'X', '1'),
    ).resolves.toBeUndefined();
    await expect(postPaired('https://cp', 'tok', '1')).resolves.toBeUndefined();
  });

  it('does not throw on non-200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 500 }),
    );
    await expect(
      postPairingCode('https://cp', 'tok', 'X', '1'),
    ).resolves.toBeUndefined();
  });
});

describe('runWhatsAppPairingBroker', () => {
  it('no-ops (returns false) when trigger conditions unmet', async () => {
    // no phone, no control plane
    const { runPairingSession } = await import('../whatsapp-pairing.js');
    const result = await runWhatsAppPairingBroker();
    expect(result).toBe(false);
    expect(runPairingSession).not.toHaveBeenCalled();
  });

  it('relays each pairing code and stops on auth, POSTing paired', async () => {
    vi.useFakeTimers();
    process.env.WHATSAPP_PAIRING_PHONE = '14155551234';
    cpMock.cfg = { url: 'https://cp', token: 'tok' };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const brokerPromise = runWhatsAppPairingBroker();

    // Let runPairingSession resolve and wire up onPairingCode.
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionMock.onPairingCode).toBeTypeOf('function');

    // Simulate the shared session emitting a pairing code → broker relays it.
    sessionMock.onPairingCode!('CODE-0001');
    await vi.advanceTimersByTimeAsync(0);
    const codeCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/pairing-code'),
    );
    expect(codeCall).toBeTruthy();
    expect(JSON.parse((codeCall![1] as RequestInit).body as string)).toEqual({
      code: 'CODE-0001',
      phone: '14155551234',
    });

    // Now authentication succeeds → broker should POST paired and return true.
    sessionMock.resolveDone!('authenticated');
    // flush the paired POST + resolution
    await vi.advanceTimersByTimeAsync(0);
    const result = await brokerPromise;

    expect(result).toBe(true);
    expect(sessionMock.close).toHaveBeenCalled();
    const pairedCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/paired'),
    );
    expect(pairedCall).toBeTruthy();
    expect(JSON.parse((pairedCall![1] as RequestInit).body as string)).toEqual({
      phone: '14155551234',
    });
  });

  it('returns false (no paired POST) when the session fails', async () => {
    vi.useFakeTimers();
    process.env.WHATSAPP_PAIRING_PHONE = '14155551234';
    cpMock.cfg = { url: 'https://cp', token: 'tok' };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const brokerPromise = runWhatsAppPairingBroker();
    await vi.advanceTimersByTimeAsync(0);

    sessionMock.resolveDone!({ failed: 401 });
    await vi.advanceTimersByTimeAsync(0);
    const result = await brokerPromise;

    expect(result).toBe(false);
    const pairedCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/paired'),
    );
    expect(pairedCall).toBeFalsy();
  });
});
