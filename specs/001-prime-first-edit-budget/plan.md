# Implementation Plan

## Technical Context

The launcher is dependency-free Node.js and runs Prime Agent through Ubuntu WSL JSONL RPC. Task prompts are assembled in `skill-source/scripts/delegate.mjs`; user-facing workflow guidance lives in `skill-source/SKILL.md`; integration behavior is covered by the fake Prime executable and Node's built-in test runner.

## Design

- Tighten only the generated worker prompt. Keep the watchdog and runtime state machine unchanged.
- Add explicit task-part paths to the file-backed prompt so one batched read needs no manifest-discovery turn.
- Apply early-edit language only when `--require-change` is active; read-only modes retain batching guidance without an edit obligation.
- Extend the fake worker only to persist the received RPC prompt for deterministic assertions.
- Use one real bounded smoke to validate model behavior that unit tests cannot prove.

## File Strategy

Runtime changes are limited to `skill-source/scripts/delegate.mjs` and `skill-source/SKILL.md`. Test changes are limited to `tests/fake-prime-agent.mjs` and `tests/test-delegate-integration.mjs`. Spec Kit infrastructure and this feature directory are included separately from unrelated work already present in the main checkout.

## Verification and Publication

Run `node --check` and the complete `node --test tests/test-*.mjs` suite in Ubuntu WSL. Run a source-skill smoke before copying verified source files into the installed skill. Verify SHA-256 parity, run the installed `--check`, then repeat the smoke through the installed copy.
