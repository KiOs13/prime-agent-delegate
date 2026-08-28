# Prime Agent Delegate

Unofficial reference implementation of a Codex-to-Prime Agent delegation control plane for Windows and Ubuntu WSL.

It runs bounded work through Prime Agent's JSONL RPC mode, monitors the worker, preserves compact audit artifacts, and leaves final review and integration authority with Codex.

This project is not affiliated with or endorsed by Prime Intellect.

## What it demonstrates

- RPC startup and handshake without putting the task prompt in process arguments
- file-backed transport for large UTF-8 tasks
- startup, idle, deadline, no-progress, and repeated-tool-failure watchdogs
- read-only investigation and exact changed-path validation
- deterministic failure classification and process-tree cleanup
- sanitized summaries, compact event capture, and a separate Codex outcome record

## Requirements

- Windows with an Ubuntu WSL distribution named `Ubuntu`
- Node.js on Windows and at `/usr/bin/node` in WSL
- Prime Agent installed at `/usr/bin/prime-agent` in WSL
- Git available in Windows and WSL
- Codex for Windows

The currently verified Prime Agent runtime is `0.8.1`.

## Install as a Codex skill

Copy `skill-source` to your Codex skills directory as `prime-agent-delegate`:

```powershell
Copy-Item -Recurse -Force .\skill-source "$env:USERPROFILE\.codex\skills\prime-agent-delegate"
```

Restart Codex, then verify the local integration:

```powershell
node "$env:USERPROFILE\.codex\skills\prime-agent-delegate\scripts\delegate.mjs" --check
```

The check must return JSON with `"ok": true` before delegation is used.

## Usage

Ask Codex to use `$prime-agent-delegate` for a bounded implementation, prototype, investigation, or testing task. The skill defines the full workflow, including isolated worktrees for edits and independent Codex verification.

For a direct read-only run:

```powershell
node "$env:USERPROFILE\.codex\skills\prime-agent-delegate\scripts\delegate.mjs" `
  --prepare-command `
  --cwd C:\path\to\repo `
  --prompt-file C:\path\to\task.md `
  --delegation-mode investigate `
  --task-type investigation
```

Run the emitted command with `wsl bash -lc`.

Run artifacts are stored outside the repository by default under
`C:\Project\_Prime\runs\<project>\<threadId>\<runId>`. Pass
`--project-id` and `--thread-id` to group runs by project and Codex thread,
or an explicit `--out-dir` to override the location.

## Tests

Run the complete suite inside Ubuntu WSL so Windows paths, WSL Git preflight, and the fake Prime executable use the same runtime boundary as production:

```powershell
wsl bash -lc "cd /mnt/c/path/to/Prime-agent-delegate && node --test tests/test-*.mjs"
```

No network or real model calls are required by the test suite.

## Security model

Prime Agent output is always a candidate result. Codex retains responsibility for scope, review, corrections, commits, and production actions.

`--allow-change` validates the final Git paths but is not an operating-system sandbox. Do not put secrets in prompts, command lines, or task files. Run artifacts may contain repository data and must remain ignored by Git.

See [SECURITY.md](SECURITY.md) for reporting guidance and supported security assumptions.

## Project status

This is a Windows/WSL reference implementation, not a general-purpose Prime Agent SDK. Portability should be added only when there is a concrete second supported platform.

## License

[MIT](LICENSE)
