"""Read a shell command the way the shell will, before the shell does.

Kaaval never runs anything here. It splits a command line into simple commands,
finds the ones that can destroy or move data, and works out which paths they will
touch after the shell has expanded ~, $HOME and other variables. A destructive
command whose targets can't be resolved statically is reported as such, so the
guard can ask instead of guessing.
"""
from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass, field

# Command separators the shell treats as "start a new command".
_SEPARATORS = {";", "&&", "||", "|", "&", "\n"}
_PREFIXES = {"sudo", "doas", "nohup", "time", "command", "builtin", "exec", "env", "xargs", "nice"}
_WRAPPERS = {"bash", "sh", "zsh", "dash"}

# Windows commands (cmd.exe and PowerShell) that delete or move.
_WIN_DESTRUCTIVE = {"rmdir", "rd", "del", "erase", "remove-item", "ri"}
_WIN_MOVE = {"move", "ren", "rename", "move-item", "mi"}

_DRIVE = re.compile(r"^[a-zA-Z]:[\\/]?")
_DYNAMIC = re.compile(r"\$\(|`|\$\{?[A-Za-z_]+\}?")


@dataclass
class Op:
    """One simple command that can destroy, overwrite or move data."""
    verb: str                      # rm, mv, mkdir, redirect, find-delete, ...
    raw: str                       # the simple command as written
    targets: list[str] = field(default_factory=list)      # resolved absolute paths
    sources: list[str] = field(default_factory=list)      # for mv/cp: what is being moved
    unresolved: list[str] = field(default_factory=list)   # targets we could not resolve
    recursive: bool = False
    mutating: bool = True


def split_commands(line: str) -> list[list[str]]:
    """Split a command line into simple commands (lists of words).

    Handles ;, &&, ||, | and &. Unwraps `bash -c "..."`, `sudo`, `env X=1`, `xargs`.
    """
    lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        tokens = list(lexer)
    except ValueError:
        # Unbalanced quotes: fall back to a plain split so the guard still sees something.
        tokens = line.split()
    commands, cur = [], []
    for tok in tokens:
        if tok in _SEPARATORS or set(tok) <= set(";&|"):
            if cur:
                commands.append(cur)
            cur = []
        else:
            cur.append(tok)
    if cur:
        commands.append(cur)

    out: list[list[str]] = []
    for cmd in commands:
        cmd = _strip_prefixes(cmd)
        if len(cmd) >= 3 and os.path.basename(cmd[0]) in _WRAPPERS and cmd[1] == "-c":
            out.extend(split_commands(cmd[2]))
        elif cmd:
            out.append(cmd)
    return out


def _strip_prefixes(cmd: list[str]) -> list[str]:
    i = 0
    while i < len(cmd):
        if os.path.basename(cmd[i]) in _PREFIXES:
            i += 1
            while i < len(cmd) and cmd[i].startswith("-"):   # sudo -E, xargs -0
                i += 1
        elif re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", cmd[i]):   # FOO=bar cmd ...
            i += 1
        else:
            break
    return cmd[i:]


def resolve(path: str, cwd: str, home: str) -> str | None:
    """Expand ~ and $HOME, make absolute, normalise. None if it depends on runtime values."""
    if _DRIVE.match(path):
        return path.replace("\\", "/").rstrip("/") + ("/" if len(path) <= 3 else "")
    p = path
    if p == "~" or p.startswith("~/"):
        p = home + p[1:]
    p = p.replace("${HOME}", home).replace("$HOME", home)
    if _DYNAMIC.search(p):
        return None
    if not os.path.isabs(p):
        p = os.path.join(cwd, p)
    p = os.path.normpath(p)
    # Follow symlinks that already exist, so a link into $HOME can't hide the real target.
    if os.path.lexists(p):
        p = os.path.realpath(p)
    return p


def _paths(args: list[str]) -> list[str]:
    return [a for a in args if not a.startswith("-") or a == "-"]


def _flags(args: list[str]) -> str:
    return "".join(a.lstrip("-") for a in args if a.startswith("-") and a != "-")


def destructive_ops(line: str, cwd: str, home: str) -> list[Op]:
    """Every simple command in `line` that deletes, overwrites, moves or creates paths."""
    ops: list[Op] = []
    for words in split_commands(line):
        raw = " ".join(words)
        words, redirects = _take_redirects(words)
        for target in redirects:
            ops.append(_op("redirect", raw, [target], cwd, home))
        if not words:
            continue
        verb = os.path.basename(words[0]).lower()
        args = words[1:]

        win_switches = [a for a in args if re.fullmatch(r"/[A-Za-z]", a)]
        if verb in {"rm", "unlink", "shred", "rmdir"} and not win_switches:
            op = _op(verb, raw, _paths(args), cwd, home)
            op.recursive = verb == "rmdir" or any(c in _flags(args) for c in "rR")
            ops.append(op)
        elif verb in _WIN_DESTRUCTIVE:
            if verb in {"remove-item", "ri"}:
                targets = [a for a in args if not a.startswith("-")]
            else:
                targets = [a for a in args if a not in win_switches]
            op = _op(verb, raw, targets, cwd, home)
            op.recursive = any(a.lower() in {"/s", "-recurse"} for a in args)
            ops.append(op)
        elif verb in {"mv", "cp"} or verb in _WIN_MOVE:
            paths = _paths(args) if verb in {"mv", "cp"} else [a for a in args if not a.startswith("/")]
            if len(paths) >= 2:
                op = _op("mv" if verb != "cp" else "cp", raw, [paths[-1]], cwd, home)
                op.sources = [r for r in (resolve(s, cwd, home) for s in paths[:-1]) if r]
                op.recursive = len(paths) > 2 or paths[-1].endswith(("/", "\\"))
                ops.append(op)
        elif verb == "mkdir":
            op = _op("mkdir", raw, _paths(args), cwd, home)
            op.mutating = True
            ops.append(op)
        elif verb == "find" and ("-delete" in args or ("-exec" in args and any(a in {"rm", "shred"} for a in args))):
            roots = []
            for a in args:
                if a.startswith("-"):
                    break
                roots.append(a)
            ops.append(_op("find-delete", raw, roots or ["."], cwd, home))
            # A filter (-name, -path, -mtime...) narrows what is deleted; without one, everything under the root goes.
            filters = {"-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-newer", "-mtime", "-mmin", "-size", "-user"}
            ops[-1].recursive = not any(a in filters for a in args)
        elif verb in {"chmod", "chown"} and any(c in _flags(args) for c in "R"):
            ops.append(_op(verb, raw, _paths(args)[1:], cwd, home))
            ops[-1].recursive = True
        elif verb == "truncate" or verb == "dd":
            targets = [a.split("=", 1)[1] for a in args if a.startswith("of=")] if verb == "dd" else _paths(args)[-1:]
            ops.append(_op(verb, raw, targets, cwd, home))
        elif verb == "git" and args[:1] == ["clean"] and any("f" in a for a in args if a.startswith("-")):
            ops.append(_op("git-clean", raw, ["."], cwd, home))
            ops[-1].recursive = True
        elif verb == "rsync" and "--delete" in args and len(_paths(args)) >= 2:
            ops.append(_op("rsync-delete", raw, [_paths(args)[-1]], cwd, home))
            ops[-1].recursive = True
    return ops


def _take_redirects(words: list[str]) -> tuple[list[str], list[str]]:
    """Strip > and >> redirections; return the remaining words and the files they write."""
    kept, targets, i = [], [], 0
    while i < len(words):
        w = words[i]
        if w in {">", ">>", "1>", "2>", "&>"} and i + 1 < len(words):
            if words[i + 1] != "/dev/null":
                targets.append(words[i + 1])
            i += 2
            continue
        m = re.match(r"^(?:[12&]?>>?)(.+)$", w)
        if m and m.group(1) != "/dev/null" and not w.startswith(">=") :
            targets.append(m.group(1))
            i += 1
            continue
        kept.append(w)
        i += 1
    return kept, targets


def _op(verb: str, raw: str, paths: list[str], cwd: str, home: str) -> Op:
    op = Op(verb=verb, raw=raw)
    for p in paths:
        r = resolve(p, cwd, home)
        (op.targets if r else op.unresolved).append(r or p)
    return op
