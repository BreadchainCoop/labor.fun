/**
 * Step: pop-org — connect this profile to a POP (Perpetual Organization
 * Protocol) org, and optionally deploy a brand-new one.
 *
 * POP IS OPTIONAL. An org that does not use it never runs this step, and
 * nothing else in setup depends on it.
 *
 * FOUR ACTIONS, SPLIT BY BLAST RADIUS. Deploying an org spends real gas and
 * publishes irreversibly, so the safe operations are deliberately separate
 * commands rather than flags on one:
 *
 *   check    read-only. Derives the org id, asks the chain whether it already
 *            exists, reports wallet readiness. No key, no writes, no network
 *            writes. Safe to run repeatedly.
 *   init     writes a starter deploy config to a local file. No key, no network.
 *   link     points this profile at an org that ALREADY exists on chain. Edits
 *            profile.config.json only — no key, no gas. This is the common path.
 *   deploy   the real thing: gas, and an irreversible public IPFS pin. Requires
 *            an explicit --confirm on top of --yes.
 *
 * ⚠️ `pop org deploy --dry-run` IS NOT SIDE-EFFECT-FREE. Verified in the CLI
 * source (src/commands/org/deploy.ts): `pinJson(metadata)` runs at line ~221,
 * unconditionally, while the dry-run check lives inside `executeTx` at line
 * ~452. The command's own header says "--dry-run fires ZERO transactions",
 * which is true of transactions and NOT true of side effects — a dry run still
 * publishes your org's description and links to public IPFS, permanently. That
 * is why `check` does its validation locally instead of shelling out to a dry
 * run, and why `deploy` says so out loud before it does anything.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { promisify } from 'util';

import { keccak256, toUtf8Bytes } from 'ethers';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

const execFileAsync = promisify(execFile);
const require_ = createRequire(import.meta.url);

export type PopOrgAction = 'check' | 'init' | 'link' | 'deploy';

/**
 * The org-name normalisation POP itself applies before hashing. Quoted from
 * src/commands/org/deploy.ts:
 *
 *   const normalizedName = config.orgName.toLowerCase().replace(/\s+/g, '-');
 */
export function normalizeOrgName(orgName: string): string {
  return String(orgName ?? '')
    .toLowerCase()
    .replace(/\s+/g, '-');
}

/**
 * Derive an org's on-chain id from its name, with no network call.
 *
 *   orgId = keccak256(utf8(normalizedName))
 *
 * Verified against the live chain: `Argus` derives to
 * 0x112de94b6e6cba0ccece7301df866a932711655946942d795f07334e3fd6f46b, which is
 * exactly the id the subgraph reports. That determinism is what lets `check`
 * answer "does this org already exist?" and `link` fill in the id without ever
 * needing a deploy to have happened first.
 */
export function deriveOrgId(orgName: string): string {
  return keccak256(toUtf8Bytes(normalizeOrgName(orgName)));
}

export interface PopOrgEntry {
  name: string;
  chainId: number;
  orgId: string;
}

/**
 * Merge a POP org into a profile config, returning a NEW object.
 *
 * PRESERVES `enabledPlugins`, and this is the whole reason the function exists.
 * The key being ABSENT means "gating off": every plugin in
 * `profiles/<org>/plugins/` auto-registers and the catalog stays dark. The
 * moment the key exists — even as `[]` — gating flips ON and only listed ids
 * register, from either source. So blindly writing `enabledPlugins: ['pop']`
 * would silently stop an org's own plugins from loading.
 *
 * We therefore append to whatever is already there. The one unavoidable
 * consequence: an org with NO `enabledPlugins` today gains the key, which turns
 * gating on. Any profile-dir plugins must come along, so we enumerate them and
 * include them — the caller passes what it found on disk.
 */
export function mergePopProfileConfig(
  existing: Record<string, unknown>,
  entry: PopOrgEntry,
  profilePluginIds: string[] = [],
): { config: Record<string, unknown>; gatingNewlyEnabled: boolean; addedPluginIds: string[] } {
  const config: Record<string, unknown> = { ...existing };

  const hadGating = Array.isArray(existing.enabledPlugins);
  const current = hadGating ? (existing.enabledPlugins as unknown[]).map(String) : [];
  // When gating was off, every profile-dir plugin was implicitly enabled;
  // carry them across so turning gating on does not disable them.
  const carried = hadGating ? [] : profilePluginIds;
  const next = [...new Set([...current, ...carried, 'pop'])];
  config.enabledPlugins = next;

  const pluginConfig: Record<string, unknown> = {
    ...((existing.pluginConfig as Record<string, unknown>) ?? {}),
  };
  const pop: Record<string, unknown> = {
    ...((pluginConfig.pop as Record<string, unknown>) ?? {}),
  };
  const orgs = Array.isArray(pop.orgs) ? (pop.orgs as PopOrgEntry[]) : [];
  // Idempotent: re-linking the same org on the same chain updates in place
  // rather than appending a duplicate.
  const idx = orgs.findIndex(
    (o) => normalizeOrgName(o?.name ?? '') === normalizeOrgName(entry.name) &&
      Number(o?.chainId) === Number(entry.chainId),
  );
  if (idx >= 0) orgs[idx] = { ...orgs[idx], ...entry };
  else orgs.push(entry);
  pop.orgs = orgs;
  pluginConfig.pop = pop;
  config.pluginConfig = pluginConfig;

  return {
    config,
    gatingNewlyEnabled: !hadGating,
    addedPluginIds: carried,
  };
}

/** Is this org already configured in the profile? */
export function findConfiguredOrg(
  config: Record<string, unknown>,
  orgName: string,
  chainId: number,
): PopOrgEntry | undefined {
  const pop = (config.pluginConfig as Record<string, unknown> | undefined)?.pop as
    | Record<string, unknown>
    | undefined;
  const orgs = Array.isArray(pop?.orgs) ? (pop!.orgs as PopOrgEntry[]) : [];
  return orgs.find(
    (o) =>
      normalizeOrgName(o?.name ?? '') === normalizeOrgName(orgName) &&
      Number(o?.chainId) === Number(chainId),
  );
}

/** Plugin ids discoverable in a profile's plugins dir (filename sans ext). */
export function listProfilePluginIds(profileDir: string): string[] {
  const dir = path.join(profileDir, 'plugins');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(mjs|cjs|js)$/.test(f))
      .filter((f) => {
        try {
          return fs.statSync(path.join(dir, f)).isFile();
        } catch {
          return false;
        }
      })
      .map((f) => f.replace(/\.(mjs|cjs|js)$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/** Absolute path to the `pop` binary, or null when @poa-box/cli is absent. */
export function resolvePopBin(): string | null {
  try {
    const pkgPath = require_.resolve('@poa-box/cli/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pop;
    if (!rel) return null;
    const full = path.join(path.dirname(pkgPath), rel);
    return fs.existsSync(full) ? full : null;
  } catch {
    return null;
  }
}

/**
 * Run `pop` READ-ONLY. `POP_READONLY=1` makes signing and IPFS pinning
 * structurally impossible inside the CLI, so nothing this helper runs can
 * broadcast or publish — regardless of what is in the environment.
 *
 * The env is built explicitly rather than inherited: POP's own loader reads
 * `./.env` from cwd at highest precedence, so inheriting would pull labor.fun's
 * entire .env into the child.
 */
async function popRead(
  args: string[],
  opts: { chainId?: number; agentHome: string },
): Promise<{ ok: boolean; json: unknown; error: string | null }> {
  const bin = resolvePopBin();
  if (!bin) return { ok: false, json: null, error: '@poa-box/cli is not installed' };
  const env: Record<string, string> = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: opts.agentHome,
    POP_AGENT_HOME: opts.agentHome,
    POP_READONLY: '1',
  };
  if (opts.chainId != null) env.POP_DEFAULT_CHAIN = String(opts.chainId);
  try {
    const { stdout } = await execFileAsync(process.execPath, [bin, ...args, '--json'], {
      env,
      cwd: opts.agentHome,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, json: stdout.trim() ? JSON.parse(stdout) : null, error: null };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    let msg = (e.stderr || e.message || 'pop failed').trim();
    try {
      const parsed = JSON.parse(e.stderr ?? '');
      if (parsed?.message) msg = parsed.message;
    } catch {
      /* not structured */
    }
    return { ok: false, json: null, error: msg.slice(0, 300) };
  }
}

/** Look the org up on chain by its derived id. Read-only. */
export async function lookupOrgOnChain(
  orgName: string,
  chainId: number,
  agentHome: string,
): Promise<{ exists: boolean; error: string | null; orgId: string }> {
  const orgId = deriveOrgId(orgName);
  const res = await popRead(['org', 'list'], { chainId, agentHome });
  if (!res.ok) return { exists: false, error: res.error, orgId };
  const rows = Array.isArray(res.json) ? (res.json as Array<Record<string, unknown>>) : [];
  // `org list --json` abbreviates the id ("0xa71879ef...6befd069"), so compare
  // on the head and tail rather than the whole string.
  const exists = rows.some((r) => {
    const shown = String(r.Name ?? '');
    if (normalizeOrgName(shown) === normalizeOrgName(orgName)) return true;
    const id = String(r['Org ID'] ?? '');
    const [head, tail] = id.split('...');
    return Boolean(head && tail && orgId.startsWith(head) && orgId.endsWith(tail));
  });
  return { exists, error: null, orgId };
}

// ---------------------------------------------------------------------------

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function resolveProfileDir(): string {
  const explicit = process.env.LABOR_PROFILE;
  const root = process.cwd();
  if (explicit) return path.join(root, 'profiles', explicit);
  // Single profile present (excluding the reserved template) → that one.
  try {
    const names = fs
      .readdirSync(path.join(root, 'profiles'))
      .filter((n) => n !== 'example')
      .filter((n) => fs.existsSync(path.join(root, 'profiles', n, 'profile.config.json')));
    if (names.length === 1) return path.join(root, 'profiles', names[0]);
  } catch {
    /* fall through */
  }
  return root;
}

/** Read + write profile.config.json, preserving formatting conventions. */
function readProfileConfig(profileDir: string): Record<string, unknown> {
  const p = path.join(profileDir, 'profile.config.json');
  if (!fs.existsSync(p)) throw new Error(`no profile.config.json at ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeProfileConfig(profileDir: string, config: Record<string, unknown>): void {
  const p = path.join(profileDir, 'profile.config.json');
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

export async function run(args: string[]): Promise<void> {
  const action = (args.find((a) => !a.startsWith('--')) ?? 'check') as PopOrgAction;
  const profileDir = resolveProfileDir();
  const agentHome = path.join(profileDir, 'store', 'pop');
  fs.mkdirSync(agentHome, { recursive: true });

  const config = readProfileConfig(profileDir);
  const orgName = arg(args, '--org') ?? String(config.orgName ?? '');
  const chainId = Number(arg(args, '--chain') ?? 100);

  if (!orgName) {
    logger.error('pop-org: no --org given and profile.config.json has no orgName');
    emitStatus('POP-ORG', {
        OK: 'false', REASON: 'missing-org-name' });
    process.exitCode = 1;
    return;
  }

  const orgId = deriveOrgId(orgName);

  if (!resolvePopBin()) {
    logger.error('pop-org: @poa-box/cli is not installed — run npm install first');
    emitStatus('POP-ORG', {
        OK: 'false', REASON: 'cli-missing' });
    process.exitCode = 1;
    return;
  }

  switch (action) {
    case 'check': {
      const { exists, error } = await lookupOrgOnChain(orgName, chainId, agentHome);
      const configured = findConfiguredOrg(config, orgName, chainId);
      logger.info(
        { orgName, chainId, orgId, existsOnChain: exists, chainError: error, configured: !!configured },
        'pop-org: check',
      );
      console.log(`Org name        : ${orgName}`);
      console.log(`Chain           : ${chainId}`);
      console.log(`Derived org id  : ${orgId}`);
      console.log(`Exists on chain : ${error ? `unknown (${error})` : exists ? 'yes' : 'no'}`);
      console.log(`In profile      : ${configured ? 'yes' : 'no'}`);
      console.log('');
      if (exists && !configured) console.log('Next: npm run setup -- --step pop-org link');
      else if (!exists && !error) console.log('Next: npm run setup -- --step pop-org init   (then deploy)');
      else if (configured) console.log('Nothing to do — this profile is already linked.');
      emitStatus('POP-ORG', {
        OK: 'true',
        ACTION: 'check',
        ORG_ID: orgId,
        EXISTS_ON_CHAIN: error ? 'unknown' : String(exists),
        CONFIGURED: String(!!configured),
      });
      return;
    }

    case 'init': {
      const out = arg(args, '--output') ?? path.join(profileDir, 'pop-org-deploy.json');
      const username = arg(args, '--username') ?? normalizeOrgName(orgName);
      const bin = resolvePopBin()!;
      // deploy-config is a pure local file write — verified: no signer, no
      // network, runs with an empty environment.
      await execFileAsync(
        process.execPath,
        [bin, 'org', 'deploy-config', '--name', orgName, '--username', username, '--output', out, '--json'],
        { env: { PATH: process.env.PATH || '', HOME: agentHome }, cwd: profileDir, timeout: 60_000 },
      );
      logger.info({ out, orgName }, 'pop-org: wrote a starter deploy config');
      console.log(`Wrote ${out}`);
      console.log('Edit it (roles, voting classes, links), then:');
      console.log('  npm run setup -- --step pop-org deploy --confirm');
      emitStatus('POP-ORG', {
        OK: 'true', ACTION: 'init', CONFIG_PATH: out });
      return;
    }

    case 'link': {
      const { exists, error } = await lookupOrgOnChain(orgName, chainId, agentHome);
      if (error) {
        logger.error({ error }, 'pop-org: could not reach the chain to verify the org');
        emitStatus('POP-ORG', {
        OK: 'false', REASON: 'chain-unreachable' });
        process.exitCode = 1;
        return;
      }
      if (!exists) {
        logger.error(
          { orgName, chainId, orgId },
          'pop-org: that org does not exist on chain — deploy it first, or check the name/chain',
        );
        emitStatus('POP-ORG', {
        OK: 'false', REASON: 'org-not-found' });
        process.exitCode = 1;
        return;
      }
      const pluginIds = listProfilePluginIds(profileDir);
      const merged = mergePopProfileConfig(config, { name: orgName, chainId, orgId }, pluginIds);
      writeProfileConfig(profileDir, merged.config);
      logger.info({ orgName, chainId, orgId }, 'pop-org: linked profile to the on-chain org');
      console.log(`Linked ${orgName} (chain ${chainId}) — org id ${orgId}`);
      if (merged.gatingNewlyEnabled) {
        console.log('');
        console.log('NOTE: enabledPlugins did not exist before, so plugin gating is now ON.');
        console.log(
          merged.addedPluginIds.length
            ? `      Carried your existing profile plugins across: ${merged.addedPluginIds.join(', ')}`
            : '      No profile-dir plugins were found to carry across.',
        );
      }
      emitStatus('POP-ORG', {
        OK: 'true', ACTION: 'link', ORG_ID: orgId });
      return;
    }

    case 'deploy': {
      const confirmed = args.includes('--confirm');
      const cfgPath = arg(args, '--config') ?? path.join(profileDir, 'pop-org-deploy.json');

      if (!confirmed) {
        console.log('Refusing to deploy without --confirm.');
        console.log('');
        console.log('`pop org deploy` is IRREVERSIBLE and costs real gas:');
        console.log('  • it broadcasts a ~15,000,000-gas transaction from POP_PRIVATE_KEY');
        console.log('  • it pins your org description and links to PUBLIC IPFS, permanently');
        console.log('  • even `--dry-run` performs that IPFS pin (the pin runs before the');
        console.log('    dry-run check in the CLI), so there is no way to rehearse it privately');
        console.log('');
        console.log(`Config : ${cfgPath}`);
        console.log(`Org id : ${orgId}  (derived from "${orgName}")`);
        console.log('');
        console.log('Re-run with --confirm when you mean it.');
        emitStatus('POP-ORG', {
        OK: 'false', REASON: 'needs-confirm' });
        process.exitCode = 1;
        return;
      }

      if (!fs.existsSync(cfgPath)) {
        logger.error({ cfgPath }, 'pop-org: no deploy config — run `--step pop-org init` first');
        emitStatus('POP-ORG', {
        OK: 'false', REASON: 'config-missing' });
        process.exitCode = 1;
        return;
      }

      // Idempotency guard 1: already in this profile.
      if (findConfiguredOrg(config, orgName, chainId)) {
        logger.error({ orgName, chainId }, 'pop-org: this profile already has that org configured');
        emitStatus('POP-ORG', {
        OK: 'false', REASON: 'already-configured' });
        process.exitCode = 1;
        return;
      }
      // Idempotency guard 2: already on chain. orgId is keccak256 of the name,
      // so a second deploy under the same name cannot produce a second org —
      // it would revert after spending gas and pinning.
      const { exists, error } = await lookupOrgOnChain(orgName, chainId, agentHome);
      if (error) {
        logger.error({ error }, 'pop-org: cannot verify the org does not already exist — refusing');
        emitStatus('POP-ORG', {
        OK: 'false', REASON: 'chain-unreachable' });
        process.exitCode = 1;
        return;
      }
      if (exists) {
        logger.error(
          { orgName, chainId, orgId },
          'pop-org: an org with that id already exists on chain — use `link`, not `deploy`',
        );
        emitStatus('POP-ORG', {
        OK: 'false', REASON: 'org-exists' });
        process.exitCode = 1;
        return;
      }

      const key = process.env.POP_PRIVATE_KEY;
      if (!key) {
        logger.error('pop-org: POP_PRIVATE_KEY is not set (env/vault only, never config)');
        emitStatus('POP-ORG', {
        OK: 'false', REASON: 'no-key' });
        process.exitCode = 1;
        return;
      }

      const bin = resolvePopBin()!;
      logger.info({ orgName, chainId, cfgPath }, 'pop-org: deploying — this spends gas');
      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          [bin, 'org', 'deploy', '--config', cfgPath, '--chain', String(chainId), '--yes', '--json'],
          {
            env: {
              PATH: process.env.PATH || '',
              HOME: agentHome,
              POP_AGENT_HOME: agentHome,
              POP_PRIVATE_KEY: key,
              POP_DEFAULT_CHAIN: String(chainId),
            },
            cwd: agentHome,
            timeout: 900_000,
            maxBuffer: 32 * 1024 * 1024,
          },
        );
        logger.info({ result: stdout.trim().slice(0, 500) }, 'pop-org: deploy returned');
        // Wire the profile to the org we just created. The id is derived, not
        // parsed out of the receipt, so this is correct even if the subgraph has
        // not indexed the deploy yet.
        const pluginIds = listProfilePluginIds(profileDir);
        const merged = mergePopProfileConfig(
          readProfileConfig(profileDir),
          { name: orgName, chainId, orgId },
          pluginIds,
        );
        writeProfileConfig(profileDir, merged.config);
        console.log(`Deployed and linked ${orgName} (chain ${chainId}) — org id ${orgId}`);
        console.log('The mirror will pick it up on its next tick (subgraph indexing may lag).');
        emitStatus('POP-ORG', {
        OK: 'true', ACTION: 'deploy', ORG_ID: orgId });
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        logger.error(
          { err: (e.stderr || e.message || '').slice(0, 500) },
          'pop-org: deploy failed — the profile was NOT modified',
        );
        emitStatus('POP-ORG', {
        OK: 'false', REASON: 'deploy-failed' });
        process.exitCode = 1;
      }
      return;
    }

    default:
      logger.error({ action }, 'pop-org: unknown action');
      console.log('Usage: npm run setup -- --step pop-org <check|init|link|deploy> [--org NAME] [--chain 100]');
      emitStatus('POP-ORG', {
        OK: 'false', REASON: 'unknown-action' });
      process.exitCode = 1;
  }
}
