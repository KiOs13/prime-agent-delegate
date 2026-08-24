---
name: prime-agent-delegate
description: Delegate bounded implementation, prototyping, investigation, or testing to Prime Agent in Ubuntu WSL, then independently review and correct the candidate result as Codex.
---

# Prime Agent Delegate

Use `/usr/bin/prime-agent` in the local `Ubuntu` WSL distribution. Reuse its
current configuration and credentials. Do not install, update, log out, or
expose credentials. Prime Agent `0.8.0` is the verified runtime.

## Authority

Codex owns user intent, work-package decomposition, mode selection, review,
corrections, integration, commits, and production actions. Prime output is a
candidate result. A failed or unusable delegation causes Codex takeover.

Delegate useful bounded primary work by default. Codex selects:

- `implement`: autonomous changes in an isolated clean worktree;
- `prototype`: a bounded draft, autonomous when files may change;
- `investigate`: single-shot read-only analysis.

Statistics may improve task packaging but never disable delegation.

## Workflow

1. Inspect repository rules, Git state, and required checks.
2. Run the installation check:

```powershell
node <skill-dir>\scripts\delegate.mjs --check
```

3. Write a self-contained task with scope, constraints, gates, and:
   `Do not commit. Work only inside the supplied cwd.`
4. For edits, create a separate `codex/prime-agent-<slug>` worktree. Never let
   Prime and Codex edit the same worktree concurrently.
5. Keep the task file outside the delegated worktree or under ignored `.codex/`.
6. Generate the WSL command:

```powershell
node <skill-dir>\scripts\delegate.mjs --prepare-command `
  --cwd <absolute-windows-worktree-path> `
  --prompt-file <absolute-windows-task-file> `
  --out-dir <absolute-windows-output-directory>
```

7. Run the emitted command with `wsl bash -lc`.
8. Read `summary.json` and `audit-summary.json` first. Query `events.jsonl` only
   with targeted filters when compact evidence is insufficient.
9. Inspect the complete diff and rerun every acceptance check independently.
10. Accept, fix, partially reuse, or reject the result. Commit only after Codex
    verification and user authorization.

## Modes

Read-only investigation uses the default single-shot mode and explicitly
forbids edits.

Implementation uses:

```text
--autonomous
--require-change
--autonomous-gate <deterministic-command>
--allow-change <repo-relative-path>
--delegation-mode implement
```

Repeat `--allow-change` for each permitted file. Prototype mode uses
`--delegation-mode prototype`; use autonomous gates whenever it may edit.

Optional metadata:

```text
--task-id <id>
--work-package-id <id>
--task-type implementation|investigation|testing|prototype
--delegation-mode implement|prototype|investigate
```

## Run storage

The V2 default is:

```text
<target>/.prime-delegate/runs/<runId>/
```

Any output inside the worktree must already be ignored by Git. The launcher
fails before model inference and before creating artifacts otherwise. It never
changes `.gitignore` or `.git/info/exclude`. An explicit external `--out-dir`
remains supported.

Each run retains:

- `events.jsonl`, `stderr.log`, and `worker-prompt.md`;
- `health.json`, `summary.json`, and `audit-summary.json`;
- `run-manifest.json`;
- split `task-parts/` when required;
- `codex-outcome.json` after Codex review.

Semantic-compact capture preserves complete terminal messages, tool results,
turns, session metadata, and `agent_end`; only streaming deltas are omitted.
These are source artifacts for later user-controlled Hermes conversion. The
skill does not convert sessions, call `/refine`, or maintain a Hermes queue.

Record the final Codex result separately:

```powershell
node <skill-dir>\scripts\record-outcome.mjs `
  --run-dir <absolute-run-directory> `
  --verdict ACCEPTED `
  --prime-value HIGH
```

## Watchdog

Defaults:

| Option | Default |
| --- | ---: |
| `--timeout-ms` | 1800000 |
| `--startup-grace-ms` | 90000 |
| `--idle-timeout-ms` | 300000 |
| `--max-infra-restarts` | 1 |
| `--restart-delay-ms` | 5000 |
| `--no-change-timeout-ms` | 600000 |
| `--no-change-max-tool-calls` | 80 |
| `--autonomous-max-continuations` | 3 |
| `--autonomous-max-turns` | 12 |
| `--autonomous-max-tokens` | 1000000 |

Only startup silence, idle silence, or nonzero exit before the first valid event
may receive a bounded infrastructure restart. Code, gate, protocol, timeout,
configuration, and changed-worktree failures do not retry.

Check an existing run without starting Prime:

```powershell
node <skill-dir>\scripts\delegate.mjs --status-dir <absolute-run-directory>
```

Exit code 0 means the recorded state is healthy and non-stale.

## Boundaries

- Never delegate production deployment, release publication, secrets,
  credential changes, destructive cleanup, or final security judgment without
  explicit authorization for that exact action.
- `--allow-change` is validation, not a security sandbox.
- Do not pass secrets in task files or command lines.
- Do not report success from exit code or assistant text alone.
- Do not load full event trajectories into Codex context by default.
- Do not ask Prime to repair launcher Git context.
- Do not use the modified skill to prove itself before source verification.
