/**
 * faq-capture — the deterministic contract behind the living-FAQ skill.
 *
 * The `faq-capture` container skill (container/skills/faq-capture/SKILL.md)
 * turns a resolved chat question into a KB "FAQ card". The *behavior* (deciding
 * a question is worth capturing, drafting the answer) lives in the skill; this
 * module pins the two things that must be DETERMINISTIC so the feature is
 * idempotent and testable regardless of the agent's phrasing:
 *
 *   1. faqSlug(question)  — a stable slug derived from the normalized question,
 *      so the same question always maps to the same card path (update, never
 *      duplicate). This is the idempotency key.
 *   2. renderFaqCard(...) — the on-disk card (YAML frontmatter + markdown body)
 *      matching rules/knowledge-base/document-format.md.
 *
 * The card is written through the existing `modify_kb_file` IPC path (relative
 * to the KB context dir), gated — for orgs that opt in — by the reusable
 * approval primitive (action_class `kb_write`). Nothing here touches the DB or
 * the network; it's pure so both the orchestrator and tests can rely on it.
 */

import matter from 'gray-matter';

/** All FAQ cards live under this KB-relative directory. */
export const FAQ_DIR = 'artifacts/faq';

/** Where a "could-not-answer" knowledge-gap note is appended. */
export const FAQ_GAPS_PATH = `${FAQ_DIR}/_gaps.md`;

/**
 * Deterministic slug for a question. Lowercase, strip punctuation, collapse
 * whitespace to single hyphens, trim, and cap length. Two phrasings that
 * normalize identically collide by design (that's the idempotency).
 */
export function faqSlug(question: string): string {
  const slug = question
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop diacritics
    .toLowerCase()
    .replace(/['’"`]/g, '') // drop apostrophes/quotes so "don't" == "dont"
    .replace(/[^a-z0-9]+/g, '-') // everything else → hyphen
    .replace(/^-+|-+$/g, '') // trim hyphens
    .slice(0, 80)
    .replace(/-+$/g, ''); // re-trim if the slice landed on a hyphen
  return slug || 'faq';
}

/** KB-relative path for a question's card. Stable for a given question. */
export function faqCardPath(question: string): string {
  return `${FAQ_DIR}/${faqSlug(question)}.md`;
}

export interface FaqCardInput {
  question: string;
  answer: string;
  /** Who/where the answer came from (a person, a message, a doc). */
  source: string;
  /** Card author attribution (defaults to the assistant). */
  createdBy?: string;
  /** ISO date (YYYY-MM-DD). Defaults to today (UTC). */
  createdAt?: string;
  /** Extra tags beyond the implicit `faq` tag. */
  tags?: string[];
  /** Visibility; default `open`. Respect RBAC — don't capture private info. */
  visibility?: 'open' | 'restricted' | 'private';
  editableBy?: 'open' | 'admins' | 'creator';
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Render the full card file (frontmatter + body). Deterministic given the same
 * input, so re-rendering an unchanged card produces identical bytes (a cheap
 * "did anything actually change?" check for idempotent updates).
 */
export function renderFaqCard(input: FaqCardInput): string {
  const tags = Array.from(new Set(['faq', ...(input.tags ?? [])]));
  const frontmatter = {
    title: input.question.trim(),
    created_by: input.createdBy ?? 'labor.fun',
    created_at: input.createdAt ?? todayUtc(),
    visibility: input.visibility ?? 'open',
    editable_by: input.editableBy ?? 'open',
    tags,
  };
  const body =
    `# ${input.question.trim()}\n\n` +
    `${input.answer.trim()}\n\n` +
    `**Source:** ${input.source.trim()}\n`;
  // gray-matter's stringify emits `---\n<yaml>---\n<body>`.
  return matter.stringify(body, frontmatter);
}

/**
 * Decide whether writing `next` over `existing` is a no-op. Compares the
 * question + answer + source (the load-bearing content), ignoring incidental
 * frontmatter like created_at so a same-day re-capture doesn't churn the file.
 * Returns true when the card already says the same thing (skip the write).
 */
export function isFaqCardUnchanged(
  existingContent: string,
  next: FaqCardInput,
): boolean {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(existingContent);
  } catch {
    return false;
  }
  const existingTitle = String(parsed.data.title ?? '').trim();
  const nextTitle = next.question.trim();
  if (existingTitle !== nextTitle) return false;
  // Body comparison: normalize whitespace so formatting-only diffs don't count.
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const existingBody = norm(parsed.content);
  const nextBody = norm(`${next.answer} Source: ${next.source}`);
  return existingBody.includes(norm(next.answer)) &&
    existingBody.includes(norm(next.source))
    ? true
    : existingBody === nextBody;
}
