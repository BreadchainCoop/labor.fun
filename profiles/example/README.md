# Example profile

A starter template for a new labor.fun organization. **Copy this directory**,
don't edit it in place:

```bash
cp -r profiles/example profiles/<your-org>
```

Then:

1. Edit `profiles/<your-org>/profile.config.json` — set `assistantName`,
   `orgName`, `githubOrg`, `kbDashboardUrl`, `sharedKbGroup`, etc.
2. Edit `profiles/<your-org>/groups/main/CLAUDE.md` and
   `profiles/<your-org>/groups/global/CLAUDE.md` to describe your org and how the
   assistant should behave. (`{{ASSISTANT_NAME}}` is substituted automatically.)
3. Add your members under
   `profiles/<your-org>/groups/<sharedKbGroup>/context/people/` (the template
   uses `slack_main`; match whatever `sharedKbGroup` you set in step 1).
4. Activate it: `LABOR_PROFILE=<your-org>` in `.env` (or leave it unset if this
   is the only profile present).

`profiles/<your-org>/store/`, `.../data/`, and group runtime state are created
on first run and are gitignored. See `docs/NEW-ORG-GUIDE.md` for the full
walkthrough.
