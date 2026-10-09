"""Classify SQL statements by what they can destroy. Deliberately simple: keyword-level, not a parser."""
from __future__ import annotations

import re

_COMMENT = re.compile(r"--[^\n]*|/\*.*?\*/", re.S)
_STRING = re.compile(r"'(?:[^']|'')*'")


def statements(query: str) -> list[str]:
    q = _STRING.sub("''", _COMMENT.sub(" ", query))
    return [s.strip() for s in q.split(";") if s.strip()]


def classify(stmt: str) -> str:
    """'destroy' (DROP, TRUNCATE, DELETE/UPDATE with no WHERE), 'write', or 'read'."""
    s = stmt.upper()
    first = s.split(None, 1)[0] if s.split() else ""
    if first in {"DROP", "TRUNCATE"}:
        return "destroy"
    if first in {"DELETE", "UPDATE"}:
        return "destroy" if not re.search(r"\bWHERE\b", s) else "write"
    if first in {"INSERT", "ALTER", "CREATE", "GRANT", "REVOKE", "MERGE", "REPLACE", "COPY"}:
        return "write"
    if first == "WITH" and re.search(r"\b(DELETE|UPDATE|INSERT)\b", s):
        return "write"
    return "read"


def worst(query: str) -> str:
    order = {"read": 0, "write": 1, "destroy": 2}
    kinds = [classify(s) for s in statements(query)] or ["read"]
    return max(kinds, key=order.__getitem__)
