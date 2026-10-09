"""kaaval — command line.

  kaaval init [--env staging]        create .kaaval/ in the current directory (the workspace)
  kaaval check -- <command>          print the decision, run nothing (exit 0 allow, 1 ask, 2 deny)
  kaaval run -- <command>            run it only if allowed, record the real outcome
  kaaval sql <target> <query>        decide on a SQL statement against a named target
  kaaval freeze on|off               code freeze as a permission
  kaaval stop [reason] / resume      halt everything that changes state
  kaaval ack                         a human accepts a failed step; the chain may continue
  kaaval log / report / verify       the ledger: what happened, from the record not the agent
  kaaval hook claude-code            PreToolUse hook: reads the tool call on stdin, prints a decision
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from .guard import ALLOW, Guard, Policy

EXIT = {"ALLOW": 0, "ASK": 1, "DENY": 2}


def _find_root(start: Path) -> Path | None:
    for d in [start, *start.parents]:
        if (d / ".kaaval" / "policy.json").exists():
            return d
    return None


def _guard() -> Guard:
    root = _find_root(Path.cwd())
    if not root:
        sys.exit("kaaval: no .kaaval/ here or above. Run `kaaval init` in the workspace root.")
    cfg = json.loads((root / ".kaaval" / "policy.json").read_text())
    return Guard(Policy(**cfg), root / ".kaaval")


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in {"-h", "--help", "help"}:
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    if rest[:1] == ["--"]:
        rest = rest[1:]

    if cmd == "init":
        env = rest[rest.index("--env") + 1] if "--env" in rest else "staging"
        d = Path.cwd() / ".kaaval"
        d.mkdir(exist_ok=True)
        (d / "policy.json").write_text(json.dumps({"workspace": str(Path.cwd()), "env": env}, indent=2))
        print(f"kaaval: workspace {Path.cwd()} bound to environment '{env}'")
        return 0

    g = _guard()
    if cmd in {"check", "run"}:
        line = " ".join(rest)
        d = g.check(line, os.getcwd())
        print(d)
        if cmd == "check" or d.verdict != ALLOW:
            return EXIT[d.verdict]
        proc = subprocess.run(line, shell=True)
        ok = proc.returncode == 0 and _postconditions_hold(line, g)
        g.record(line, ok, f"exit {proc.returncode}" + ("; post-condition failed" if proc.returncode == 0 and not ok else ""), mutating=d.mutating)
        if not ok and d.mutating:
            print("kaaval: step failed. Further changes are blocked until `kaaval ack`.", file=sys.stderr)
        return proc.returncode or (0 if ok else 3)
    if cmd == "sql":
        d = g.check({"tool": "sql", "target": rest[0], "query": " ".join(rest[1:])})
        print(d)
        return EXIT[d.verdict]
    if cmd == "freeze":
        g.freeze(rest[:1] != ["off"])
        print(f"freeze {'on' if g.state.freeze else 'off'}")
        return 0
    if cmd == "stop":
        g.stop(" ".join(rest) or "stop requested by a human")
        print("stopped")
        return 0
    if cmd == "resume":
        g.resume()
        print("resumed")
        return 0
    if cmd == "ack":
        g.acknowledge()
        print("acknowledged")
        return 0
    if cmd == "log":
        for e in g.ledger.entries:
            print(json.dumps(e))
        return 0
    if cmd == "report":
        print(json.dumps(g.ledger.report(), indent=2))
        return 0
    if cmd == "hook" and rest[:1] == ["claude-code"]:
        from .hooks import run_claude_code
        return run_claude_code(g)
    if cmd == "verify":
        ok, msg = g.ledger.verify()
        print(msg)
        return 0 if ok else 4
    print(f"kaaval: unknown command {cmd!r}", file=sys.stderr)
    return 64


def _postconditions_hold(line: str, g: Guard) -> bool:
    """The harness checks results itself instead of trusting the agent (NA-02)."""
    from . import shell
    for op in shell.destructive_ops(line, os.getcwd(), g.policy.home):
        if op.verb == "mkdir" and not all(os.path.isdir(t) for t in op.targets):
            return False
        if op.verb in {"rm", "rmdir", "unlink"} and any(os.path.lexists(t) for t in op.targets):
            return False
    return True


if __name__ == "__main__":
    sys.exit(main())
