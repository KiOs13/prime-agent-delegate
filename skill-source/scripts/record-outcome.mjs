#!/usr/bin/env node

import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitize } from "./sanitize.mjs";

const VERDICTS = new Set(["ACCEPTED", "MINOR_FIX", "MAJOR_FIX", "PARTIAL_USED", "REJECTED"]);
const PRIME_VALUES = new Set(["HIGH", "MEDIUM", "LOW", "NONE", "NEGATIVE"]);

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!["--run-dir", "--verdict", "--prime-value"].includes(name)) fail(`Unknown argument: ${name}`);
		if (!value) fail(`Missing value for ${name}`);
		options[name.slice(2)] = value;
	}
	if (!isAbsolute(options["run-dir"] ?? "")) fail("--run-dir must be an absolute path");
	if (!VERDICTS.has(options.verdict)) fail(`Invalid --verdict: ${options.verdict ?? ""}`);
	if (!PRIME_VALUES.has(options["prime-value"])) fail(`Invalid --prime-value: ${options["prime-value"] ?? ""}`);
	return options;
}

const options = parseArgs(process.argv.slice(2));
const runDir = options["run-dir"];
let manifest;
try {
	manifest = JSON.parse(readFileSync(join(runDir, "run-manifest.json"), "utf8"));
} catch (error) {
	fail(`Cannot read completed run manifest: ${error.message}`);
}
if (!manifest.runId || !manifest.completed || manifest.run?.status == null) fail("Run manifest is incomplete");

const outcome = sanitize({
	schemaVersion: 1,
	runId: manifest.runId,
	recordedAt: new Date().toISOString(),
	verdict: options.verdict,
	primeValue: options["prime-value"],
});
const outputPath = join(runDir, "codex-outcome.json");
const tempPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
try {
	writeFileSync(tempPath, `${JSON.stringify(outcome, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	linkSync(tempPath, outputPath);
	unlinkSync(tempPath);
} catch (error) {
	try { unlinkSync(tempPath); } catch {}
	if (error?.code === "EEXIST") fail("codex-outcome.json already exists");
	throw error;
}

process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
