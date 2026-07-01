import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * A "profile" is one organization's instance of labor.fun. The framework
 * (everything under src/, container/, kb-ui/, setup/) is org-agnostic; all
 * org-specific identity, knowledge, and runtime state lives in
 * `profiles/<name>/`:
 *
 *   profiles/<name>/profile.config.json   ← identity & config (this shape)
 *   profiles/<name>/groups/               ← per-group memory + KB context
 *   profiles/<name>/store/                ← SQLite DB (gitignored)
 *   profiles/<name>/data/                 ← sessions + IPC (gitignored)
 *   profiles/<name>/container-skills/     ← optional org-specific agent skills
 *   profiles/<name>/plugins/              ← optional org-specific plugins
 *
 * The active profile is chosen at startup (see resolveProfileDir): explicit
 * `LABOR_PROFILE`, else the single non-example profile present, else the repo
 * root itself (legacy/test layout with groups/ store/ data/ at the root).
 */
export interface ProfileConfig {
  /** Display name the agent answers to (e.g. "Breadbrich Engels"). */
  assistantName: string;
  /** Canonical organization name (e.g. "Bread Cooperative"). */
  orgName: string;
  /** Short/brand name used in casual references. */
  orgShortName?: string;
  /** Public org website. */
  orgWebsite?: string;
  /** GitHub org/login the agent operates on (e.g. "BreadchainCoop"). */
  githubOrg?: string;
  /** Default repo for self-deploy / ops references. */
  githubRepo?: string;
  /** KB dashboard URL, if exposed. */
  kbDashboardUrl?: string;
  /**
   * Group folder whose `context/` directory is the canonical shared KB,
   * mounted read-only into every container at /workspace/shared-kb.
   */
  sharedKbGroup: string;
  /** OS user that owns KB files in production (for chown on write). */
  serviceUser?: string;
  /** Telegram bot @username, used in identity/registration docs. */
  telegramBotUsername?: string;
  /** IANA timezone for scheduling/formatting. */
  timezone?: string;
  /**
   * Where to escalate things the agent can't do from its container (deploy /
   * infra changes, framework feature requests, cross-system coordination).
   * Identity-agnostic — set per org instead of hardcoding admin names in
   * CLAUDE.md. `escalationContact` is a KB person slug to tag/loop in;
   * `escalationChannel` is a registered chat JID to post the summary to.
   * See `rules/escalation.md`. Either may be empty (escalation then degrades
   * to "tell the user it needs a human with deploy access").
   */
  escalationContact?: string;
  escalationChannel?: string;
  /**
   * Container skills to enable for this org that ship disabled by default.
   * A skill declares itself opt-in with `default: false` in its SKILL.md
   * frontmatter; such skills are only synced into this org's containers when
   * their folder name is listed here (or in the `ENABLED_SKILLS` env var).
   * Skills without that flag always load and need not be listed.
   * See container-runner.ts (skill sync) and docs/PLUGINS.md.
   */
  enabledSkills?: string[];
  /**
   * On-chain reimbursement via a Safe{Wallet} multisig (issue #108). Absent →
   * the safe-payouts integration stays dormant (no-op). Org-agnostic: the
   * concrete Safe/token addresses live here, never in `src/`. The proposer
   * private key is NOT here — it comes from the env/vault (`SAFE_PROPOSER_KEY`)
   * so it is never committed. The agent is a *proposer only*: it can propose a
   * transfer but can never confirm or execute — the Safe threshold is the
   * approval. See rules/finance/safe-payouts.md.
   */
  safe?: {
    /** EVM chain id (Gnosis Chain = 100). */
    chainId: number;
    /** The Safe multisig address (checksummed). */
    safeAddress: string;
    /** ERC-20 reimbursement token contract (e.g. BREAD), checksummed. */
    tokenAddress: string;
    /** Token symbol for human-facing mirrors (default "tokens"). */
    tokenSymbol?: string;
    /** Token decimals (default 18). */
    tokenDecimals?: number;
    /** JSON-RPC endpoint for the chain. */
    rpcUrl: string;
    /** Safe Transaction Service base URL (propose + confirmation reads). */
    txServiceUrl?: string;
    /** Safe{Wallet} UI base, used to build a "confirm in your wallet" link. */
    safeWalletBaseUrl?: string;
  };
}

const DEFAULTS: ProfileConfig = {
  assistantName: 'labor.fun',
  orgName: 'Your Organization',
  sharedKbGroup: 'slack_main',
};

/** Absolute path to the framework checkout (the labor.fun repo root). */
export const PROJECT_ROOT = process.cwd();

const PROFILES_ROOT = path.join(PROJECT_ROOT, 'profiles');

/** The `example` profile is a scaffold/template — never auto-selected. */
const RESERVED_PROFILE_NAMES = new Set(['example']);

function activeProfileName(): string | undefined {
  const fromEnv =
    process.env.LABOR_PROFILE ?? readEnvFile(['LABOR_PROFILE']).LABOR_PROFILE;
  return fromEnv?.trim() || undefined;
}

/**
 * Resolve the active profile directory.
 *
 * 1. `LABOR_PROFILE=<name>` → `profiles/<name>` (must exist).
 * 2. Exactly one `profiles/<name>/profile.config.json` (excluding `example`)
 *    → that profile.
 * 3. No `profiles/` dir, or none matched → the repo root itself. This keeps
 *    the legacy single-tenant layout (groups/ store/ data/ at the root)
 *    working for development and the existing test suite.
 */
export function resolveProfileDir(): string {
  const name = activeProfileName();
  if (name) {
    const dir = path.join(PROFILES_ROOT, name);
    if (!fs.existsSync(dir)) {
      throw new Error(
        `LABOR_PROFILE="${name}" set but ${dir} does not exist. ` +
          `Create profiles/${name}/ or unset LABOR_PROFILE.`,
      );
    }
    // An explicitly-selected profile with no config is almost always a
    // misconfiguration — warn rather than silently fall back to defaults.
    if (!fs.existsSync(path.join(dir, 'profile.config.json'))) {
      logger.warn(
        { profile: name, dir },
        'LABOR_PROFILE is set but profile.config.json is missing — ' +
          'using framework defaults (assistant name, org, etc.)',
      );
    }
    return dir;
  }

  if (fs.existsSync(PROFILES_ROOT)) {
    const candidates = fs.readdirSync(PROFILES_ROOT).filter((entry) => {
      if (entry.startsWith('.') || RESERVED_PROFILE_NAMES.has(entry)) {
        return false;
      }
      return fs.existsSync(
        path.join(PROFILES_ROOT, entry, 'profile.config.json'),
      );
    });
    if (candidates.length === 1) {
      return path.join(PROFILES_ROOT, candidates[0]);
    }
    if (candidates.length > 1) {
      throw new Error(
        `Multiple profiles found (${candidates.join(', ')}). ` +
          `Set LABOR_PROFILE=<name> to choose one.`,
      );
    }
  }

  // Legacy / test fallback: the repo root is the profile.
  return PROJECT_ROOT;
}

/** Load and validate a profile's config, filling in framework defaults. */
export function loadProfileConfig(dir: string): ProfileConfig {
  const file = path.join(dir, 'profile.config.json');
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    // Missing file is the expected legacy/dev/test case → quiet defaults.
    // Any other read error (permissions, etc.) is surfaced, not swallowed.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug(
        { file },
        'No profile.config.json — using framework defaults',
      );
      return { ...DEFAULTS };
    }
    throw err;
  }
  // A present-but-malformed config must fail loudly rather than silently
  // starting the app with the wrong identity/config.
  let raw: Partial<ProfileConfig>;
  try {
    raw = JSON.parse(contents) as Partial<ProfileConfig>;
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${file}: ${(err as Error).message}. ` +
        `Fix the file or remove it to use framework defaults.`,
    );
  }
  return { ...DEFAULTS, ...raw };
}
