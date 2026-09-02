---
name: prime-agent-delegate
description: Delegate bounded implementation, prototyping, investigation, or testing to Prime Agent in Ubuntu WSL, then independently review and correct the candidate result as Codex.
---

# Prime Agent Delegate

Use `/usr/bin/prime-agent` in the local `Ubuntu` WSL distribution. Reuse its
current configuration and credentials. Do not install, update, log out, or
expose credentials. Prime Agent `0.8.1` is the verified runtime.

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
2. Stage task context (see "Task context" below): exact guard strings, excerpts, or a
   recon list of the files the worker must read. Write the task so the first edits do not
   depend on broad exploration.
3. Run the installation check:

```powershell
node <skill-dir>\scripts\delegate.mjs --check
```

4. Write a self-contained task with scope, constraints, gates, and:
   `Do not commit. Work only inside the supplied cwd.`
5. For edits, create a separate `codex/prime-agent-<slug>` worktree under
   `C:\Project-Prime\worktrees\<project>\<slug>`, where `<project>` is the
   repository directory name. Never let Prime and Codex edit the same
   worktree concurrently.
6. Keep the task file outside the delegated worktree, under
   `C:\Project-Prime\runs\<project>\` next to that project's run folders
   (for example `C:\Project-Prime\runs\Prime-agent-delegate\smoke-task.md`),
   or under ignored `.codex/` in the repository.
7. Generate the WSL command:

```powershell
node <skill-dir>\scripts\delegate.mjs --prepare-command `
  --cwd <absolute-windows-worktree-path> `
  --prompt-file <absolute-windows-task-file> `
  --out-dir <absolute-windows-output-directory>
```

The generated command always stores run artifacts outside the delegated
worktree. By default `--prepare-command` resolves the output directory to
`C:\Project-Prime\runs\<project>\<threadId>\<runId>` and passes it to the
launcher as an explicit `--out-dir` together with the matching `--run-id`.
Pass `--project-id <id>` to group runs by repository directory name and
`--thread-id <id>` to group runs by Codex thread; without them the path uses
the `default` segment. An explicit `--out-dir` on `--prepare-command` still
overrides this location.

8. Run the emitted command with `wsl bash -lc`.
9. Read `summary.json` and `audit-summary.json` first. Query `events.jsonl` only
   with targeted filters when compact evidence is insufficient.
10. Prime may run focused checks for its bounded change, but must leave the full
   integration and regression suites to Codex after the worker session exits.
11. Inspect the complete diff and rerun every acceptance check independently.
12. Accept, fix, partially reuse, or reject the result. Commit only after Codex
    verification and user authorization.

## Task context

Every unknown the worker must resolve by reading the repository costs model turns.
Move host knowledge into the task before delegating:

- Put exact strings the worker must assert or reproduce (guard lines, identifiers,
  current wording) directly into the task file.
- List the allowed files with a one-line reason each, and order the steps so cheap
  document edits land before source-dependent assertions.
- For repeated task families, keep a recon script next to the task file that prints
  the needed excerpts in one deterministic command, and name it as the expected first
  tool call.

For runs that need sealed, auditable context, pass repeatable `--stage-context
<windows-path>[@<start>-<end>]` flags. The launcher copies each source into
`<run-dir>/context/`, records a sha256 manifest, and instructs the worker to batch-read
that directory first and treat it as the authoritative view of those sources. Use
`--no-staged-context` to opt out for a single run. Staged context is an audit snapshot,
not live repository state: generate it from a fresh worktree immediately before launch.

Task delivery is selected automatically: tasks whose text is at most
`--inline-task-bytes <N>` UTF-8 bytes (default 1024, range 200-8192) ship inline in
the wire prompt; anything larger goes through task parts. Raise
`--task-part-bytes <N>` (default 600, range 200-8192) only after one verified live
run on the target configuration, and confirm the checksum gate below passed.

Integrity gate for split delivery: the parts manifest records `taskSha256` of the
full task, and the worker instruction requires `cat <parts in order> | sha256sum` to
match it before any edit; a mismatch must be reported as `task_integrity_mismatch`
without changing files. `summary.transport.taskSha256` records the expected digest
for run audits.

## Modes

Read-only investigation uses the default single-shot mode and explicitly
forbids edits. The launcher compares the final Git state with the launch
baseline and fails with `read_only_violation` if Prime changes the worktree.

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

Prime process control uses RPC stdin by default, so the initial instruction
never enters argv or a shell command. The launcher performs a `get_state`
handshake, records a synthetic session header with Prime's real session id,
sends one prompt command, and closes stdin. Use `--transport cli` only as a
compatibility fallback.

Prime's downstream CCR can replace user messages even when RPC delivery is
byte-perfect. Tools-enabled runs ship short tasks inline (see "Task context" for the
threshold and integrity gate) and larger tasks through
`task-parts/manifest.json`; RPC or CLI then carries only the short manifest
instruction directing Prime to batch-read all task parts, verify the stitched
checksum, and only then execute. `--no-tools` cannot read files, so it stays
inline-only and limited to effective prompts of at most
`--inline-task-bytes` UTF-8 bytes.

Optional metadata:

```text
--task-id <id>
--work-package-id <id>
--task-type implementation|investigation|testing|prototype
--delegation-mode implement|prototype|investigate
--transport rpc|cli
--task-part-bytes <200-8192>
--inline-task-bytes <200-8192>
--stage-context <windows-path>[@<start>-<end>] (repeatable)
--no-staged-context
```

## Run storage

Run artifacts are stored outside the delegated worktree:

```text
C:\Project-Prime\runs\<project>\<threadId>\<runId>\
```

The `--prepare-command` step resolves this path automatically, so run output
never pollutes Git state and never depends on repo-local ignore rules. Do not
store Prime run artifacts under `.codex/visualizations`; that directory is for
rendered artifacts, not delegation history.

Each run retains:

- `events.jsonl`, `stderr.log`, and `worker-prompt.md`;
- `health.json`, `summary.json`, and `audit-summary.json` (enriched with tool call stats `totalToolCalls` and `failedToolCalls`);
- `run-manifest.json`;
- split `task-parts/` with a `taskSha256` integrity manifest for content above the
  inline threshold;
- staged `context/` with `manifest.json` when `--stage-context` was used;
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

When a run terminates, the launcher writes a completion marker
`.prime-task-complete.json` into the delegated worktree. After Codex has
integrated or discarded the result, remove the worktree with the cleanup
command of your choice; the marker makes completed worktrees safe to identify
and delete in bulk.

## Cleanup

Identify and remove stale delegated worktrees:

```powershell
node <skill-dir>\scripts\cleanup-worktrees.mjs `
  [--project <name>] [--min-age-hours <N>] [--apply] [--delete-branches]
```

A worktree is a cleanup candidate only when all of these hold:

- `.prime-task-complete.json` exists with a valid `runId` and `finishedAt`;
- the marker is at least `--min-age-hours` old (default 168 = 7 days);
`git status --porcelain` in the worktree shows nothing except the marker
itself.

The script scans `C:\Project-Prime\worktrees\<project>\<slug>` and never
touches worktrees without a marker, with any Git diff beyond the marker, with
an invalid marker, or whose main repository cannot be verified. Dry-run is the
default and prints a candidate table; pass `--apply` to delete. Branch
deletion requires the explicit `--delete-branches` flag and uses only
`git branch -d` (merged-only); unmerged branches stay with a warning.
Always review the dry-run output before `--apply`.

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
| `--repeated-tool-failure-limit` | 8 |
| `--task-part-bytes` | 600 |
| `--inline-task-bytes` | 1024 |
| `--autonomous-max-continuations` | 3 |
| `--autonomous-max-turns` | disabled |
| `--autonomous-max-tokens` | 1000000 |

Only startup silence, idle silence, or nonzero exit before the first valid event
may receive a bounded infrastructure restart. Code, gate, protocol, timeout,
configuration, and changed-worktree failures do not retry.
The launcher also stops eight consecutive identical failed tool
completions as `repeated_tool_failure` (`tool_loop`, owned by `prime_agent`)
while preserving the partial worktree.
`--require-change` is also checked by the launcher at process completion; exit
0 without a worktree change fails as `required_change_missing`.
`--autonomous-max-turns <N>` is an optional explicit guard. When set, the
launcher independently counts `turn_start` events and stops the first turn
beyond the limit as `max_turns_exhausted`, preserving any partial diff. When
omitted, the other time, progress, tool-loop, token, and gate watchdogs remain
active without a launcher turn-count limit.
At child completion, every changed Git path is also checked exactly against
all `--allow-change` values. Any extra path fails as `unauthorized_change`
without deleting the partial worktree.

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
