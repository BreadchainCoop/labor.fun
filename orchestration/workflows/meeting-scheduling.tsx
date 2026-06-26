/**
 * meeting-scheduling.tsx — makes the meeting-task approval flow (Pattern B,
 * src/ipc.ts:1681-1991) *robust* by adding a calendar-aware scheduling stage in
 * front of the human approval gate.
 *
 * Today a proposed meeting is just text — a human eyeballs a time. With Smithers
 * we can, before asking anyone:
 *   1. resolve each participant's timezone + calendar handle from the KB,
 *   2. fan out a free/busy read per participant IN PARALLEL,
 *   3. intersect availability, respect each person's working hours in THEIR
 *      OWN timezone, and rank candidate slots,
 *   4. pre-propose the best few hours,
 *   5. suspend on `needsApproval` until a human/participant picks one,
 *   6. book the event and write the KB task.
 *
 * This is why Smithers fits: step 2 is genuine parallel fan-out (one durable
 * sub-step per participant, each resumable), step 3 is a single reasoning step,
 * and step 5 is the same human gate the expense flow uses. A crash after 4 of 6
 * free/busy reads resumes at the 5th instead of re-querying everyone.
 *
 * ── REMOTE-ENV REQUIREMENT ──────────────────────────────────────────────────
 * The free/busy and booking steps need calendar access *inside the container*
 * (a google-calendar MCP server wired into the agent container, with per-group
 * OAuth via the credential vault) plus each person's timezone in their
 * context/people/<slug>.md frontmatter. Neither is assumed to exist yet — see
 * docs/SMITHERS-ORCHESTRATION.md § "Remote environment requirements".
 * VERIFY-ON-INSTALL: <Parallel>, map-in-JSX, and ctx.outputs against the package.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { createSmithers, Sequence, Parallel } from 'smithers-orchestrator';
import { z } from 'zod';

import { ContainerAgent } from '../agents/container-agent.js';
import { chainFor, type TaskKind } from '../model-router.js';
import { getRunStep } from '../runtime.js';

const slot = z.object({
  startIso: z.string(),
  endIso: z.string(),
  /** Per-participant local time, so the proposal reads naturally for each. */
  localTimes: z.array(z.object({ person: z.string(), local: z.string() })),
  score: z.number(), // higher = better (more inside everyone's working hours)
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({
    group: z.string(),
    chatJid: z.string(),
    title: z.string(),
    participants: z.array(z.string()), // KB people slugs
    windowStartIso: z.string(),
    windowEndIso: z.string(),
    durationMinutes: z.number(),
  }),
  // One row per participant from the parallel availability fan-out.
  availability: z.object({
    person: z.string(),
    timezone: z.string(),
    busy: z.array(z.object({ startIso: z.string(), endIso: z.string() })),
  }),
  proposal: z.object({ slots: z.array(slot) }),
  booked: z.object({ eventId: z.string(), startIso: z.string(), kbPath: z.string() }),
});

function agentsFor(kind: TaskKind, group: string, chatJid: string, allowedTools?: string[]) {
  const runStep = getRunStep();
  return chainFor(kind).map(
    (spec) => new ContainerAgent({ spec, group, chatJid, runStep, allowedTools }),
  );
}

export default smithers((ctx) => {
  const { group, chatJid, title, participants, windowStartIso, windowEndIso, durationMinutes } =
    ctx.input;

  // Calendar reads are read-only; booking needs the calendar write tool.
  const calRead = ['Read', 'mcp__google-calendar__get-freebusy', 'mcp__google-calendar__list-calendars'];
  const calWrite = ['Read', 'mcp__google-calendar__create-event'];

  return (
    <Workflow name="meeting-scheduling">
      <Sequence>
        {/* 1+2. One durable, parallel availability read per participant. */}
        <Parallel>
          {participants.map((person) => (
            <Task
              key={person}
              id={`availability:${person}`}
              output={outputs.availability}
              agent={agentsFor('availability', group, chatJid, calRead)}
            >
              {`Read ${person}'s timezone from context/people/${person}.md and their ` +
                `calendar free/busy between ${windowStartIso} and ${windowEndIso}. ` +
                `Return timezone + busy intervals only.`}
            </Task>
          ))}
        </Parallel>

        {/* 3+4. Intersect availability, respect each person's local working */}
        {/*       hours, rank candidate slots, pre-propose the best few. */}
        <Task id="propose" output={outputs.proposal} agent={agentsFor('schedule', group, chatJid)}>
          {`Given everyone's timezone + busy intervals (${JSON.stringify(
            ctx.outputs.availability,
          )}), find ${durationMinutes}-minute slots in [${windowStartIso}, ${windowEndIso}] ` +
            `that fall inside 09:00–18:00 LOCAL time for every participant. Rank by how ` +
            `central the hour is for all (penalize early/late outliers). Return the top 3 ` +
            `with each participant's local time. Title: "${title}".`}
        </Task>

        {/* 5. Human gate — suspends until someone confirms a slot. */}
        <Task id="confirm" output={outputs.proposal} agent={agentsFor('render', group, chatJid)} needsApproval>
          {`Post the proposed slots to the group and await a pick. Slots: ${JSON.stringify(
            ctx.latest('proposal', 'propose')?.slots,
          )}`}
        </Task>

        {/* 6. Book the chosen slot and file the KB task. */}
        <Task id="book" output={outputs.booked} agent={agentsFor('schedule', group, chatJid, calWrite)}>
          {`Create the calendar event for the confirmed slot, invite ${participants.join(
            ', ',
          )}, and write the meeting task to context/tasks/. Confirm back with the event link.`}
        </Task>
      </Sequence>
    </Workflow>
  );
});
