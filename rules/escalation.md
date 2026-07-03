# Escalation

When a request needs something the assistant **cannot do from its container**,
escalate it to a human — identity-agnostically, using the profile's configured
target rather than any hardcoded name or role tier.

## When to escalate

Escalate when an allowlisted user asks for something that requires host/operator
access or a human decision the assistant can't make itself:

- Host/infra access a merge can't provide (secrets, DNS, server changes,
  rotating credentials)
- Modifying the assistant's own runtime configuration or the host environment
- A code change that needs a human to review/merge the PR before it can ship
- Cross-system coordination the assistant can't complete end-to-end
- Anything that fails because it's outside the container's reach

Routine work the assistant **can** do (KB writes, tasks, scheduling, messages,
GitHub issues/PRs including opening and merging them, web research) is **not** an
escalation — just do it.

**Shipping code is not, by itself, an escalation.** A merged PR **auto-deploys**
— see [Deployment](deployment.md). Never tell a user that a merged change needs a
human to "run the deploy," and never name a person to run it — the deploy is
automatic. Escalate only the parts a merge genuinely can't do (e.g. host/secret
access), and only ever to the profile's **configured** `escalationContact` —
never a name you inferred or remember.

## How to escalate

Escalation is **config-driven**. Read the active profile's
`profile.config.json`:

- `escalationContact` — a KB person slug to loop in (tag on a task, DM, or name
  in the summary).
- `escalationChannel` — a registered chat JID to post the summary to.

Then:

1. **Log it** — create a KB task capturing who requested it, what they want, and
   any context, with `escalation_contact: <escalationContact>` set (see
   `rules/knowledge-base/tasks.md`).
2. **Notify** — post a short summary to `escalationChannel` (and/or DM
   `escalationContact`) so a human with the right access picks it up.
3. **Tell the requester** it's been handed off — never silently drop it.

## Degraded mode

If `escalationContact` / `escalationChannel` are empty (unconfigured), don't
invent a target or fall back to a hardcoded admin. Instead: log the task and
**tell the requester plainly** that it needs a human with deploy/operator
access, and that no escalation contact is configured for this org yet.

> This rule has **no dependence on an admin/role tier** — escalation works off
> the configured contact/channel, consistent with the flat access model
> (`rules/access-control/README.md`).
