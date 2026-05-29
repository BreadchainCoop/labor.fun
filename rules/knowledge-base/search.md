# KB Full-Text Search

The knowledge base is also indexed for **ranked full-text search** via SQLite
FTS5. Use this instead of `grep` when you need relevance ranking, stemming
("manage" matches "manages/managing"), or cross-file lookups — grep is still
fine for exact-path reads.

## What's indexed

The orchestrator chunks every markdown file under each group's `context/`
directory into fragments and stores them in the `kb_fragments` FTS5 table in
`store/messages.db`. The index is:

- **Incremental** — only files whose mtime changed are re-chunked.
- **Always fresh** — the `kb-reindex` post-turn evaluator re-indexes the
  group's KB after every interaction, and the orchestrator warms the whole
  index on startup.
- **Source-of-truth-preserving** — the markdown files are authoritative and
  git-tracked; the index is a rebuildable accelerator (`npm run kb-reindex`).

## Querying from a container

In cooperative mode every container has `store/messages.db` mounted, so you
can query the index directly with the `sqlite3` CLI:

```bash
DB=/workspace/project/store/messages.db

# Ranked search across all groups (BM25 — lower rank = better match)
sqlite3 -readonly "$DB" "
  SELECT group_folder, source_path,
         snippet(kb_fragments, 3, '[', ']', '…', 16) AS snippet,
         bm25(kb_fragments) AS rank
  FROM kb_fragments
  WHERE kb_fragments MATCH '\"treasury\" \"lead\"'
  ORDER BY rank LIMIT 10;"

# Scope to one group's KB
sqlite3 -readonly "$DB" "
  SELECT source_path, snippet(kb_fragments, 3, '[', ']', '…', 16)
  FROM kb_fragments
  WHERE kb_fragments MATCH '\"shape\" \"rotator\"'
    AND group_folder = 'slack_main'
  ORDER BY bm25(kb_fragments) LIMIT 10;"
```

**Quote each search term** (`"term"`) so user text can't trip FTS5 operator
syntax (`AND`/`OR`/`NEAR`/`*`/parentheses). Quoted terms are implicitly ANDed.
Once you have the `source_path`, read the actual file under
`/workspace/group/context/<source_path>` or `/workspace/shared-kb/` for full
content — the snippet is only a preview.

## Querying from the host

```bash
npm run kb-search -- "who manages the treasury"
npm run kb-search -- --group slack_main "shape rotator event"
npm run kb-reindex            # force a full incremental re-index
```

## Limitations

- Keyword/BM25 only — no semantic/vector search. A query for "money" won't
  match a doc that only says "treasury" unless that word appears. (Vector
  search was intentionally deferred — it would require an external embeddings
  provider and per-turn spend.)
- The index covers `.md` files only.

## Related Rules

- [Storage Systems](storage.md) — markdown KB vs SQLite, container DB access
- [Knowledge Base](README.md) — KB structure and document conventions
