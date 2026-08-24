---
name: prime-agent-delegate
description: Delegate bounded implementation, investigation, or test work from Codex to Prime Agent in local Ubuntu WSL, let Prime Agent choose its own execution strategy, then independently review, test, and correct the result. Use when the user asks Codex to make Prime Agent the primary worker while Codex retains final validation and ownership.
---

# Prime Agent Delegate

Use `/usr/bin/prime-agent` in the local `Ubuntu` WSL distribution. Reuse its current `~/.prime/agent` configuration and credentials. Do not install, update, log out, or expose credentials.

Prime Agent `0.8.0` is the currently verified runtime. Do not spoof its version.

## Workflow

1. Inspect the target repository rules and current git status.
2. Write a self-contained task specification with scope, constraints, acceptance gates, and this instruction: `Do not commit. Work only inside the supplied cwd.`
3. For any task that may edit files, create a separate git worktree and a `codex/prime-agent-<slug>` branch. Never delegate edits in the user's active dirty worktree. The launcher must pass its WSL Git preflight before model inference. It converts a Windows linked-worktree `.git` pointer into WSL `GIT_DIR` and `GIT_WORK_TREE`; do not ask Prime Agent to repair Git context itself.
4. Save the specification to a file outside the delegated worktree or under its ignored `.codex/` directory.
5. Generate and run the launcher via WSL:

```bash
# Step 5a: Generate the WSL-compatible command
WSL_CMD=$(node <skill-dir>\scripts\delegate.mjs --prepare-command \
  --cwd <absolute-windows-worktree-path> \
  --prompt-file <absolute-windows-task-file> \
  --out-dir <absolute-windows-output-directory>)

# Step 5b: Run it via exec_command
exec_command wsl bash -lc "$WSL_CMD"
```

The `--prepare-command` flag outputs the exact `node delegate.mjs --wsl-mode ...` command that Codex should run via `exec_command wsl bash -lc "..."`. This bypasses the Codex Desktop sandbox which blocks `child_process.spawn("wsl.exe")` from Node.js.

The launcher writes the complete worker contract to `worker-prompt.md` for audit. Only very short tasks up to 160 characters are passed inline. Longer tasks are split into ordered 600-character files under the run directory, while the initial prompt stays short and tells Prime Agent to read each part once. The conservative inline threshold accounts for the launcher rules that are added around the task and avoids OmniRoute CCR replacing the combined initial prompt with an unretrievable hash. Do not use `@file`: Prime Agent 0.8.0 may expose it as a path that the model repeatedly tries to read. Prime Agent decides whether to work directly, use installed orchestration, or use its own subagents. Codex must not select internal Prime personas.

Do not use `--no-tools` for work that requires repository inspection. Run bounded read-only investigation and verification in the default single-shot mode; explicitly instruct the worker not to edit and verify Git remains clean. Use `--timeout-ms` when the task needs a limit other than 30 minutes.
For implementation tasks, use `--autonomous --require-change`, provide at least one explicit deterministic `--autonomous-gate <command>`, and repeat `--allow-change <repo-relative-path>` for the exact permitted files. The launcher rejects autonomous mode without an explicit completion gate. Change gates reject empty or out-of-scope work; the explicit gate proves the requested result.

Prime Agent owns its internal execution strategy. The same source-change timeout and tool-call ceiling apply regardless of that strategy.

### Watchdog options and defaults

| Option | Default | Meaning |
| --- | --- | --- |
| `--timeout-ms` | 1800000 (30 min) | Overall wall-clock deadline. Starts once at launch and never resets across restarts. |
| `--startup-grace-ms` | 90000 | No valid JSON event within this window after attempt start counts as an infrastructure failure. |
| `--idle-timeout-ms` | 300000 | After the first valid event, no valid JSON event for this long counts as an infrastructure failure. |
| `--max-infra-restarts` | 1 | Maximum automatic restarts (integer 0..3) for infrastructure failures only. |
| `--restart-delay-ms` | 5000 | Pause between a permitted restart and the next attempt (nonnegative integer). |
| `--no-change-timeout-ms` | 600000 (10 min) | With `--require-change`, stop an unchanged worker after this discovery budget. |
| `--no-change-max-tool-calls` | 80 | With `--require-change`, stop repeated tool activity that produced no source change. |
| `--autonomous-max-continuations` | 3 | Explicit Prime `0.8.0` continuation ceiling. |
| `--autonomous-max-turns` | 12 | Explicit Prime `0.8.0` assistant-turn ceiling. |
| `--autonomous-max-tokens` | 1000000 | High effective Prime `0.8.0` token ceiling; wall-clock and no-change watchdogs remain the practical limits. |

All numeric options are validated; invalid values fail the launcher with exit code 2.

`--autonomous-max-turns` is a Prime Agent soft boundary checked after an internal model/tool cycle; a single cycle can overshoot it. Do not raise it to compensate for repeated verification. Use a deterministic completion gate and single-shot mode for read-only work.

### Health file and status command

The launcher atomically writes `<out-dir>/health.json` (temp file + rename, never partially visible). Attempt starts, the first event, watchdog decisions, restarts, and terminal completion are flushed immediately; subsequent streaming events are coalesced to at most one disk write per second. It contains `schemaVersion`, `status`, `healthy`, `active`, `attempt`, `restartCount`, `maxInfraRestarts`, `childPid`, `processHost`, `startedAt`, `attemptStartedAt`, `firstEventAt`, `lastEventAt`, `updatedAt`, `eventCount`, `attemptToolCallCount`, `changeDetectedAt`, `lastReason`, `startupGraceMs`, `idleTimeoutMs`, `noChangeTimeoutMs`, `noChangeMaxToolCalls`, `restartDelayMs`, and `overallTimeoutMs`. Statuses are `starting`, `running`, `restarting`, then terminal `completed`, `failed`, `timed_out`, `unresponsive_with_changes`, or `restart_exhausted`.

Check a previous run without starting Prime Agent:

```powershell
node <skill-dir>\scripts\delegate.mjs --status-dir <absolute-windows-out-dir>
```

It prints compact JSON with `healthy` and `active`, checks that the recorded child PID is alive while an attempt is active, and compares heartbeat age against the threshold for the current status (`--startup-grace-ms` while `starting`, `--idle-timeout-ms` while `running`, and restart delay plus startup grace while `restarting`). Exit code 0 only when the state is healthy and non-stale; exit 1 otherwise.

WSL child PIDs are checked inside WSL. Windows `wsl.exe` output is normalized from UTF-8 or UTF-16LE before parsing.

### Watchdog and restart behavior

Valid parsed JSON events on stdout are the only proof of activity (stderr bytes never count). Infrastructure-unresponsive conditions, and only these, may trigger an automatic restart of the exact same task:

1. No valid JSON event within `--startup-grace-ms` of attempt start.
2. After the first valid event, no valid JSON event for `--idle-timeout-ms`.
3. The child exits nonzero before producing any valid event, unless its capped stderr preview matches a known CLI argument/configuration error.

On conditions 1 or 2 the launcher terminates only the exact spawned process tree. In WSL mode (inside Linux), it uses `kill -TERM` then `kill -9`; on Windows, it uses `taskkill /PID <pid> /T` first, then exact-PID `taskkill /PID <pid> /T /F` after a short bounded grace if still alive. It verifies that the PID disappeared before starting another attempt. No broad `pkill`/`taskkill` patterns are used.

Before a restart the worktree is compared with the `git status --porcelain` baseline captured immediately before attempt 1 (same WSL Git context used for the preflight). A restart happens only when the worktree is byte-identical to that baseline and all of these hold: the failure is one of the three conditions above, `restartCount < --max-infra-restarts`, and the overall deadline still leaves room for `--restart-delay-ms` plus `--startup-grace-ms`. Permitted restarts append synthetic compact `watchdog_event` records and preserve events/stderr from all attempts in the same `events.jsonl`/`stderr.log`.

Code/gate failures are never retried: a nonzero exit after any valid event (including a failed autonomous gate, `--autonomous-max-turns`/`--autonomous-max-tokens`, or a test/code failure), a normal exit, the overall `--timeout-ms` deadline, out-of-scope/worktree changes, and spawn/configuration/argument errors all end the run. Prime limits and gate failures receive precise terminal reasons such as `max_turns_exhausted`, `max_tokens_exhausted`, and `gate_failed`; final assistant text alone never converts failure to success. If the worktree changed during an infrastructure failure the run terminates as `unresponsive_with_changes` and preserves the diff; once the restart budget or deadline is exhausted it terminates as `restart_exhausted`. Summary JSON adds `attemptCount`, `restartCount`, `restartReasons`, `healthPath`, and `terminalReason` alongside the existing fields and artifacts.

With `--require-change`, JSON activity alone is not progress. The launcher checks the WSL Git status on tool calls and stops with `no_change_progress` when either no-change ceiling is reached before the worktree differs from its baseline.

The worker receives the complete task inline and is explicitly told not to open the audit copy in `worker-prompt.md`. The contract tells implementation workers to use targeted searches instead of whole-file dumps, make the first permitted source change before the configured no-change limit, and leave full acceptance execution to the host completion gates.

The launcher stores compact events by default: streaming `message_update` and `tool_execution_update` deltas are counted but omitted. Its audit reports turn-limit overshoot and repeated identical tool invocations. Use `--full-events` only for a dedicated protocol diagnosis because it can create very large logs.

In WSL mode, if WSL has `powershell.exe` but no `powershell` command, the launcher prepends a run-local wrapper to the child `PATH`; it does not modify the WSL installation. Do not point the process-wide `TMPDIR` at `/mnt/c`: Prime Agent uses Unix sockets under its temp directory, which DrvFS does not support.

6. Read `audit-summary.json` and `summary.json` first. Do not load `events.jsonl` into model context by default. The audit summary streams the log locally and records event counts, models, tool outcomes, failures, a redacted stderr tail, and capped command evidence.
7. If the compact audit shows a discrepancy, query `events.jsonl` with a targeted local filter and return only the matching records. Read `stderr.log` directly only when its compact tail is insufficient. A zero exit code or a claim of success is not validation.
8. Inspect the complete git diff, run the repository's required checks independently, and verify every acceptance gate.
9. Correct defects as Codex. Commit only after the result is verified and only when the user requested or authorized a commit.

## Boundaries

- Do not delegate production deployment, release publication, secret handling, credential changes, destructive cleanup, or final security judgment without explicit user authorization for that exact action.
- Do not let Prime Agent work in the same worktree concurrently with Codex.
- Do not pass secrets in the task file or command line.
- Treat WSL as an external execution boundary. Request only the scoped approval needed to run the launcher when Windows sandbox access is denied.
- Prime Agent may use its own subagents, but Codex remains accountable for the final result.
- If the launcher fails, diagnose from the saved summaries and targeted log filters. Do not report completion from partial JSON events.

## Installation check

Run this without model inference:

```powershell
node <skill-dir>\scripts\delegate.mjs --check
```

The check verifies Prime Agent's version (`prime-agent --version`) and daemon/status command reachability (`prime-agent status --json`) and reports both; exit code 0 only when both succeed.
