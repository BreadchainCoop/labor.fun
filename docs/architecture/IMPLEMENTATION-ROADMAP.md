# Breadbrich Engels Orchestration — Implementation Roadmap

**Status:** awaiting Phase 0 approval
**Estimated total:** 5-7 weeks from Phase 0 approval to Phase 5 cleanup

## Guiding principles

1. **Smallest blast radius first.** Each phase must be independently verifiable + rollback-able.
2. **No bundling.** Each phase has its own PR, its own deploy, its own verify window.
3. **Docs in the same PR.** State inventory and recovery map stay current.
4. **Golden-path validation every phase.** Send test message, verify response, check observations.

## Phase 0 — Docs + safety net

**Deliverables (this PR):**
- ✅ BREADBRICH-ORCHESTRATION.md
- ✅ DATA-INVENTORY.md
- ✅ STATE-RECOVERY-MAP.md
- ✅ MIGRATION-RUNBOOK.md
- ✅ routing-rules.yaml
- ✅ breadbrich-architecture.html
- ✅ IMPLEMENTATION-ROADMAP.md (this file)

**Gates:**
- User reviews HTML viz standalone
- User approves routing rules (especially credential + cross-chat rules)
- PR merged to cvnt/main
- Tag `v2.0.0-spec`

**State already preserved (2026-04-21):**
- Pre-migration master tarball (droplet + local, SHA256 verified)
- 15 merged branches deleted, 3 preserved as tags on remote
- Droplet src divergence resolved
- breadbrich-tunnel.service deprecated + masked
- Memory file `reference_breadbrich_state_recovery.md` written

**Still to do before Phase 1:**
- [ ] GPG-encrypt master tarball (needs user passphrase)
- [ ] Third-offsite copy (iCloud / S3 / external drive)
- [ ] Stand up staging VPS
- [ ] Run context drain on prod (read-only)

**Estimated Phase 0 duration:** 1 week (mostly review + sign-off)

## Phase 1 — Cosmetic rename

**Goal:** users see "Breadbrich Engels" everywhere; `breadbrich.service` is a working alias to `breadbrich.service`.

**Changes:**
- `/etc/systemd/system/breadbrich.service` gets `Alias=breadbrich.service` in `[Install]`
- Same for `breadbrich-kb.service` → `breadbrich-kb.service`
- Cloudflare dashboard: tunnel label rename (UUID + DNS unchanged)

**Non-changes:**
- Filesystem paths stay `/opt/breadbrich/` — Phase 3
- User account stays `breadbrich` — Phase 4 (skip)
- DB schema — none

**Verify:**
- Both `systemctl status breadbrich` and `systemctl status breadbrich` report the same unit
- `systemctl restart breadbrich` works
- Bot responds to TG + Slack test messages
- Dashboard kb.example.com loads

**Estimated duration:** 1 day + 1 week verify window

**Rollback:** `mv breadbrich.service.bak → breadbrich.service && systemctl daemon-reload`

## Phase 2 — the central orchestrator orchestrator (the main work)

**Goal:** evolve `breadbrich.service` from router → full orchestrator.

### 2.a — SDK + session manager
**Files changed:**
- `package.json` — add `@anthropic-ai/sdk`
- `src/index.ts` — initialize Anthropic client at startup
- `src/sessions.ts` (new) — per-chat SDK session manager keyed on `(group_folder, sender_identity)`
- `src/types.ts` — new `Session` and `SessionManager` types
- Tests: session create/resume, credential injection via proxy

### 2.b — Routing engine
**Files changed:**
- `src/router-rules.ts` (new) — load `docs/architecture/routing-rules.yaml`, validate, evaluate
- `src/rule-types.ts` (new) — rule schema types
- `src/index.ts` — wire rule evaluator into message path
- Tests: rule precedence, auth check, visibility filter, fallback behavior

### 2.c — Classifier pre-pass
**Files changed:**
- `src/classifier.ts` (new) — Haiku call with `request_type` + `urgency` + `needs_big_breadbrich` output
- `src/index.ts` — call classifier before SDK, short-circuit on `casual_social`
- Tests: classifier output shape, skip-on-casual

### 2.d — Thin-forwarder containers
**Files changed:**
- `container/agent-runner/src/index.ts` — remove Claude SDK init, add forward loop
- `container/agent-runner/src/ipc-mcp-stdio.ts` — remove MCP tool registration (the central orchestrator has these now)
- `container/agent-runner/src/forward.ts` (new) — write `type=forward_to_big_breadbrich`, poll for response
- `container/build.sh` — no changes, image rebuilds
- `src/ipc.ts` — new `type=forward_to_big_breadbrich` handler + `type=response` writer
- Tests: forward + relay round-trip, timeout behavior

### 2.e — Observer + Reflector + Curator
**Files changed:**
- `src/dreaming/observer.ts` (new) — scheduled task that extracts facts
- `src/dreaming/reflector.ts` (new) — daily consolidation + duplicate detection
- `src/dreaming/curator.ts` (new) — weekly tiering + cleanup
- `src/dreaming/memory-index.ts` (new) — maintains per-chat `MEMORY.md` pointer file
- `scripts/schedule-dreaming.sh` (new) — seeds initial scheduled_tasks rows on first deploy
- Tests: observer replay on sample transcript, dedup accuracy

**Order within Phase 2:**
1. 2.a SDK wiring (standalone, no behavior change yet)
2. 2.b rule engine (loads YAML, evaluates but doesn't yet gate)
3. 2.c classifier (shadow mode — logs but doesn't skip)
4. 2.d thin forwarder (one group first — slack_main — then roll TG group by group)
5. 2.e dreaming jobs (observer first, then reflector after 1 week of observations)

**Verify (per sub-phase):**
- 2.a: unit tests pass; SDK call from host works in dev
- 2.b: rule-matcher tests on all routing-rules.yaml entries
- 2.c: classifier accuracy on sample set; casual_social detection rate
- 2.d: test message via slack_main → response within 10s; no Claude calls in container logs
- 2.e: observations.md grows; Reflector produces non-empty consolidation; Curator tiers correctly

**Estimated duration:** 3 weeks

**Rollback:** safe-deploy auto-rollback; if partial, restore from pre-deploy tarball.

## Phase 3 — Filesystem rename

**Goal:** `/opt/breadbrich/` → `/opt/breadbrich/` with symlink bridge.

See MIGRATION-RUNBOOK.md §Phase 3 for detailed steps.

**Key files touched:**
- `/etc/systemd/system/*.service` — WorkingDirectory + ExecStart paths updated
- `scripts/safe-deploy.sh` — path references updated
- `scripts/backup.sh` — path references updated
- `CLAUDE.md` files across groups that reference `/opt/breadbrich/`
- Documentation in `docs/`

**Estimated duration:** 1 day + 1-month verify window before Phase 5

## Phase 4 — User account rename (RECOMMEND SKIP)

Research concluded: high risk, low reward. System usernames are invisible to end-users.

If pursued: see MIGRATION-RUNBOOK.md §Phase 4.

**Estimated duration:** if done, 1 day + 2 weeks verify + ongoing cleanup

## Phase 5 — Cleanup

After Phase 3 has baked 1 month:
- Remove `/opt/breadbrich.old`
- Drop systemd `breadbrich.service` alias (keep only `breadbrich.service`)
- Delete `/opt/breadbrich` symlink
- Archive old backups
- Tag repo `v3.0.0`

**Estimated duration:** 1 day

## Post-Phase-5 — Deferred work

Items from the original edit/delete message planning + other discovered items:

| Item | Owner | Priority |
|---|---|---|
| `delete_message` + `edit_message` MCP tools (TASK-037 follow-on) | TBD | Medium |
| `get_recent_sent_messages` tool (so Breadbrich Engels can edit what it sent) | TBD | Medium |
| `once`-timestamp UTC bug fix | TBD | High — keeps burning people |
| Voice message transcription in container (whisper + ffmpeg) | TBD | Low |
| Staging bot @breadbrich_staging_bot formally registered | TBD | Medium |
| kb-ui routing rule editor (admin-only runtime toggling) | TBD | Low |
| Observer cross-chat mode (with explicit privacy opt-in) | TBD | Deferred |

## Timeline overview

```
Week 1: Phase 0 PR merged, tag v2.0.0-spec, third-offsite backup
Week 2: Phase 1 cosmetic rename + verify
Week 3-5: Phase 2 the central orchestrator orchestrator (sub-phases a → e)
Week 6: Phase 3 filesystem rename
Week 7-10: Phase 3 verification window (1 month)
Week 11: Phase 5 cleanup + v3.0.0
Weeks 11+: Deferred work
```

Assumes no major blockers. Realistically budget 7-10 weeks to v3.0.0.

## Acceptance criteria for "done"

v3.0.0 tagged when:
- All 3 channels (Slack, TG groups, TG DMs) confirmed working post-rename
- Observer producing observations for 2+ weeks
- Reflector consolidating without human intervention needed
- Routing rules YAML committed as source-of-truth for request gating
- No reference to "breadbrich" in production deployment (paths, services, logs) except archived backups
- STATE-RECOVERY-MAP.md reflects v3.0.0 topology
- One documented disaster-recovery drill run on staging (restore master tarball, verify services come up)

## Risks carried forward

| Risk | Mitigation |
|---|---|
| Rate limits on increased SDK usage (the central orchestrator handling all reasoning) | Cheap Haiku classifier gates. Per-chat session reuse. Monitor spend daily. |
| Observer hallucination polluting KB | Writes through `modify_kb_file` RBAC; nothing auto-merges to canonical KB without human review queue |
| Thin-forwarder IPC hop adds latency | Measured in Phase 2.d; acceptable if <500ms; typing indicator covers user perception |
| Routing rules YAML grows unruly | Keep <20 rules in v1; HTML viz for audit; require PR review for changes |
| The infra owner's Cloudflare tunnel changes during migration | Coordinated — the infra owner owns `cloudflared.service`; we don't touch it |
