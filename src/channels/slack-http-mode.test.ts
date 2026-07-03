import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks (mirrors slack.test.ts; this file covers the SLACK_RECEIVER_MODE
// switch — socket-mode behavior itself is covered by slack.test.ts) ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
  logReaction: vi.fn(),
  storeOutboundMessage: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  appOpts: null as any,
  receiverOpts: null as any,
}));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    client = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT_123' }) },
      chat: { postMessage: vi.fn().mockResolvedValue(undefined) },
      conversations: {
        list: vi
          .fn()
          .mockResolvedValue({ channels: [], response_metadata: {} }),
      },
      users: { info: vi.fn().mockResolvedValue({ user: { name: 'alice' } }) },
    };

    constructor(opts: any) {
      mocks.appOpts = opts;
    }

    event() {}
    async start() {}
    async stop() {}
  },
  LogLevel: { ERROR: 'error' },
}));

// The receiver starts a real HTTP server; mock it so constructing the channel
// in http mode stays side-effect free.
vi.mock('./slack-http-receiver.js', () => ({
  SlackHttpReceiver: class MockReceiver {
    constructor(opts: any) {
      mocks.receiverOpts = opts;
    }

    init() {}
    async start() {}
    async stop() {}
  },
}));

const envRef = vi.hoisted(() => ({ vars: {} as Record<string, string> }));
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...envRef.vars })),
}));

import { SlackChannel, SlackChannelOpts } from './slack.js';
import { registerChannel } from './registry.js';
import { logger } from '../logger.js';

// Capture the factory registered at import time, before beforeEach's
// clearAllMocks() wipes the mock's call record.
const slackFactory = vi.mocked(registerChannel).mock.calls[0][1];

function createTestOpts(): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

function setEnv(vars: Record<string, string>) {
  for (const key of Object.keys(envRef.vars)) delete envRef.vars[key];
  Object.assign(envRef.vars, vars);
}

describe('SlackChannel HTTP receiver mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appOpts = null;
    mocks.receiverOpts = null;
    setEnv({});
  });

  describe('construction', () => {
    it('builds an App with a custom receiver and no app token', () => {
      setEnv({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_RECEIVER_MODE: 'http',
        SLACK_INGRESS_SECRET: 'ingress-secret',
      });

      expect(() => new SlackChannel(createTestOpts())).not.toThrow();

      expect(mocks.appOpts.token).toBe('xoxb-test-token');
      expect(mocks.appOpts.receiver).toBeDefined();
      expect(mocks.appOpts.appToken).toBeUndefined();
      expect(mocks.appOpts.socketMode).toBeUndefined();
    });

    it('does not require SLACK_APP_TOKEN in http mode', () => {
      setEnv({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_RECEIVER_MODE: 'http',
        SLACK_SIGNING_SECRET: 'signing-secret',
        // no SLACK_APP_TOKEN
      });

      expect(() => new SlackChannel(createTestOpts())).not.toThrow();
    });

    it('passes port, ingress secret, and signing secret to the receiver', () => {
      setEnv({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_RECEIVER_MODE: 'http',
        SLACK_HTTP_PORT: '4500',
        SLACK_INGRESS_SECRET: 'ingress-secret',
        SLACK_SIGNING_SECRET: 'signing-secret',
      });

      new SlackChannel(createTestOpts());

      expect(mocks.receiverOpts).toEqual({
        port: 4500,
        ingressSecret: 'ingress-secret',
        signingSecret: 'signing-secret',
      });
    });

    it('defaults the port to 3012', () => {
      setEnv({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_RECEIVER_MODE: 'http',
        SLACK_INGRESS_SECRET: 'ingress-secret',
      });

      new SlackChannel(createTestOpts());

      expect(mocks.receiverOpts.port).toBe(3012);
    });
  });

  describe('refuse-to-start cases', () => {
    it('throws when neither SLACK_INGRESS_SECRET nor SLACK_SIGNING_SECRET is set', () => {
      setEnv({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_APP_TOKEN: 'xapp-test-token', // present but irrelevant in http mode
        SLACK_RECEIVER_MODE: 'http',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        /SLACK_INGRESS_SECRET.*or SLACK_SIGNING_SECRET/s,
      );
      // Clear error log before the throw, per contract.
      expect(logger.error).toHaveBeenCalled();
    });

    it('throws when SLACK_BOT_TOKEN is missing in http mode', () => {
      setEnv({
        SLACK_RECEIVER_MODE: 'http',
        SLACK_INGRESS_SECRET: 'ingress-secret',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN must be set in .env',
      );
    });
  });

  describe('socket mode default is unchanged', () => {
    it('builds a socket-mode App when SLACK_RECEIVER_MODE is unset', () => {
      setEnv({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_APP_TOKEN: 'xapp-test-token',
      });

      new SlackChannel(createTestOpts());

      expect(mocks.appOpts.socketMode).toBe(true);
      expect(mocks.appOpts.appToken).toBe('xapp-test-token');
      expect(mocks.appOpts.receiver).toBeUndefined();
    });

    it('requires both tokens when SLACK_RECEIVER_MODE=socket explicitly', () => {
      setEnv({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_RECEIVER_MODE: 'socket',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });
  });

  describe('registerChannel factory gating', () => {
    function factory() {
      return slackFactory;
    }

    function factoryOpts() {
      return {
        ...createTestOpts(),
        registerGroup: vi.fn(),
        deregisterGroup: vi.fn(),
      };
    }

    it('creates the channel in http mode without an app token', () => {
      setEnv({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_RECEIVER_MODE: 'http',
        SLACK_INGRESS_SECRET: 'ingress-secret',
      });

      expect(factory()(factoryOpts())).toBeInstanceOf(SlackChannel);
    });

    it('returns null in http mode when no verification secret is set', () => {
      setEnv({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_RECEIVER_MODE: 'http',
      });

      expect(factory()(factoryOpts())).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('http mode'),
      );
    });

    it('returns null in http mode when SLACK_BOT_TOKEN is missing', () => {
      setEnv({
        SLACK_RECEIVER_MODE: 'http',
        SLACK_INGRESS_SECRET: 'ingress-secret',
      });

      expect(factory()(factoryOpts())).toBeNull();
    });

    it('still requires both tokens in socket mode', () => {
      setEnv({ SLACK_BOT_TOKEN: 'xoxb-test-token' });

      expect(factory()(factoryOpts())).toBeNull();
    });
  });
});
