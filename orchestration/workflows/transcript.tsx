/**
 * transcript.tsx — pilot durable workflow: meeting transcript → structured KB
 * items → HTML slideshow. Mirrors container/skills/transcript-processor, but as
 * a checkpointed Smithers graph so a crash mid-extraction resumes instead of
 * re-running the whole thing, and each step runs at its own model tier.
 *
 * Step → tier mapping lives in model-router.ts, NOT here. Each <Task> asks the
 * router for a fallback chain and gets escalation (cheap/local → strong on
 * validation failure) for free. To move bulk steps onto a local model, edit the
 * router's TIERS — this file does not change.
 *
 * VERIFY-ON-INSTALL: import names from `smithers-orchestrator` (createSmithers,
 * Sequence) and the <Task> prop names match the documented API; confirm against
 * the installed package after `bunx smithers-orchestrator init`.
 */

import { createSmithers, Sequence } from 'smithers-orchestrator';
import { z } from 'zod';

import { ContainerAgent } from '../agents/container-agent';
import { chainFor, type TaskKind } from '../model-router';
import { getRunStep } from '../runtime';

const actionItem = z.object({
  description: z.string(),
  assignee: z.string(),
  due_date: z.string().nullable(),
  priority: z.enum(['high', 'medium', 'low']),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({
    group: z.string(),
    chatJid: z.string(),
    transcript: z.string(),
  }),
  parsed: z.object({
    speakers: z.array(z.string()),
    date: z.string().nullable(),
    topics: z.array(z.string()),
  }),
  extracted: z.object({
    actionItems: z.array(actionItem),
    events: z.array(z.object({ title: z.string(), date: z.string().nullable() })),
    people: z.array(z.object({ name: z.string(), role: z.string().nullable() })),
  }),
  reconciled: z.object({
    kbWrites: z.array(z.object({ path: z.string(), summary: z.string() })),
    matchedPeople: z.array(z.string()),
  }),
  rendered: z.object({ html: z.string() }),
});

/**
 * Build the escalating agent chain for a step. `chainFor` returns
 * [baseTier, ...escalations]; we wrap each in a ContainerAgent so Smithers'
 * `agent={[primary, fallback]}` advances to the stronger model on failure.
 */
function agents(kind: TaskKind, group: string, chatJid: string, allowedTools?: string[]) {
  const runStep = getRunStep();
  return chainFor(kind).map(
    (spec) => new ContainerAgent({ spec, group, chatJid, runStep, allowedTools }),
  );
}

export default smithers((ctx) => {
  const { group, chatJid, transcript } = ctx.input;
  // Extraction is read-only; reconcile/render may write KB via the IPC tools.
  const readOnly = ['Read', 'Grep', 'Glob'];

  return (
    <Workflow name="transcript">
      <Sequence>
        <Task id="parse" output={outputs.parsed} agent={agents('parse', group, chatJid, readOnly)}>
          {`Identify the speakers, meeting date, and topic clusters in this transcript. Return only the structured fields.\n\n${transcript}`}
        </Task>

        <Task
          id="extract"
          output={outputs.extracted}
          agent={agents('extract', group, chatJid, readOnly)}
        >
          {`From the transcript, extract action items, events, and newly-mentioned people. Topics already identified: ${ctx
            .latest('parsed', 'parse')
            ?.topics?.join(', ')}.\n\n${transcript}`}
        </Task>

        <Task id="reconcile" output={outputs.reconciled} agent={agents('reconcile', group, chatJid)}>
          {`Cross-reference the extracted people and action items against context/people/ and context/tasks/. Write/merge KB files via your tools and report what you wrote. Items: ${JSON.stringify(
            ctx.latest('extracted', 'extract'),
          )}`}
        </Task>

        <Task id="render" output={outputs.rendered} agent={agents('render', group, chatJid)}>
          {`Produce a self-contained HTML slideshow summary of this meeting from the reconciled items: ${JSON.stringify(
            ctx.latest('reconciled', 'reconcile'),
          )}`}
        </Task>
      </Sequence>
    </Workflow>
  );
});
