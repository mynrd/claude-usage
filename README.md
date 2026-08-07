# Claude Usage

A desktop application that tracks local token consumption from Claude Code sessions.

## Tech Stack

- **Electron** — Cross-platform desktop framework (Windows & macOS)
- **Chart.js** — Usage charts and analytics (bundled locally in `src/vendor/`)
- **Node.js** — JSONL parsing for local Claude Code session data

## Features

### Rate-Limit Window Tracking
- Reconstructs Anthropic's **5-hour session windows** from transcript timestamps across all projects (main threads + subagents, deduped): current window start/end, exact token burn, cost, and burn rate (tokens/hr)
- **Pace badge** — current window vs your average completed window (e.g. `4.1× avg`)
- **Rolling 7-day** token/cost total alongside
- Optional **Limit** field (your own per-window estimate, in M tokens — Anthropic doesn't publish plan quotas): shows a % gauge and a projected time you'd hit it at the current pace
- Shown as a bar on the Local tab and a section in Widget mode
- Token counts are exact; window anchoring (floored to the hour) follows community convention since Anthropic doesn't document it

### Live Refresh
- Watches `~/.claude/projects` and auto-refreshes the active tab, widget, and tray tooltip when transcripts change (debounced; paused while you're typing in a field or viewing a chat)
- **New conversations appear in the session list automatically** as Claude Code creates them — no manual refresh
- **Live indicator** — a pulsing green dot on session rows and project entries where Claude is actively working, driven by transcript file writes (main + subagent transcripts, last write within ~45 s); dots dim on their own once writes stop. A long-running tool that produces no output yet can briefly dim the dot — transcripts carry no end-of-turn marker, so write recency is the best available signal
- No Claude Code hooks or configuration required — the app reads the transcript files directly
- Backed by a per-file parse cache keyed by size+mtime — refreshes re-read only files that actually changed

### Cache Savings
- **Cache Saved** cards on the Local tab and Analytics: what the cache-read tokens would have cost extra at the full input rate

### Tab 1 — Local Usage
- Parses Claude Code session data from `~/.claude/projects/`
- Lists all projects with total token counts, estimated cost, session counts, and last active date
- Project names resolved from the encoded folder names by probing the real filesystem path
- **Date range filters** — From/To date pickers (default to today); Clear shows full history
- **Include subagents** toggle — folds subagent / agent-team token spend into every total (cards, project list, sessions, daily totals, charts); preference persisted
- **Session search** — search across session titles and content
- Per-project detail views:
  - **Sessions** — one row per session with its AI-generated title (plus a short id to disambiguate), per-model badges, total tokens + estimated cost, and a subagent-count badge when the session spawned agents
  - **Usage detail modal** — per-session breakdown by model (Input / Cache Write / Cache Read / Output, each with its cost share), plus a **Subagents & team** table (one row per teammate × model, with spawns, tool calls, and cost) and a session + subagents grand total
  - **Daily Totals** — aggregated daily usage with estimated cost
  - **Chart** — stacked bar chart of daily token consumption

### Tab 2 — Analytics
- Cross-project analytics with date range filtering and the same **Include subagents** toggle
- **Daily Token Usage** — stacked bar chart across all projects
- **Daily Cost** — stacked bar chart split by model family (opus / sonnet / haiku / …)
- **Token Type Breakdown** — doughnut chart of input/output/cache distribution
- **Top Projects by Usage** — bar chart of heaviest consumers

### Export
- **CSV** — session rows and daily totals per project (Local tab), and cross-project daily totals (Analytics)
- **Markdown** — export any conversation from the chat viewer

### Subagent & Agent Team Tracking
- Subagent/team transcripts live in `<sessionId>/subagents/agent-*.jsonl` (Workflow runs nest one level deeper under `subagents/workflows/<wf-id>/`); the whole tree is parsed
- Teammate identity resolved from the `agent-*.meta.json` sidecar (`agentType`), falling back to the `You are "name"` self-identification in the transcript
- One row per **teammate × model** — a subagent that runs on multiple models is split so each row maps to a single rate card
- Subagent default models resolved from agent definition frontmatter (project `.claude/agents/` first, then global `~/.claude/agents/`)
- Results cached per session keyed by file sizes/mtimes, so the fold-in across all projects stays fast

### Counting Accuracy
- **Streamed-row dedupe** — Claude Code writes the JSONL during streaming, so one API response appears as several lines each carrying a copy of the usage object; raw sums overcount 2–20×. Every counting path dedupes by `message.id + requestId`, counting each usage category once at the highest value observed.
- **Resumed/branched sessions** — dedup is folder-scoped and files are scanned oldest-first, so a resumed session's copied history isn't double-counted; the copy contributes only its new turns.
- Shared agent-team turns and repeated tool_use blocks are likewise deduped across all of a session's agent files.
- `scripts/verify-usage.py` is an independent Python reference implementation that recomputes raw vs deduped totals straight from the JSONL, so the app's numbers can be checked against it.

### Chat History Viewer
- Full chat viewer overlay for any session
- Displays user/assistant messages with timestamps, model badges, and per-message token usage
- **Tool use visualization** — shows tool calls with inputs and results; parallel tool results are re-ordered so each result sits next to its call
- **Subagent calls** — Agent tool calls render with the agent type and its resolved model (explicit override, agent default, or "inherits parent model"), and results show the agent's token/tool-call/duration summary
- **Context records** — every non-message transcript record is rendered: file reads/references/edits, memory loads, compaction boundaries, API errors/retries, hook runs, queue operations, mode/permission changes, scheduled-task fires, and more. Unknown shapes are never dropped — they render as collapsed raw JSON so new record types stay visible
- **Compacted summaries** — `/compact` summaries render as a collapsible card
- **Slash commands** — command invocations and their local stdout render as compact chips (ANSI codes stripped)
- **Task notifications** — background-task / workflow completion notices render as status chips
- **Agent teams** — `<teammate-message>` blocks render as color-coded teammate cards; status payloads (e.g. idle notifications) collapse to one-line summaries
- **IDE context** — shows opened files and code selections
- **Image viewing** — inline images with click-to-zoom lightbox
- **Chat search** — highlight matches within a conversation
- JSON-only content pretty-prints as a code block

### Widget Mode
- Compact summary overlay showing today's local token usage and estimated cost across all projects
- Honors the **Include subagents** preference
- **Pin** button keeps the widget above other windows

### Dark Mode
- Toggle between light and dark themes via the moon/sun button in the header
- Full dark theme across all UI components
- Theme preference saved and restored on launch

### Cost Estimation
- Estimated dollar costs based on Anthropic's per-model pricing (Opus / Sonnet / Haiku)
- Model auto-detected from session data
- Cost displayed per session, per day, per project, and in summary totals
- **Per-record accuracy** — each API response is costed at the rate that was active on its date
- **Detailed Model Usage** — per-session breakdown by model (Output / Cache Write / Cache Read / Input / Cost)

### System Tray
- App minimizes to system tray on close instead of quitting
- Tray tooltip shows today's tokens and cost, kept current by the file watcher
- Right-click menu: Show, Widget Mode, Quit
- Double-click tray icon to restore window
- Single-instance lock — launching a second copy focuses the existing window

### Keyboard Shortcuts
- **F11** — Toggle fullscreen
- **F12** — Toggle DevTools

## Setup

```bash
npm install
npm start
```

That's the whole installation. The app only **reads** `~/.claude/projects/` — it needs no
Claude Code hooks, plugins, or settings changes, and it never modifies your transcripts.
Live refresh works out of the box via a file watcher on that folder.

## Verify Counting

```bash
python scripts/verify-usage.py <folder> [sessionId ...]
```

`<folder>` is the encoded project folder name under `~/.claude/projects`. The
script shares no code with the app: it reads the transcript JSONL directly and
prints raw vs deduped totals as JSON, so the app's numbers can be compared
against an independent implementation.

## Build Distributable

### Prerequisites

- Node.js installed
- Dependencies installed: `npm install`

### Build Commands

```bash
npm run build:win   # Windows (.exe installer)
npm run build:mac   # macOS (.dmg)
npm run build       # Current platform (auto-detect)
```

### Output

After a successful build, the output is in the `dist/` folder:

| File | Description |
|------|-------------|
| `dist/Claude Usage Setup 1.0.0.exe` | Windows NSIS installer |
| `dist/win-unpacked/Claude Usage.exe` | Portable exe (no install needed) |

### How to Rebuild

1. Make your code changes
2. Run the build command:
   ```bash
   npm run build:win
   ```
3. The new exe replaces the previous one in `dist/`

> **Note:** The exe is not code-signed. Windows SmartScreen may show a warning on first run — click "More info" then "Run anyway".

---

## Updating Model Pricing

Anthropic occasionally changes model prices. Since there is no official pricing API, rates are stored locally in `price-history.json`.

### In-app editor (recommended)

Click **$ Pricing** in the header. The dialog shows the latest snapshot's rates in an
editable table ($ / MTok) — edit values, add new models, remove stale ones, then
**Save as today's snapshot**. This appends a snapshot dated today to the **live**
`price-history.json` (saving again the same day replaces today's snapshot), recalculates
costs immediately, and never touches historical rates. No restart needed.

The manual file-editing path below still works if you prefer it.

### How it works

- `price-history.json` is an **append-only** array of dated snapshots.
- Each session record is costed at the rate from the most recent snapshot on or before its timestamp — so **historical records are never retroactively repriced** when you add new rates.
- On first launch the file is copied from the project root into the Electron user-data directory and used from there.

### Steps to add new rates

1. Check the latest pricing at `https://www.anthropic.com/pricing`.
2. Open `price-history.json` in the project root.
3. **Append** a new object to the end of the array. Do not edit or remove existing entries.
4. Set `"date"` to today in `YYYY-MM-DD` format.
5. Restart the app.

```json
[
  {
    "date": "2026-05-20",
    "prices": [ ... ]
  },
  {
    "date": "2026-09-01",
    "prices": [
      { "model": "opus-4.7",   "input": 4,   "cacheWrite5m": 5,    "cacheWrite1h": 8,    "cacheRead": 0.40, "output": 20 },
      { "model": "sonnet-4.6", "input": 2.5, "cacheWrite5m": 3.13, "cacheWrite1h": 5,    "cacheRead": 0.25, "output": 12 },
      { "model": "haiku-4.5",  "input": 0.8, "cacheWrite5m": 1,    "cacheWrite1h": 1.60, "cacheRead": 0.08, "output": 4  }
    ]
  }
]
```

### Field reference

| Field | Description | Unit |
|---|---|---|
| `model` | Model key, e.g. `opus-4.6`, `sonnet-4.5`, `haiku-3.5` | — |
| `input` | Base input tokens | $/MTok |
| `cacheWrite5m` | 5-minute prompt cache write | $/MTok |
| `cacheWrite1h` | 1-hour prompt cache write | $/MTok |
| `cacheRead` | Cache hits & refreshes | $/MTok |
| `output` | Output tokens | $/MTok |

> **Note:** `cacheWrite5m` is used for all cache creation tokens. The raw session data (`cache_creation_input_tokens`) does not distinguish between 5-minute and 1-hour writes.

### Live file location

After first launch, the active copy is at:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\claude-usage\data\price-history.json` |
| macOS | `~/Library/Application Support/claude-usage/data/price-history.json` |

Editing the project-root copy and restarting the app will **not** overwrite an existing live copy — only the first-run seed copy. To update the live file, edit it directly at the path above, or delete it so the app re-seeds from the project root on next launch.

## Project Structure

```
Claude Usage/
├── main.js              Electron main process (single-instance lock, bootstrap)
├── preload.js           Secure context bridge
├── package.json
├── assets/              App + tray icons
├── price-history.json   Historical model pricing snapshots (edit to update rates)
├── scripts/
│   └── verify-usage.py      Independent reference counter (raw vs deduped)
├── perf.log             Startup/query timings written at runtime (gitignored)
├── src/
│   ├── index.html       UI layout (tabs, widget, chat overlay, lightbox)
│   ├── styles.css       Styling (light & dark themes)
│   ├── renderer.js      Frontend entry point
│   ├── vendor/
│   │   └── chart.umd.min.js  Bundled Chart.js
│   ├── modules/
│   │   ├── pricing-settings.js  In-app model pricing editor ($ Pricing)
│   │   ├── local-tab.js     Local usage tab + usage detail modal
│   │   ├── analytics-tab.js Analytics tab
│   │   ├── chat-viewer.js   Chat history overlay
│   │   ├── widget.js        Widget mode (incl. pin)
│   │   ├── settings.js      Persisted UI settings (include-subagents toggle)
│   │   ├── pricing.js       Cost estimation (renderer fallback)
│   │   ├── theme.js         Dark/light theme toggle
│   │   └── utils.js         Shared utilities
│   └── services/
│       ├── config.js         App config (theme settings)
│       ├── ipc.js            IPC handlers (thin — forward to the parser worker)
│       ├── usage-worker.js   utilityProcess that does all transcript parsing
│       ├── worker-client.js  Main-side request/response bridge to that worker
│       ├── projects.js       JSONL parsing, dedupe, subagent aggregation, chat extraction
│       ├── scan-index.js     Single shared readdir+stat sweep of ~/.claude/projects
│       ├── parse-cache.js    Parse cache persisted across restarts
│       ├── perf.js           Startup/query timing written to perf.log
│       ├── paths.js          ~/.claude/projects location
│       ├── pricing.js        Cost calculation (main process)
│       ├── price-history.js  Historical pricing lookup
│       ├── stats-cache.js    Reads Claude Code's own stats-cache.json
│       ├── usage-cli.js      Runs `claude -p /usage` and parses it
│       ├── watcher.js        ~/.claude/projects file watcher (live refresh)
│       ├── tray.js           System tray + tooltip
│       └── window.js         BrowserWindow management
└── README.md
```
