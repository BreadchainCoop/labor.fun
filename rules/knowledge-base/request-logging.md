# Request Logging

**Mandatory after EVERY interaction**, regardless of channel.

## Process

After completing a request, append a row to `context/artifacts/request_log.md`:

| Column | Format | Description |
|--------|--------|-------------|
| Date | `YYYY-MM-DD` | Date of the request |
| User | Name | Who made the request |
| Channel | Slack / Telegram / CLI | Which platform |
| Summary | One line | What was requested |
| Status | Completed / Failed / Pending | Outcome |

## Rules

- Log is `visibility: restricted` — only admins can view it in the dashboard
- Log every interaction, even simple questions
- Keep summaries concise (one line)
- If a request spans multiple turns, log the final outcome
- Failed requests should include the reason in the summary

## Related Rules

- [Access Control](../access-control/privacy-policy.md) — Log visibility is restricted
