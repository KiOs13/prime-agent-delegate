# Prime First Edit Budget

## Overview

Prevent bounded Prime implementation tasks from consuming the complete no-change window on repeated repository reads. The launcher will provide a concise worker contract that requires batched task-part loading, limits initial exploration to four tool calls, and directs `--require-change` workers to make the first allowed edit before assertions or further investigation.

The existing watchdog, retry behavior, allowlist, gates, transport, and security boundaries remain unchanged.

## Functional Requirements

- **FR-001**: Tools-enabled task-parts prompts MUST list every exact part path and require the manifest and all parts to be read once, in order, in one tool call.
- **FR-002**: The worker contract MUST limit initial exploration to at most four tool calls, require batched reads, and prohibit overlapping rereads unless earlier output was incomplete.
- **FR-003**: For `--require-change`, the contract MUST require the first allowed edit within the four-call exploration budget and before writing assertions.
- **FR-004**: Read-only and investigate runs MUST receive read-efficiency guidance but MUST NOT be instructed to edit.
- **FR-005**: Codex task-packaging guidance MUST require exact anchors and an explicit first edit so the worker does not need broad reconnaissance.
- **FR-006**: Existing no-change timing, failure classification, restart policy, allowlist enforcement, autonomous gates, RPC transport, and artifact schemas MUST remain behaviorally compatible.
- **FR-007**: The feature MUST NOT add staged-context, task-part-size, sanitizer, dependency, or other public CLI changes.

## User Scenarios

1. Codex delegates a bounded implementation with an exact anchor. Prime reads the task package in one call and creates the first allowed diff no later than its fourth tool call.
2. Codex delegates an investigation. Prime batches reads but is never told to modify the worktree.
3. Prime still makes no change. The existing watchdog terminates the run as `no_change_progress` owned by `prime_agent`.

## Success Criteria

- **SC-001**: The complete Ubuntu WSL test suite passes from a clean feature worktree.
- **SC-002**: Integration tests verify exact task-part paths, one-call loading language, the four-call exploration budget, and mode-specific edit language.
- **SC-003**: A real source-skill smoke creates an allowed diff by tool call four, completes its gate, and records no failed tool calls.
- **SC-004**: After publication, source and installed `SKILL.md` and `scripts/delegate.mjs` have identical SHA-256 hashes and `delegate.mjs --check` returns `ok: true`.
- **SC-005**: The focused commit contains no staged-context, task-part-size, sanitizer, watchdog, or unrelated dirty-tree changes.

## Boundaries

The pre-existing dirty checkout at `C:\Project\Prime-agent-delegate` is preserved. Implementation occurs in an isolated worktree from clean `HEAD`. The real smoke uses non-sensitive temporary fixtures and performs no publication, deployment, or credential operation.
