# claude-usage — project notes

Electron app that reads Claude Code transcripts from `~/.claude/projects/<folder>/<sessionId>.jsonl`
and reports token usage, cost, and a chat viewer.

## Chat extraction contract (IMPORTANT — this is the working pattern)

The transcript JSONL contains many record/context shapes beyond plain `user`/`assistant`
messages (slash commands, local-command stdout, post-compact file reads, edited files,
memory loads, queued commands, task notifications, todo/skill reminders, …). New shapes
appear over time as Claude Code evolves.

**Rule: never silently drop a context record.** Every record/part is either:

1. **Rendered nicely** — a purpose-built chip/row (preferred), or
2. **Surfaced raw** — shown as collapsed JSON (`kind: 'unknown'`) so a new/unknown shape is
   visible in the UI, not hidden.

The workflow is: unknown shape shows up raw → the user reports it (the raw JSON is right
there to copy) → we design a proper renderer for it and move it from bucket 2 to bucket 1.
Do **not** add a silent denylist that hides records — even noisy ones (e.g. `todo_reminder`)
render raw/collapsed rather than disappearing. If something is genuinely too noisy to view,
the user will say so and we adjust the design (collapse, dedupe, etc.) — we don't drop it.

When you handle a new shape, prefer matching the CLI's own wording (e.g. `Read <path> (N lines)`,
`Referenced file <path>`).

## Where the code lives

- [src/services/projects.js](src/services/projects.js) — `getSessionChat()` parses JSONL into
  `messages[]` of `{ role, parts[], timestamp }`. This is where record/attachment shapes are
  turned into `parts`. The attachment branch handles `file`, `compact_file_reference`,
  `edited_text_file`, `nested_memory`, `queued_command`, `date_change`, and a catch-all `else`
  that emits `kind: 'unknown'` carrying the raw object. Consecutive `attachment` records are
  buffered into one `role: 'attachment'` "Context" message via `flushAttach()`.
- [src/modules/chat-viewer.js](src/modules/chat-viewer.js) — renders `parts` to HTML.
  String-content wrapper tags are extracted by `renderCommandBlocks` (`<command-*>`,
  `<local-command-*>`), `renderTaskNotifications` (`<task-notification>`), `renderTeammateBlocks`
  (`<teammate-message>`), and `renderIdeContext` (`<ide_*>`). The text chain runs them in order
  and renders whatever text remains. Attachment parts (incl. the raw `unknown` block) render in
  `renderChatParts`. Messages that collapse to empty are suppressed.
- [src/styles.css](src/styles.css) — chat styles: `.cmd-block`/`.cmd-badge*`, `.ctx-row`/`.ctx-*`,
  `.ctx-raw` (the collapsible unknown block), `.chat-context`, `.chat-compact`.

## Known shapes (current coverage)

Record types: `user`, `assistant` (with `message.usage`), `attachment`, plus `isCompactSummary`
user records (rendered as a collapsible "Compacted Summary"). All other top-level record
types go through `contextEventPart()` in projects.js: known ones render as compact event
rows in a "Context" card — `system` (per subtype: compact_boundary, api_error,
stop_hook_summary, turn_duration, away_summary, informational, scheduled_task_fire,
local_command), `progress` (hook_progress, agent_progress), `queue-operation`,
`last-prompt`, `file-history-snapshot`, `mode`, `permission-mode`, `teleported-from`,
`ai-title` — and any unrecognized type/subtype surfaces as a raw `record: <type>` block.

`attachment.type` rendered nicely: `file`, `compact_file_reference`, `edited_text_file`,
`nested_memory`, `queued_command`, `date_change`. Everything else → raw `unknown` block
(currently: `todo_reminder`, `deferred_tools_delta`, `skill_listing`, `hook_additional_context`,
`command_permissions`, `task_reminder`, `workflow_keyword_request`, `invoked_skills`).

String wrapper tags rendered: `<command-name|message|args>`, `<local-command-stdout>`,
`<local-command-caveat>` (dropped), `<task-notification>`, `<teammate-message>`, `<ide_*>`.

## Token usage notes

- The `/compact` operation has **no token usage in the JSONL** — the summary is a synthetic
  `user` record with `isCompactSummary: true` and no `usage` field, and Claude Code does not log
  the summarization call's cost anywhere. There is nothing to display for it; this is expected.
- Subagent/team transcripts live in `<sessionId>/subagents/agent-*.jsonl` and are parsed/aggregated
  separately in `getSessionSubagents()` (one row per teammate × model).
