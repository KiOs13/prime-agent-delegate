import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DELEGATE = join(SCRIPT_DIR, "..", "skill-source", "scripts", "delegate.mjs");
const FAKE_PRIME = join(SCRIPT_DIR, "fake-prime-agent.mjs");

function createRepo({ ignored = true } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "prime-delegate-int-"));
	const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
	const git = (args) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
	assert.equal(git(["init", "-q"]).status, 0);
	assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
	assert.equal(git(["config", "user.name", "Prime Delegate Test"]).status, 0);
	writeFileSync(join(cwd, ".gitignore"), ignored ? ".prime-delegate/\n" : "", "utf8");
	assert.equal(git(["add", ".gitignore"]).status, 0);
	assert.equal(git(["commit", "-q", "-m", "fixture"]).status, 0);
	return cwd;
}

function runDelegate({ cwd, prompt, outDir, scenario = "normal", args = [], env = {} }) {
	const promptFile = join(mkdtempSync(join(tmpdir(), "prime-delegate-task-")), "task.md");
	writeFileSync(promptFile, prompt, "utf8");
	return spawnSync(process.execPath, [
		DELEGATE,
		"--wsl-mode",
		"--cwd", cwd,
		"--prompt-file", promptFile,
		...(outDir ? ["--out-dir", outDir] : []),
		"--timeout-ms", "15000",
		"--startup-grace-ms", "5000",
		"--idle-timeout-ms", "5000",
		"--max-infra-restarts", "0",
		...args,
	], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_DIR: undefined,
			GIT_WORK_TREE: undefined,
			PRIME_AGENT_DELEGATE_TEST_MODE: "1",
			PRIME_AGENT_DELEGATE_TEST_EXEC: FAKE_PRIME,
			PRIME_AGENT_DELEGATE_FAKE_SCENARIO: scenario,
			...env,
		},
	});
}

function json(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("default RPC uses task-parts for large prompts and seals artifacts", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "normal");
	const prompt = "Проверка 世界 😀 \u2028\u2029 mixed UTF-8 ".repeat(4000).trim();
	const result = runDelegate({ cwd, outDir, prompt });
	assert.equal(result.status, 0, result.stderr);

	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.schemaVersion, 2);
	assert.equal(summary.status, "completed");
	assert.equal(summary.protocolComplete, true);
	assert.equal(summary.delegationMode, "investigate");
	assert.equal(summary.taskType, "investigation");
	assert.equal(summary.droppedStreamingEventCount, 2);
	assert.equal(summary.transport.protocol, "rpc");
	assert.equal(summary.transport.mode, "task-parts");
	assert.equal(summary.transport.handshakeAccepted, true);
	assert.equal(summary.transport.promptAccepted, true);
	assert.match(
		readFileSync(join(outDir, "worker-prompt.md"), "utf8"),
		/Leave full integration and regression suites to Codex after this worker session exits\./,
	);
	assert.match(
		readFileSync(join(outDir, "worker-prompt.md"), "utf8"),
		/Reading budget: finish all exploration in at most 4 tool calls/,
	);
	assert.match(
		readFileSync(join(outDir, "worker-prompt.md"), "utf8"),
		/Batch reads in one tool call with a heredoc-free shell command per batch/,
	);
	assert.match(
		readFileSync(join(outDir, "worker-prompt.md"), "utf8"),
		/Do not edit unless the task explicitly requests it\./,
	);
	const taskManifest = json(join(outDir, "task-parts", "manifest.json"));
	assert.equal(taskManifest.parts.map((part) => readFileSync(join(outDir, "task-parts", part.name), "utf8")).join(""), prompt);
	for (const part of taskManifest.parts) assert.equal(sha256(join(outDir, "task-parts", part.name)), part.sha256);

	const events = readFileSync(join(outDir, "events.jsonl"), "utf8");
	assert.equal(events.includes("message_update"), false);
	assert.equal(events.includes("tool_execution_update"), false);
	assert.match(events, /complete message/);
	assert.match(events, /complete tool result/);

	const manifest = json(join(outDir, "run-manifest.json"));
	assert.equal(manifest.runId, summary.runId);
	assert.equal(manifest.captureMode, "semantic-compact");
	assert.equal(manifest.refineSourceAvailable, true);
	assert.equal(manifest.protocolEvidence.complete, true);
	assert.equal(manifest.eventsSha256, sha256(join(outDir, "events.jsonl")));
	assert.equal(manifest.artifacts.some((artifact) => artifact.path === "run-manifest.json"), false);
	for (const artifact of manifest.artifacts) {
		const path = join(outDir, artifact.path);
		assert.equal(existsSync(path), true, artifact.path);
		assert.equal(readFileSync(path).length, artifact.bytes, artifact.path);
		assert.equal(sha256(path), artifact.sha256, artifact.path);
	}
});

test("short tools-enabled RPC ships the task inline and preserves exact Unicode", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "rpc-inline");
	const prompt = "Проверка 世界 😀 \u2028\u2029";
	const result = runDelegate({
		cwd,
		outDir,
		prompt,
		env: { PRIME_AGENT_DELEGATE_FAKE_PROMPT_ECHO: join(outDir, "echoed-prompt.json") },
	});
	assert.equal(result.status, 0, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.transport.protocol, "rpc");
	assert.equal(summary.transport.mode, "inline");
	assert.equal(summary.transport.taskSha256, createHash("sha256").update(prompt.trim(), "utf8").digest("hex"));
	assert.equal(existsSync(join(outDir, "task-parts")), false);

	const rpcPrompt = readFileSync(join(outDir, "echoed-prompt.json"), "utf8");
	assert.ok(rpcPrompt.includes("Проверка 世界 😀"), "unicode task text reaches the wire prompt");
	assert.ok(rpcPrompt.includes(prompt.trim()), "full trimmed task text reaches the wire prompt");
	assert.match(rpcPrompt, /TASK:/);
	assert.doesNotMatch(rpcPrompt, /TASK PARTS: /);
});

test("no-tools remains inline-only across transports", () => {
	const cwd = createRepo();
	const inlineOut = join(cwd, ".prime-delegate", "runs", "no-tools-rpc");
	const inline = runDelegate({
		cwd,
		outDir: inlineOut,
		prompt: "Reply with exactly NO_TOOLS_OK",
		args: ["--no-tools"],
	});
	assert.equal(inline.status, 0, inline.stderr);
	assert.equal(json(join(inlineOut, "summary.json")).transport.protocol, "rpc");
	assert.equal(json(join(inlineOut, "summary.json")).transport.mode, "inline");
	assert.equal(json(join(inlineOut, "summary.json")).transport.inlineTaskEndMarker, null);
	assert.equal(existsSync(join(inlineOut, "task-parts")), false);

	const oversizedOut = join(cwd, ".prime-delegate", "runs", "no-tools-oversized");
	const oversized = runDelegate({
		cwd,
		outDir: oversizedOut,
		prompt: "x".repeat(2000),
		args: ["--no-tools"],
	});
	assert.equal(oversized.status, 2);
	assert.equal(existsSync(oversizedOut), false);
});

test("inline delivery carries a wire-only truncation marker and audit contract stays clean", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "inline-end-marker");
	const prompt = "short inline task";
	const echoPath = join(outDir, "echoed-prompt.txt");
	const result = runDelegate({
		cwd,
		outDir,
		prompt,
		env: { PRIME_AGENT_DELEGATE_FAKE_PROMPT_ECHO: echoPath },
	});
	assert.equal(result.status, 0, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.transport.mode, "inline");
	const marker = summary.transport.inlineTaskEndMarker;
	assert.match(String(marker), /^[0-9a-f]{16}$/, "marker is a 16-hex run-unique token");

	const rpcPrompt = readFileSync(echoPath, "utf8");
	assert.ok(rpcPrompt.includes(`TASK END MARKER: ${marker}`), "marker line rides on the wire");
	assert.ok(rpcPrompt.includes("task_integrity_mismatch"), "truncation rule rides on the wire");
	const wireLines = rpcPrompt.split("\n").map((line) => line.trim());
	const markerLineIndex = wireLines.indexOf(`TASK END MARKER: ${marker}`);
	const truncationRuleIndex = wireLines.findIndex((line) => line.startsWith("Before executing TASK"));
	assert.ok(markerLineIndex > 0, "marker line present");
	assert.ok(truncationRuleIndex < markerLineIndex, "truncation rule precedes the task and marker");
	assert.equal(wireLines.at(-1), `TASK END MARKER: ${marker}`, "marker is the final line");

	const auditPrompt = readFileSync(join(outDir, "worker-prompt.md"), "utf8");
	assert.equal(auditPrompt.includes("TASK END MARKER"), false, "audit contract stays wire-only clean");

	const partsOut = join(cwd, ".prime-delegate", "runs", "inline-end-marker-parts");
	const partsResult = runDelegate({
		cwd,
		outDir: partsOut,
		prompt: "p".repeat(400),
		args: ["--inline-task-bytes", "200"],
	});
	assert.equal(partsResult.status, 0, partsResult.stderr);
	const partsSummary = json(join(partsOut, "summary.json"));
	assert.equal(partsSummary.transport.mode, "task-parts");
	assert.equal(partsSummary.transport.inlineTaskEndMarker, null, "task-parts keeps its sha256 gate instead");
});

test("inline integrity mismatch retries once through task-parts", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "inline-fallback");
	const result = runDelegate({ cwd, outDir, prompt: "short task", scenario: "inline-truncated" });
	assert.equal(result.status, 0, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.status, "completed");
	assert.equal(summary.attemptCount, 2);
	assert.equal(summary.transport.mode, "task-parts");
	assert.equal(summary.transport.inlineFallbackUsed, true);
	assert.equal(summary.transport.inlineTaskEndMarker, null);
	assert.equal(existsSync(join(outDir, "task-parts", "manifest.json")), true);
});

test("CLI inline integrity mismatch also retries through task-parts", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "cli-inline-fallback");
	const result = runDelegate({ cwd, outDir, prompt: "short CLI task", scenario: "inline-truncated", args: ["--transport", "cli"] });
	assert.equal(result.status, 0, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.attemptCount, 2);
	assert.equal(summary.transport.protocol, "cli");
	assert.equal(summary.transport.mode, "task-parts");
	assert.equal(summary.transport.inlineFallbackUsed, true);
});

test("explicit CLI transport selects inline for short tasks and task-parts above the floor", () => {
	const cwd = createRepo();
	const inlineOut = join(cwd, ".prime-delegate", "runs", "cli-inline");
	const shortPrompt = "short CLI task";
	const inlineResult = runDelegate({ cwd, outDir: inlineOut, prompt: shortPrompt, args: ["--transport", "cli"] });
	assert.equal(inlineResult.status, 0, inlineResult.stderr);
	const inlineSummary = json(join(inlineOut, "summary.json"));
	assert.equal(inlineSummary.transport.protocol, "cli");
	assert.equal(inlineSummary.transport.mode, "inline");
	assert.equal(existsSync(join(inlineOut, "task-parts")), false);

	const partsOut = join(cwd, ".prime-delegate", "runs", "cli-parts");
	const partsPrompt = "p".repeat(400);
	const result = runDelegate({ cwd, outDir: partsOut, prompt: partsPrompt, args: ["--transport", "cli", "--inline-task-bytes", "200"] });
	assert.equal(result.status, 0, result.stderr);
	const summary = json(join(partsOut, "summary.json"));
	assert.equal(summary.transport.mode, "task-parts");
	const taskManifest = json(join(partsOut, "task-parts", "manifest.json"));
	assert.equal(taskManifest.parts.map((part) => readFileSync(join(partsOut, "task-parts", part.name), "utf8")).join(""), partsPrompt);
	assert.equal(taskManifest.taskSha256, summary.transport.taskSha256);
	assert.equal(taskManifest.taskSha256, createHash("sha256").update(partsPrompt, "utf8").digest("hex"));
	for (const part of taskManifest.parts) assert.equal(sha256(join(partsOut, "task-parts", part.name)), part.sha256);
});

test("no-change watchdog still stops a hanging worker after prompt acceptance", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "no-change-hang");
	const result = runDelegate({
		cwd,
		outDir,
		scenario: "hang-after-prompt",
		prompt: "hang without changes",
		args: [
			"--autonomous",
			"--require-change",
			"--autonomous-gate", "true",
			"--delegation-mode", "implement",
			"--no-change-timeout-ms", "800",
			"--max-infra-restarts", "0",
		],
	});
	assert.equal(result.status, 1, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.status, "failed");
	assert.equal(summary.terminalReason, "no_change_progress");
});

test("no-change window starts at RPC prompt acceptance, not at spawn", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "no-change-deferred-window");
	const result = runDelegate({
		cwd,
		outDir,
		scenario: "normal",
		prompt: "make a change after a slow prompt handshake",
		args: [
			"--autonomous",
			"--require-change",
			"--allow-change", "fake-prime-output.txt",
			"--autonomous-gate", "true",
			"--delegation-mode", "implement",
			"--no-change-timeout-ms", "1500",
		],
		env: { PRIME_AGENT_DELEGATE_FAKE_PROMPT_DELAY_MS: "2500" },
	});
	assert.equal(result.status, 0, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.status, "completed");
	assert.equal(summary.transport.promptAccepted, true);
	assert.equal(existsSync(join(cwd, "fake-prime-output.txt")), true);
});

test("--require-change fails closed when Prime exits zero without an edit", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "required-change-missing");
	const result = runDelegate({
		cwd,
		outDir,
		scenario: "no-change",
		prompt: "make a required change",
		args: [
			"--autonomous",
			"--require-change",
			"--allow-change", "fake-prime-output.txt",
			"--autonomous-gate", "true",
			"--delegation-mode", "implement",
		],
	});
	assert.equal(result.status, 1, result.stderr);
	assert.match(
		readFileSync(join(outDir, "worker-prompt.md"), "utf8"),
		/Make the first allowed edit within the first 4 tool calls, before writing assertions\./,
	);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.terminalReason, "required_change_missing");
	assert.equal(summary.failureClass, "contract");
	assert.equal(summary.failureOwner, "prime_agent");
	assert.equal(summary.restartCount, 0);
	assert.equal(existsSync(join(cwd, "fake-prime-output.txt")), false);
});

test("terminal run writes a completion marker into the delegated worktree", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "completion-marker");
	const result = runDelegate({ cwd, outDir, prompt: "completion marker" });
	assert.equal(result.status, 0, result.stderr);
	const marker = JSON.parse(readFileSync(join(cwd, ".prime-task-complete.json"), "utf8"));
	assert.equal(marker.status, "completed");
	assert.match(marker.runId, /^[0-9a-f-]{36}$/);
	assert.match(marker.finishedAt, /^\d{4}-/);
});

test("--repeated-tool-failure-limit rejects zero before creating out-dir", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "bad-repeated-limit");
	const result = runDelegate({
		cwd,
		outDir,
		prompt: "invalid repeated failure limit",
		args: ["--repeated-tool-failure-limit", "0"],
	});
	assert.equal(result.status, 2);
	assert.equal(existsSync(outDir), false);
});

test("--transport invalid exits with code 2 before creating out-dir", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "bad-transport");
	const result = runDelegate({ cwd, outDir, prompt: "invalid transport", args: ["--transport", "invalid"] });
	assert.equal(result.status, 2);
	assert.equal(existsSync(outDir), false);
});

test("--prepare-command forwards transport and repeated failure limit", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "prepare-cli");
	const result = runDelegate({
		cwd,
		outDir,
		prompt: "prepare cli",
		args: ["--prepare-command", "--transport", "cli", "--repeated-tool-failure-limit", "5"],
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /'--transport' 'cli'/);
	assert.match(result.stdout, /'--repeated-tool-failure-limit' '5'/);

	const enriched = runDelegate({
		cwd,
		outDir,
		prompt: "prepare staged",
		args: [
			"--prepare-command",
			"--task-part-bytes", "1200",
			"--stage-context", "C:\\ctx\\spec.md",
			"--stage-context", "C:\\ctx\\guard.php@10-20",
		],
	});
	assert.equal(enriched.status, 0, enriched.stderr);
	assert.match(enriched.stdout, /'--task-part-bytes' '1200'/);
	assert.match(enriched.stdout, /'--stage-context' '\/mnt\/c\/ctx\/spec\.md'/);
	assert.match(enriched.stdout, /'--stage-context' '\/mnt\/c\/ctx\/guard\.php@10-20'/);
});

test("--prepare-command defaults out-dir to Codex home with run id", () => {
	const cwd = createRepo();
	const result = runDelegate({
		cwd,
		prompt: "prepare default out",
		args: ["--prepare-command", "--project-id", "nmon_1.9", "--thread-id", "thread-42"],
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /'--out-dir' '\/mnt\/c\/Project-Prime\/runs\/nmon_1\.9\/thread-42\/[0-9a-f-]{36}'/);
	assert.match(result.stdout, /'--run-id' '[0-9a-f-]{36}'/);
	assert.match(result.stdout, /'--thread-id' 'thread-42'/);
	assert.match(result.stdout, /'--project-id' 'nmon_1\.9'/);
});

test("RPC handshake and prompt rejection are delegate transport failures", () => {
	for (const [scenario, reason] of [
		["rpc-reject-handshake", "rpc_handshake_failed"],
		["rpc-malformed-handshake", "rpc_handshake_malformed"],
		["rpc-reject-prompt", "rpc_prompt_rejected"],
	]) {
		const cwd = createRepo();
		const outDir = join(cwd, ".prime-delegate", "runs", scenario);
		const result = runDelegate({ cwd, outDir, prompt: scenario, scenario });
		assert.equal(result.status, 1, scenario);
		const summary = json(join(outDir, "summary.json"));
		assert.equal(summary.terminalReason, reason, scenario);
		assert.equal(summary.failureOwner, "delegate_skill", scenario);
	}
});

test("investigate fails when Prime changes the worktree", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "read-only");
	const result = runDelegate({
		cwd,
		outDir,
		prompt: "read only",
		env: {
			PRIME_AGENT_DELEGATE_FAKE_FORCE_CHANGE: "1",
			PRIME_AGENT_DELEGATE_FAKE_CHANGE: "unexpected.txt",
		},
	});
	assert.equal(result.status, 1, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.terminalReason, "read_only_violation");
	assert.equal(summary.failureOwner, "prime_agent");
	assert.match(summary.worktreeDiff, /unexpected\.txt/);
});

test("exit zero with incomplete lifecycle is a Prime protocol failure", () => {
	for (const scenario of ["no-events", "missing-agent-end", "malformed", "unmatched-tool"]) {
		const cwd = createRepo();
		const outDir = join(cwd, ".prime-delegate", "runs", scenario);
		const result = runDelegate({ cwd, outDir, scenario, prompt: `scenario ${scenario}` });
		assert.equal(result.status, 1, scenario);
		const summary = json(join(outDir, "summary.json"));
		assert.equal(summary.terminalReason, "protocol_incomplete", scenario);
		assert.equal(summary.failureOwner, "prime_agent", scenario);
		assert.equal(summary.protocolComplete, false, scenario);
	}
});

test("provider evidence is classified without retry", () => {
	for (const [scenario, reason] of [["provider-429", "provider_rate_limited"], ["provider-503", "provider_unavailable"]]) {
		const cwd = createRepo();
		const outDir = join(cwd, ".prime-delegate", "runs", scenario);
		const result = runDelegate({ cwd, outDir, scenario, prompt: scenario });
		assert.equal(result.status, 1);
		const summary = json(join(outDir, "summary.json"));
		assert.equal(summary.terminalReason, reason);
		assert.equal(summary.failureOwner, "provider");
		assert.equal(summary.restartCount, 0);
	}
});

test("repeated tool failures after a change stop without retry and preserve the diff", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "repeated-tool-failure");
	const result = runDelegate({
		cwd,
		outDir,
		scenario: "repeated-tool-failure",
		prompt: "make one change, then fail repeatedly",
		args: [
			"--autonomous",
			"--require-change",
			"--allow-change", "fake-prime-output.txt",
			"--autonomous-gate", "test -f fake-prime-output.txt",
			"--delegation-mode", "implement",
			"--repeated-tool-failure-limit", "3",
		],
	});
	assert.equal(result.status, 1, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.terminalReason, "repeated_tool_failure");
	assert.equal(summary.failureClass, "tool_loop");
	assert.equal(summary.failureOwner, "prime_agent");
	assert.equal(summary.restartCount, 0);
	assert.equal(summary.repeatedToolFailureLimit, 3);
	assert.equal(summary.repeatedToolFailureCount, 3);
	assert.equal(summary.repeatedToolFailureTool, "ipython");
	assert.equal(existsSync(join(cwd, "fake-prime-output.txt")), true);
	assert.match(summary.worktreeDiff, /fake-prime-output\.txt/);
});

test("repeated tool failures in a no-change read-only run stop at the configured limit", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "repeated-tool-failure-no-change");
	const result = runDelegate({
		cwd,
		outDir,
		scenario: "repeated-tool-failure",
		prompt: "investigate, then fail repeatedly without any file change",
		args: ["--repeated-tool-failure-limit", "3"],
	});
	assert.equal(result.status, 1, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.terminalReason, "repeated_tool_failure");
	assert.equal(summary.failureClass, "tool_loop");
	assert.equal(summary.failureOwner, "prime_agent");
	assert.equal(summary.restartCount, 0);
	assert.equal(summary.repeatedToolFailureLimit, 3);
	assert.equal(summary.repeatedToolFailureCount, 3);
	assert.equal(summary.repeatedToolFailureTool, "ipython");
	assert.equal(existsSync(join(cwd, "fake-prime-output.txt")), false);
});

test("launcher stops autonomous runs on the first turn beyond the configured limit", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "max-turns");
	const result = runDelegate({
		cwd,
		outDir,
		scenario: "max-turns",
		prompt: "change one file, then exceed the turn limit",
		args: [
			"--autonomous",
			"--require-change",
			"--allow-change", "fake-prime-output.txt",
			"--autonomous-gate", "test -f fake-prime-output.txt",
			"--delegation-mode", "implement",
			"--autonomous-max-turns", "3",
		],
	});
	assert.equal(result.status, 1, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.terminalReason, "max_turns_exhausted");
	assert.equal(summary.failureClass, "prime_limit");
	assert.equal(summary.failureOwner, "prime_agent");
	assert.equal(summary.autonomousMaxTurns, 3);
	assert.equal(summary.observedTurnCount, 4);
	assert.equal(summary.restartCount, 0);
	assert.match(summary.worktreeDiff, /fake-prime-output\.txt/);
});

test("autonomous runs have no turn limit unless explicitly configured", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "no-max-turns");
	const result = runDelegate({
		cwd,
		outDir,
		scenario: "max-turns",
		prompt: "complete a long bounded task without an explicit turn limit",
		args: [
			"--autonomous",
			"--require-change",
			"--allow-change", "fake-prime-output.txt",
			"--autonomous-gate", "test -f fake-prime-output.txt",
			"--delegation-mode", "implement",
		],
	});
	assert.equal(result.status, 0, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.autonomousMaxTurns, null);
	assert.equal(summary.observedTurnCount, 15);
	assert.equal(summary.terminalReason, "normal_exit");
});

test("launcher rejects changes outside the exact allowlist", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "unauthorized-change");
	const result = runDelegate({
		cwd,
		outDir,
		scenario: "unauthorized-change",
		prompt: "create one allowed and one unauthorized file",
		args: [
			"--autonomous",
			"--require-change",
			"--allow-change", "allowed.txt",
			"--autonomous-gate", "true",
			"--delegation-mode", "implement",
		],
		env: { PRIME_AGENT_DELEGATE_FAKE_CHANGE: "allowed.txt" },
	});
	assert.equal(result.status, 1, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.terminalReason, "unauthorized_change");
	assert.equal(summary.failureClass, "contract");
	assert.equal(summary.failureOwner, "prime_agent");
	assert.equal(summary.restartCount, 0);
	assert.deepEqual(summary.unauthorizedChanges, ["unauthorized.txt"]);
	assert.equal(existsSync(join(cwd, "allowed.txt")), true);
	assert.equal(existsSync(join(cwd, "unauthorized.txt")), true);
	assert.match(summary.worktreeDiff, /allowed\.txt/);
	assert.match(summary.worktreeDiff, /unauthorized\.txt/);
});

test("invalid task contract is owned by task_spec", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "task-spec");
	const result = runDelegate({ cwd, outDir, scenario: "task-spec", prompt: "invalid contract fixture" });
	assert.equal(result.status, 1);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.terminalReason, "task_contract_invalid");
	assert.equal(summary.failureOwner, "task_spec");
	assert.equal(summary.restartCount, 0);
});

test("Git ignore is fail-closed while an external out-dir remains valid", () => {
	const cwd = createRepo({ ignored: false });
	const internal = join(cwd, ".prime-delegate", "runs", "blocked");
	const blocked = runDelegate({ cwd, outDir: internal, prompt: "blocked" });
	assert.equal(blocked.status, 2);
	assert.equal(existsSync(internal), false);

	const external = mkdtempSync(join(tmpdir(), "prime-delegate-out-"));
	const allowed = runDelegate({ cwd, outDir: external, prompt: "external output" });
	assert.equal(allowed.status, 0, allowed.stderr);
	assert.equal(existsSync(join(external, "run-manifest.json")), true);
});

test("metadata validation, implement gates, and backward-compatible invocation", () => {
	const cwd = createRepo();
	const invalidOut = join(cwd, ".prime-delegate", "runs", "invalid");
	const invalid = runDelegate({
		cwd,
		outDir: invalidOut,
		prompt: "invalid metadata",
		args: ["--task-id", "../bad"],
	});
	assert.equal(invalid.status, 2);
	assert.equal(existsSync(invalidOut), false);

	const implementOut = join(cwd, ".prime-delegate", "runs", "implement");
	const implemented = runDelegate({
		cwd,
		outDir: implementOut,
		prompt: "bounded implementation",
		args: [
			"--autonomous",
			"--require-change",
			"--allow-change", "fake-prime-output.txt",
			"--autonomous-gate", "test -f fake-prime-output.txt",
			"--delegation-mode", "implement",
			"--task-type", "implementation",
			"--task-id", "T053",
			"--work-package-id", "WP-1",
		],
	});
	assert.equal(implemented.status, 0, implemented.stderr);
	const summary = json(join(implementOut, "summary.json"));
	assert.equal(summary.taskId, "T053");
	assert.equal(summary.workPackageId, "WP-1");
	assert.equal(summary.delegationMode, "implement");
	assert.equal(summary.taskType, "implementation");
	const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).stdout.trim();
	assert.equal(status, ["?? .prime-task-complete.json", "?? fake-prime-output.txt"].join("\n"));
});

test("production ignores a fake executable unless test mode is enabled", () => {
	const check = spawnSync(process.execPath, [DELEGATE, "--check"], {
		encoding: "utf8",
		env: {
			...process.env,
			PRIME_AGENT_DELEGATE_TEST_MODE: undefined,
			PRIME_AGENT_DELEGATE_TEST_EXEC: "/bin/false",
		},
	});
	const report = JSON.parse(check.stdout);
	assert.equal(report.executable, "/usr/bin/prime-agent");
	assert.notEqual(report.version, "prime-agent 0.8.0-test");
});

test("staged context is sealed with manifest and referenced by worker rules", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "staged-context");
	const contextDir = join(mkdtempSync(join(tmpdir(), "prime-delegate-ctx-")), "src");
	mkdirSync(contextDir, { recursive: true });
	const specSource = join(contextDir, "spec.md");
	writeFileSync(specSource, Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n"), "utf8");
	const rangeSource = join(contextDir, "guard.php");
	writeFileSync(rangeSource, Array.from({ length: 400 }, (_, i) => `// php line ${i + 1}`).join("\n"), "utf8");
	const echoPath = join(outDir, "echoed-prompt.json");
	const result = runDelegate({
		cwd,
		outDir,
		prompt: "staged context task",
		env: {
			PRIME_AGENT_DELEGATE_FAKE_PROMPT_ECHO: echoPath,
			PRIME_AGENT_DELEGATE_FAKE_PROMPT_ECHO_APPEND: "1",
		},
		args: [
			"--stage-context", specSource,
			"--stage-context", `${rangeSource}@100-110`,
		],
	});
	assert.equal(result.status, 0, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.stagedContext.entryCount, 2);
	assert.ok(summary.stagedContext.totalBytes > 0);

	const contextManifest = json(join(outDir, "context", "manifest.json"));
	assert.equal(contextManifest.schemaVersion, 1);
	assert.equal(contextManifest.entries.length, 2);
	const [specEntry, guardEntry] = contextManifest.entries;
	assert.equal(specEntry.name, "spec.md");
	assert.equal(specEntry.source.replaceAll("\\", "/").endsWith("/spec.md"), true);
	assert.equal(specEntry.lineRange, null);
	assert.equal(guardEntry.name, "guard.php");
	assert.equal(guardEntry.lineRange, "100-110");
	for (const entry of contextManifest.entries) {
		const path = join(outDir, "context", entry.name);
		assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), entry.sha256, entry.name);
	}
	const stagedSpec = readFileSync(join(outDir, "context", "spec.md"), "utf8");
	assert.match(stagedSpec, /^line 1$/m);
	assert.match(stagedSpec, /^line 120$/m);
	const stagedRange = readFileSync(join(outDir, "context", "guard.php"), "utf8");
	assert.equal(
		stagedRange,
		Array.from({ length: 11 }, (_, i) => `// php line ${100 + i}`).join("\n"),
	);

	const rpcPrompt = readFileSync(echoPath, "utf8");
	assert.match(rpcPrompt, /All task context is pre-staged under \/tmp\/\S+\/context/);
	assert.match(rpcPrompt, /Batch-read every file there in one tool call before anything else/);
});

test("staged context is opt-out via --no-staged-context and fails closed on missing sources", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "staged-optout");
	const missing = join(mkdtempSync(join(tmpdir(), "prime-delegate-ctx-")), "absent.md");
	const result = runDelegate({ cwd, outDir, prompt: "opt", args: ["--stage-context", missing] });
	assert.equal(result.status, 2);
	assert.match(result.stderr, /--stage-context/);

	const optOutDir = join(cwd, ".prime-delegate", "runs", "staged-optout-run");
	const existing = join(mkdtempSync(join(tmpdir(), "prime-delegate-ctx-")), "note.md");
	writeFileSync(existing, "context body", "utf8");
	const ok = runDelegate({ cwd, outDir: optOutDir, prompt: "opt out", args: ["--stage-context", existing, "--no-staged-context"] });
	assert.equal(ok.status, 0, ok.stderr);
	assert.equal(json(join(optOutDir, "summary.json")).stagedContext, null);
	assert.equal(existsSync(join(optOutDir, "context")), false);
});

test("--task-part-bytes raises the per-part budget and is validated", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "big-parts");
	const prompt = "x".repeat(1500);
	const result = runDelegate({ cwd, outDir, prompt, args: ["--task-part-bytes", "2048"] });
	assert.equal(result.status, 0, result.stderr);
	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.transport.partByteLimit, 2048);
	const taskManifest = json(join(outDir, "task-parts", "manifest.json"));
	assert.equal(taskManifest.maxPartBytes, 2048);
	assert.equal(taskManifest.parts.length, 1);
	assert.equal(taskManifest.parts[0].bytes, 1500);

	const badDir = join(cwd, ".prime-delegate", "runs", "bad-parts");
	const bad = runDelegate({ cwd, outDir: badDir, prompt: "tiny", args: ["--task-part-bytes", "100"] });
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /--task-part-bytes/);
	assert.equal(existsSync(badDir), false);
});

test("inline threshold boundary and integrity manifest", () => {
	const cwd = createRepo();
	const atLimit = "b".repeat(1024);
	const outAt = join(cwd, ".prime-delegate", "runs", "inline-at-limit");
	const r1 = runDelegate({ cwd, outDir: outAt, prompt: atLimit });
	assert.equal(r1.status, 0, r1.stderr);
	assert.equal(json(join(outAt, "summary.json")).transport.mode, "inline");

	const outAbove = join(cwd, ".prime-delegate", "runs", "inline-above");
	const r2 = runDelegate({
		cwd,
		outDir: outAbove,
		prompt: "b".repeat(1025),
		env: { PRIME_AGENT_DELEGATE_FAKE_PROMPT_ECHO: join(outAbove, "echoed-prompt.json") },
	});
	assert.equal(r2.status, 0, r2.stderr);
	const above = json(join(outAbove, "summary.json"));
	assert.equal(above.transport.mode, "task-parts");
	assert.equal(above.transport.taskSha256, createHash("sha256").update("b".repeat(1025), "utf8").digest("hex"));

	const wirePrompt = readFileSync(join(outAbove, "echoed-prompt.json"), "utf8");
	assert.match(wirePrompt, /Verify the stitched task: `cat <every TASK PARTS path in order> \| sha256sum` must equal the manifest taskSha256/);
	assert.match(wirePrompt, /task_integrity_mismatch/);
});
