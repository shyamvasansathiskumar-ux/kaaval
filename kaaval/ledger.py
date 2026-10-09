"""An append-only, hash-chained record of what the agent asked for and what actually happened.

NA-05 (state misreporting) is answered here. After an incident, recovery decisions
should rest on this file, not on the agent's own account. Each entry carries the
SHA-256 of the previous one, so editing or deleting a line breaks the chain and
`verify()` says where.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path

GENESIS = "0" * 64


class Ledger:
    def __init__(self, path: str | os.PathLike | None = None):
        self.path = Path(path) if path else None
        self.entries: list[dict] = []
        if self.path and self.path.exists():
            self.entries = [json.loads(l) for l in self.path.read_text().splitlines() if l.strip()]

    @property
    def head(self) -> str:
        return self.entries[-1]["hash"] if self.entries else GENESIS

    def append(self, kind: str, **data) -> dict:
        body = {"seq": len(self.entries), "ts": round(time.time(), 3), "kind": kind, "prev": self.head, **data}
        body["hash"] = _digest(body)
        self.entries.append(body)
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a") as f:
                f.write(json.dumps(body, sort_keys=True) + "\n")
        return body

    def verify(self) -> tuple[bool, str]:
        prev = GENESIS
        for i, e in enumerate(self.entries):
            if e.get("seq") != i:
                return False, f"entry {i}: sequence number is {e.get('seq')}, expected {i} (line removed or reordered)"
            if e.get("prev") != prev:
                return False, f"entry {i}: chain broken (previous entry altered or removed)"
            if _digest({k: v for k, v in e.items() if k != "hash"}) != e.get("hash"):
                return False, f"entry {i}: contents altered after it was written"
            prev = e["hash"]
        return True, f"{len(self.entries)} entries, chain intact"

    def report(self) -> dict:
        """What happened, from the record alone: the answer to 'what did the agent actually do?'"""
        ran = [e for e in self.entries if e["kind"] == "outcome"]
        return {
            "requested": sum(1 for e in self.entries if e["kind"] == "decision"),
            "denied": [e["action"] for e in self.entries if e["kind"] == "decision" and e["verdict"] == "DENY"],
            "asked": [e["action"] for e in self.entries if e["kind"] == "decision" and e["verdict"] == "ASK"],
            "executed": [e["action"] for e in ran],
            "failed": [e["action"] for e in ran if not e["ok"]],
            "halts": [e.get("reason", "") for e in self.entries if e["kind"] == "halt"],
        }


def _digest(body: dict) -> str:
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
