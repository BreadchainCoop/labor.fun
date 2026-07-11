/**
 * Skill shim for the local-LLM backend.
 *
 * Claude Code reads ~/.claude/skills/<name>/SKILL.md natively. Local OpenAI-compatible
 * models don't, so we walk the same directory, extract each skill's name +
 * description from frontmatter, and produce a markdown block to inject into
 * the system prompt. The model becomes aware that capabilities exist; the
 * underlying tools (where they're MCP-backed) remain reachable via the bridge.
 *
 * v1: prompt-context only. Skills that wrap CLI binaries (e.g. agent-browser)
 * are NOT exposed as callable tools — that's a follow-up.
 */

import fs from 'fs';
import path from 'path';

import { log } from '../runtime.js';

const SKILLS_DIR = '/home/node/.claude/skills';

interface ParsedSkill {
  name: string;
  description: string;
}

function parseFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = content.slice(3, end).trim();
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (key) out[key] = val;
  }
  return out;
}

function loadSkills(): ParsedSkill[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    return [];
  }

  const skills: ParsedSkill[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR)) {
    const skillFile = path.join(SKILLS_DIR, entry, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    try {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const fm = parseFrontmatter(content);
      if (!fm) continue;
      const name = fm.name || entry;
      const description = fm.description || '';
      if (description) {
        skills.push({ name, description });
      }
    } catch (err) {
      log(
        `[skill-shim] Failed to read ${skillFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return skills;
}

/**
 * Build a markdown block listing available skills, suitable for appending to
 * the system prompt. Returns an empty string when no skills are found.
 */
export function buildSkillsContext(): string {
  const skills = loadSkills();
  if (skills.length === 0) return '';

  const lines: string[] = ['## Available Capabilities', ''];
  for (const skill of skills) {
    lines.push(`- **${skill.name}**: ${skill.description}`);
  }
  lines.push('');
  lines.push(
    'These capabilities describe what the assistant can be asked to do. The full skill instructions are not loaded automatically in local-LLM mode — when a task aligns with a capability, follow the general intent described above and call the relevant MCP tools when available.',
  );
  lines.push('');
  return lines.join('\n');
}
