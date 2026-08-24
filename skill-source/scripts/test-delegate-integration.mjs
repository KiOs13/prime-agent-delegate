import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DELEGATE = join(SCRIPT_DIR, "delegate.mjs");
const FAKE_PRIME = join(SCRIPT_DIR, "fake-prime-agent.mjs");
chmodSync(FAKE_PRIME, 0o755);

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
		"--out-dir", outDir,
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

test("normal lifecycle preserves semantic terminal events and seals artifacts", () => {
	const cwd = createRepo();
	const outDir = join(cwd, ".prime-delegate", "runs", "normal");
	const result = runDelegate({ cwd, outDir, prompt: "Проверка 世界 😀 mixed UTF-8 ".repeat(40) });
	assert.equal(result.status, 0, result.stderr);

	const summary = json(join(outDir, "summary.json"));
	assert.equal(summary.schemaVersion, 2);
	assert.equal(summary.status, "completed");
	assert.equal(summary.protocolComplete, true);
	assert.equal(summary.delegationMode, "investigate");
	assert.equal(summary.taskType, "investigation");
	assert.equal(summary.droppedStreamingEventCount, 2);

	const events = readFileSync(join(outDir, "events.jsonl"), "utf8");
	assert.equal(events.includes("message_update"), false);
	assert.equal(events.includes("tool_execution_update"), false);
	assert.match(events, /complete message/);
	assert.match(events, /complete tool result/);

	const taskManifest = json(join(outDir, "task-parts", "manifest.json"));
	assert.ok(taskManifest.parts.length > 1);
	assert.equal(
		taskManifest.parts.map((part) => readFileSync(join(outDir, "task-parts", part.name), "utf8")).join(""),
		"Проверка 世界 😀 mixed UTF-8 ".repeat(40).trim(),
	);
	for (const part of taskManifest.parts) {
		assert.ok(part.bytes <= taskManifest.maxPartBytes);
		assert.equal(sha256(join(outDir, "task-parts", part.name)), part.sha256);
	}

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
	assert.equal(status, "?? fake-prime-output.txt");
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
