# PLAN — Usage modal: subagent detail + accuracy guards

Scope: the session detail modal (Usage popup) and the parsing behind it. Five items,
ordered. Items 1-3 are the deliverable; 4-5 are optional stretch, do them only if 1-3
land cleanly. No other refactors.

This is NOT `PLANNING.md` (historic design notes referenced from code comments; leave
that file alone).

## Ground rules

- All transcript parsing stays in the worker (`src/services/usage-worker.js` routes
  ops to `src/services/projects.js`). No new parsing in the main process. No new IPC
  ops are needed; every item rides existing ops (`getSessionSubagents`,
  `getProjectDetail`).
- `src/services/parse-cache.js` persists both the file cache (raw token tuples) and
  the subagent aggregate cache. Items 2-4 change cached shapes; do ONE version bump
  (`VERSION = 2` -> `3` in parse-cache.js:22) covering all shape changes in this plan.
  A version mismatch drops the whole persisted cache and causes one cold re-parse
  (~1.2 s, in the worker, non-blocking) - acceptable, do not build migration code.
- Minimal diffs. Match surrounding style. No em dashes in UI strings.

## Item 1 — Turns + tool-calls columns in the subagent table (renderer only)

`getSessionSubagents()` already computes `toolUses` and `turns` per (teammate, model)
row (projects.js: `newAcc()` at ~761, accumulated at ~796/~819, spread into `agents`
rows at ~877). The modal never shows them.

- `src/modules/local-tab.js` `renderSubagentTable()` (~636): add two columns,
  `Turns` and `Tools`, between `Model` and `Input`. Plain numbers via `formatNum`.
- Footer totals: `sub.totals` does not carry these; sum them in the renderer from
  `sub.agents` (`reduce`). Do not change the totals shape for this item.
- Old persisted subagent-cache entries already contain `toolUses`/`turns` (they are
  part of the row object), so this item alone needs no cache bump.
- AC: modal shows per-row and total turns/tool-calls; numbers match the chat viewer's
  per-agent bar (`chat-viewer.js:226`) for the same transcript.

## Item 2 — Cache-savings line in the modal

`calcCostBreakdown()` (src/services/pricing.js:66) already returns
`cacheReadSavings` (what the cache-read tokens would have cost extra at the input
rate). The subagent daily rollup sums it (projects.js:826) but session totals and the
modal do not.

- projects.js `getSessionSubagents()`: add `savings: 0` to the `totals` object
  (~756) and accumulate `bd.cacheReadSavings` next to the other totals (~868).
- projects.js `getProjectDetail()` modelUsage accumulator (~357): add a `savings`
  field per model row, accumulate `bd.cacheReadSavings`. This is computed at query
  time from raw cached records, so no persistence concern on the main-thread side.
- The subagent `totals` object IS persisted (parse-cache.json `subagents`); this
  shape change is covered by the single VERSION bump.
- `src/modules/local-tab.js` `showModelDetailModal()` (~700): under the
  `grand-total-bar`, add one line:
  `Cache reads saved ~$X vs. input-rate pricing` where X = main savings (sum over
  `session.modelUsage`) + `sub.totals.savings`. Hide the line when X is 0 or the
  fields are missing.
- AC: for a session with heavy cache reads the line shows a savings figure of the
  right order (C.READ tokens x ~90% of input rate); sessions with zero cache reads
  show no line.

## Item 3 — Guards against silent undercount (future shapes)

Two usage fields are zero in all current data but would silently undercount if
Claude Code starts using them: `usage.iterations` with more than 1 element, and
`usage.server_tool_use` with `web_search_requests` or `web_fetch_requests` > 0.
Project rule: never silently drop - surface, don't ignore.

- Detection sites (both):
  - main thread: `parseInto()` (projects.js:83) - add per-file counters on the
    cache entry, e.g. `entry.flags = { multiIter: 0, webSearch: 0, webFetch: 0 }`,
    incremented when `u.iterations?.length > 1` or the server_tool_use counts are
    nonzero. Tuple/entry shape change - covered by the VERSION bump.
  - subagents: the inline parse in `getSessionSubagents()` (~799) - same counters,
    bubbled into the result object (persisted subagent cache, same bump).
- Bubble up: `getProjectDetail()` merges file flags into each session's summary
  (nonzero only); `getSessionSubagents()` returns `flags` on its result.
- UI (`local-tab.js`, modal): when any flag is nonzero, render a small warning badge
  under the section label:
  - webSearch/webFetch: `N web searches not priced` (they bill per request, not
    tokens).
  - multiIter: `multi-iteration responses seen - token totals may undercount`.
  Style: reuse an existing badge/subtle class; no new CSS unless nothing fits.
- AC: with today's transcripts, no badge ever appears (all counts are zero). A
  hand-crafted JSONL fixture with `iterations` of length 2 or
  `web_search_requests: 1` makes the badge appear in the modal.

## Item 4 (optional) — Thinking-token split in OUTPUT cells

`usage.output_tokens_details.thinking_tokens` is a breakdown of `output_tokens`
(subset, not additional), present in ~27% of records.

- Parse: capture `u.output_tokens_details?.thinking_tokens || 0` as `thinking` in
  both parse sites (parseInto record tuples at projects.js:101, subagent parse at
  ~803). Add `thinking` to `createUsageDeduper()` (projects.js:30): include it in
  the category loop so streamed duplicates converge like the others.
- Aggregate: add to modelUsage rows, subagent rows, and both totals. Do NOT price it
  separately - it is already inside output cost.
- Render: OUTPUT cells become `22.9K (11K thinking)` when thinking > 0, unchanged
  otherwise. Applies to `renderModelTable` and `renderSubagentTable`.
- Covered by the same VERSION bump.
- AC: a session whose records carry thinking_tokens shows the split; output token
  totals and costs are byte-identical to before (thinking is display-only).

## Item 5 (optional) — Wall-clock per subagent

- In `getSessionSubagents()`, track min/max `rec.timestamp` per agent file while
  parsing (all record types, not just assistant, so idle tool time counts). Put
  `durationMs` on each row; sum of per-file spans on totals is meaningless, skip it.
- Render as a `Time` column in `renderSubagentTable` (`Nm Ss` formatting; reuse the
  duration formatter the chat viewer uses if one exists, else a small local helper).
- Persisted row shape change - same VERSION bump.
- AC: durations roughly match the spread of timestamps visible in the chat viewer
  for that agent transcript.

## Verification (after each item)

- Run the app, open a session with subagents (e.g. the "Event Registration field
  mapping sync endpoint" session), open the Usage modal, check the new columns/lines.
- Confirm totals did not change vs. before the edit (items 1, 4, 5 are display-only;
  item 2 adds a new number without touching existing ones).
- Delete `<userData>/data/parse-cache.json` once after the VERSION bump and confirm a
  cold scan rebuilds it and the modal still populates.
- When testing, kill the electron process to exit (window close only hides to tray).
