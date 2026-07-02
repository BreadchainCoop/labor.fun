// peer-reviews.mjs — Quarterly peer-review + self-evaluation flow (issue #23,
// Phase 1), as a profile plugin. Two peer reviews per member are required for
// next-quarter payment eligibility; today the follow-up "sits in people's
// heads." This automates the tracking + nudging half:
//
//   * ~N weeks before quarter end (default 6 — reviews take time), announce the
//     cycle in the channel, assign each member two peers to review (seeded from
//     the optional `collaborators` map, round-robin to fill gaps, unless config
//     overrides with explicit `assignments`), and DM each member: write your
//     self-evaluation, and review the two peers you've been given.
//   * Each tick, DM anyone with outstanding items (self-eval not filed, or an
//     assigned review not filed), listing exactly what's left. Re-nudge every
//     nudge_every_days until done — silence is not progress. After max_nudges,
//     escalate once in the channel and stop DMing them.
//   * "Done" is read from the KB: a self-eval exists at
//     `peer-reviews/<quarter>/self-eval/<slug>.md`; a review exists at
//     `peer-reviews/<quarter>/reviews/<reviewer>--<reviewee>.md`. The companion
//     `peer-reviews` container skill files these when a member replies in DM
//     (pulling their last-quarter goals from KB to anchor the self-eval); a
//     human can also write the files by hand.
//   * When everyone is complete — or the soft deadline (payment-proposal
//     window) arrives — post a status summary in the channel: all-clear, or
//     who's still missing what.
//
// Meeting scheduling ("bot books the review meeting": availability → a Google
// Calendar event with both as attendees) is handled conversationally by the
// companion `peer-reviews` container skill using the agent's `gws` calendar
// tool — the nudges OFFER it and the agent books when a member engages. This
// plugin owns the orchestration (who's outstanding, who to nudge, when to
// summarize); the agent owns the calendar I/O the plugin can't do itself.
//
// Architecture mirrors sd-kickoff.mjs: no secrets, no framework imports. It
// acts purely through the shared KB (config, per-quarter state, filed
// artifacts) and the IPC dirs (`dm_user` / `message` ops in the shared-KB
// group's own namespace, so same-group authorization applies). Config lives in
// `groups/<sharedKbGroup>/context/peer-reviews/config.md`; without it the flow
// is a silent no-op.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import matter from 'gray-matter';

const DAY_MS = 86_400_000;

/** Label of the quarter that ENDS at a given quarter boundary (start-of-month
 * for months Jan/Apr/Jul/Oct). Jan 1 closes Q4 of the prior year. */
function quarterEndingAt(boundaryMs) {
  const b = new Date(boundaryMs);
  const m = b.getMonth(); // 0, 3, 6, 9
  return m === 0 ? `${b.getFullYear() - 1}-Q4` : `${b.getFullYear()}-Q${m / 3}`;
}

/**
 * The review window around a quarter boundary. Reviews evaluate the quarter
 * being CLOSED OUT, and realistically run from a few weeks before the quarter
 * ends through a couple weeks into the next one (people finish them in early
 * next quarter — a window that closed AT quarter end would kill a cycle just
 * as it got going). We anchor to the nearest quarter boundary: while still
 * within `weeksAfter` of the PREVIOUS boundary the cycle is for the quarter
 * that just ended; otherwise it's for the quarter ending next. `label` names
 * the reviewed quarter (e.g. `2026-Q2`); the flow is active iff
 * `openMs <= now < closeMs`. `boundaryMs` is the quarter end (used for the
 * summary deadline).
 */
export function reviewWindow(nowMs, weeksBefore = 3, weeksAfter = 2) {
  const beforeMs = weeksBefore * 7 * DAY_MS;
  const afterMs = weeksAfter * 7 * DAY_MS;
  const d = new Date(nowMs);
  const qStartMonth = Math.floor(d.getMonth() / 3) * 3;
  const prevBoundary = new Date(d.getFullYear(), qStartMonth, 1).getTime();
  const nextBoundary = new Date(d.getFullYear(), qStartMonth + 3, 1).getTime();
  const boundaryMs = nowMs < prevBoundary + afterMs ? prevBoundary : nextBoundary;
  return {
    label: quarterEndingAt(boundaryMs),
    boundaryMs,
    openMs: boundaryMs - beforeMs,
    closeMs: boundaryMs + afterMs,
  };
}

/** Parse context/peer-reviews/config.md (frontmatter config; body is notes). */
export function parseConfig(mdText) {
  const fm = matter(mdText).data ?? {};
  const members = Array.isArray(fm.members)
    ? fm.members.filter((m) => typeof m === 'string' && m.trim() !== '')
    : [];
  // Optional explicit pairing: { reviewer: [reviewee, ...] }. When absent the
  // flow assigns round-robin. Kept as-is (ops owns the "valid peer / anonymity"
  // policy that issue #23 leaves open).
  const assignments =
    fm.assignments && typeof fm.assignments === 'object'
      ? fm.assignments
      : null;
  // Optional collaboration signal: { slug: [slugs they work with, ...] }
  // (issue #135). Edges are treated as symmetric — listing one direction is
  // enough. When present (and `assignments` isn't), computeAssignments seeds
  // pairs from these edges and only falls back to round-robin to fill gaps.
  // Absent → pure round-robin, exactly as before.
  const collaborators =
    fm.collaborators &&
    typeof fm.collaborators === 'object' &&
    !Array.isArray(fm.collaborators)
      ? fm.collaborators
      : null;
  return {
    members,
    assignments,
    collaborators,
    channelJid: typeof fm.channel_jid === 'string' ? fm.channel_jid : '',
    windowWeeksBefore: Number(fm.window_weeks_before) || 3,
    windowWeeksAfter: Number(fm.window_weeks_after) || 2,
    // Optional hard start gate: the flow stays dormant until this instant even
    // if the review window is open. Lets ops "queue" a cycle for a date.
    // Accepts an ISO date/datetime (YAML may parse it to a Date — stringify).
    activateOn: fm.activate_on != null ? String(fm.activate_on) : null,
    // When true, the flow also helps schedule each review meeting: it asks both
    // people for their availability this week and, once both have answered, an
    // agent matches a common slot and books a Google Calendar event. Opt-in.
    autoSchedule: fm.auto_schedule === true,
    nudgeEveryDays: Number(fm.nudge_every_days) || 4,
    maxNudges: Number(fm.max_nudges) || 4,
    reviewsRequired: Number(fm.reviews_required) || 2,
    summaryDaysBeforeEnd: Number(fm.summary_days_before_end) || 7,
  };
}

/**
 * Reviewer assignment (issue #135): collaboration-seeded, round-robin-filled.
 *
 * Runs `min(count, N-1)` rounds; each round is a perfect matching (everyone
 * reviews exactly one person, everyone is reviewed exactly once), so after all
 * rounds every member reviews and is reviewed exactly `min(count, N-1)` times —
 * the same balance guarantees as the old positional round-robin. Within a
 * round, a maximum matching over `collaborators` edges (symmetric; unknown
 * slugs ignored) is seeded first, then round-robin fill completes the round to
 * a perfect matching — displacing a collab seed only when a member can't be
 * covered any other way. Everything is roster-order driven → deterministic.
 * With no `collaborators` the output is EXACTLY the old round-robin (member i
 * reviews the next `count` members, wrapping). Never self, never the same pair
 * twice. Degrades for small N (you can't get 2 distinct reviewers with fewer
 * than 3 people). Returns { reviewer: [reviewee, ...] }.
 */
export function computeAssignments(members, count = 2, collaborators = null) {
  const n = members.length;
  const idx = new Map(members.map((m, i) => [m, i]));

  // Symmetric collaboration adjacency, restricted to roster members.
  const collab = members.map(() => new Set());
  if (collaborators && typeof collaborators === 'object') {
    for (const [a, list] of Object.entries(collaborators)) {
      const ia = idx.get(a);
      if (ia === undefined || !Array.isArray(list)) continue;
      for (const b of list) {
        const ib = idx.get(b);
        if (ib === undefined || ib === ia) continue;
        collab[ia].add(ib);
        collab[ib].add(ia);
      }
    }
  }

  const used = members.map(() => new Set()); // reviewer i → reviewee indices
  const out = Object.fromEntries(members.map((m) => [m, []]));
  const rounds = Math.min(count, n - 1);

  for (let r = 0; r < rounds; r++) {
    // Per-reviewer candidates in preference order: collaborators first, then
    // the rest — both walked in round-robin order from i+1 so the no-collab
    // case reproduces the old assignment and ties break deterministically.
    const collabCands = [];
    const allCands = [];
    for (let i = 0; i < n; i++) {
      const cc = [];
      const rest = [];
      for (let k = 1; k < n; k++) {
        const j = (i + k) % n;
        if (used[i].has(j)) continue;
        (collab[i].has(j) ? cc : rest).push(j);
      }
      collabCands.push(cc);
      allCands.push(cc.concat(rest));
    }
    const matchedTo = new Array(n).fill(-1); // reviewee j → reviewer i
    // Kuhn's augmenting-path matching; `locked` reviewees can't be rerouted.
    const tryMatch = (i, cands, locked, visited) => {
      for (const j of cands[i]) {
        if (visited.has(j) || locked.has(j)) continue;
        visited.add(j);
        if (matchedTo[j] === -1 || tryMatch(matchedTo[j], cands, locked, visited)) {
          matchedTo[j] = i;
          return true;
        }
      }
      return false;
    };
    const none = new Set();
    // Seed: maximum matching over collaboration edges only.
    for (let i = 0; i < n; i++) tryMatch(i, collabCands, none, new Set());
    const locked = new Set(
      matchedTo.flatMap((i, j) => (i === -1 ? [] : [j])),
    );
    // Fill: complete to a perfect matching (guaranteed to exist — the
    // available pair graph is (n-1-r)-regular). Collab seeds stay locked;
    // unlock only when a reviewer can't be placed any other way, so
    // round-robin fills coverage gaps without dismantling collab pairs.
    for (let i = 0; i < n; i++) {
      if (matchedTo.includes(i)) continue; // already reviewing someone
      if (!tryMatch(i, allCands, locked, new Set())) {
        tryMatch(i, allCands, none, new Set());
      }
    }
    for (let j = 0; j < n; j++) {
      const i = matchedTo[j];
      if (i === -1) continue;
      used[i].add(j);
      out[members[i]].push(members[j]);
    }
  }
  return out;
}

const reviewKey = (reviewer, reviewee) => `${reviewer}--${reviewee}`;

/**
 * Outstanding items for one member: their self-eval if unfiled, plus any
 * assigned review they haven't filed. Pure — `selfEvalDone`/`reviewsDone` are
 * the Sets read from the KB. Returns structured items so callers can render
 * them with names/mentions.
 */
export function outstandingFor(slug, assignments, selfEvalDone, reviewsDone) {
  const items = [];
  if (!selfEvalDone.has(slug)) items.push({ type: 'self-eval' });
  for (const reviewee of assignments[slug] ?? []) {
    if (!reviewsDone.has(reviewKey(slug, reviewee))) {
      items.push({ type: 'review', reviewee });
    }
  }
  return items;
}

/**
 * Read each member's `people/<slug>.md` frontmatter once: `discord_id` (for
 * channel mentions — a plain name doesn't ping) and `title` (a readable name
 * for DM text, where a mention wouldn't ping anyway). Missing → falls back to
 * the slug.
 */
export function resolveDirectory(ctxDir, members) {
  const out = {};
  for (const slug of members) {
    let id = null;
    let name = slug;
    try {
      const fm = matter(
        fs.readFileSync(path.join(ctxDir, 'people', `${slug}.md`), 'utf-8'),
      ).data;
      if (fm?.discord_id) id = String(fm.discord_id);
      if (fm?.title && String(fm.title).trim()) name = String(fm.title);
    } catch {
      // No people file — leave id null, name = slug.
    }
    out[slug] = { id, name };
  }
  return out;
}

/** Channel rendering: `<@id> (name)` so the post pings them; else the name. */
function mentionFor(slug, dir) {
  const e = dir?.[slug];
  if (e?.id) return `<@${e.id}> (${e.name})`;
  return e?.name ?? slug;
}

/** DM rendering: just the readable name (a mention wouldn't ping in a DM). */
function nameFor(slug, dir) {
  return dir?.[slug]?.name ?? slug;
}

function renderItems(items, dir) {
  return items.map((it) =>
    it.type === 'self-eval'
      ? 'your self-evaluation'
      : `a peer review of ${nameFor(it.reviewee, dir)}`,
  );
}

function announcePost(label, members, dir) {
  const who = members.map((m) => mentionFor(m, dir)).join(', ');
  return (
    `📋 Quarterly peer reviews for **${label}** are open (${who}). ` +
    `Each of you has a self-evaluation to write and two peers to review — ` +
    `I've DM'd everyone their assignments. Two completed peer reviews are ` +
    `required for next-quarter payment eligibility, so let's get them in ` +
    `before the proposal window. Reply to my DM and I can pull up your goals, ` +
    `record your reviews, and even put the review meetings on the calendar. ` +
    `I'll nudge by DM until you're done.`
  );
}

function escalationPost(slug, items, label, dir) {
  const left = renderItems(items, dir).join('; ');
  const who = mentionFor(slug, dir);
  // Recovery-oriented, not a call-out (shared-mirror voice rule): the work may
  // be done and just not recorded. Offer the self-heal, stop DMing, no shaming.
  return (
    `📝 I don't have ${who}'s ${label} review items recorded yet (${left}), and I've ` +
    `stopped DMing them. If they're already done and just not filed, ${who}, reply ` +
    `here and I'll capture them — no rush.`
  );
}

// Appended to the first DM when auto-scheduling is on — collects each member's
// availability once so the agent can match + book their review meetings.
const AVAILABILITY_ASK =
  ` Also: reply with the times you're free **this week** (e.g. "Tue/Thu after 2pm, Wed morning") ` +
  `and I'll match them with your review partners and put the meetings on the calendar.`;

function nudgeText(label, askNumber, items, dir, autoSchedule) {
  const left = renderItems(items, dir).join('\n• ');
  if (askNumber === 1) {
    return (
      `Hi! Quarterly reviews for **${label}** are open. You still have:\n• ${left}\n\n` +
      `Two completed peer reviews are required for next-quarter payment eligibility. ` +
      `Reply here and I'll pull up the goals you set last quarter to anchor your self-eval ` +
      `and help you write your peer reviews. I'll check back every few days.` +
      (autoSchedule ? AVAILABILITY_ASK : '')
    );
  }
  return (
    `Reminder ${askNumber - 1} — still outstanding for **${label}**:\n• ${left}\n\n` +
    `Reply here whenever you're ready and I'll help you knock these out. ` +
    `(Already did one but it isn't filed? Tell me and I'll record it.)`
  );
}

function summaryPost(label, members, assignments, selfEvalDone, reviewsDone, dir, allDone) {
  if (allDone) {
    return (
      `✅ All self-evaluations and peer reviews for **${label}** are complete — ` +
      `everyone's review requirement is met. 🎉 Thanks all!`
    );
  }
  const lines = members.map((slug) => {
    const items = outstandingFor(slug, assignments, selfEvalDone, reviewsDone);
    if (items.length === 0) return `• ${nameFor(slug, dir)}: ✅ complete`;
    return `• ${mentionFor(slug, dir)}: still to file ${renderItems(items, dir).join(', ')}`;
  });
  // A supportive check-in tied to the eligibility window, not a call-out
  // (shared-mirror voice rule): offer help rather than pressure.
  return (
    `⏰ Peer-review status for **${label}** (payment-proposal window opening):\n` +
    lines.join('\n') +
    `\n\nStill wrapping up? Reply to my DM and I'll pull up your goals and record ` +
    `your reviews — happy to help you get there before the window.`
  );
}

/**
 * Decide this tick's actions from current state. Pure — no I/O, no clock — so
 * the nudge/assignment logic is unit-testable. Returns the actions plus the
 * next state (never mutates the input). `selfEvalDone` / `reviewsDone` are Sets
 * read from the KB; `assignments` is the freshly-computed (or config) pairing.
 */
export function planActions({
  nowMs,
  cfg,
  members,
  assignments,
  state,
  selfEvalDone,
  reviewsDone,
  dir,
  // Auto-scheduling inputs (default off / empty so the non-scheduling path is
  // unchanged): who has filed availability this week, which meetings are booked.
  autoSchedule = false,
  availability = new Set(),
  meetings = new Set(),
}) {
  const out = { dms: [], posts: [], matchTasks: [] };
  const st = {
    ...state,
    members: Object.fromEntries(
      Object.entries(state.members ?? {}).map(([k, v]) => [k, { ...v }]),
    ),
    matchKicked: { ...(state.matchKicked ?? {}) },
  };

  // Freeze the assignment on first run so nudges stay consistent even if the
  // member list is reordered later (config-supplied pairings already win in
  // tick()). state wins over the freshly-passed one once set.
  const asg = st.assignments ?? assignments;
  st.assignments = asg;

  if (!st.announcedAt) {
    st.announcedAt = new Date(nowMs).toISOString();
    out.posts.push(announcePost(cfg.label, members, dir));
  }

  const nudgeMs = cfg.nudgeEveryDays * DAY_MS;
  for (const slug of members) {
    const items = outstandingFor(slug, asg, selfEvalDone, reviewsDone);
    const m = st.members[slug] ?? { asks: 0, lastAskAt: null, escalated: false };
    if (items.length === 0) {
      st.members[slug] = m; // complete — never nudge
      continue;
    }
    const due = !m.lastAskAt || nowMs - Date.parse(m.lastAskAt) >= nudgeMs;
    if (due) {
      if (m.asks >= cfg.maxNudges) {
        if (!m.escalated) {
          m.escalated = true;
          out.posts.push(escalationPost(slug, items, cfg.label, dir));
        }
      } else {
        m.asks += 1;
        m.lastAskAt = new Date(nowMs).toISOString();
        out.dms.push({
          slug,
          text: nudgeText(cfg.label, m.asks, items, dir, autoSchedule),
        });
      }
    }
    st.members[slug] = m;
  }

  // Auto-scheduling pass: for each assigned review still outstanding, once BOTH
  // people have filed availability, kick a one-shot agent task to match a slot
  // and book the meeting. Keyed by the UNORDERED pair so a mutual pairing
  // (a reviews b AND b reviews a) schedules one meeting, not two. Re-kicks at
  // most daily until the meeting is recorded — so an agent failure self-heals,
  // while a booked/coordinated meeting (its file written by the skill) stops it.
  if (autoSchedule) {
    const RETRY_MS = DAY_MS;
    const seen = new Set();
    for (const r of members) {
      for (const e of asg[r] ?? []) {
        if (reviewsDone.has(`${r}--${e}`)) continue; // review done → meeting moot
        const [x, y] = [r, e].slice().sort();
        const pk = `${x}--${y}`;
        if (seen.has(pk)) continue;
        seen.add(pk);
        if (meetings.has(pk)) continue; // already booked / coordinated
        if (!availability.has(x) || !availability.has(y)) continue; // wait
        const last = st.matchKicked[pk] ? Date.parse(st.matchKicked[pk]) : 0;
        if (nowMs - last < RETRY_MS) continue; // recently kicked
        st.matchKicked[pk] = new Date(nowMs).toISOString();
        out.matchTasks.push({ a: x, b: y, key: pk });
      }
    }
  }

  const allDone = members.every(
    (s) => outstandingFor(s, asg, selfEvalDone, reviewsDone).length === 0,
  );
  const deadlineHit = nowMs >= cfg.quarterEndMs - cfg.summaryDaysBeforeEnd * DAY_MS;
  if (!st.summaryPostedAt && (allDone || deadlineHit)) {
    st.summaryPostedAt = new Date(nowMs).toISOString();
    out.posts.push(
      summaryPost(cfg.label, members, asg, selfEvalDone, reviewsDone, dir, allDone),
    );
  }

  return { ...out, state: st };
}

/** Atomic write: IPC watchers only pick up `*.json`, so write `.tmp` first. */
function writeIpcFile(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path.join(dir, name));
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Local-time stamp without timezone suffix — the schedule_task `once` format. */
function localStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Build the one-shot agent task that matches availability and books the
 * meeting for an unordered pair. The skill does the calendar I/O; the prompt
 * carries the quarter + paths so the run is self-contained. */
export function matchTaskIpc({ label, pair, channelJid, nowMs }) {
  const { a, b, key } = pair;
  const base = `/workspace/shared-kb/peer-reviews/${label}`;
  const prompt =
    `Schedule the peer-review meeting between ${a} and ${b} for ${label}. ` +
    `Use the peer-reviews skill (Booking a review meeting).\n\n` +
    `1. If ${base}/meetings/${key}.md already exists, STOP — it's handled.\n` +
    `2. Read both people files (people/${a}.md, people/${b}.md) for each member's email AND ` +
    `\`timezone\` frontmatter. If a timezone is missing, infer nothing — ask that person in DM ` +
    `and fall back to the org timezone for the draft.\n` +
    `3. Read both self-reported availabilities: ${base}/availability/${a}.md and ${base}/availability/${b}.md.\n` +
    `4. Check both members' REAL Google Calendar free/busy (gws calendar tools) for the coming week.\n` +
    `5. Pick the best 30-minute slot that is (a) free on BOTH calendars, (b) inside both ` +
    `self-reported windows where given, and (c) within working hours (~09:00-18:00) in EACH ` +
    `member's own timezone — for split timezones prefer the overlap fairest to both, not just ` +
    `the first free gap.\n` +
    `6. Create a Google Calendar event (gws) titled "Peer review: ${a} ↔ ${b} (${label})" ` +
    `with both as attendees (if an email is missing, ask them in DM).\n` +
    `7. DM both the booked time, expressed in EACH recipient's own local timezone.\n` +
    `8. Record it at peer-reviews/${label}/meetings/${key}.md via modify_kb_file. ` +
    `If you can't find an overlap or can't book, DM both to coordinate directly and STILL ` +
    `write that file (note "manual coordination") so I don't keep retrying.`;
  return {
    type: 'schedule_task',
    taskId: `pr-meet-${label.toLowerCase()}-${key}-${nowMs}`,
    prompt,
    schedule_type: 'once',
    schedule_value: localStamp(nowMs + 2 * 60_000),
    context_mode: 'isolated',
    targetJid: channelJid,
    timestamp: new Date(nowMs).toISOString(),
  };
}

/** Slugs of `.md` files directly under `dir` (filename without extension). */
function mdSlugs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

/**
 * One scheduler tick: read config + state from the KB, decide actions, emit
 * IPC files, persist state. Exported (with injectable paths/clock) so tests
 * can drive it against a temp profile dir. Returns the plan, or null when the
 * flow is unconfigured / out of window.
 */
export function tick({ profileDir, logger, nowMs }) {
  let sharedKb = 'slack_main';
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(profileDir, 'profile.config.json'), 'utf-8'),
    );
    if (typeof cfg.sharedKbGroup === 'string' && cfg.sharedKbGroup) {
      sharedKb = cfg.sharedKbGroup;
    }
  } catch {
    /* default */
  }

  const ctxDir = path.join(profileDir, 'groups', sharedKb, 'context');
  const configPath = path.join(ctxDir, 'peer-reviews', 'config.md');
  if (!fs.existsSync(configPath)) return null; // not configured → no-op

  const cfg = parseConfig(fs.readFileSync(configPath, 'utf-8'));
  if (cfg.members.length === 0 || !cfg.channelJid) {
    logger.warn(
      { configPath },
      'peer-reviews: config.md needs `members` and `channel_jid` frontmatter',
    );
    return null;
  }

  // Hard start gate: stay dormant until activate_on (if set), even if the
  // review window is already open. Invalid dates are ignored (don't gate).
  if (cfg.activateOn) {
    const startMs = Date.parse(cfg.activateOn);
    if (!Number.isNaN(startMs) && nowMs < startMs) return null;
  }

  const { label, boundaryMs, openMs, closeMs } = reviewWindow(
    nowMs,
    cfg.windowWeeksBefore,
    cfg.windowWeeksAfter,
  );
  if (nowMs < openMs || nowMs >= closeMs) return null;

  const baseDir = path.join(ctxDir, 'peer-reviews', label);
  const selfEvalDone = new Set(mdSlugs(path.join(baseDir, 'self-eval')));
  const reviewsDone = new Set(mdSlugs(path.join(baseDir, 'reviews')));
  // Auto-scheduling inputs: per-person availability filed, per-pair meetings booked.
  const availability = new Set(mdSlugs(path.join(baseDir, 'availability')));
  const meetings = new Set(mdSlugs(path.join(baseDir, 'meetings')));

  const statePath = path.join(ctxDir, 'peer-reviews', 'state', `${label}.json`);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    /* fresh quarter */
  }

  // Config pairing wins (ops owns the policy); else collab-seeded round-robin.
  const assignments =
    cfg.assignments ??
    computeAssignments(cfg.members, cfg.reviewsRequired, cfg.collaborators);
  const dir = resolveDirectory(ctxDir, cfg.members);

  const plan = planActions({
    nowMs,
    cfg: {
      label,
      quarterEndMs: boundaryMs,
      nudgeEveryDays: cfg.nudgeEveryDays,
      maxNudges: cfg.maxNudges,
      summaryDaysBeforeEnd: cfg.summaryDaysBeforeEnd,
    },
    members: cfg.members,
    assignments,
    state,
    selfEvalDone,
    reviewsDone,
    dir,
    autoSchedule: cfg.autoSchedule,
    availability,
    meetings,
  });

  // Same-group IPC namespace → orchestrator authorizes these as same-group ops.
  const ipcDir = path.join(profileDir, 'data', 'ipc', sharedKb);
  for (const dm of plan.dms) {
    writeIpcFile(path.join(ipcDir, 'tasks'), {
      type: 'dm_user',
      target: dm.slug,
      text: dm.text,
      sourceJid: cfg.channelJid,
      timestamp: new Date(nowMs).toISOString(),
    });
  }
  for (const text of plan.posts) {
    writeIpcFile(path.join(ipcDir, 'messages'), {
      type: 'message',
      chatJid: cfg.channelJid,
      text,
      timestamp: new Date(nowMs).toISOString(),
    });
  }
  for (const pair of plan.matchTasks) {
    writeIpcFile(
      path.join(ipcDir, 'tasks'),
      matchTaskIpc({ label, pair, channelJid: cfg.channelJid, nowMs }),
    );
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  atomicWrite(statePath, JSON.stringify(plan.state, null, 2));

  if (plan.dms.length || plan.posts.length || plan.matchTasks.length) {
    logger.info(
      {
        label,
        dms: plan.dms.length,
        posts: plan.posts.length,
        meetings: plan.matchTasks.length,
      },
      'peer-reviews: actions emitted',
    );
  }
  return plan;
}

export default function register({ registerIntegration, logger }) {
  let timer = null;
  registerIntegration({
    name: 'peer-reviews',
    start: () => {
      const profileDir = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
      );
      const tickMs = Number(process.env.PEER_REVIEWS_TICK_MS) || 6 * 3600_000;
      const run = () => {
        try {
          tick({ profileDir, logger, nowMs: Date.now() });
        } catch (err) {
          logger.error({ err }, 'peer-reviews: tick failed');
        }
      };
      const first = setTimeout(run, 90_000);
      first.unref?.();
      timer = setInterval(run, tickMs);
      timer.unref?.();
      logger.info({ tickMs }, 'peer-reviews flow started');
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
}
