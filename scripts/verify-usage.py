#!/usr/bin/env python3
"""Independent reference implementation for deduped token usage.

Shares NO code with the app. Reads Claude Code transcript JSONL directly and
computes raw vs deduped usage totals, so the app's numbers (after D1-D4 in
PLANNING.md) can be compared against fixed targets.

Dedup semantics (PLANNING.md D1):
  key = message.id + ':' + requestId
  max-per-category: per key, each usage category counts once at the highest
  value observed (placeholder -> final rows converge to the final value).

Scopes (PLANNING.md D2/D3):
  main thread   : one deduper per project folder, session files scanned
                  oldest-first by mtime (ties: name); deltas attributed to the
                  file being scanned when first/raised.
  subagents     : one deduper per session, across ALL agent-*.jsonl under
                  <sessionId>/subagents/** (recursive), sorted path order.
  main vs sub   : separate dedupers (disjoint sets, PLANNING.md F3).

Usage:
  python scripts/verify-usage.py <folder> [sessionId ...]
  python scripts/verify-usage.py --projects-dir <dir> <folder> [sessionId ...]

<folder> is the encoded project folder name under ~/.claude/projects.
With no sessionIds, reports every session in the folder.
Output: JSON to stdout.
"""

import json
import os
import sys
from collections import defaultdict

CATS = ("input", "output", "cacheCreate", "cacheRead")
USAGE_KEYS = {
    "input": "input_tokens",
    "output": "output_tokens",
    "cacheCreate": "cache_creation_input_tokens",
    "cacheRead": "cache_read_input_tokens",
}


def new_acc():
    return {c: 0 for c in CATS}


def acc_total(acc):
    return sum(acc[c] for c in CATS)


class Deduper:
    """max-per-category dedup keyed on message.id + ':' + requestId."""

    def __init__(self):
        self.seen = {}

    def take(self, rec):
        """Return (delta_per_category, first_sighting)."""
        u = rec["message"]["usage"]
        cur = {c: u.get(USAGE_KEYS[c]) or 0 for c in CATS}
        msg_id = rec.get("message", {}).get("id")
        if not msg_id:
            return cur, True
        key = msg_id + ":" + (rec.get("requestId") or "")
        prev = self.seen.get(key)
        if prev is None:
            self.seen[key] = cur
            return cur, True
        delta = {}
        for c in CATS:
            if cur[c] > prev[c]:
                delta[c] = cur[c] - prev[c]
                prev[c] = cur[c]
            else:
                delta[c] = 0
        return delta, False


def iter_records(path):
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def is_usage_record(rec):
    return rec.get("type") == "assistant" and isinstance(
        rec.get("message"), dict
    ) and isinstance(rec["message"].get("usage"), dict)


def list_agent_transcripts(subdir):
    out = []
    for root, _dirs, files in os.walk(subdir):
        for name in files:
            if name.endswith(".jsonl"):
                out.append(os.path.join(root, name))
    return sorted(out)


def scan_main(folder_path):
    """Folder-scoped dedup over session files, oldest-first by mtime.

    Returns {sessionId: {raw, deduped, turns}} plus folder totals.
    """
    files = [
        f
        for f in os.listdir(folder_path)
        if f.endswith(".jsonl") and os.path.isfile(os.path.join(folder_path, f))
    ]
    files.sort(
        key=lambda f: (round(os.stat(os.path.join(folder_path, f)).st_mtime * 1000), f)
    )

    deduper = Deduper()
    sessions = {}
    folder_raw = new_acc()
    folder_deduped = new_acc()

    for fname in files:
        sid = fname[: -len(".jsonl")]
        raw = new_acc()
        deduped = new_acc()
        turns = 0
        for rec in iter_records(os.path.join(folder_path, fname)):
            if not is_usage_record(rec):
                continue
            u = rec["message"]["usage"]
            for c in CATS:
                raw[c] += u.get(USAGE_KEYS[c]) or 0
            delta, first = deduper.take(rec)
            for c in CATS:
                deduped[c] += delta[c]
            if first:
                turns += 1
        sessions[sid] = {
            "raw": raw,
            "rawTotal": acc_total(raw),
            "deduped": deduped,
            "dedupedTotal": acc_total(deduped),
            "turns": turns,
        }
        for c in CATS:
            folder_raw[c] += raw[c]
            folder_deduped[c] += deduped[c]

    return sessions, {
        "raw": folder_raw,
        "rawTotal": acc_total(folder_raw),
        "deduped": folder_deduped,
        "dedupedTotal": acc_total(folder_deduped),
    }


def scan_subagents(folder_path, session_id):
    """Session-scoped dedup across all agent transcripts (recursive, sorted)."""
    subdir = os.path.join(folder_path, session_id, "subagents")
    if not os.path.isdir(subdir):
        return None
    files = list_agent_transcripts(subdir)
    deduper = Deduper()
    raw = new_acc()
    deduped = new_acc()
    turns = 0
    tool_use_ids = set()
    tool_uses_raw = 0
    per_model = defaultdict(new_acc)

    for fpath in files:
        for rec in iter_records(fpath):
            if rec.get("type") != "assistant":
                continue
            msg = rec.get("message") or {}
            content = msg.get("content")
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        tool_uses_raw += 1
                        bid = block.get("id")
                        if bid:
                            tool_use_ids.add(bid)
            if not isinstance(msg.get("usage"), dict):
                continue
            u = msg["usage"]
            for c in CATS:
                raw[c] += u.get(USAGE_KEYS[c]) or 0
            delta, first = deduper.take(rec)
            model = msg.get("model") or "unknown"
            if model == "<synthetic>":
                model = "unknown"
            for c in CATS:
                deduped[c] += delta[c]
                per_model[model][c] += delta[c]
            if first:
                turns += 1

    return {
        "agentFiles": len(files),
        "raw": raw,
        "rawTotal": acc_total(raw),
        "deduped": deduped,
        "dedupedTotal": acc_total(deduped),
        "turns": turns,
        "toolUsesRaw": tool_uses_raw,
        "toolUsesDeduped": len(tool_use_ids),
        "perModel": {m: dict(a, total=acc_total(a)) for m, a in sorted(per_model.items())},
    }


def main(argv):
    args = argv[1:]
    projects_dir = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    if args and args[0] == "--projects-dir":
        projects_dir = args[1]
        args = args[2:]
    if not args:
        print(__doc__, file=sys.stderr)
        return 2

    folder = args[0]
    wanted = args[1:]
    folder_path = os.path.join(projects_dir, folder)
    if not os.path.isdir(folder_path):
        print(f"folder not found: {folder_path}", file=sys.stderr)
        return 1

    sessions, folder_totals = scan_main(folder_path)

    report = {"folder": folder, "folderMain": folder_totals, "sessions": {}}
    ids = wanted or sorted(sessions.keys())
    for sid in ids:
        entry = {"main": sessions.get(sid)}
        sub = scan_subagents(folder_path, sid)
        if sub:
            entry["subagents"] = sub
            if entry["main"]:
                entry["combinedDedupedTotal"] = (
                    entry["main"]["dedupedTotal"] + sub["dedupedTotal"]
                )
        report["sessions"][sid] = entry

    # Invariant: sum of per-session deduped == folder deduped total.
    sum_sessions = new_acc()
    for s in sessions.values():
        for c in CATS:
            sum_sessions[c] += s["deduped"][c]
    report["invariantSessionsSumEqualsFolder"] = sum_sessions == folder_totals["deduped"]

    json.dump(report, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
