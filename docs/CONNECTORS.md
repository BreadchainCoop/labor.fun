# Knowledge Connectors (RAG)

Connectors sync documents from external sources (Notion, Google Drive, …)
**into the existing per-group markdown KB**. Once a doc lands in the KB, it
inherits everything the KB already gives you for free:

- **Per-doc RBAC** — synced docs carry a `visibility` frontmatter field, so the
  access-control rules apply exactly as they do to hand-authored docs.
- **Search** — synced docs are plain markdown under `context/`, so the agent
  finds them with the same tools it uses for the rest of the KB.
- **Citations** — every synced doc carries a `title` and a `source_url` in
  frontmatter (the Notion/Drive URL), so the citations skill renders a link
  back to the origin document.

This is the "ground answers in your data" capability that Dust / Glean /
Cassidy / Albus lead with — here it's just markdown in the KB.

## Where synced docs live

```
profiles/<org>/groups/<sharedKbGroup>/context/connectors/<source>/<docId>.md
```

- `<source>` is the connector name (`notion`, `google-drive`).
- `<docId>` is a **sanitized** stable id from the source (a Notion page id, a
  Drive file id). Sanitization guarantees the id can never escape the connector
  directory — path separators and `..` are collapsed (see `sanitizeDocId` /
  `docPath` in `base.ts`, and the path-safety tests).
- One file **per page / per document** — so a citation lands on a specific page,
  not a whole database or folder.

Every file gets standard KB frontmatter plus citation + reconcile fields:

```yaml
---
id: <stable source id>
title: <document title>          # citation label
source: notion                   # which connector wrote this
source_url: https://…            # citation target (the origin doc URL)
source_updated_at: 2026-06-01T…  # upstream last-edited time
created_by: notion-connector
created_at: 2026-06-01
visibility: restricted            # RBAC — defaults NOT world-open; overridable (see below)
editable_by: admins
tags: [connector, notion-synced]
synced_at: 2026-06-02T…          # reconcile marker (see "Deletion" below)
---

[View source](https://…)

…converted markdown body…
```

Hand-authored files elsewhere in the KB are never touched — connectors only
write under `context/connectors/<source>/`.

## Enabling a connector

Connectors are **off by default** and **env-gated**. Nothing runs until you set
the relevant scope env vars (and provide credentials). Secrets are read via
`readEnvFile` (`.env`) / the OneCLI vault, never hardcoded, never logged.

Shared knob for all connectors:

| Env | Default | Meaning |
|---|---|---|
| `CONNECTOR_SYNC_INTERVAL_MS` | `1800000` (30 min) | Poll interval for every connector loop. `0` disables all connectors. |

### Notion

| Env | Required | Meaning |
|---|---|---|
| `NOTION_API_KEY` | yes | Notion **internal integration** token. Create an integration at notion.so/my-integrations and **share** the pages/databases you want synced with it. Read-only content scope is enough. |
| `NOTION_DATABASE_IDS` | one of these | Comma-separated Notion **database** ids. Every page (row) in the database is synced as one doc. |
| `NOTION_ROOT_PAGE_IDS` | one of these | Comma-separated Notion **page** ids. The page (and its direct child pages) are synced. |
| `NOTION_DEFAULT_VISIBILITY` | no | Overrides the default `visibility` frontmatter for every doc this connector syncs (default `restricted` — see "Visibility defaults" below). One of `open` / `restricted` / `private`; an unrecognized value is ignored and the safe default is kept. |

The connector converts Notion blocks → markdown (headings, lists, to-dos,
quotes, code, callouts, toggles, inline bold/italic/code/links) and preserves
the Notion page URL as `source_url`. **Full pull every run**: every configured
database/root page is re-listed and every page's blocks re-fetched on each
tick (see "How sync works" below for why).

Enable example (`.env`):

```
NOTION_API_KEY=secret_…
NOTION_DATABASE_IDS=abcd1234efgh5678,…
NOTION_ROOT_PAGE_IDS=1111aaaa2222bbbb
```

### Google Drive

Auth **reuses the existing Google Workspace credentials** — the same OAuth
creds file the container's `gws` tool uses. You do not configure a second
Google auth.

| Env | Required | Meaning |
|---|---|---|
| `GOOGLE_WORKSPACE_CREDENTIALS_FILE` | yes | Path to the Google Workspace OAuth credentials JSON (already used for the `gws` MCP). The connector mints/uses an access token from it to call the Drive + Docs REST APIs. The token needs Drive **read** + Docs **read** scope. |
| `GOOGLE_DRIVE_FOLDER_IDS` | yes | Comma-separated Drive **folder** ids. Every Google Doc in each folder (and one level of subfolders) is synced as one doc. |
| `GOOGLE_DRIVE_DEFAULT_VISIBILITY` | no | Overrides the default `visibility` frontmatter for every doc this connector syncs (default `restricted` — see "Visibility defaults" below). One of `open` / `restricted` / `private`; an unrecognized value is ignored and the safe default is kept. |

The connector lists Google Docs via the Drive API, exports each via the Docs
API, and converts the structured document → markdown (heading styles → `#`,
bullets → lists, bold/italic/links inline). `source_url` is the Drive
`webViewLink`. **Full pull every run**: every configured folder (and its
immediate subfolders) is re-listed and every Doc re-exported on each tick.

Enable example (`.env`):

```
GOOGLE_WORKSPACE_CREDENTIALS_FILE=/home/breadbrich/.config/gws/credentials.json
GOOGLE_DRIVE_FOLDER_IDS=0AbCdEf…,1GhIjKl…
```

### Confluence

Mirrors Confluence Cloud wiki pages. Auth is **Basic** (`email:api-token`) with
an Atlassian API token created at
id.atlassian.com/manage-profile/security/api-tokens.

| Env | Required | Meaning |
|---|---|---|
| `CONFLUENCE_BASE_URL` | yes | Your Confluence site, e.g. `https://your-org.atlassian.net/wiki`. |
| `CONFLUENCE_EMAIL` | yes | The Atlassian account email the API token belongs to (Basic-auth username). |
| `CONFLUENCE_API_TOKEN` | yes | The Atlassian API token (Basic-auth password). Read-only content scope is enough. Never logged. |
| `CONFLUENCE_SPACE_KEYS` | one of these | Comma-separated **space keys**. Every page in each space is synced as one doc. |
| `CONFLUENCE_PAGE_IDS` | one of these | Comma-separated **page ids**, synced in addition to / instead of whole spaces. |
| `CONFLUENCE_DEFAULT_VISIBILITY` | no | Overrides the default `visibility` frontmatter (default `restricted` — see "Visibility defaults"). |

The connector lists pages in the configured spaces (paginated) via the
Confluence Cloud REST API, converts each page's storage-format body → markdown
(headings, lists, tables, links, and `code`/`noformat` macros — with all raw
page text HTML-escaped so a wiki page can't inject markup into the dashboard),
and records the page's web URL as `source_url`. **Full pull every run**: all
configured spaces/pages are re-listed and re-fetched each tick, and pages
removed upstream are reconciled (deleted) from the KB on the next run.

Enable example (`.env`):

```
CONFLUENCE_BASE_URL=https://your-org.atlassian.net/wiki
CONFLUENCE_EMAIL=you@your-org.com
CONFLUENCE_API_TOKEN=…
CONFLUENCE_SPACE_KEYS=ENG,OPS
```

## How sync works

Each connector's loop is registered as a background integration
(`connector:<name>`) and started at orchestrator startup. On each tick:

1. **Pull** — the connector calls its API (Notion / Drive+Docs) via `fetch`,
   converts each source document to markdown, and returns `ConnectorDoc`s plus a
   `complete` flag.
2. **Upsert** — the framework writes each doc to
   `context/connectors/<source>/<docId>.md` (atomic tmp+rename). Because the id
   is stable, a re-sync **updates the same file in place** — idempotent, no
   duplicates.
3. **Reconcile (delete)** — **only when the pull was `complete`** this run (see
   below), the framework deletes any file whose `synced_at` predates this
   run — i.e. docs that were removed upstream and so weren't re-written. This
   mirrors the checkpointed delete-reconcile in `github-project-sync.ts`.

### Sync model: full pull every run

The bundled connectors (Notion, Google Drive) do a **full pull every tick** —
every configured database/root page/folder is re-listed and every
page/doc's content re-fetched, on every run, not just the first. `complete`
is computed fresh each run (true only when every listing and every
page/doc fetch succeeded) and is **never persisted** — there is no
incremental cursor.

This is a deliberate choice over an incremental, cursor-persisted design
(what these connectors originally shipped with), which had three related
bugs:

- **Reconcile only ran once, ever.** `complete` gated delete-reconcile, and
  with a cursor persisted permanently, `complete` (`!cursor`) was only true
  on the very first run — every later run was "incremental" and so never
  reconciled. A page/doc deleted upstream would linger in the KB forever.
- **The cursor could advance past a failed fetch.** The incremental cursor
  advanced to the newest timestamp *seen* (listed), regardless of whether
  that item's content fetch actually succeeded. A transient per-item error
  meant the item was skipped forever afterward — its timestamp was already
  behind the cursor.
- **The `<=` timestamp boundary could drop same-timestamp edits.** Two
  items sharing the exact cursor timestamp (minute-granularity in Notion's
  case) would have one silently skipped.

A full pull every tick removes the cursor entirely, so all three dissolve at
once: reconcile runs on every fully-successful pass, nothing can be
"advanced past," and there is no boundary to compare against. The cost is
re-fetching unchanged content every tick — acceptable for a background KB
sync on a multi-minute interval (`CONNECTOR_SYNC_INTERVAL_MS`, default 30
min) against a bounded, admin-configured scope; upserts are idempotent by
stable id, so re-writing unchanged content is a harmless no-op write.

A connector you write doesn't have to follow this model — `ConnectorContext`
still exposes `ctx.getCursor()` / `ctx.setCursor()` (backed by the
`router_state` table, key `connector_cursor:<name>`) for a source where a
full pull genuinely isn't affordable. If you do use a cursor, make sure (a)
`complete` becomes true again periodically (not just on the very first run)
so deletions still reconcile, (b) the cursor only advances past items whose
fetch actually succeeded, and (c) the skip comparison doesn't drop
same-timestamp items (e.g. dedupe by id at the boundary instead of a bare
`<=`/`<` comparison).

## Writing a new connector

A connector is a small module that implements the `Connector` interface from
[`src/integrations/connectors/base.ts`](../src/integrations/connectors/base.ts):

```ts
export interface Connector {
  name: string;              // KB subdir + log key, e.g. 'confluence'
  syncInterval: number;      // ms; 0 disables the loop
  isConfigured: () => boolean;   // true when its env/creds are present
  sync: (ctx: ConnectorContext) => Promise<{ docs: ConnectorDoc[]; complete: boolean }>;
}
```

Your `sync(ctx)` only has to:

1. Talk to the external API using `ctx.fetchImpl` (so tests can inject a stub).
2. Convert each source document to markdown, escaping raw source text with
   `escapeHtml` (base.ts) before any markdown styling is layered on it — see
   "Security" below.
3. Return `ConnectorDoc`s — each with a stable `id`, a `title`, a `sourceUrl`
   (the citation target), the `markdown` body, ideally an `updatedAt`, and a
   `visibility` (default to `DEFAULT_CONNECTOR_VISIBILITY`, not `open` — see
   "Visibility defaults" below).
4. Prefer pulling the **entire** scope every run (see "Sync model" above) so
   `complete` is simply "did every listing/fetch succeed this run" and
   reconcile-delete stays correct on every run, not just the first. Only reach
   for `ctx.getCursor()` / `ctx.setCursor()` if a full pull genuinely isn't
   affordable, and if so mind the three pitfalls called out above.
5. Report `complete: true` only when you pulled the entire scope with no
   errors (so the framework may reconcile-delete this run); report
   `complete: false` for any partial/errored pull.

The framework handles KB paths, path-safety, frontmatter (including the citable
`title` + `source_url`), atomic writes, upsert idempotency, deletion-on-removal,
and the polling loop. Register it by adding a `registerConnector(...)` call in
[`src/integrations/connectors/index.ts`](../src/integrations/connectors/index.ts).

Because a connector can be added per-org via a **profile plugin**
(`profiles/<org>/plugins/*.mjs` — see [PLUGINS.md](PLUGINS.md)), an org can ship
its own connector without touching `src/`: build the `ConnectorDoc`s in the
plugin and call `startConnectorLoop(...)`.

## Security

- Credentials are read only via `readEnvFile` / the OneCLI vault. Tokens are
  never written to logs, never placed in frontmatter, and never committed.
- Synced ids are sanitized so a hostile/malformed source id can never write
  outside `context/connectors/<source>/` (path-safety is unit-tested).
- Source text is HTML-escaped before it's woven into the converted markdown
  (`escapeHtml` in `base.ts`, applied to raw rich-text/run content in
  `notionBlocksToMarkdown`/`richTextToMarkdown` and `googleDocToMarkdown`), so
  a literal `<img src=x onerror=...>` in an upstream doc can never execute as
  HTML/script when the KB dashboard renders the synced markdown. Only the
  converter's own markdown control characters (headings, lists, links, …) are
  left unescaped.

### Visibility defaults

Synced docs mirror an **external** source whose own access controls the KB has
no visibility into — a Notion page or Drive doc might be confidential even
though nothing in its content says so. Defaulting to `visibility: open` would
flatten that and expose it to every allowlisted user and to citations.
Instead:

- Every connector defaults new docs to **`restricted`**
  (`DEFAULT_CONNECTOR_VISIBILITY` in `base.ts`) — per
  [privacy-policy.md](../rules/access-control/privacy-policy.md) that means
  "surfaced only on direct request, never folded into summaries."
- Each connector can override its own default via an env var read with
  `readEnvFile` **inside the connector module** (not `config.ts`):
  `NOTION_DEFAULT_VISIBILITY` / `GOOGLE_DRIVE_DEFAULT_VISIBILITY`. Set one of
  these to `open` if you've vetted that connector's scope (e.g. a
  company-wide-readable wiki) and want synced docs to behave like the rest of
  the open KB.
- An unrecognized value (typo, unsupported level) is ignored in favor of the
  safe default — misconfiguration can only make a doc *more* private, never
  silently widen access.
- A connector may still set a **per-doc** `visibility` (e.g. flag one
  Notion database as `private`) regardless of the connector-wide default.

## Related

- [PLUGINS.md](PLUGINS.md) — the extension model (connectors are flows;
  per-org connectors go in profile plugins).
- [rules/knowledge-base/README.md](../rules/knowledge-base/README.md) — the KB
  synced docs live in, and the RBAC/citation guarantees they inherit.
