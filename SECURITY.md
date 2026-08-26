# Security Policy

## Scope

This project launches an autonomous coding agent with the permissions of the local user. It does not claim to sandbox Prime Agent.

Security-sensitive guarantees include:

- task content is not placed in process arguments by the default RPC transport;
- investigation mode fails when the Git worktree changes;
- implementation mode validates every changed path against the explicit allowlist;
- captured summaries redact common structured and inline credential forms;
- run artifacts must remain outside version control;
- deployment, release publication, secrets, credential changes, destructive cleanup, and final security decisions remain outside delegated authority.

The changed-path allowlist is a validation control, not a filesystem security boundary. Treat delegated code and conclusions as untrusted until independently reviewed.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not include real credentials, private repository contents, or production data in a public issue.

Include the affected version or commit, reproduction steps using non-sensitive fixtures, expected behavior, and observed impact.
