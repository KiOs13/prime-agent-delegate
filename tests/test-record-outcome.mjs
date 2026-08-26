import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = join(import.meta.dirname, "..", "skill-source", "scripts", "record-outcome.mjs");

function run(args) {
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("records one validated outcome atomically and rejects duplicates", () => {
	const runDir = mkdtempSync(join(tmpdir(), "prime-outcome-"));
	writeFileSync(join(runDir, "run-manifest.json"), JSON.stringify({
		runId: "run-1",
		completed: true,
		run: { status: "completed" },
	}));
	const args = ["--run-dir", runDir, "--verdict", "ACCEPTED", "--prime-value", "HIGH"];
	assert.equal(run(args).status, 0);
	assert.deepEqual(
		(({ recordedAt, ...rest }) => rest)(JSON.parse(readFileSync(join(runDir, "codex-outcome.json"), "utf8"))),
		{ schemaVersion: 1, runId: "run-1", verdict: "ACCEPTED", primeValue: "HIGH" },
	);
	assert.equal(run(args).status, 2);
});

test("rejects invalid enums and incomplete manifests", () => {
	const runDir = mkdtempSync(join(tmpdir(), "prime-outcome-"));
	writeFileSync(join(runDir, "run-manifest.json"), JSON.stringify({ runId: "run-2" }));
	assert.equal(run(["--run-dir", runDir, "--verdict", "YES", "--prime-value", "HIGH"]).status, 2);
	assert.equal(run(["--run-dir", runDir, "--verdict", "REJECTED", "--prime-value", "NONE"]).status, 2);
});
