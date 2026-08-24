# Prime Agent Delegate V2 Implementation Contract

## Objective

Evolve the existing `prime-agent-delegate` skill without rewriting its working
launcher. Prime Agent performs useful bounded primary work; Codex owns task
decomposition, mode selection, independent review, corrections, integration,
commits, and any production action.

Prime output is always a candidate result. An unusable Prime result causes a
Codex takeover, not failure of the user task.

## Scope

Implement:

- delegate-first workflow documentation;
- `IMPLEMENT`, `PROTOTYPE`, and `INVESTIGATE` metadata;
- ignored `.prime-delegate/runs/<runId>/` storage;
- summary schema v2 and a final run manifest;
- semantic-compact Prime event capture for later Hermes processing;
- UTF-8 byte-aware task transport;
- deterministic protocol lifecycle validation and failure classification;
- structured audit redaction;
- a separate Codex outcome recorder;
- fake-Prime integration tests.

Do not implement:

- Prime session JSONL conversion or import/export;
- `/refine` execution;
- Hermes queues or automatic candidate selection;
- corpus analytics;
- automatic changes to Prime skills, memory, prompts, or subagents;
- provider/CCR semantic retry loops;
- commit, push, deploy, credential, or production authority for Prime.

## Preserve

Preserve existing behavior unless this contract explicitly changes it:

- `/usr/bin/prime-agent` in Ubuntu WSL and `--no-session`;
- isolated Git branch/worktree delegation;
- WSL and linked-worktree Git preflight;
- explicit autonomous gates, `--require-change`, and `--allow-change`;
- startup/idle watchdogs and bounded infrastructure restarts;
- exact process-tree termination;
- `health.json`, `summary.json`, `audit-summary.json`, `events.jsonl`,
  `stderr.log`, and `worker-prompt.md`;
- compact event capture by default;
- independent Codex diff review and test execution;
- existing CLI invocations that omit all V2 metadata.

## Repository workflow

1. Confirm the current baseline and run the existing test suite.
2. For each implementation stage, establish a failing regression or a confirmed
   requirement before changing behavior.
3. Make the smallest change that fixes the shared code path.
4. Run focused tests, then all relevant tests.
5. Inspect the complete diff and commit only after Codex validation.
6. Do not use a newly modified installed skill to prove itself. Use the stable
   installed baseline until source verification is complete.

## Delegation policy

Codex alone selects one mode:

- `implement`: autonomous work that must change an isolated clean worktree;
- `prototype`: bounded draft work, using autonomous gates if files may change;
- `investigate`: single-shot read-only analysis.

Default mode is `implement` for autonomous runs and `investigate` otherwise.
`implement` requires `--autonomous --require-change`. `investigate` rejects
`--require-change`. Historical statistics never decide whether delegation is
allowed.

## Storage preflight

Generate `runId` before resolving the default output directory.

Default:

```text
<target-repository>/.prime-delegate/runs/<runId>/
```

Before creating any output:

1. Resolve the same WSL Git context used for baseline and restart checks.
2. If output is inside the worktree, run `git check-ignore` for that path.
3. Fail with launcher exit code 2 before model inference and before artifact
   creation when the path is not ignored.
4. Do not modify `.gitignore` or `.git/info/exclude`.
5. Permit an explicit `--out-dir` outside the worktree without an ignore check.

Support Windows-style and POSIX linked-worktree `.git` pointers.

## CLI metadata

Add optional arguments:

```text
--task-id <id>
--work-package-id <id>
--task-type implementation|investigation|testing|prototype
--delegation-mode implement|prototype|investigate
```

IDs must match `[A-Za-z0-9._-]{1,128}`. Invalid combinations and values fail
with exit code 2. Existing invocations remain valid.

The delegate version is `2.0.0`. Read the real Prime version from
`/usr/bin/prime-agent --version`; never synthesize it.

## Run artifacts

Each completed run directory contains:

```text
events.jsonl
stderr.log
worker-prompt.md
health.json
summary.json
audit-summary.json
run-manifest.json
task-parts/                 # split transport only
codex-outcome.json          # written later by Codex
```

Add to `summary.json` without removing existing fields:

- `schemaVersion: 2`;
- `runId`;
- delegate and Prime versions;
- task/work-package metadata;
- delegation mode;
- transport telemetry;
- protocol evidence and completeness;
- failure class and owner.

Write `run-manifest.json` last, after streams, audit, and final summary are
stable. Use relative artifact names, byte sizes, and SHA-256 hashes. Do not hash
the manifest itself. Do not automatically delete run data.

## Hermes source data

`events.jsonl` remains a Prime JSON event trajectory, not a Prime session file.

The default `semantic-compact` capture keeps source order and complete payloads
for:

- `session`;
- `agent_start` and `agent_end`;
- `turn_start` and `turn_end`;
- `message_start` and `message_end`;
- `tool_execution_start` and `tool_execution_end`;
- compaction, retry, and session events;
- synthetic watchdog events.

Drop only `message_update` and `tool_execution_update`, recording their count.
Do not truncate completed messages or tool results.

The manifest records session-header presence, Prime event schema, capture mode,
event counts, terminal lifecycle evidence, events SHA-256, and
`refineSourceAvailable`. Hermes later owns any selection, conversion, and
`/refine` invocation.

## UTF-8 transport

Use RPC stdin as the default process-control transport.

- Perform a correlated `get_state` handshake and require a real session id.
- Persist a synthetic schema-v3 session header with that id before lifecycle
  events.
- Send the selected inline or manifest instruction as one strict LF-delimited
  JSON prompt command and close stdin.
- Never place RPC task text in argv or a shell command.
- Filter RPC command responses from `events.jsonl`; retain Prime lifecycle
  events unchanged.
- Treat malformed/rejected handshake or prompt responses as delegate-owned
  transport failures.
- Do not retry through another transport after prompt inference may have
  started.

RPC does not bypass downstream CCR replacement of large user messages. Keep
size-aware content transport for both process modes:

- Measure task bytes with `Buffer.byteLength`.
- Measure the complete initial payload including worker rules and framing.
- Select inline or split transport from effective bytes.
- Split by Unicode code points without exceeding the part byte limit.
- Create `task-parts/manifest.json` with ordered exact file names, byte sizes,
  and SHA-256 hashes.
- Tell Prime to read the manifest and exact parts; do not use wildcard guessing.
- Add transport mode, task/effective bytes, part count, and maximum part bytes
  to the summary.

Keep `--transport cli` as an explicit compatibility fallback for process
control. Large `--no-tools` prompts fail before inference in both modes.

Use a deterministic effective-payload fixture instead of depending on missing
historical T053 artifacts.

## Protocol lifecycle

Track lifecycle independently from process exit.

A successful run requires:

- exit code 0;
- exactly one `session` header;
- `agent_start`;
- balanced turn start/end events;
- balanced tool start/end events by `toolCallId`;
- zero malformed JSON lines;
- terminal `agent_end`.

Exit 0 with incomplete evidence is `failed` with
`terminalReason: protocol_incomplete`.

## Failure classification

Add deterministic `failureClass` and `failureOwner`:

- launcher, argument, Git-artifact defects: `delegate_skill`;
- Prime lifecycle, loops, and Prime limits: `prime_agent`;
- structured 429/503/network evidence: `provider`;
- invalid worker contract: `task_spec`;
- gates and project tests: `project`;
- WSL, process, and filesystem failures: `environment`;
- unresolved cases: `unknown`.

Do not infer ownership from vague error words. Preserve current infrastructure
restart behavior and do not add provider or CCR recovery in V2.

## Redaction and outcome

Create one dependency-free structured sanitizer shared by audit and outcome
code. Recursively redact:

```text
authorization, apiKey, api_key, token, access_token, refresh_token,
password, passwd, secret, cookie, cookies, set-cookie
```

Also redact Bearer, Basic Authorization, and common secret `key=value` strings.
Raw local `events.jsonl` and `worker-prompt.md` remain unchanged source
evidence. Passing secrets to Prime remains prohibited.

Add:

```text
node scripts/record-outcome.mjs
  --run-dir <absolute-path>
  --verdict ACCEPTED|MINOR_FIX|MAJOR_FIX|PARTIAL_USED|REJECTED
  --prime-value HIGH|MEDIUM|LOW|NONE|NEGATIVE
```

Validate the completed manifest and run ID, sanitize the output, and atomically
create `codex-outcome.json`. Reject duplicate recording.

## Tests

Keep all existing watchdog tests passing. Add a guarded fake Prime executable
available only with `PRIME_AGENT_DELEGATE_TEST_MODE=1`.

Cover:

- ignored and non-ignored in-worktree output;
- external output;
- metadata defaults and validation;
- Cyrillic, CJK, emoji, and mixed UTF-8 splitting;
- effective payload and part manifest;
- valid lifecycle;
- exit 0 with no events;
- missing `agent_end`;
- malformed JSON and unmatched tools;
- provider, gate, and Prime-limit classifications;
- semantic-compact capture;
- nested and string redaction;
- run manifest hashes;
- outcome validation, atomic creation, and duplicate rejection;
- unchanged legacy CLI calls;
- no out-of-scope worktree changes.

Integration tests use a temporary Git repository and fake Prime process. They
must not consume LLM tokens.

## Completion

Completion requires:

- syntax checks and all unit/integration tests pass;
- existing behavior remains compatible;
- the final diff contains no unrelated changes;
- source and installed skill files match by SHA-256;
- installed `--check` exits 0;
- one bounded read-only smoke run produces coherent summary, audit, health, and
  manifest artifacts while leaving Git clean;
- no production deployment occurs.
