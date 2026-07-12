// weekly-agenda.mjs — Weekly meeting agenda automation, as a first-party
// CATALOG plugin (M2 of per-tenant plugins). Drives weekly-meeting prep so the
// facilitator doesn't have to chase everyone by hand:
//
//   * Each week, inside the prep window, fires a ONE-SHOT agent task that
//     (re)builds the agenda's "This Week" tab into a DECISION-READY draft:
//     archives the prior week into the doc's Archive tab, writes a fresh dated
//     agenda pre-filled with the week's facilitator (explicit rota entry, else
//     auto-rotated from the facilitator pool) and rich auto-pulled context —
//     each owner's merged PRs / closed issues (linked), upcoming deadlines, and
//     a goals read against the quarter's directives. Posts the link only after
//     a build is verified (the `built` marker).
//   * DMs every project owner asking them to fill in their section and re-nudges
//     on a cadence until they do, escalating once in the channel after
//     max_nudges and then stopping.
//   * An owner has "responded" when an input file exists at
//     context/weekly-agenda/inputs/<week>/<slug>.md.
//
// PORTED FROM profiles/example/plugins/weekly-agenda.mjs, made org-agnostic:
//   * The per-week MEETING CONTENT (channel, doc/tab ids, owners map,
//     facilitators rota, corrector page, …) still lives in the KB config file
//     so ops can edit it from the dashboard —
//     groups/<sharedKbGroup>/context/weekly-agenda/config.md.
//   * The PLUGIN-LEVEL knobs that were hardcoded / env-driven in the example are
//     now CONFIG (second arg to register), so any org can tune them without
//     forking: tick cadence, first-tick delay, which shared-KB group to watch,
//     and DEFAULTS for meeting_day / meeting_hour / prep_days_before /
//     nudge_every_days / max_nudges / facilitator_pool that apply when the KB
//     config.md omits them. KB values always win over these config defaults.
//   * profileDir comes from the PluginApi (catalog plugins live outside the
//     profile, so they cannot derive it from import.meta.url).
//
// See container/catalog-plugins/README.md for the full config-key table.

import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Re-request the build this often until the agent confirms it (writes the
 * `built` marker) — so a failed/incomplete build self-heals instead of
 * stalling the week with no agenda. */
const BUILD_RETRY_MS = 30 * 60_000;

/** Manifest: stable id (matched against ENABLED_PLUGINS) + kind. */
export const id = 'weekly-agenda';
export const kind = 'integration';

/**
 * Normalize the plugin CONFIG (register's 2nd arg) into a fully-defaulted shape.
 * Every key is optional; sensible defaults make the plugin usable the moment an
 * org enables it and writes a KB config.md. Exported for tests.
 */
export function resolvePluginConfig(config = {}) {
  const c = config && typeof config === 'object' ? config : {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const intOr = (v, d) => (Number.isInteger(v) ? v : d);
  return {
    // Runtime knobs (were env / hardcoded in the example plugin).
    tickMs: num(c.tickMs, 6 * HOUR_MS),
    firstTickDelayMs: num(c.firstTickDelayMs, 60_000),
    // Which shared-KB group's context/ holds the config + state. Empty →
    // fall back to the profile's sharedKbGroup (read inside tick()).
    sharedKbGroup: typeof c.sharedKbGroup === 'string' ? c.sharedKbGroup.trim() : '',
    // DEFAULTS applied only when the KB config.md omits the corresponding key.
    defaults: {
      meetingDay: intOr(c.meetingDay, 3), // 0=Sun..6=Sat; 3 = Wed
      meetingHour: intOr(c.meetingHour, 16),
      prepDaysBefore: num(c.prepDaysBefore, 2),
      nudgeEveryDays: num(c.nudgeEveryDays, 1),
      maxNudges: num(c.maxNudges, 3),
      refreshHoursBefore: Number.isFinite(Number(c.refreshHoursBefore))
        ? Math.max(0, Number(c.refreshHoursBefore))
        : 0,
      facilitatorPool: Array.isArray(c.facilitatorPool)
        ? c.facilitatorPool.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
        : [],
    },
  };
}

/** Local YYYY-MM-DD for a timestamp (the per-week key + the human date). */
export function isoDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The meeting window this flow operates in. Meetings recur weekly on
 * `meetingDay` (0=Sun..6=Sat) at `meetingHour` local time. Returns the NEXT
 * upcoming meeting and the prep window that opens `prepDaysBefore` days before
 * it. `weekKey` (the meeting's local date) namespaces state + inputs.
 */
export function meetingWindow(nowMs, meetingDay = 3, meetingHour = 16, prepDaysBefore = 2) {
  const d = new Date(nowMs);
  const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), meetingHour, 0, 0);
  let add = (meetingDay - cand.getDay() + 7) % 7;
  // Meeting day but already past meeting time → target next week's meeting.
  if (add === 0 && nowMs >= cand.getTime()) add = 7;
  cand.setDate(cand.getDate() + add);
  const meetingMs = cand.getTime();
  const windowStartMs = meetingMs - prepDaysBefore * DAY_MS;
  return { weekKey: isoDate(meetingMs), meetingMs, windowStartMs };
}

/**
 * Normalize a facilitator map key to `YYYY-MM-DD`. YAML parses an UNQUOTED
 * `2026-06-10` key as a timestamp, so js-yaml hands us a Date-stringified key
 * (e.g. "Wed Jun 10 2026 00:00:00 GMT+0000…") — reformat those back from their
 * UTC parts (js-yaml reads bare timestamps as UTC midnight). Already-quoted
 * `'2026-06-10'` keys arrive as plain strings and pass straight through.
 */
function normalizeDateKey(k) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(k)) return k;
  const d = new Date(k);
  if (!Number.isNaN(d.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }
  return k;
}

/**
 * Parse context/weekly-agenda/config.md (frontmatter-driven; body free text).
 * `defaults` (from plugin CONFIG) fill any cadence/pool key the file omits, so
 * an org can set org-wide defaults in config and only override per-week content
 * in the KB. KB values always win over the config defaults.
 */
export function parseConfig(mdText, defaults = {}) {
  const d = {
    meetingDay: 3,
    meetingHour: 16,
    prepDaysBefore: 2,
    nudgeEveryDays: 1,
    maxNudges: 3,
    refreshHoursBefore: 0,
    facilitatorPool: [],
    ...defaults,
  };
  const fm = matter(mdText).data ?? {};
  // owners: project label -> KB people slug. Accepts a YAML map.
  const owners =
    fm.owners && typeof fm.owners === 'object' && !Array.isArray(fm.owners)
      ? Object.fromEntries(
          Object.entries(fm.owners)
            .filter(([k, v]) => typeof v === 'string' && v.trim() && String(k).trim())
            .map(([k, v]) => [String(k), String(v)]),
        )
      : {};
  // facilitators: meeting-date (YYYY-MM-DD) -> KB people slug. Explicit entries
  // are manual OVERRIDES that always win over the auto-rotation below.
  const facilitators =
    fm.facilitators && typeof fm.facilitators === 'object' && !Array.isArray(fm.facilitators)
      ? Object.fromEntries(
          Object.entries(fm.facilitators)
            .filter(([, v]) => typeof v === 'string' && v.trim())
            .map(([k, v]) => [normalizeDateKey(String(k)), String(v)]),
        )
      : {};
  // facilitator_pool: ordered list of KB people slugs to auto-rotate the chair
  // through on weeks with no explicit `facilitators[<date>]` entry. KB value
  // wins; else the config default (which itself defaults to []).
  const facilitatorPool = Array.isArray(fm.facilitator_pool)
    ? fm.facilitator_pool.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    : d.facilitatorPool;
  return {
    channelJid: typeof fm.channel_jid === 'string' ? fm.channel_jid : '',
    docId: typeof fm.doc_id === 'string' ? fm.doc_id : '',
    thisWeekTabId: typeof fm.this_week_tab_id === 'string' ? fm.this_week_tab_id : '',
    archiveTabId: typeof fm.archive_tab_id === 'string' ? fm.archive_tab_id : '',
    meetingDay: Number.isInteger(fm.meeting_day) ? fm.meeting_day : d.meetingDay,
    meetingHour: Number.isInteger(fm.meeting_hour) ? fm.meeting_hour : d.meetingHour,
    prepDaysBefore: Number(fm.prep_days_before) || d.prepDaysBefore,
    nudgeEveryDays: Number(fm.nudge_every_days) || d.nudgeEveryDays,
    maxNudges: Number(fm.max_nudges) || d.maxNudges,
    // Optional second pass: hours before the meeting to run a light "refresh"
    // that re-pulls GitHub/deadline facts into the already-built doc without
    // re-nudging or resetting owner content. 0 disables it.
    refreshHoursBefore: Number(fm.refresh_hours_before) || d.refreshHoursBefore,
    owners,
    facilitators,
    facilitatorPool,
    // Optional context sources the build agent weaves into the agenda (all
    // org-agnostic — paths are KB-relative, org is the GitHub org to mine).
    // Strategic directives doc → drives the "Goals Review" section.
    directivesDoc: typeof fm.directives_doc === 'string' ? fm.directives_doc.trim() : '',
    // Auto-maintained deadline digest → drives the "Upcoming Deadlines" section.
    deadlineDigest:
      typeof fm.deadline_digest === 'string' && fm.deadline_digest.trim()
        ? fm.deadline_digest.trim()
        : 'deadline-digest.md',
    // GitHub org to mine for each owner's recent merged PRs / closed issues
    // (else the build agent falls back to its profile's configured org).
    githubOrg: typeof fm.github_org === 'string' ? fm.github_org.trim() : '',
    // Corrector page (the agenda-web service). When both are set, the kickoff
    // post links the StatiCrypt page so members can correct the optimistic draft.
    // Base URL (no trailing slash); the page lives at <base>/<week>.html.
    correctorBaseUrl: typeof fm.corrector_base_url === 'string' ? fm.corrector_base_url.trim().replace(/\/$/, '') : '',
    // Shared StatiCrypt password (must match the agenda-web service's AGENDA_WEB_PASSWORD).
    correctorPassword: typeof fm.corrector_password === 'string' ? fm.corrector_password : '',
  };
}

/**
 * Resolve the facilitator (chair) for a meeting week.
 *
 * Priority:
 *   1. An explicit `facilitators[weekKey]` entry always wins — a manual override.
 *   2. Otherwise, when a non-empty `pool` is configured, auto-rotate: pick the
 *      pool member by a deterministic week index so the chair advances by one
 *      each week and wraps around the pool fairly, with no persisted state.
 *   3. Otherwise '' — the doc renders "Facilitator: TBD — claim it".
 *
 * The index counts whole weeks since the Unix epoch from the meeting date, so
 * consecutive weekly meetings (7 days apart) step the rotation by exactly one;
 * a skipped week still moves it forward rather than repeating the same chair.
 */
export function pickFacilitator(weekKey, explicit = {}, pool = []) {
  const override = explicit?.[weekKey];
  if (typeof override === 'string' && override.trim()) return override.trim();
  if (!Array.isArray(pool) || pool.length === 0) return '';
  const ms = Date.parse(`${weekKey}T00:00:00Z`);
  if (Number.isNaN(ms)) return '';
  const weeks = Math.floor(ms / (7 * 86_400_000));
  const idx = ((weeks % pool.length) + pool.length) % pool.length;
  return pool[idx];
}

/** slug -> [project labels they own], so one DM can name all their sections. */
export function assignmentsBySlug(owners) {
  const out = {};
  for (const [project, slug] of Object.entries(owners)) {
    (out[slug] ??= []).push(project);
  }
  return out;
}

/** Render a member for a CHANNEL post: their Discord mention when resolved. */
function mentionFor(slug, mentions) {
  const id = mentions?.[slug];
  return id ? `<@${id}> (${slug})` : slug;
}

/**
 * Map slugs → discord_id from each `people/<slug>.md` frontmatter, so channel
 * posts actually ping people (a plain name doesn't notify on Discord).
 */
export function resolveDiscordIds(ctxDir, slugs) {
  const out = {};
  for (const slug of slugs) {
    try {
      const fm = matter(
        fs.readFileSync(path.join(ctxDir, 'people', `${slug}.md`), 'utf-8'),
      ).data;
      if (fm?.discord_id) out[slug] = String(fm.discord_id);
    } catch {
      // No people file / unreadable — leave unmapped, render the slug.
    }
  }
  return out;
}

function kickoffPost(weekKey, facilitator, slugs, mentions, docUrl, correctorUrl, correctorPassword) {
  const who = slugs.map((s) => mentionFor(s, mentions)).join(', ');
  const fac = facilitator ? mentionFor(facilitator, mentions) : 'TBD';
  const link = docUrl ? ` ${docUrl}` : '';
  // The corrector page lets owners fix the optimistic draft and copy it back —
  // a lower-friction path than the doc, and on-message (it's a draft, not a verdict).
  const corrector = correctorUrl
    ? `\n📝 Or correct my draft in one place — filter to your name, edit, then copy → DM it back to me: ` +
      `${correctorUrl}/${weekKey}.html` +
      (correctorPassword ? ` (password: ${correctorPassword})` : '')
    : '';
  return (
    `🗓️ Weekly meeting agenda for ${weekKey} is up.${link}\n` +
    `Facilitator: ${fac}. I've drafted each project's merged PRs/closed issues (linked), ` +
    `upcoming deadlines, and a goals read against the Q directives — it's a starting point, ` +
    `owners (${who}) please add what I missed before the meeting. I'll DM each of you and check back.${corrector}`
  );
}

function escalationPost(slug, asks, weekKey, mentions) {
  // Recovery-oriented, not a call-out: the most common cause of an "unfilled"
  // section is an update that was sent but never filed. Offer the self-heal path
  // and stop nudging — never frame it as the person being behind.
  const who = mentionFor(slug, mentions);
  return (
    `📝 I don't have ${who}'s agenda section for ${weekKey} yet, and I've stopped DMing them. ` +
    `If you already shared an update and it isn't in the doc, it may not have been filed — ` +
    `${who}, just reply "file my agenda update" (restating it) and I'll capture it. No rush.`
  );
}

function askText(weekKey, projects, askNumber, docUrl) {
  const sections = projects.length ? ` (${projects.join(', ')})` : '';
  const link = docUrl ? ` ${docUrl}` : '';
  if (askNumber === 1) {
    return (
      `Hi! Weekly meeting on ${weekKey} — time to fill in your agenda section${sections}. ` +
      `Reply here with your update(s) and I'll drop them into the agenda doc${link}. ` +
      `A few bullets is plenty. I'll check back until I hear from you (silence isn't consent 🙂).`
    );
  }
  return (
    `Reminder ${askNumber - 1} — still need your agenda update${sections} for ${weekKey}. ` +
    `Reply here and I'll file it into the doc. ` +
    `(Already replied but it wasn't filed? Say "file my agenda update" and restate it.)`
  );
}

/**
 * Decide this tick's actions from current state. Pure — no I/O, no clock — so
 * the build/nudge ladder is unit-testable. Returns the actions plus the next
 * state (never mutates the input state).
 */
export function planActions({ nowMs, cfg, slugs, assignments, facilitator, state, filled, built, refreshDue, mentions, docUrl }) {
  const out = { dms: [], posts: [], requestBuild: false, requestRefresh: false };
  const st = {
    ...state,
    members: Object.fromEntries(
      Object.entries(state.members ?? {}).map(([k, v]) => [k, { ...v }]),
    ),
  };

  // Phase 1 — get the doc built FIRST. (Re)request the build task until the
  // agent confirms it actually wrote + verified the skeleton (the `built`
  // marker). We announce and nudge NOTHING here, so the channel/owners are
  // never told the agenda is ready before it is.
  if (!built) {
    const last = st.buildKickedAt ? Date.parse(st.buildKickedAt) : 0;
    if (nowMs - last >= BUILD_RETRY_MS) {
      st.buildKickedAt = new Date(nowMs).toISOString();
      out.requestBuild = true;
    }
    return { ...out, state: st };
  }

  // Phase 2 — build verified. Announce once (now the "pre-filled" claim is
  // true), then run the owner nudge ladder.
  if (!st.announcedAt) {
    st.announcedAt = new Date(nowMs).toISOString();
    out.posts.push(
      kickoffPost(
        cfg.weekKey,
        facilitator,
        slugs,
        mentions,
        docUrl,
        cfg.correctorBaseUrl,
        cfg.correctorPassword,
      ),
    );
  }

  // Refresh pass — once the refresh window opens (refreshDue, computed by the
  // caller), re-pull fresh GitHub/deadline facts into the already-built doc.
  // Fires exactly once per week (the `refreshedAt` guard) and NEVER re-nudges
  // or resets owner content — that's enforced by the refresh task prompt.
  if (refreshDue && !st.refreshedAt) {
    st.refreshedAt = new Date(nowMs).toISOString();
    out.requestRefresh = true;
  }

  const nudgeMs = cfg.nudgeEveryDays * DAY_MS;
  for (const slug of slugs) {
    if (filled.has(slug)) continue;
    const m = st.members[slug] ?? { asks: 0, lastAskAt: null, escalated: false };
    const due = !m.lastAskAt || nowMs - Date.parse(m.lastAskAt) >= nudgeMs;
    if (due) {
      if (m.asks >= cfg.maxNudges) {
        if (!m.escalated) {
          m.escalated = true;
          out.posts.push(escalationPost(slug, m.asks, cfg.weekKey, mentions));
        }
      } else {
        m.asks += 1;
        m.lastAskAt = new Date(nowMs).toISOString();
        out.dms.push({ slug, text: askText(cfg.weekKey, assignments[slug] ?? [], m.asks, docUrl) });
      }
    }
    st.members[slug] = m;
  }

  return { ...out, state: st };
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

function buildTaskIpc({ cfg, weekKey, facilitator, nowMs }) {
  const facLine = facilitator
    ? `This week's facilitator is "${facilitator}".`
    : `No facilitator is set for ${weekKey} in the config — write "Facilitator: TBD — claim it" and ask the team to claim it.`;
  const orgLine = cfg.githubOrg
    ? `the "${cfg.githubOrg}" GitHub org`
    : `your profile's configured GitHub org`;
  const directivesLine = cfg.directivesDoc
    ? `the strategic directives at \`${cfg.directivesDoc}\` (the quarter's numbered priorities + success metrics)`
    : `the quarter's strategic directives if you can find them in the KB (artifacts/, look for "strategy"/"directives")`;
  const prompt =
    `Weekly meeting agenda build for ${weekKey}. Use the weekly-agenda skill (Build section).\n\n` +
    `You are producing a DECISION-READY agenda, not a bare skeleton. Make it genuinely useful: ` +
    `every recent piece of work shown with a clickable link and a one-line "what it did", deadlines surfaced, ` +
    `and progress read against the quarter's strategic goals. Read these KB sources FIRST and weave them in:\n` +
    `  • ${directivesLine}.\n` +
    `  • the deadline digest at \`${cfg.deadlineDigest}\` (auto-maintained; bucketed Overdue / This week / Next week).\n` +
    `  • each owner's \`people/<slug>.md\` for their \`github_username\` (use it to attribute GitHub activity).\n\n` +
    `STEPS:\n` +
    `1. In Google Doc ${cfg.docId}, FIRST archive the current contents of the "This Week" tab ` +
    `(tabId ${cfg.thisWeekTabId}) by appending them, under a "### ${weekKey}" heading, to the TOP of ` +
    `the Archive tab (tabId ${cfg.archiveTabId}). Never create a new tab — write only into these two existing tabs.\n` +
    `2. Replace the "This Week" tab with a fresh agenda dated ${weekKey}. ${facLine} Use these sections IN ORDER, ` +
    `and format for READABILITY — clear sections from real heading styles (H1 title, H2 per section, H3 per ` +
    `project), real bulleted lists (not "- " text), and REAL hyperlinks (link the title text to the URL; never ` +
    `paste raw URLs). Use bold SPARINGLY — the headings are the emphasis; do NOT bold labels or whole lines:\n` +
    `   🏁 Check In · ✍️ Revise Agenda\n` +
    `   📣 This Week in Brief — 2–3 sentences YOU write from the data below: what moved, what's stuck, and where the ` +
    `work needs hands. Frame it as the collective's shared picture (what the WORK needs), not a roll-call of who did ` +
    `what. Sign it with the facilitator's name — a rotating weave of the week, not a manager's report.\n` +
    `   🎯 Goals Review — one sub-bullet PER numbered strategic priority from the directives doc; for each, name the ` +
    `priority and give a plain one-line read on where the WORK stands vs its success metrics this week ` +
    `(on track / needs hands / blocked?), citing the shipped work below. This is a status read on the GOAL — never a ` +
    `verdict on a person: don't single anyone out, don't imply who is "behind".\n` +
    `   📅 Upcoming Deadlines — from the deadline digest, list items due THIS WEEK and NEXT WEEK that are still OPEN ` +
    `(skip ones marked ✅ done). Group any past-due-and-still-open items at the top under "Past due — worth a check-in" ` +
    `(a prompt to see what the task needs, not a callout on whoever holds it). Each line: the item as a hyperlink ` +
    `(to the GitHub issue/PR where it is one), its date, and the owner.\n` +
    `   🧑‍🏭 Contributor Pipeline · ‼️ Urgent Topics\n` +
    `   🌱 Active Projects — a collective "shipped this week" changelog, one H3 sub-heading per project reading ` +
    `"<Project> — <owner name>" (a real heading — no leading "•", no manual bold). Under each, list that owner's ` +
    `MERGED PRs and CLOSED issues from the LAST 7 DAYS, ` +
    `pulled from ${orgLine} by their github_username — each a hyperlink on "title (#num)" + a 4–8 word plain summary. ` +
    `Treat this as a DRAFT the owner edits/expands/corrects, not a final word. Merged PRs are an engineering-only, ` +
    `PARTIAL proxy: design, BD, community, care and organizing work rarely show up as a PR, so absence of PRs is NOT ` +
    `absence of contribution. If an owner had no merged/closed activity, do NOT write a "did nothing" line — write an ` +
    `open invitation instead: "— space for <name>'s update —". Under every owner leave one blank "• " bullet as room ` +
    `for them to add work GitHub can't see. Attribute work to the project whose repo it lives in; if ambiguous, list ` +
    `under their primary one.\n` +
    `   🎉 Appreciations (3 MINIMUM) · 💰 Other topics / Upcoming Time Off\n` +
    `   Also fold any upcoming calendar events (next 7 days) into the relevant section if a calendar is configured.\n` +
    `3. QUALITY BAR: easy to READ — clear heading sections, one line per bullet, every PR/issue/deadline a ` +
    `clickable link, and bold used SPARINGLY (past feedback: "everything is in bold and there are no clear ` +
    `sections" — so keep body text normal weight and let headings carry the structure). It should read like a ` +
    `clean, skimmable agenda a facilitator can run the meeting from, not a raw dump. Owners still flesh out their ` +
    `own narrative — you give them the scaffolding + the facts.\n` +
    `4. CORRECTOR PAGE DATA: write the SAME agenda as structured JSON to weekly-agenda/page-data/${weekKey}.json ` +
    `via modify_kb_file, so members can review and correct their sections on the corrector page. Use EXACTLY this ` +
    `shape (valid JSON only): {"week":"${weekKey}","facilitator":"<name>","docUrl":"<the doc url>","brief":"<the ` +
    `This Week in Brief text>","goals":[{"priority":"<P# — name>","read":"<one-line status on the work>"}],` +
    `"deadlines":[{"text":"<title>","date":"<YYYY-MM-DD>","owner":"<name>","url":"<github url or empty>",` +
    `"pastDue":true|false}],"members":[{"slug":"<slug>","name":"<display name>","projects":[{"project":"<Project>",` +
    `"items":[{"text":"<what shipped>","ref":"#<num or empty>","url":"<github url or empty>"}]}]}]}. One members[] ` +
    `entry per owner, one projects[] entry per project they own, items[] = their merged PRs / closed issues (an EMPTY ` +
    `array if none — the page renders an invitation, never a "did nothing" line).\n` +
    `5. VERIFY: re-read the "This Week" tab and confirm the real content landed (dated header, the Goals Review ` +
    `bullets, the Upcoming Deadlines list, and the per-project activity — not just empty section headers). ONLY if ` +
    `it did, mark the build done by writing the marker file weekly-agenda/built/${weekKey}.md via modify_kb_file ` +
    `(a one-line note is fine). Do NOT post anything to the channel on success — the flow announces it once the ` +
    `marker exists.\n` +
    `6. If the doc write or verification FAILED (e.g. tab not found, no Docs access), do NOT write the marker — ` +
    `instead post a short message in this channel saying the agenda build failed and why, so a human can fix it.\n\n` +
    `Tone: a shared mirror, not a scoreboard. You're a peer tool inside a cooperative, not a manager over it — point ` +
    `the agenda at the WORK and what it needs, never at ranking people. Helpful and crisp; a rich starting point the ` +
    `team fills in.`;
  return {
    type: 'schedule_task',
    taskId: `weekly-agenda-build-${weekKey}-${nowMs}`,
    prompt,
    schedule_type: 'once',
    schedule_value: localStamp(nowMs + 2 * 60_000),
    context_mode: 'isolated',
    targetJid: cfg.channelJid,
    timestamp: new Date(nowMs).toISOString(),
  };
}

function refreshTaskIpc({ cfg, weekKey, nowMs }) {
  const orgLine = cfg.githubOrg
    ? `the "${cfg.githubOrg}" GitHub org`
    : `your profile's configured GitHub org`;
  const prompt =
    `Weekly meeting agenda REFRESH for ${weekKey}. The agenda was already built earlier this week and ` +
    `owners may have filled in their sections since — this is a LIGHT refresh of the AUTO-PULLED facts only, ` +
    `NOT a rebuild.\n\n` +
    `DO NOT: archive anything, reset or replace the "This Week" tab, change the facilitator line, or touch ` +
    `Goals Review prose, Appreciations, Urgent Topics, owner-written narrative, or any human edit. DO NOT DM ` +
    `anyone, post a kickoff, or write any marker file (the build marker already exists).\n\n` +
    `DO: In Google Doc ${cfg.docId}, "This Week" tab (tabId ${cfg.thisWeekTabId}), update ONLY the auto-pulled ` +
    `facts so the agenda is current for today's meeting:\n` +
    `  • Under "🌱 Active Projects", for each project sub-heading ("<Project> — <owner>"), re-pull that owner's ` +
    `MERGED PRs and CLOSED issues from the LAST 7 DAYS from ${orgLine} (by their people/<slug>.md github_username) ` +
    `and update the auto-pulled activity bullets — the linked "title (#num) — summary" lines, or the ` +
    `"space for <name>'s update" placeholder. Keep real hyperlinks and real bullets.\n` +
    `  • Refresh "📅 Upcoming Deadlines" from \`${cfg.deadlineDigest}\` (open items due this/next week; overdue on top).\n\n` +
    `CRITICAL — preserve human content: only replace bullets you can clearly tell are auto-pulled GitHub/deadline ` +
    `facts. If an owner has added their own narrative under a project, leave it and update the GitHub bullets ` +
    `alongside it — never overwrite it. If you cannot cleanly tell auto-pulled from human content in a section, ` +
    `LEAVE THAT SECTION UNTOUCHED.\n\n` +
    `When done: do NOT write a marker and do NOT message the channel — just stop. Only if the doc can't be ` +
    `read/written, post one short line in this channel explaining why.`;
  return {
    type: 'schedule_task',
    taskId: `weekly-agenda-refresh-${weekKey}-${nowMs}`,
    prompt,
    schedule_type: 'once',
    schedule_value: localStamp(nowMs + 2 * 60_000),
    context_mode: 'isolated',
    targetJid: cfg.channelJid,
    timestamp: new Date(nowMs).toISOString(),
  };
}

/** Atomic write: IPC watchers only pick up `*.json`, so write `.tmp` first. */
function writeIpcFile(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path.join(dir, name));
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * One scheduler tick: read config + state from the KB, decide actions, emit
 * IPC files, persist state. Exported (with injectable paths/clock/plugin
 * config) so tests can drive it against a temp profile dir. Returns the plan,
 * or null when the flow is unconfigured / out of the prep window.
 *
 * `pluginConfig` is the normalized plugin CONFIG (see resolvePluginConfig): its
 * `sharedKbGroup` overrides which group the flow watches, and its `defaults`
 * fill any cadence/pool key the KB config.md omits.
 */
export function tick({ profileDir, logger, nowMs, pluginConfig = {} }) {
  const pc = resolvePluginConfig(pluginConfig);
  let sharedKb = pc.sharedKbGroup || 'slack_main';
  if (!pc.sharedKbGroup) {
    try {
      const cfg = JSON.parse(
        fs.readFileSync(path.join(profileDir, 'profile.config.json'), 'utf-8'),
      );
      if (typeof cfg.sharedKbGroup === 'string' && cfg.sharedKbGroup) {
        sharedKb = cfg.sharedKbGroup;
      }
    } catch {
      /* fall through to default */
    }
  }

  const ctxDir = path.join(profileDir, 'groups', sharedKb, 'context');
  const configPath = path.join(ctxDir, 'weekly-agenda', 'config.md');
  if (!fs.existsSync(configPath)) return null; // not configured → no-op

  const cfg = parseConfig(fs.readFileSync(configPath, 'utf-8'), pc.defaults);
  if (!cfg.channelJid || Object.keys(cfg.owners).length === 0) {
    logger.warn(
      { configPath },
      'weekly-agenda: config.md needs `channel_jid` and an `owners` map',
    );
    return null;
  }

  const { weekKey, meetingMs, windowStartMs } = meetingWindow(
    nowMs,
    cfg.meetingDay,
    cfg.meetingHour,
    cfg.prepDaysBefore,
  );
  if (nowMs < windowStartMs || nowMs >= meetingMs) return null; // outside prep window

  // The refresh window opens `refresh_hours_before` hours before the meeting
  // (disabled when 0). We're already inside the prep window and before the
  // meeting here, so this is always a sub-window of it.
  const refreshDue =
    cfg.refreshHoursBefore > 0 && nowMs >= meetingMs - cfg.refreshHoursBefore * HOUR_MS;

  const assignments = assignmentsBySlug(cfg.owners);
  const slugs = Object.keys(assignments);
  const facilitator = pickFacilitator(weekKey, cfg.facilitators, cfg.facilitatorPool);

  const statePath = path.join(ctxDir, 'weekly-agenda', 'state', `${weekKey}.json`);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    /* fresh week */
  }

  const inputsDir = path.join(ctxDir, 'weekly-agenda', 'inputs', weekKey);
  const filled = new Set(
    fs.existsSync(inputsDir)
      ? fs.readdirSync(inputsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
      : [],
  );

  // The build agent writes this marker only AFTER it has written the skeleton
  // and re-read the tab to confirm it landed. Its existence is what unlocks the
  // announce + nudges (so we never announce an unbuilt doc).
  const built = fs.existsSync(
    path.join(ctxDir, 'weekly-agenda', 'built', `${weekKey}.md`),
  );

  const mentions = resolveDiscordIds(ctxDir, [...slugs, facilitator].filter(Boolean));
  const docUrl = cfg.docId ? `https://docs.google.com/document/d/${cfg.docId}/edit` : '';

  const plan = planActions({
    nowMs,
    cfg: { weekKey, ...cfg },
    slugs,
    assignments,
    facilitator,
    state,
    filled,
    built,
    refreshDue,
    mentions,
    docUrl,
  });

  // Same-group IPC namespace: the shared-KB group's own dirs, so the
  // orchestrator authorizes `dm_user`/`message`/`schedule_task` as same-group.
  const ipcDir = path.join(profileDir, 'data', 'ipc', sharedKb);
  if (plan.requestBuild) {
    writeIpcFile(
      path.join(ipcDir, 'tasks'),
      buildTaskIpc({ cfg: { weekKey, ...cfg }, weekKey, facilitator, nowMs }),
    );
  }
  if (plan.requestRefresh) {
    writeIpcFile(
      path.join(ipcDir, 'tasks'),
      refreshTaskIpc({ cfg: { weekKey, ...cfg }, weekKey, nowMs }),
    );
  }
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

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  atomicWrite(statePath, JSON.stringify(plan.state, null, 2));

  if (plan.dms.length || plan.posts.length || plan.requestBuild || plan.requestRefresh) {
    logger.info(
      {
        weekKey,
        dms: plan.dms.length,
        posts: plan.posts.length,
        buildRequested: plan.requestBuild,
        refreshRequested: plan.requestRefresh,
      },
      'weekly-agenda: actions emitted',
    );
  }
  return plan;
}

/**
 * Catalog plugin entry point. `api` carries the framework surface (including
 * `profileDir`, since a catalog plugin lives outside the profile) and `config`
 * is this plugin's own config object (PLUGIN_CONFIG['weekly-agenda'] ?? {}).
 */
export default function register({ registerIntegration, logger, profileDir }, config = {}) {
  const pc = resolvePluginConfig(config);
  let timer = null;
  registerIntegration({
    name: 'weekly-agenda',
    start: () => {
      const run = () => {
        try {
          tick({ profileDir, logger, nowMs: Date.now(), pluginConfig: config });
        } catch (err) {
          logger.error({ err }, 'weekly-agenda: tick failed');
        }
      };
      // First tick shortly after startup (lets channels/IPC watcher settle),
      // then on the regular cadence. Timers are unref'd so this flow never
      // keeps a shutting-down process alive.
      const first = setTimeout(run, pc.firstTickDelayMs);
      first.unref?.();
      timer = setInterval(run, pc.tickMs);
      timer.unref?.();
      logger.info({ tickMs: pc.tickMs }, 'weekly-agenda flow started');
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
}
