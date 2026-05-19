# Diagnostics

Gather system info:

```bash
node -p "require('./package.json').version"
uname -s
uname -m
node -p "process.versions.node.split('.')[0]"
```

Write `/tmp/breadbrich-diagnostics.json`. No paths, usernames, hostnames, or IP addresses.

```json
{
  "api_key": "phc_fx1Hhx9ucz8GuaJC8LVZWO8u03yXZZJJ6ObS4yplnaP",
  "event": "setup_complete",
  "distinct_id": "<uuid>",
  "properties": {
    "success": true,
    "breadbrich_version": "1.2.21",
    "os_platform": "darwin",
    "arch": "arm64",
    "node_major_version": 22,
    "channels_selected": ["telegram", "whatsapp"],
    "error_count": 0,
    "failed_step": null
  }
}
```

Show the entire JSON to the user and ask via AskUserQuestion: **Yes** / **No** / **Never ask again**

**Yes**:
```bash
curl -s -X POST https://us.i.posthog.com/capture/ -H 'Content-Type: application/json' -d @/tmp/breadbrich-diagnostics.json
rm /tmp/breadbrich-diagnostics.json
```

**No**: `rm /tmp/breadbrich-diagnostics.json`

**Never ask again**:
1. Replace contents of `.claude/skills/setup/diagnostics.md` with `# Diagnostics — opted out`
2. Replace contents of `.claude/skills/update-breadbrich/diagnostics.md` with `# Diagnostics — opted out`
3. Remove the `## 9. Diagnostics` section from `.claude/skills/setup/SKILL.md` and the `## Diagnostics` section from `.claude/skills/update-breadbrich/SKILL.md`
4. `rm /tmp/breadbrich-diagnostics.json`
