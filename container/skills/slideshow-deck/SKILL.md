---
name: slideshow-deck
description: Make a self-contained HTML slideshow deck and host it password-protected on GitHub Pages. Use when someone asks for a slideshow, debrief, presentation, or "deck" they can share via a link. Produces a live in-browser slideshow (not a Drive download) that is always statically encrypted before publishing.
---

# Slideshow decks (make + host, encrypted)

Build a slideshow as one self-contained HTML file, **statically encrypt it**,
and publish it to the org's `decks` repo so it's served as a live, password-
gated slideshow at `https://<org>.github.io/decks/<slug>.html`.

> **Why not Google Drive:** Drive can't render HTML — a Drive link forces a
> download. Hosting on GitHub Pages opens the deck as a real slideshow in the
> browser. **Always host decks this way.**

## 1. Build the deck

Start from `${CLAUDE_SKILL_DIR}/deck-template.html` (the house format: inline
CSS/JS, one `<section class="slide">` per slide, keyboard + click nav, progress
bar). Copy it, fill in the content, restyle the `:root` palette if you like.
Keep it **one self-contained file** — no external assets, no build step.

```bash
cp ${CLAUDE_SKILL_DIR}/deck-template.html /tmp/deck.html
# …edit /tmp/deck.html: title, slides, palette…
```

## 2. Encrypt it (required — never publish plaintext)

The Pages URL is public, so every deck is password-gated with
[StatiCrypt](https://github.com/robinmoisson/staticrypt) (client-side AES, no
server). Get the deck password from config — **do not hardcode it** (this skill
ships in a public repo):

- `DECK_PASSWORD` env var, or
- the KB config `decks/config.md` (`password:` frontmatter), or
- ask the user if neither is set.

```bash
cd /tmp
npx staticrypt deck.html -p "$DECK_PASSWORD" --short -d out   # → out/deck.html
```

`out/deck.html` is the encrypted file you publish. Sanity-check it: its title
should read "Protected Page" and your slide text should NOT appear in it.

## 3. Publish to the decks repo (fresh-history hygiene)

The decks repo defaults to `<githubOrg>/decks` (override with `DECKS_REPO`).
Authenticate git with the bot's GitHub token
(`GITHUB_PERSONAL_ACCESS_TOKEN`). Commit **only the encrypted file**:

```bash
REPO="${DECKS_REPO:-<githubOrg>/decks}"
git clone "https://x-access-token:${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/${REPO}.git" /tmp/decks
cp /tmp/out/deck.html /tmp/decks/<slug>.html
cd /tmp/decks
git add <slug>.html && git commit -m "Add <topic> deck" && git push
```

**If a plaintext deck ever lands in the repo**, rewrite history so it isn't
recoverable (you can't rely on deleting the repo — the token usually lacks
`delete_repo`):

```bash
git checkout --orphan fresh && git add -A && git commit -m "reset"
git branch -D main && git branch -m fresh main && git push -f origin main
```

## 4. Share

Post the link **and the password** in the requested channel:

> 🔒 Slides: `https://<org>.github.io/decks/<slug>.html` · password: `<password>`
> Enter the password, then ← / → or click to advance.

If Pages was just enabled on a new repo, the first build takes ~30–60s; poll the
URL until it returns 200 and contains `staticrypt` before sharing.

## Notes
- Keep the password **out of the repo** (README included) — committing it would
  defeat the encryption. It's shared with the team out-of-band (e.g. pinned in
  the channel).
- One `.html` per deck; Pages serves the file directly, no index needed.
- Reuse this for any debrief/summary/strategy deck.
