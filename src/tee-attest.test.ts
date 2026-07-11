import crypto from 'crypto';

import { describe, it, expect } from 'vitest';

import {
  attestNonce,
  formatAttestationReply,
  isValidNonce,
  parseVerifyCommand,
  reportDataForNonce,
  type DstackClient,
} from './tee-attest.js';

/** A stub dstack client: presence + canned Info/Quote, or a throwing call. */
function stubClient(opts: {
  present: boolean;
  info?: Record<string, unknown>;
  quote?: Record<string, unknown>;
  throwOn?: 'info' | 'quote';
}): Pick<DstackClient, 'socketPresent' | 'getInfo' | 'getQuote'> {
  return {
    socketPresent: () => opts.present,
    getInfo: async () => {
      if (opts.throwOn === 'info') throw new Error('info boom');
      return (opts.info ?? {}) as never;
    },
    getQuote: async () => {
      if (opts.throwOn === 'quote') throw new Error('quote boom');
      return (opts.quote ?? { quote: '' }) as never;
    },
  };
}

describe('parseVerifyCommand', () => {
  it('returns ok with the nonce for a valid command', () => {
    expect(parseVerifyCommand('!verify abc12345')).toEqual({
      kind: 'ok',
      nonce: 'abc12345',
    });
    expect(parseVerifyCommand('  !verify  my-Nonce_123  ')).toEqual({
      kind: 'ok',
      nonce: 'my-Nonce_123',
    });
  });

  it('returns missing when no nonce is given', () => {
    expect(parseVerifyCommand('!verify')).toEqual({ kind: 'missing' });
    expect(parseVerifyCommand('!verify   ')).toEqual({ kind: 'missing' });
  });

  it('returns invalid for a malformed nonce', () => {
    expect(parseVerifyCommand('!verify short')).toEqual({
      kind: 'invalid',
      arg: 'short',
    });
    expect(parseVerifyCommand('!verify has spaces here')).toEqual({
      kind: 'invalid',
      arg: 'has spaces here',
    });
    expect(parseVerifyCommand('!verify bad$chars!!')).toEqual({
      kind: 'invalid',
      arg: 'bad$chars!!',
    });
  });

  it('returns null for non-verify messages', () => {
    expect(parseVerifyCommand('hello')).toBeNull();
    expect(parseVerifyCommand('!verifysomething')).toBeNull();
    expect(parseVerifyCommand('please !verify abc')).toBeNull();
  });
});

describe('isValidNonce', () => {
  it('accepts 8-64 url-safe chars', () => {
    expect(isValidNonce('abcd1234')).toBe(true); // 8
    expect(isValidNonce('a'.repeat(64))).toBe(true); // 64
    expect(isValidNonce('A_z-0_9')).toBe(false); // 7, too short
    expect(isValidNonce('a'.repeat(65))).toBe(false); // too long
    expect(isValidNonce('has space')).toBe(false);
    expect(isValidNonce('nope!')).toBe(false);
  });
});

describe('reportDataForNonce', () => {
  it('embeds a short nonce verbatim', () => {
    const nonce = 'my-nonce-123';
    const { bytes, hashed } = reportDataForNonce(nonce);
    expect(hashed).toBe(false);
    expect(bytes.toString('utf8')).toBe(nonce);
  });

  it('SHA-512/256-hashes an over-64-byte value', () => {
    const long = 'x'.repeat(100);
    const { bytes, hashed } = reportDataForNonce(long);
    expect(hashed).toBe(true);
    expect(bytes.length).toBe(32);
    const expected = crypto.createHash('sha512-256').update(long).digest();
    expect(bytes.equals(expected)).toBe(true);
  });
});

describe('attestNonce', () => {
  it('reports not-in-TEE when the socket is absent', async () => {
    const client = stubClient({ present: false });
    const r = await attestNonce('abc12345', { client });
    expect(r.inTee).toBe(false);
    expect(r.quote).toBeUndefined();
    expect(r.nonce).toBe('abc12345');
  });

  it('returns a full attestation when the socket is present', async () => {
    const client = stubClient({
      present: true,
      info: { app_id: 'app-1', instance_id: 'inst-1', compose_hash: 'deadbeef' },
      quote: { quote: 'abcdef0123456789' },
    });
    const r = await attestNonce('my-nonce-123', {
      client,
      verifyUrl: 'https://proof.example',
    });
    expect(r.inTee).toBe(true);
    expect(r.quote).toBe('abcdef0123456789');
    expect(r.appId).toBe('app-1');
    expect(r.instanceId).toBe('inst-1');
    expect(r.composeHash).toBe('deadbeef');
    expect(r.wasHashed).toBe(false);
    // report_data hex is the nonce encoded as UTF-8 hex.
    expect(r.reportDataHex).toBe(
      Buffer.from('my-nonce-123', 'utf8').toString('hex'),
    );
    expect(r.verifyUrl).toBe('https://proof.example');
    expect(r.error).toBeUndefined();
  });

  it('captures a dstack failure without throwing (degraded, still in TEE)', async () => {
    const client = stubClient({ present: true, throwOn: 'quote' });
    const r = await attestNonce('abc12345', { client });
    expect(r.inTee).toBe(true);
    expect(r.error).toContain('quote boom');
    expect(r.quote).toBeUndefined();
  });
});

describe('formatAttestationReply', () => {
  it('renders the non-TEE fallback honestly', () => {
    const out = formatAttestationReply({
      inTee: false,
      nonce: 'abc12345',
      verifyUrl: 'https://proof.phala.network',
    });
    expect(out).toContain('NOT RUNNING IN A TEE');
    expect(out).not.toContain('TDX quote');
  });

  it('renders a full attestation with nonce, quote, and verify steps', () => {
    const out = formatAttestationReply({
      inTee: true,
      nonce: 'my-nonce-123',
      reportDataHex: '6d792d6e6f6e63652d313233',
      wasHashed: false,
      quote: 'a'.repeat(200),
      composeHash: 'deadbeef',
      appId: 'app-1',
      instanceId: 'inst-1',
      verifyUrl: 'https://proof.phala.network',
    });
    expect(out).toContain('TEE Attestation');
    expect(out).toContain('my-nonce-123');
    expect(out).toContain('6d792d6e6f6e63652d313233');
    expect(out).toContain('deadbeef');
    expect(out).toContain('app-1');
    expect(out).toContain('TDX quote');
    expect(out).toContain('https://proof.phala.network');
    // Quote is chunked at 64 chars for readability.
    expect(out).toContain('a'.repeat(64) + '\n');
    // Not the hashed hint, since wasHashed is false.
    expect(out).toContain('xxd -p');
  });

  it('renders the SHA-512/256 hint when the nonce was hashed', () => {
    const out = formatAttestationReply({
      inTee: true,
      nonce: 'x'.repeat(100),
      reportDataHex: 'ab'.repeat(32),
      wasHashed: true,
      quote: 'ff',
      verifyUrl: 'https://proof.phala.network',
    });
    expect(out).toContain('sha512-256');
  });

  it('renders a degraded reply when the quote failed', () => {
    const out = formatAttestationReply({
      inTee: true,
      nonce: 'abc12345',
      reportDataHex: '6162633132333435',
      error: 'quote boom',
      verifyUrl: 'https://proof.phala.network',
    });
    expect(out).toContain('Quote generation failed');
    expect(out).toContain('quote boom');
    expect(out).not.toContain('TDX quote (hex)');
  });
});
