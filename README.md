# kaaval

*Kaaval* (காவல்) is Tamil for "guard". It is a permission layer that sits between an AI coding agent and the shell, the database and its other tools, and decides **allow**, **ask** or **deny** before anything runs.

**Try it live:** [shyamvasansathiskumar-ux.github.io/kaaval](https://shyamvasansathiskumar-ux.github.io/kaaval/). The page runs this exact package in your browser through Pyodide, and replays all six incidents. The site's source is in [`docs/`](docs/).

It exists because of a finding in [ai-incident-atlas](https://github.com/shyamvasansathiskumar-ux/ai-incident-atlas): in six public incidents between July 2025 and April 2026, AI agents destroyed real data **with no attacker involved**. Every control that would have stopped them lives outside the model. None of them is a better prompt. Kaaval is those controls, written as code.

```
$ kaaval check -- "rm -rf tests/ patches/ plan/ ~/"
DENY  rm -rf tests/ patches/ plan/ ~/
  [NA-01] `rm` would touch /Users/you — the home directory (/Users/you/project)

$ kaaval freeze on
$ kaaval sql postgres://db/app "DELETE FROM users"
DENY  [postgres://db/app] DELETE FROM users
  [NA-01] DROP / TRUNCATE / unbounded DELETE or UPDATE
  [NA-03] freeze is on: changes are refused, not discouraged
```

## The five rules

Each rule enforces one of the proposed checklist entries from the atlas (`analysis/no-adversary-failures.md`).

| Rule | Failure it stops | How |
|---|---|---|
| **NA-01** Scope widening | The right destructive command with an over-broad target | Every target of `rm`, `rmdir`, `mv`, `cp`, `find -delete`, `>`, `dd`, `git clean`, `rsync --delete`, `chmod -R`, and Windows `rmdir /s` / `del` / `Remove-Item` is resolved the way the shell will resolve it: `~`, `$HOME`, `..` and existing symlinks. Anything outside the workspace is denied. Targets that depend on runtime values (`$DIR`, `$(...)`) are sent to a human. |
| **NA-02** Unverified precondition | Carrying on after a step failed | After a mutating step fails, or its post-condition doesn't hold (for example, `mkdir` exits 0 but no directory exists), every further change is refused until a human runs `kaaval ack`. Moving several files into a path that isn't an existing directory is refused before it runs. |
| **NA-03** Constraint override | Breaking a freeze, or ignoring "stop" | `kaaval freeze on` and `kaaval stop` change permissions, not the prompt. While either is on, nothing that changes state runs. Reads still work. |
| **NA-04** Credential overreach | A staging task reaching production or the backups | The workspace is bound to one environment. Commands, SQL targets and tool resources that name another environment (`prod`, `production`, `live`), and destructive actions that name backups or snapshots, are denied. |
| **NA-05** State misreporting | The agent's account of the damage is wrong | Every decision and every real outcome goes into a hash-chained ledger (`.kaaval/ledger.jsonl`). `kaaval report` says what happened from the record. `kaaval verify` detects any edited or deleted line. |

## The incidents, replayed

`tests/test_incidents.py` runs each incident's damaging action through the guard. The 08 and 09 commands are verbatim from the public record. The others are reconstructions of the same shape, because the exact commands weren't published, and each test says which kind it is.

| # | Incident | What the agent did | Kaaval |
|---|---|---|---|
| 05 | OpenClaw, Feb 2026 | Kept deleting a live inbox after being told to stop | `stop` → DENY (NA-03) |
| 06 | Replit, Jul 2025 | Destructive SQL against production during a code freeze | freeze → DENY (NA-03); dev session → prod DB DENY (NA-04) |
| 07 | Gemini CLI, Jul 2025 | `mkdir` failed; moved files into the missing folder, overwriting each one | move into a non-directory DENY; chain stopped after the failed step (NA-02) |
| 08 | Google Antigravity, Nov 2025 | `rmdir /s /q d:\` while clearing one cache folder | drive root DENY (NA-01) |
| 09 | Claude Code, Dec 2025 | `rm -rf tests/ patches/ plan/ ~/` | home directory DENY (NA-01) |
| 10 | Cursor / PocketOS, Apr 2026 | Staging work deleted the production database and backup volumes via Railway | production named from staging DENY; backups DENY (NA-04) |

Each replay also checks that the narrow, intended version of the command is still **allowed**. A guard that blocks everything isn't a guard anyone keeps switched on.

## Use it

Python 3.10+, no dependencies.

```sh
pip install .                  # or: python -m kaaval ...
cd your-project
kaaval init --env staging      # creates .kaaval/policy.json; this directory is the workspace
kaaval check -- "rm -rf build" # decide only
kaaval run -- "rm -rf build"   # decide, run if allowed, record the real outcome
kaaval report                  # what actually happened
kaaval verify                  # is the record intact?
```

### In front of Claude Code

Kaaval can answer Claude Code's `PreToolUse` hook. Add this to `.claude/settings.json` in the project:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "python3 -m kaaval hook claude-code" }] }
    ]
  }
}
```

Bash commands are checked as shell. Write and Edit are checked as writes to their file path. Other tools pass through to the agent's own permission settings.

## Tests

```sh
python3 -m unittest discover -s tests -v     # 39 tests
```

These cover the six incident replays, shell parsing (compound commands, `bash -c`, `sudo`, `env`, redirects, `..`, symlinks into `$HOME`), SQL classification (comments and string literals can't hide a missing `WHERE`), environment word boundaries (`products` is not `prod`), ledger tampering and deletion, state surviving a restart, and the Claude Code hook.

## What this is not

Read this before relying on it.

- **It's not a sandbox.** It reads commands statically. A determined program can hide intent: write a script and run it, use `python -c`, or base64-decode into a shell. Kaaval is one layer. The others are least-privilege credentials, an OS sandbox or container, and backups the agent can't reach. The atlas's main finding is that permissions bound the damage, and that applies to this tool too.
- **The environment check is a word match.** `prod`, `production` and `live` are configurable, and it uses word boundaries, but a production database called `db7` won't be caught. Name your environments, or bind credentials so the agent can't reach production at all. That's the real fix for NA-04.
- **The SQL check reads keywords, not a parse tree.** It's good enough to catch `DROP`, `TRUNCATE` and an unbounded `DELETE`. It isn't a SQL firewall.
- **`ASK` needs a human to answer.** In `kaaval run` and the hook it surfaces as a prompt. In an unattended pipeline, treat `ASK` as `DENY`.

## Mapping

| | |
|---|---|
| OWASP LLM Top 10 (2025) | LLM05 Improper Output Handling, LLM06 Excessive Agency |
| OWASP Agentic Top 10 (2026) | ASI02 Tool Misuse and Exploitation, ASI03 Identity and Privilege Abuse, ASI08 Cascading Failures |
| MITRE ATLAS | `AML.T0101` Data Destruction via AI Agent Tool Invocation (effect), `AML.T0053` AI Agent Tool Invocation |
| NIST AI RMF | MANAGE 2.4 (mechanisms to supersede or deactivate), MEASURE 2.6 (fail safely), MAP 3.5 (human oversight), GOVERN 6.1 (third-party risk) |

## Notes

Built with Claude as a pair programmer, from the controls written up in ai-incident-atlas. The rules, the test cases and the limits above are mine to defend.

MIT licence.
