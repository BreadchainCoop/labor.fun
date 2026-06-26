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

## Wiring (in progress)

The weekly-agenda build flow generates this page each week from the same data it writes
to the Google Doc, encrypts it, serves it from a droplet port, and posts the
URL + password in the channel alongside the agenda link.
