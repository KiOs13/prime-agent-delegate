# Prime Agent Delegate Constitution

## Core Principles

### I. Bounded Delegation
Every delegated edit MUST use an isolated worktree, an explicit changed-path allowlist, and deterministic gates. Prime output remains an untrusted candidate until Codex independently reviews it.

### II. Fail-Closed Controls
Investigation MUST fail on worktree changes, implementation MUST fail on paths outside its allowlist, and incomplete or unhealthy runs MUST retain precise terminal classifications. The allowlist is validation, not an operating-system sandbox.

### III. Minimal Platform-Native Design
Changes MUST remain dependency-free unless the existing Node.js, Git, PowerShell, and Ubuntu WSL toolchain cannot satisfy a demonstrated requirement. Portability and new public CLI options require a concrete supported use case.

### IV. Auditable Transport
Default RPC transport MUST keep task content out of process arguments. Run artifacts MUST remain outside version control, preserve useful terminal evidence, and redact common credential forms.

### V. Independent Verification
Changed scripts MUST pass `node --check`; the complete suite MUST run in Ubuntu WSL. A modified installed skill MUST NOT validate its own source changes: verify source first, then install and run a separate installed-skill smoke.

## Security Boundaries

Delegation MUST NOT authorize deployment, publication, credential changes, destructive cleanup, or final security judgment. Prompts, fixtures, documentation, and run artifacts MUST NOT contain real credentials or private production data.

## Development Workflow

Keep commits focused. Preserve unrelated working-tree changes. Record the failure mode and deterministic verification evidence. Source is authoritative; the installed skill is updated only after source verification.

## Governance

This constitution summarizes the repository's existing README, SECURITY.md, and CONTRIBUTING.md requirements. Amendments require an explicit scoped change and corresponding tests when behavior changes.

**Version**: 1.0.0 | **Ratified**: 2026-09-02 | **Last Amended**: 2026-09-02
