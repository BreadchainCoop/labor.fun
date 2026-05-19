---
name: transcript-processor
description: Process meeting transcripts into action items, KB updates, and HTML slideshow summaries
---

# Transcript Processor Skill

## Overview
When someone pastes a meeting transcript or asks you to process meeting notes, follow this workflow to extract structured data and produce an HTML slideshow summary.

## Detection
Recognize transcript intake when:
- User says "transcript", "meeting notes", "process this meeting", "summarize this transcript"
- A large block of text with multiple speakers, dialogue markers (e.g., "Alice:", timestamps, "Speaker 1:")
- User says "here are the notes from..." followed by substantial text

## Processing Steps

### 1. Parse the Transcript
Read the full text and identify:
- **Who spoke**: List all unique speakers/participants
- **When**: Date/time if mentioned
- **What was discussed**: Group dialogue into topic clusters

### 2. Extract Structured Items

For each of these categories, scan the transcript thoroughly:

#### Action Items
Look for commitments: "I'll...", "Let's...", "We need to...", "Can you...", "Action item:", "TODO:"
```json
[{
  "description": "What needs to be done",
  "assignee": "Who is responsible (or 'unassigned')",
  "due_date": "YYYY-MM-DD or null if not mentioned",
  "priority": "high/medium/low (infer from urgency language)",
  "status": "pending"
}]
```

#### New Events
Look for scheduled meetings, deadlines, gatherings: "next Thursday", "schedule a...", "let's meet on..."
```json
[{
  "title": "Event name",
  "date": "YYYY-MM-DD or description like 'next Friday'",
  "time": "HH:MM or null",
  "location": "Where, or null",
  "description": "Context from transcript"
}]
```

#### New People
Cross-reference names against `context/people/`. Anyone not already in the KB:
```json
[{
  "name": "Full name",
  "role": "Role if mentioned",
  "context": "How they came up in the meeting"
}]
```

#### Task Updates
References to existing work: "the website project", "TASK-042", "the thing we discussed last week"
```json
[{
  "task_id": "TASK-NNN if identifiable, null otherwise",
  "title": "Task title for matching",
  "description": "What was said about it",
  "assignee": "New or confirmed assignee",
  "priority": "Changed priority if discussed",
  "status": "New status if discussed"
}]
```

#### Documents Needed
Requests for materials: "send me the...", "we need the contract", "share the report"
```json
[{
  "title": "Document name",
  "description": "What it's for",
  "owner": "Who should provide it",
  "type": "contract/report/design/spec/other"
}]
```

### 3. Identify Unclear Items
For EVERY extracted item, check completeness. If anything is missing or ambiguous, create a clarification question:
```json
[{
  "item_type": "action_item/event/task/document",
  "item_description": "Brief description of the item",
  "questions": ["Specific question 1", "Specific question 2"]
}]
```

Common missing info:
- Action items without clear assignees
- Events without dates or times
- Tasks without priorities
- Vague references ("that thing", "the project")

### 4. Generate HTML Slideshow

Create a **self-contained HTML document** with this structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Meeting Summary: {title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; }
  .slide { display: none; min-height: 100vh; padding: 60px 80px; }
  .slide.active { display: flex; flex-direction: column; justify-content: center; }
  .slide h1 { font-size: 2.5em; margin-bottom: 0.5em; color: #e94560; }
  .slide h2 { font-size: 1.8em; margin-bottom: 0.8em; color: #0f3460; background: #e94560; display: inline-block; padding: 8px 20px; border-radius: 4px; }
  .slide ul { font-size: 1.3em; line-height: 1.8; list-style: none; }
  .slide ul li::before { content: "→ "; color: #e94560; }
  .slide table { width: 100%; border-collapse: collapse; font-size: 1.1em; margin-top: 20px; }
  .slide th { background: #0f3460; padding: 12px; text-align: left; }
  .slide td { padding: 12px; border-bottom: 1px solid #333; }
  .slide .meta { font-size: 1.1em; color: #aaa; margin-bottom: 2em; }
  .nav { position: fixed; bottom: 30px; right: 40px; display: flex; gap: 10px; z-index: 100; }
  .nav button { background: #e94560; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 1em; }
  .nav button:hover { background: #c73651; }
  .counter { position: fixed; bottom: 35px; left: 40px; color: #666; font-size: 0.9em; }
  .questions { background: #2a1a3e; padding: 20px; border-radius: 8px; margin-top: 20px; }
  .questions h3 { color: #e94560; margin-bottom: 10px; }
</style>
</head>
<body>
<!-- Slides go here -->

<div class="nav">
  <button onclick="prev()">← Prev</button>
  <button onclick="next()">Next →</button>
</div>
<div class="counter" id="counter"></div>

<script>
let current = 0;
const slides = document.querySelectorAll('.slide');
function show(n) {
  slides.forEach(s => s.classList.remove('active'));
  current = Math.max(0, Math.min(n, slides.length - 1));
  slides[current].classList.add('active');
  document.getElementById('counter').textContent = (current + 1) + ' / ' + slides.length;
}
function next() { show(current + 1); }
function prev() { show(current - 1); }
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === ' ') next();
  if (e.key === 'ArrowLeft') prev();
});
show(0);
</script>
</body>
</html>
```

**Slide structure:**
1. **Title slide**: Meeting name, date, participant list
2. **Executive summary**: 3-5 key takeaways as bullet points
3. **Topic slides**: One per major discussion thread (key points + decisions)
4. **Action items slide**: Table with columns: Assignee, Action, Due Date, Priority
5. **New events slide** (if any): Events that need to be scheduled
6. **Clarification questions slide** (if any): What needs follow-up

### 5. Persist and Respond

1. **Save to database**: Call `save_meeting_summary` with all extracted data
2. **Create KB entries**: For each new item:
   - New tasks: create `context/tasks/TASK-NNN.md` with standard frontmatter
   - New people: create `context/people/{name}.md` with person template
   - Task updates: edit existing task files, add comments
3. **Send the HTML**: Include the full HTML in your response
4. **List clarification questions**: After the HTML, enumerate questions that need answers
5. **Summarize changes**: Brief list of what was added/updated in the KB

## Example Response Format

```
I've processed the transcript from your [meeting name] meeting. Here's what I found:

**Extracted:**
- 5 action items (3 assigned, 2 need assignees)
- 1 new event (team dinner next Friday)
- 2 new people added to KB (Jane Doe, Bob Smith)
- 3 existing task updates

[HTML slideshow here]

**Clarification needed:**
1. Action item "finalize the budget" -- who is responsible? Was this assigned to Finance or Operations?
2. "The deadline" was mentioned but no specific date given -- when is this due?
3. "Bob's project" -- is this related to TASK-015 (Website Redesign) or something new?

**KB updates made:**
- Created TASK-048: Finalize event catering (assigned to Dave, due 2026-04-20)
- Created TASK-049: Send venue contracts (unassigned, needs clarification)
- Updated TASK-042: Added comment about timeline discussion
- Created person file: context/people/jane-doe.md
```

## Edge Cases
- **Very short transcripts** (< 5 lines): Ask if there's more, but process what you have
- **No clear action items**: Still generate the summary slideshow, note that no action items were identified
- **Unclear speakers**: Use "Unknown Speaker" and ask for clarification
- **Multiple meetings in one transcript**: Split and process separately, or ask which to focus on
- **Non-English transcripts**: Process in the original language, generate summary in English
