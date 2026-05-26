# Claude Usage

A desktop application that tracks local token consumption from Claude Code sessions.

## Tech Stack

- **Electron** — Cross-platform desktop framework (Windows & macOS)
- **Chart.js** — Usage charts and analytics
- **Node.js** — JSONL parsing for local Claude Code session data

## Features

### Tab 1 — Local Usage
- Parses Claude Code session data from `~/.claude/projects/`
- Lists all projects with total token counts, estimated cost, session counts, and last active date
- **Date range filters** — From/To date pickers to scope usage data
- **Session search** — search across session titles and content
- Per-project detail views:
  - **Sessions** — breakdown by session (model, input/output/cache tokens, estimated cost), clickable to open chat viewer
  - **Daily Totals** — aggregated daily usage with estimated cost
  - **Chart** — stacked bar chart of daily token consumption

### Tab 2 — Analytics
- Cross-project analytics with date range filtering
- **Daily Token Usage** — stacked bar chart across all projects
- **Daily Cost** — cost trend over time
- **Token Type Breakdown** — doughnut chart of input/output/cache distribution
- **Top Projects by Usage** — bar chart of heaviest consumers

### Chat History Viewer
- Full chat viewer overlay for any session
- Displays user/assistant messages with timestamps
- **Tool use visualization** — shows Bash, Edit, Read, Write, Glob, Grep calls with inputs and results
- **IDE context** — shows opened files and code selections
- **Image viewing** — inline images with click-to-zoom lightbox
- **Chat search** — highlight matches within a conversation

### Widget Mode
- Compact summary overlay showing today's local token usage and estimated cost across all projects

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
- Right-click menu: Show, Widget Mode, Quit
- Double-click tray icon to restore window

### Keyboard Shortcuts
- **F11** — Toggle fullscreen
- **F12** — Toggle DevTools

## Setup

```bash
npm install
npm start
```

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
├── main.js              Electron main process (IPC, tray)
├── preload.js           Secure context bridge
├── package.json
├── assets/
│   └── tray-icon.png    System tray icon
├── price-history.json   Historical model pricing snapshots (edit to update rates)
├── src/
│   ├── index.html       UI layout (tabs, modals)
│   ├── styles.css       Styling (light & dark themes)
│   ├── renderer.js      Frontend entry point
│   ├── modules/
│   │   ├── local-tab.js     Local usage tab
│   │   ├── analytics-tab.js Analytics tab
│   │   ├── chat-viewer.js   Chat history overlay
│   │   ├── widget.js        Widget mode
│   │   ├── pricing.js       Cost estimation (renderer fallback)
│   │   ├── theme.js         Dark/light theme toggle
│   │   └── utils.js         Shared utilities
│   └── services/
│       ├── config.js         App config (theme settings)
│       ├── ipc.js            IPC handlers
│       ├── projects.js       JSONL parsing for Claude Code sessions
│       ├── pricing.js        Cost calculation (main process)
│       ├── price-history.js  Historical pricing lookup
│       ├── tray.js           System tray
│       └── window.js         BrowserWindow management
└── README.md
```
