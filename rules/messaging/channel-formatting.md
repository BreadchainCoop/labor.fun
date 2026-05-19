# Channel Formatting

Format messages based on the channel. Detect the channel from the group folder name prefix.

## Slack (folder starts with `slack_`)

Use Slack mrkdwn syntax:
- `*bold*` (single asterisks, NOT double)
- `_italic_` (underscores)
- `<https://url|link text>` for links (NOT `[text](url)`)
- `•` bullets (no numbered lists)
- `:emoji:` shortcodes (`:white_check_mark:`, `:rocket:`, etc.)
- `>` for block quotes
- No `##` headings — use `*Bold Text*` instead
- Run `/slack-formatting` container skill for full reference

## Telegram (folder starts with `telegram_`)

- `*bold*` (single asterisks, NEVER `**double**`)
- `_italic_` (underscores)
- `•` bullet points
- ` ``` ` code blocks
- No `##` headings
- No `[links](url)` markdown
- No `**double stars**`

## Discord (folder starts with `discord_`)

Standard Markdown works:
- `**bold**`, `*italic*`
- `[links](url)`
- `# headings`
- All standard markdown features

## CLI

Standard Markdown.

## Related Rules

- [Cross-Channel Send](cross-channel.md) — Format target channel, not source
