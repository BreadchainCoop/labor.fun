# Close the Loop

**HARD RULE: Every assistant interaction that surfaces actionable information MUST write to the KB, not just reply in chat.**

## Task Creation
- ALWAYS create a TASK-NNN.md file for any actionable request (maintenance, expense, event, purchase, scheduling)
- NEVER just acknowledge in chat without writing the task file
- Use IPC modify_kb_file action to write from container agents
- Assign to the relevant person, or leave unassigned if it's unclear

## Entity Updates
- When a NEW person, event, artifact, or space is mentioned: check if a KB file exists, create/update if needed
- When a task STATUS changes (completed, blocked, etc.): update the TASK file, don't just say "noted"
- When an EXPENSE or RECEIPT is shared: log it as a task or artifact with amount, who paid, what for

## Event Logging
- Every event lead or inbound request → TASK file or calendar entry
- Every event cost/expense → tracked in task or artifact
- Every event decision → update the relevant project file

## Self-Audit (run before EVERY reply)
Before sending any response, ask yourself:
1. Did someone request an action? → Did I create/update a TASK file?
2. Was a new entity mentioned? → Did I create/update a KB file?
3. Was a status update given? → Did I update the relevant file?
4. Was money/expense discussed? → Did I log it?
5. Did I only reply in chat without writing anything to KB? → FAILURE. Go back and write it.

## Related
- [Tasks schema](tasks.md)
- [Document format](document-format.md)
- [Request logging](request-logging.md)
