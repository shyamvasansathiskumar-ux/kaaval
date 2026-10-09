"""Adapters that put Kaaval in front of a real agent.

Claude Code: register `python -m kaaval hook claude-code` as a PreToolUse hook.
The hook receives the pending tool call as JSON on stdin and answers with a
permission decision. Bash commands are checked as shell; Write/Edit as a write
to the file path; everything else passes through to the agent's own permissions.
"""
from __future__ import annotations

import json
import sys

from .guard import Guard


def claude_code(guard: Guard, payload: dict) -> dict:
    tool = payload.get("tool_name", "")
    inp = payload.get("tool_input", {}) or {}
    cwd = payload.get("cwd")
    if tool == "Bash":
        d = guard.check(inp.get("command", ""), cwd)
    elif tool in {"Write", "Edit", "MultiEdit", "NotebookEdit"}:
        path = inp.get("file_path") or inp.get("notebook_path") or ""
        d = guard.check(f"true > {_quote(path)}", cwd)
    else:
        return {}
    decision = {"ALLOW": "allow", "ASK": "ask", "DENY": "deny"}[d.verdict]
    reason = "; ".join(f"[{r}] {w}" for r, w in d.findings) or "kaaval: no rule matched"
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                   "permissionDecision": decision,
                                   "permissionDecisionReason": reason}}


def _quote(p: str) -> str:
    return "'" + p.replace("'", "'\\''") + "'"


def run_claude_code(guard: Guard) -> int:
    out = claude_code(guard, json.load(sys.stdin))
    if out:
        print(json.dumps(out))
    return 0
