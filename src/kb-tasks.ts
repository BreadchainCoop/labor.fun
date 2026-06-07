import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import type { ProposedTask } from './db.js';

export interface ApprovalOverrides {
  title?: string;
  assignee?: string;
  due_date?: string;
  escalation_contact?: string;
  approved_by: string;
}

/**
 * Scan a group's context/tasks/ directory and return the next unused TASK-NNN id.
 * Pads to 3 digits when next id is < 1000, otherwise grows naturally.
 */
function nextTaskId(tasksDir: string): string {
  let max = 0;
  if (fs.existsSync(tasksDir)) {
    for (const name of fs.readdirSync(tasksDir)) {
      const m = name.match(/^TASK-(\d+)\.md$/);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  const next = max + 1;
  return `TASK-${String(next).padStart(3, '0')}`;
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

function yamlList(items: string[]): string {
  if (items.length === 0) return '[]';
  return `[${items.join(', ')}]`;
}

function escapeYamlScalar(s: string): string {
  if (/[:#\n"'\\&*?{}\[\]|>%@`!,]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/**
 * Write a TASK-NNN.md file derived from an approved ProposedTask.
 * Returns the assigned TASK-NNN id.
 */
export function writeApprovedTaskFile(
  proposed: ProposedTask,
  overrides: ApprovalOverrides,
): string {
  const tasksDir = path.join(
    GROUPS_DIR,
    proposed.group_folder,
    'context',
    'tasks',
  );
  fs.mkdirSync(tasksDir, { recursive: true });

  const taskId = nextTaskId(tasksDir);
  const rawTitle = overrides.title || proposed.title;
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  const assignee = overrides.assignee || proposed.proposed_assignee || '';
  const dueDate = overrides.due_date || proposed.proposed_due_date || '';
  const today = todayISODate();
  const owners = assignee ? [assignee] : [];

  const description = proposed.description?.trim()
    ? proposed.description.trim()
    : 'Action item from meeting transcript.';
  const sourceQuoteSection = proposed.source_quote
    ? `\n## Source\n\n> ${proposed.source_quote.replace(/\n/g, '\n> ')}\n\n_From meeting summary ${proposed.summary_id}._\n`
    : `\n_From meeting summary ${proposed.summary_id}._\n`;

  const dueLine = dueDate ? `\n**Due**: ${dueDate}\n` : '';

  const frontmatter = [
    '---',
    `title: ${escapeYamlScalar(title)}`,
    `id: ${taskId}`,
    'status: open',
    'priority: medium',
    `created_by: ${escapeYamlScalar(overrides.approved_by)}`,
    `created_at: ${today}`,
    `last_edited: ${today}`,
    `owners: ${yamlList(owners.map(escapeYamlScalar))}`,
    // Machine-readable deadline consumed by the reminder engine (#25). Empty
    // when no due date is known. `escalation_contact` is who gets looped in at
    // the final tick / when overdue; blank falls back to the engine default.
    `deadline: ${dueDate ? escapeYamlScalar(dueDate) : ''}`,
    `escalation_contact: ${overrides.escalation_contact ? escapeYamlScalar(overrides.escalation_contact) : ''}`,
    'stakeholders: []',
    'upstream: []',
    'downstream: []',
    'linked_events: []',
    `tags: ${yamlList(['transcript', proposed.summary_id].map(escapeYamlScalar))}`,
    'visibility: open',
    'editable_by: open',
    '---',
  ].join('\n');

  const body = [
    '',
    `# ${title}`,
    '',
    '## Description',
    '',
    description,
    dueLine,
    sourceQuoteSection,
    '## Checklist',
    '',
    '- [ ] Pending approved task — refine subtasks as needed',
    '',
    '## Dependencies',
    '',
    'None.',
    '',
    '## Comments',
    '',
    '| Date | User | Comment |',
    '|------|------|---------|',
    `| ${today} | ${overrides.approved_by} | Approved from meeting transcript (proposed task ${proposed.id}). |`,
    '',
  ].join('\n');

  const filePath = path.join(tasksDir, `${taskId}.md`);
  fs.writeFileSync(filePath, `${frontmatter}\n${body}`);

  logger.info(
    {
      taskId,
      proposedId: proposed.id,
      group: proposed.group_folder,
      filePath,
    },
    'Wrote approved task file from transcript',
  );

  return taskId;
}
