# Contributing

Keep changes focused and dependency-free unless an existing platform feature cannot solve the problem.

Before opening a pull request:

1. Do not include credentials, private prompts, or generated run artifacts.
2. Run `node --check` on changed scripts.
3. Run the complete test suite in Ubuntu WSL as documented in README.md.
4. Describe the failure mode being fixed and the deterministic evidence that verifies it.

Do not use a modified installed skill to validate its own source changes. Verify the source first, then install it.
