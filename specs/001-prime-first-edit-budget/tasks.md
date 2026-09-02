# Tasks

## Setup

- [x] T001 Confirm isolated worktree baseline and preserve the existing dirty checkout.
- [x] T002 Initialize Spec Kit Lean and complete the project constitution.

## Worker Contract

- [x] T003 [FR-001][FR-002][FR-003][FR-004] Add batched task-part, four-call exploration, and mode-specific early-edit rules in `skill-source/scripts/delegate.mjs`.
- [x] T004 [FR-005] Document exact-anchor and explicit-first-edit task packaging in `skill-source/SKILL.md`.

## Tests

- [x] T005 [FR-001..FR-004][SC-002] Capture and assert the exact RPC worker prompt in `tests/fake-prime-agent.mjs` and `tests/test-delegate-integration.mjs`.
- [x] T006 [FR-006][FR-007][SC-001][SC-005] Run syntax checks, the complete Ubuntu WSL suite, allowlist review, and `git diff --check`.

## Behavioral Verification

- [x] T007 [SC-003] Run one bounded source-skill smoke and verify the first diff occurs by worker tool call four with no failed tools.
- [x] T008 [SC-004] Commit verified source, synchronize only `SKILL.md` and `scripts/delegate.mjs` to the installed skill, verify SHA-256 parity and `--check`, then repeat the smoke through the installed copy.
