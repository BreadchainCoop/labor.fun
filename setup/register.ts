/**
 * Step: register — Write channel registration config, create group folders.
 *
 * Accepts --channel to specify the messaging platform (whatsapp, telegram, slack, discord).
 * Uses parameterized SQL queries to prevent injection.
 */
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
} from '../src/config.ts';
import { initDatabase, setRegisteredGroup } from '../src/db.ts';
import { isValidGroupFolder } from '../src/group-folder.ts';
import { logger } from '../src/logger.ts';
import { emitStatus } from './status.ts';

interface RegisterArgs {
  jid: string;
  name: string;
  trigger: string;
  folder: string;
  channel: string;
  requiresTrigger: boolean;
  isMain: boolean;
  assistantName: string;
}

function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    jid: '',
    name: '',
    trigger: '',
    folder: '',
    channel: 'whatsapp', // backward-compat: pre-refactor installs omit --channel
    requiresTrigger: true,
    isMain: false,
    assistantName: '', // empty = not provided; falls back to the profile's name
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--jid':
        result.jid = args[++i] || '';
        break;
      case '--name':
        result.name = args[++i] || '';
        break;
      case '--trigger':
        result.trigger = args[++i] || '';
        break;
      case '--folder':
        result.folder = args[++i] || '';
        break;
      case '--channel':
        result.channel = (args[++i] || '').toLowerCase();
        break;
      case '--no-trigger-required':
        result.requiresTrigger = false;
        break;
      case '--is-main':
        result.isMain = true;
        break;
      case '--assistant-name':
        result.assistantName = args[++i] || '';
        break;
    }
  }

  return result;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  if (!parsed.jid || !parsed.name || !parsed.trigger || !parsed.folder) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!isValidGroupFolder(parsed.folder)) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'invalid_folder',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  // The name used for {{ASSISTANT_NAME}} substitution: an explicit
  // --assistant-name override, else the active profile's configured name.
  const effectiveName = parsed.assistantName || ASSISTANT_NAME;

  logger.info(parsed, 'Registering channel');

  // Ensure data and store directories exist (store/ may not exist on
  // fresh installs that skip WhatsApp auth, which normally creates it).
  // These resolve under the active profile (profiles/<name>/) via config.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(STORE_DIR, { recursive: true });

  // Initialize database (creates schema + runs migrations)
  initDatabase();

  setRegisteredGroup(parsed.jid, {
    name: parsed.name,
    folder: parsed.folder,
    trigger: parsed.trigger,
    added_at: new Date().toISOString(),
    requiresTrigger: parsed.requiresTrigger,
    isMain: parsed.isMain,
  });

  logger.info('Wrote registration to SQLite');

  // Create group folders under the active profile (profiles/<name>/groups/).
  fs.mkdirSync(path.join(GROUPS_DIR, parsed.folder, 'logs'), {
    recursive: true,
  });

  // Create CLAUDE.md in the new group folder from template if it doesn't exist.
  // The agent runs with CWD=/workspace/group and loads CLAUDE.md from there.
  // Never overwrite an existing CLAUDE.md — users customize these extensively
  // (persona, workspace structure, communication rules, family context, etc.)
  // and a stock template replacement would destroy that work.
  const groupClaudeMdPath = path.join(GROUPS_DIR, parsed.folder, 'CLAUDE.md');
  if (!fs.existsSync(groupClaudeMdPath)) {
    const templatePath = parsed.isMain
      ? path.join(GROUPS_DIR, 'main', 'CLAUDE.md')
      : path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
    if (fs.existsSync(templatePath)) {
      // Substitute the {{ASSISTANT_NAME}} token so templates brand themselves.
      const content = fs
        .readFileSync(templatePath, 'utf-8')
        .replaceAll('{{ASSISTANT_NAME}}', effectiveName);
      fs.writeFileSync(groupClaudeMdPath, content);
      logger.info(
        { file: groupClaudeMdPath, template: templatePath },
        'Created CLAUDE.md from template',
      );
    }
  }

  // Substitute the assistant-name token across all group CLAUDE.md files so
  // template-based profiles brand themselves. Idempotent (a no-op once tokens
  // are already substituted).
  let nameUpdated = false;
  {
    const mdFiles = fs
      .readdirSync(GROUPS_DIR)
      .map((d) => path.join(GROUPS_DIR, d, 'CLAUDE.md'))
      .filter((f) => fs.existsSync(f));

    for (const mdFile of mdFiles) {
      const content = fs.readFileSync(mdFile, 'utf-8');
      if (content.includes('{{ASSISTANT_NAME}}')) {
        fs.writeFileSync(
          mdFile,
          content.replaceAll('{{ASSISTANT_NAME}}', effectiveName),
        );
        nameUpdated = true;
        logger.info(
          { file: mdFile },
          'Substituted assistant name in CLAUDE.md',
        );
      }
    }

    // Persist an explicit --assistant-name override to .env so it survives
    // restarts. When no override was given we leave .env alone — the profile's
    // assistantName is the source of truth.
    if (parsed.assistantName) {
      const envFile = path.join(projectRoot, '.env');
      if (fs.existsSync(envFile)) {
        let envContent = fs.readFileSync(envFile, 'utf-8');
        if (envContent.includes('ASSISTANT_NAME=')) {
          envContent = envContent.replace(
            /^ASSISTANT_NAME=.*$/m,
            `ASSISTANT_NAME="${parsed.assistantName}"`,
          );
        } else {
          envContent += `\nASSISTANT_NAME="${parsed.assistantName}"`;
        }
        fs.writeFileSync(envFile, envContent);
      } else {
        fs.writeFileSync(envFile, `ASSISTANT_NAME="${parsed.assistantName}"\n`);
      }
      logger.info('Set ASSISTANT_NAME in .env');
      nameUpdated = true;
    }
  }

  emitStatus('REGISTER_CHANNEL', {
    JID: parsed.jid,
    NAME: parsed.name,
    FOLDER: parsed.folder,
    CHANNEL: parsed.channel,
    TRIGGER: parsed.trigger,
    REQUIRES_TRIGGER: parsed.requiresTrigger,
    ASSISTANT_NAME: effectiveName,
    NAME_UPDATED: nameUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
