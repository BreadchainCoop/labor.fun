# Weekly-agenda corrector page

A generator for a **self-contained, zero-dependency, StatiCrypt-encryptable** HTML
page that lets co-op members review and correct the weekly agenda Breadrich drafted
**optimistically**, then copy a Breadrich-ready message to send back.

It exists because the agenda is a *draft, not a verdict* (see
`rules/identity/voice.md` and issue #91): merged PRs are an engineering-only proxy,
so members need a low-friction way to fix what the bot got wrong and add the
design / BD / community / care / organizing work GitHub can't see.

## What the page does

- **Filter to yourself** — a chip per member; click your name to see just your sections.
- **Correct anything** — every bot-drafted item is a `BOT DRAFT`-tagged, editable field
  with a remove (✕) / keep (↺) toggle.
- **Add what the bot missed** — a `+ add work the bot missed` button per project (the
  self-line); empty projects show `— space for <name>'s update —`, never a "no PRs" verdict.
- **Copy → send Breadrich** — `Copy my updates` serializes your corrected sections into a
  per-project message and copies it to the clipboard. Paste it into a **DM to Breadrich**
  and the `file-an-update` routine (issue #92) files it into the agenda doc.

No backend: all state is client-side, so the page is a pure function of its input JSON
and can be encrypted + served as a static file.

## Generate

```bash
node render.mjs <agenda.json> [out.html]   # defaults to sample.json → sample.html
```

Input schema: see `sample.json` (`week`, `facilitator`, `docUrl`, `brief`, `goals[]`,
`deadlines[]`, `members[].projects[].items[]`). Items carry `{text, ref, url}`; an empty
`items` array renders the invitation.

## Encrypt (StatiCrypt) + serve

```bash
npx staticrypt out.html -p "<shared-password>" --short -d encrypted
# serve the encrypted/ dir from a static port; share URL + password with the co-op
```

The password gates the content client-side (AES), so the page is safe to serve from a
public port. Verified end-to-end: password gate → decrypt → full interactive page.

## Wiring (weekly flow)

The corrector page is wired into the `weekly-agenda` plugin end-to-end:

1. **Build agent writes page-data.** Each week the build task writes the same agenda
   content it puts in the Google Doc to `weekly-agenda/page-data/<week>.json` (KB),
   matching `sample.json`'s schema. The refresh pass keeps that JSON's auto-pulled facts
   in sync.
2. **`serve.mjs` publishes + serves.** Run it as a long-lived service on the droplet. It
   sweeps the page-data dir, renders each `<week>.json` → plaintext HTML → StatiCrypt
   (password) → `<serveDir>/<week>.html`, and serves the encrypted pages over HTTPS.
3. **Kickoff links it.** When `agenda_web_url` (and optionally `agenda_web_password`) are
   set in `config.md`, the kickoff post includes `‹agenda_web_url›/<week>.html` + the
   password so members can open the review/correct UI.

### Droplet setup (one-time)

Run `serve.mjs` as a systemd service with:

```
AGENDA_WEB_PORT=8091                       # public port (open it in the firewall!)
AGENDA_WEB_DIR=/.../published              # where encrypted *.html are written/served
AGENDA_PAGEDATA_DIR=/.../shared-kb/weekly-agenda/page-data   # where the build agent writes <week>.json
AGENDA_WEB_PASSWORD=<shared-password>      # must equal config.md's agenda_web_password
# optional: AGENDA_WEB_TLS_CERT / AGENDA_WEB_TLS_KEY for a real cert (else self-signed)
```

Then **open the port** in the droplet firewall (e.g. `ufw allow 8091/tcp`) — otherwise
the service is unreachable from the outside (a connection to it will just time out).

### config.md keys

```yaml
agenda_web_url: https://<droplet-host>:8091   # base; per-week page is <base>/<week>.html
agenda_web_password: <shared-password>        # must equal AGENDA_WEB_PASSWORD
```

Leave `agenda_web_url` empty to keep the page un-advertised (the build agent still writes
the page-data JSON, so you can flip it on later with no rebuild).
