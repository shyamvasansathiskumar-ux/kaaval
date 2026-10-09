"""The guard: decide ALLOW / ASK / DENY for each action an agent wants to take.

Every rule here enforces one of the five no-adversary controls from
ai-incident-atlas (analysis/no-adversary-failures.md). None of them asks the model
to behave. They sit between the model and the tools, so they hold whatever it says.

  NA-01 Destructive scope widening   -> resolved-path confinement to the workspace
  NA-02 Action on unverified precond. -> chain stops after a failed mutating step;
                                         moves into missing directories refused
  NA-03 Constraint override           -> freeze and stop are permissions, not sentences
  NA-04 Credential overreach          -> the session is bound to one environment;
                                         other environments and backups are out of reach
  NA-05 State misreporting            -> hash-chained ledger of decisions and outcomes
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import shell, sql
from .ledger import Ledger

ALLOW, ASK, DENY = "ALLOW", "ASK", "DENY"
_RANK = {ALLOW: 0, ASK: 1, DENY: 2}
_MUTATING_TOOL = re.compile(r"(delete|remove|drop|purge|truncate|destroy|archive|move|send|write|update|create|reset)", re.I)


@dataclass
class Policy:
    workspace: str
    env: str = "staging"
    other_envs: list[str] = field(default_factory=lambda: ["prod", "production", "live"])
    backup_markers: list[str] = field(default_factory=lambda: ["backup", "backups", "snapshot", "snapshots"])
    home: str = field(default_factory=lambda: os.path.expanduser("~"))

    def env_pattern(self) -> re.Pattern:
        env = self.env.lower()
        # 'prod' and 'production' name the same environment: a session bound to one may use the other.
        words = [re.escape(w) for w in self.other_envs if not (env.startswith(w.lower()) or w.lower().startswith(env))]
        if not words:
            return re.compile(r"(?!x)x")
        return re.compile(r"(?<![A-Za-z0-9])(" + "|".join(words) + r")(?![A-Za-z0-9])", re.I)

    def backup_pattern(self) -> re.Pattern:
        return re.compile("|".join(re.escape(w) for w in self.backup_markers), re.I)


@dataclass
class State:
    freeze: bool = False
    halted: bool = False
    halt_reason: str = ""
    pending_failure: str = ""


@dataclass
class Decision:
    verdict: str
    findings: list[tuple[str, str]]
    action: str
    mutating: bool = False

    def __str__(self) -> str:
        lines = [f"{self.verdict}  {self.action}"]
        lines += [f"  [{rule}] {why}" for rule, why in self.findings]
        return "\n".join(lines)


class Guard:
    def __init__(self, policy: Policy, state_dir: str | os.PathLike | None = None):
        self.policy = policy
        self.policy.workspace = os.path.realpath(policy.workspace)
        self.state_dir = Path(state_dir) if state_dir else None
        self.state = State()
        if self.state_dir and (self.state_dir / "state.json").exists():
            self.state = State(**json.loads((self.state_dir / "state.json").read_text()))
        self.ledger = Ledger(self.state_dir / "ledger.jsonl" if self.state_dir else None)

    # ---- human controls (NA-03). These are the only way to change state. ----

    def freeze(self, on: bool = True) -> None:
        self.state.freeze = on
        self.ledger.append("freeze", on=on)
        self._save()

    def stop(self, reason: str = "stop requested by a human") -> None:
        self.state.halted, self.state.halt_reason = True, reason
        self.ledger.append("halt", reason=reason)
        self._save()

    def resume(self) -> None:
        self.state.halted, self.state.halt_reason = False, ""
        self.ledger.append("resume")
        self._save()

    def acknowledge(self) -> None:
        """A human has looked at the failed step and says the chain may continue (NA-02)."""
        self.ledger.append("ack", failure=self.state.pending_failure)
        self.state.pending_failure = ""
        self._save()

    # ---- the decision ----

    def check(self, action: str | dict, cwd: str | None = None) -> Decision:
        cwd = os.path.realpath(cwd or self.policy.workspace)
        kind, text, mutating, findings = self._inspect(action, cwd)

        if mutating:
            if self.state.halted:
                findings.append(("NA-03", f"session stopped by a human ({self.state.halt_reason}); nothing that changes state runs until `kaaval resume`"))
            if self.state.freeze:
                findings.append(("NA-03", "freeze is on: changes are refused, not discouraged"))
            if self.state.pending_failure:
                findings.append(("NA-02", f"an earlier step failed ({self.state.pending_failure!r}); the chain stops until a human acknowledges it"))

        verdict = ALLOW
        for rule, why in findings:
            level = DENY if not why.startswith("ask:") else ASK
            verdict = max(verdict, level, key=_RANK.__getitem__)
        findings = [(r, w.removeprefix("ask: ")) for r, w in findings]
        decision = Decision(verdict, findings, text, mutating)
        self.ledger.append("decision", action=text, tool=kind, verdict=verdict, findings=findings, mutating=mutating)
        return decision

    def record(self, action: str | dict, ok: bool, detail: str = "", mutating: bool = True) -> None:
        """Report what actually happened after an allowed action ran.

        A failed step that changed (or tried to change) state stops the chain (NA-02).
        A failed read doesn't: nothing downstream can be built on it.
        """
        text = action if isinstance(action, str) else json.dumps(action, sort_keys=True)
        self.ledger.append("outcome", action=text, ok=ok, detail=detail, mutating=mutating)
        if not ok and mutating:
            self.state.pending_failure = text
            self._save()

    # ---- inspection per tool type ----

    def _inspect(self, action, cwd):
        if isinstance(action, str):
            action = {"tool": "shell", "command": action}
        tool = action.get("tool", "shell")
        if tool == "shell":
            return self._shell(action["command"], cwd)
        if tool == "sql":
            return self._sql(action)
        return self._tool_call(action)

    def _shell(self, line: str, cwd: str):
        p, findings = self.policy, []
        ops = shell.destructive_ops(line, cwd, p.home)
        mutating = bool(ops)
        ws = p.workspace
        for op in ops:
            for t in op.unresolved:
                findings.append(("NA-01", f"ask: `{op.verb}` target {t!r} depends on runtime values and can't be checked"))
            for t in op.targets + op.sources:
                if _is_drive(t) or not _inside(t, ws):
                    where = "the home directory" if t.rstrip("/") == p.home.rstrip("/") else "the file-system root" if t in {"/", ""} or _is_drive_root(t) else "outside the workspace"
                    findings.append(("NA-01", f"`{op.verb}` would touch {t} — {where} ({ws})"))
                elif t.rstrip("/") == ws and op.recursive and op.verb not in {"mkdir"}:
                    findings.append(("NA-01", f"ask: `{op.verb}` on the whole workspace root"))
                if p.backup_pattern().search(t):
                    findings.append(("NA-04", f"`{op.verb}` on {t}: backups are out of reach for the agent"))
            if op.verb in {"mv", "cp"} and op.targets and op.recursive and not os.path.isdir(op.targets[0]):
                findings.append(("NA-02", f"`{op.verb}` into {op.targets[0]}, which is not an existing directory: each file would overwrite the last"))
            if op.verb in {"mv", "cp"} and op.targets and not os.path.isdir(os.path.dirname(op.targets[0]) or "/"):
                findings.append(("NA-02", f"`{op.verb}` destination parent {os.path.dirname(op.targets[0])} does not exist"))
        platform = _cli_mutates(line)
        mutating = mutating or platform
        env_hit = p.env_pattern().search(line)
        if env_hit and mutating:
            findings.append(("NA-04", f"this session is bound to '{p.env}', but the command names '{env_hit.group(0)}'"))
        if platform and p.backup_pattern().search(line):
            findings.append(("NA-04", "destructive platform command names backups: out of reach for the agent"))
        return "shell", line, mutating, findings

    def _sql(self, action):
        p, findings = self.policy, []
        query, target = action.get("query", ""), action.get("target", "")
        kind = sql.worst(query)
        mutating = kind != "read"
        env_hit = p.env_pattern().search(target)
        if env_hit:
            if mutating:
                findings.append(("NA-04", f"write to '{env_hit.group(0)}' database from a session bound to '{p.env}'"))
            else:
                findings.append(("NA-04", f"ask: read from '{env_hit.group(0)}' database; this session is bound to '{p.env}'"))
        if kind == "destroy":
            findings.append(("NA-01", "ask: DROP / TRUNCATE / unbounded DELETE or UPDATE"))
        return "sql", f"[{target}] {query}", mutating, findings

    def _tool_call(self, action):
        p, findings = self.policy, []
        name = action.get("tool", "")
        mutating = bool(action.get("mutating", _MUTATING_TOOL.search(name)))
        resource = str(action.get("resource", ""))
        env_hit = p.env_pattern().search(resource)
        if env_hit and mutating:
            findings.append(("NA-04", f"`{name}` on '{env_hit.group(0)}' resource from a session bound to '{p.env}'"))
        if mutating and p.backup_pattern().search(resource + " " + name):
            findings.append(("NA-04", f"`{name}` touches backups: out of reach for the agent"))
        return name, f"{name}({resource})", mutating, findings

    def _save(self):
        if self.state_dir:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            (self.state_dir / "state.json").write_text(json.dumps(asdict(self.state), indent=2))


def _inside(path: str, root: str) -> bool:
    path, root = path.rstrip("/") or "/", root.rstrip("/") or "/"
    return path == root or path.startswith(root + "/")


def _is_drive(path: str) -> bool:
    return bool(re.match(r"^[A-Za-z]:/", path))


def _is_drive_root(path: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z]:/?", path))


_PLATFORM_DESTROY = re.compile(
    r"\b(railway|vercel|heroku|fly|flyctl|kubectl|aws|gcloud|az|terraform|supabase|neonctl|render)\b.*\b(delete|destroy|remove|rm|drop|down|terminate|purge|reset)\b",
    re.I,
)


def _cli_mutates(line: str) -> bool:
    return bool(_PLATFORM_DESTROY.search(line))
