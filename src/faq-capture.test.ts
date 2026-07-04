import matter from 'gray-matter';
import { describe, it, expect } from 'vitest';

import {
  FAQ_DIR,
  faqSlug,
  faqCardPath,
  renderFaqCard,
  isFaqCardUnchanged,
} from './faq-capture.js';

describe('faqSlug (idempotency key)', () => {
  it('is deterministic and stable for the same question', () => {
    expect(faqSlug('How do I reset my password?')).toBe(
      'how-do-i-reset-my-password',
    );
    expect(faqSlug('How do I reset my password?')).toBe(
      faqSlug('How do I reset my password?'),
    );
  });

  it('collapses trivial phrasing differences so cards do not duplicate', () => {
    // punctuation, case, apostrophes, and trailing whitespace normalize away
    const a = faqSlug("What's the deploy process?");
    const b = faqSlug('  Whats the DEPLOY process!!!  ');
    expect(a).toBe(b);
  });

  it('never produces an empty slug', () => {
    expect(faqSlug('???')).toBe('faq');
    expect(faqSlug('')).toBe('faq');
  });

  it('caps length for filesystem sanity', () => {
    const long = 'a'.repeat(200) + ' question';
    expect(faqSlug(long).length).toBeLessThanOrEqual(80);
  });
});

describe('faqCardPath', () => {
  it('is under the FAQ dir and derives from the slug', () => {
    expect(faqCardPath('How do I deploy?')).toBe(
      `${FAQ_DIR}/how-do-i-deploy.md`,
    );
  });
});

describe('renderFaqCard', () => {
  it('produces valid frontmatter + a Q heading, answer, and Source line', () => {
    const content = renderFaqCard({
      question: 'How do I deploy?',
      answer: 'Merge to main; auto-deploy ships it in ~2 minutes.',
      source: 'Ron in #ops',
      createdBy: 'labor.fun',
      createdAt: '2026-07-04',
    });
    const parsed = matter(content);
    expect(parsed.data.title).toBe('How do I deploy?');
    expect(parsed.data.visibility).toBe('open'); // default
    expect(parsed.data.editable_by).toBe('open');
    expect(parsed.data.tags).toContain('faq');
    expect(parsed.content).toContain('# How do I deploy?');
    expect(parsed.content).toContain('auto-deploy');
    expect(parsed.content).toContain('**Source:** Ron in #ops');
  });

  it('respects an explicit restricted visibility (RBAC)', () => {
    const content = renderFaqCard({
      question: 'What is the wifi password?',
      answer: 'ask an admin',
      source: 'admin note',
      visibility: 'restricted',
      editableBy: 'admins',
    });
    const parsed = matter(content);
    expect(parsed.data.visibility).toBe('restricted');
    expect(parsed.data.editable_by).toBe('admins');
  });

  it('merges custom tags without duplicating the implicit faq tag', () => {
    const content = renderFaqCard({
      question: 'q',
      answer: 'a',
      source: 's',
      tags: ['faq', 'deploy'],
    });
    const tags = matter(content).data.tags as string[];
    expect(tags.filter((t) => t === 'faq').length).toBe(1);
    expect(tags).toContain('deploy');
  });

  it('is deterministic given a fixed createdAt', () => {
    const input = {
      question: 'q',
      answer: 'a',
      source: 's',
      createdAt: '2026-01-01',
    };
    expect(renderFaqCard(input)).toBe(renderFaqCard(input));
  });
});

describe('isFaqCardUnchanged (update-not-duplicate)', () => {
  const base = {
    question: 'How do I deploy?',
    answer: 'Merge to main; auto-deploy ships it.',
    source: 'Ron in #ops',
    createdAt: '2026-07-04',
  };

  it('recognizes an identical re-capture as a no-op', () => {
    const existing = renderFaqCard(base);
    expect(isFaqCardUnchanged(existing, base)).toBe(true);
  });

  it('ignores a created_at change (same content, different day)', () => {
    const existing = renderFaqCard({ ...base, createdAt: '2026-06-01' });
    expect(isFaqCardUnchanged(existing, { ...base, createdAt: '2026-07-04' })).toBe(
      true,
    );
  });

  it('detects a changed answer (should update the card)', () => {
    const existing = renderFaqCard(base);
    expect(
      isFaqCardUnchanged(existing, {
        ...base,
        answer: 'Actually: run safe-deploy.sh on the host.',
      }),
    ).toBe(false);
  });

  it('detects a changed question title', () => {
    const existing = renderFaqCard(base);
    expect(
      isFaqCardUnchanged(existing, { ...base, question: 'How do I ship?' }),
    ).toBe(false);
  });

  it('treats unparseable existing content as changed (safe: rewrite)', () => {
    expect(isFaqCardUnchanged('not: [valid: yaml', base)).toBe(false);
  });
});
