# Transcript Processing Rules

## Who Can Submit Transcripts
- Any user in any registered group can submit a transcript
- No special tags required -- transcripts are an open workflow

## Trigger Detection
The assistant should recognize a transcript when:
- A user explicitly says "here's a transcript", "meeting notes", "process this transcript", etc.
- A large block of text is pasted that looks like a meeting transcript (multiple speakers, timestamps, dialogue format)
- A user says "summarize this meeting" followed by text

## Processing Workflow

### Step 1: Parse & Identify
Read the full transcript and identify:
1. **Meeting title** -- infer from context or ask
2. **Date** -- extract from transcript or ask
3. **Participants** -- list everyone mentioned by name
4. **Key topics** -- major discussion threads

### Step 2: Extract Items
For each item, classify and extract:

| Type | What to Look For | DB Action |
|------|-----------------|-----------|
| **Action items** | "I'll do X", "Can you handle Y", "We need to Z" | Submit via `propose_meeting_tasks` for review — see [Transcript Task Approval](task-approval.md) |
| **New events** | "Let's schedule X for Friday", "We have a meeting next week" | Note for calendar addition |
| **New people** | Names not in the KB people directory | Create KB person files |
| **Task updates** | References to existing tasks, status changes | Update existing task files |
| **Documents needed** | "We need the contract", "Send me the report" | Log as document requests |

> **Important**: New action items derived from a transcript are NOT written to `context/tasks/` directly. They go through the review queue (`propose_meeting_tasks`). Updates to existing tasks, new people, new events, and document references are NOT gated. See [Transcript Task Approval](task-approval.md).

### Step 3: Identify Gaps
For EACH extracted item, check if it has complete information:
- **Action item**: needs assignee, due date, and clear description
- **Event**: needs date, time, and description
- **Person**: needs role or context
- **Task update**: needs task ID or clear reference to existing task

If information is missing, add it to the clarification questions list.

### Step 4: Generate HTML Slideshow
Create a self-contained HTML document with:
- **Slide 1**: Meeting title, date, participants
- **Slide 2**: Executive summary (3-5 bullet points)
- **Slide 3+**: One slide per major topic with key decisions
- **Slide N-1**: Action items table (assignee, item, due date, priority)
- **Slide N**: Clarification questions (if any)

The HTML must be self-contained with inline CSS and JS for slide navigation (arrow keys + click).

### Step 5: Persist & Respond
1. Call `save_meeting_summary` first to store the meeting and capture the returned `summary_id`
2. Submit new action items through the approval queue:
   - Call `propose_meeting_tasks` with the `summary_id` and the array of extracted action items — do NOT write `context/tasks/TASK-NNN.md` for these. A reviewer (any allowlisted user) will approve or reject; on approval the host writes the TASK file. See [Transcript Task Approval](task-approval.md).
3. Create/update un-gated KB files directly:
   - New people: create `context/people/name.md` files
   - New events: create `context/calendar/EVT-NNN.md` files
   - Task *updates* (status changes, comments on existing TASK-NNN): modify the existing task files
   - Document/artifact references: write under `context/artifacts/`
4. Return the HTML slideshow to the user
5. If there are clarification questions, list them after the slideshow

## Output Format
When responding to the user, provide:
1. A brief text summary of what was extracted
2. The HTML slideshow (sent as a message)
3. A numbered list of clarification questions for unclear items
4. A summary of what was added/updated in the KB

## Constraints
- Never fabricate information not in the transcript
- Mark uncertain extractions with a question mark
- Always preserve the original transcript text in the database
- If the transcript is too short or unclear to process, ask for more context
- Respect visibility rules -- meeting summaries inherit the group's default visibility
