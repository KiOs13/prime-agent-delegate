#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitize } from "./sanitize.mjs";
import {
	FAILURE_KIND,
	STATUS,
	DELEGATE_VERSION,
	SUMMARY_SCHEMA_VERSION,
	parseIntegerOption,
	atomicWriteJson,
	buildWorkerPromptArgument,
	classifyChildExit,
	createProtocolState,
	createHealth,
	decodeCapturedOutput,
	decideRestart,
	evaluateProtocol,
	evaluateHealthStatus,
	isLinuxProcessRunningFromStat,
	normalizeRunMetadata,
	parsePorcelainV1Z,
	readHealth,
	recordAttemptStart,
	recordProtocolEvent,
	recordProtocolParseError,
	recordRestarting,
	recordRepeatedToolFailure,
	recordTerminal,
	recordValidEvent,
	shouldStopForNoChange,
	splitUtf8ByBytes,
	stepRunawayTurnTracking,
	terminalStatusFor,
	updateHealth,
	windowsProcessAlive,
} from "./delegate-watchdog.mjs";

const DISTRO = "Ubuntu";
const TEST_MODE = process.env.PRIME_AGENT_DELEGATE_TEST_MODE === "1";
const PRIME_AGENT = TEST_MODE && process.env.PRIME_AGENT_DELEGATE_TEST_EXEC
	? process.env.PRIME_AGENT_DELEGATE_TEST_EXEC
	: "/usr/bin/prime-agent";
const PRIME_AGENT_COMMAND = TEST_MODE && process.env.PRIME_AGENT_DELEGATE_TEST_EXEC
	? ["/usr/bin/node", PRIME_AGENT]
	: [PRIME_AGENT];
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STARTUP_GRACE_MS = 90000;
const DEFAULT_IDLE_TIMEOUT_MS = 300000;
const DEFAULT_MAX_INFRA_RESTARTS = 1;
const DEFAULT_RESTART_DELAY_MS = 5000;
const DEFAULT_NO_CHANGE_TIMEOUT_MS = 600000;
const DEFAULT_NO_CHANGE_MAX_TOOL_CALLS = 80;
const DEFAULT_REPEATED_TOOL_FAILURE_LIMIT = 8;
const DEFAULT_RUNAWAY_TURNS_LIMIT = 2;
const DEFAULT_AUTONOMOUS_MAX_CONTINUATIONS = 3;
const DEFAULT_AUTONOMOUS_MAX_TOKENS = 1000000;
const INLINE_TASK_MAX_BYTES = 1024;
const DEFAULT_INLINE_TASK_MAX_BYTES = 1024;
const DEFAULT_TASK_CHUNK_MAX_BYTES = 600;
const STAGED_CONTEXT_MAX_FILES = 64;
const STAGED_CONTEXT_MAX_TOTAL_BYTES = 1024 * 1024;
const STAGED_CONTEXT_MAX_RANGE_BYTES = 256 * 1024;
const TERMINATE_GRACE_MS = 2000;
const HEALTH_WRITE_INTERVAL_MS = 1000;
const STDERR_PREVIEW_MAX_BYTES = 4096;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const options = { check: false, noTools: false, autonomous: false, autonomousGates: [], allowedChanges: [], stagedContext: [], fullEvents: false, requireChange: false, wslMode: false, prepareCommand: false };
	const valueArgs = new Set([
		"--cwd", "--prompt-file", "--out-dir", "--timeout-ms", "--provider", "--model", "--thinking", "--task-part-bytes", "--inline-task-bytes",
		"--thread-id", "--run-id", "--project-id",
		"--task-id", "--work-package-id", "--task-type", "--delegation-mode", "--transport",
		"--autonomous-max-continuations", "--autonomous-max-turns", "--autonomous-max-tokens",
		"--startup-grace-ms", "--idle-timeout-ms", "--max-infra-restarts", "--restart-delay-ms",
		"--no-change-timeout-ms", "--no-change-max-tool-calls", "--repeated-tool-failure-limit", "--status-dir",
		"--runaway-turns-limit",
	]);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--check") options.check = true;
		else if (arg === "--no-tools") options.noTools = true;
		else if (arg === "--full-events") options.fullEvents = true;
		else if (arg === "--require-change") options.requireChange = true;
		else if (arg === "--wsl-mode") options.wslMode = true;
		else if (arg === "--prepare-command") options.prepareCommand = true;
		else if (arg === "--autonomous") options.autonomous = true;
		else if (arg === "--no-staged-context") options.noStagedContext = true;
		else if (arg === "--allow-change") {
			const value = argv[++i];
			if (!value) fail("Missing value for --allow-change");
			options.allowedChanges.push(value.replaceAll("\\", "/"));
		} else if (arg === "--stage-context") {
			const value = argv[++i];
			if (!value) fail("Missing value for --stage-context");
			options.stagedContext.push(value);
		} else if (arg === "--autonomous-gate") {
			const value = argv[++i];
			if (!value) fail("Missing value for --autonomous-gate");
			options.autonomousGates.push(value);
		} else if (valueArgs.has(arg)) {
			const value = argv[++i];
			if (!value) fail(`Missing value for ${arg}`);
			options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
		} else fail(`Unknown argument: ${arg}`);
	}
	return options;
}

function parseIntOption(value, name, { min = 1, max = Infinity } = {}) {
	try {
		return parseIntegerOption(value, { min, max, name });
	} catch (error) {
		fail(error.message);
	}
}

function runLocalSync(args) {
	if (WSL_MODE) return spawnSync("bash", ["-lc", shellJoin(args)], { encoding: "utf8" });
	const result = spawnSync("wsl.exe", ["bash", "-lc", shellJoin(args)], { encoding: null, windowsHide: true });
	return { ...result, stdout: decodeCapturedOutput(result.stdout), stderr: decodeCapturedOutput(result.stderr) };
}

function runWslBashSync(command, options = {}) {
	if (WSL_MODE) return spawnSync("bash", ["-lc", command], { encoding: "utf8", ...options });
	const result = spawnSync("wsl.exe", ["bash", "-lc", command], { encoding: null, windowsHide: true, ...options });
	return { ...result, stdout: decodeCapturedOutput(result.stdout), stderr: decodeCapturedOutput(result.stderr) };
}

function wslProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	const stat = runWslBashSync(`cat /proc/${pid}/stat 2>/dev/null`);
	return stat.status === 0 && isLinuxProcessRunningFromStat(stat.stdout);
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function shellJoin(parts) {
	return parts.map(shellQuote).join(" ");
}

function windowsPathToWslPath(value) {
	const match = String(value).match(/^([A-Za-z]):[\\/](.*)$/);
	if (!match) return value;
	return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

// --check: version plus daemon/status command reachability. No model inference.
function checkInstallation() {
	const versionResult = runLocalSync([...PRIME_AGENT_COMMAND, "--version"]);
	const version = (versionResult.stdout.trim() || versionResult.stderr.trim()).split(/\r?\n/, 1)[0] ?? "";
	const versionOk = versionResult.status === 0 && version.length > 0;

	const statusResult = runLocalSync([...PRIME_AGENT_COMMAND, "status", "--json"]);
	let statusServices = null;
	let statusOk = statusResult.status === 0;
	try {
		const parsed = JSON.parse(statusResult.stdout.trim());
		statusServices = Array.isArray(parsed) ? parsed.length : null;
	} catch {
		statusOk = false;
	}

	const report = {
		ok: versionOk && statusOk,
		distro: DISTRO,
		executable: PRIME_AGENT,
		version,
		versionOk,
		statusCommand: "status --json",
		statusOk,
		statusServices,
		error:
			!versionOk && versionResult.status !== 0
				? versionResult.stderr.trim() || undefined
				: !statusOk
					? statusResult.stderr.trim() || "prime-agent status --json did not return parseable JSON"
					: undefined,
	};
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exit(report.ok ? 0 : 1);
}

function readPrimeVersion() {
	const result = runLocalSync([...PRIME_AGENT_COMMAND, "--version"]);
	const version = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/, 1)[0] ?? "";
	if (result.status !== 0 || !version) fail("prime-agent --version failed");
	return version;
}

// --status-dir: read-only health check against a previous run's out-dir.
// Never starts Prime Agent. Exits 0 only for healthy/non-stale state.
function runStatusCommand(statusDir) {
	const healthPath = join(statusDir, "health.json");
	if (!existsSync(healthPath)) {
		process.stdout.write(`${JSON.stringify({ healthy: false, active: false, error: "health.json not found", healthPath }, null, 2)}\n`);
		process.exit(1);
	}
	const health = readHealth(healthPath);
	if (!health) {
		process.stdout.write(`${JSON.stringify({ healthy: false, active: false, error: "health.json missing or invalid JSON", healthPath }, null, 2)}\n`);
		process.exit(1);
	}
	const isProcessAlive = health.processHost === "wsl" ? wslProcessAlive : windowsProcessAlive;
	const result = evaluateHealthStatus(health, { now: Date.now(), isProcessAlive });
	process.stdout.write(`${JSON.stringify(
		{ healthy: result.healthy, active: result.active, status: result.status, stale: result.stale, reason: result.reason, heartbeatAgeMs: result.heartbeatAgeMs, thresholdMs: result.thresholdMs, childPid: result.childPid, pidAlive: result.pidAlive, healthPath },
		null,
		2
	)}\n`);
	process.exit(result.exitCode);
}

function requireAbsoluteExistingPath(value, name) {
	if (!value || (!isAbsolute(value) && !(WSL_MODE && value.startsWith("/")))) fail(`${name} must be an absolute path`);
	try {
		return realpathSync(value);
	} catch (error) {
		fail(`${name} is not accessible: ${error.message}`);
	}
}

function toWslPath(windowsPath) {
	if (WSL_MODE) {
		if (windowsPath.startsWith("/")) return windowsPath;
		return windowsPathToWslPath(windowsPath);
	}
	const result = runLocalSync(["wslpath", "-a", "-u", windowsPath.replaceAll("\\", "/")]);
	if (result.status !== 0) fail(`wslpath failed: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

// Returns { environment, mode, baseline }. The git status preflight doubles as
// the baseline capture that restarts are compared against.
function resolveWslGitContext(cwd, wslCwd) {
	const dotGit = join(cwd, ".git");
	let environment = [];
	let mode = "native";
	try {
		if (lstatSync(dotGit).isFile()) {
			const match = readFileSync(dotGit, "utf8").trim().match(/^gitdir:\s*(.+)$/i);
			if (!match) fail(`Unsupported linked worktree metadata: ${dotGit}`);
			const rawGitDir = match[1].trim();
			const gitDir = /^[A-Za-z]:[\\/]/.test(rawGitDir)
				? windowsPathToWslPath(rawGitDir)
				: rawGitDir.startsWith("/")
					? rawGitDir
					: toWslPath(resolve(cwd, rawGitDir));
			const wslGitDir = toWslPath(gitDir);
			environment = [`GIT_DIR=${wslGitDir}`, `GIT_WORK_TREE=${wslCwd}`];
			mode = "linked-worktree";
		}
	} catch (error) {
		if (error?.code !== "ENOENT") fail(`Cannot inspect Git metadata: ${error.message}`);
	}
	const command = environment.length > 0
		? ["env", ...environment, "git", "status", "--porcelain"]
		: ["git", "status", "--porcelain"];
	const cmd = `cd ${shellQuote(wslCwd)} && ${shellJoin(command)}`;
	const result = runWslBashSync(cmd);
	if (result.status !== 0) {
		fail(`WSL Git preflight failed for ${cwd}: ${(result.stderr || result.stdout).trim()}`);
	}
	return { environment, mode, baseline: result.stdout };
}

function isPathInside(parent, candidate) {
	const rel = relative(parent, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function ensureOutputIgnored({ cwd, wslCwd, outDir, gitContext }) {
	if (!isPathInside(cwd, outDir)) return;
	const relativeOut = relative(cwd, outDir).replaceAll("\\", "/") || ".";
	const command = gitContext.environment.length > 0
		? ["env", ...gitContext.environment, "git", "check-ignore", "-q", "--", relativeOut]
		: ["git", "check-ignore", "-q", "--", relativeOut];
	const cmd = `cd ${shellQuote(wslCwd)} && ${shellJoin(command)}`;
	const result = runWslBashSync(cmd);
	if (result.status !== 0) fail(`Output path inside the worktree must be ignored by Git: ${relativeOut}`);
}

const STAGED_CONTEXT_RANGE = /@([1-9][0-9]*)-([1-9][0-9]*)$/;

function stageContextFiles({ stagedSpecs, outDir }) {
	if (stagedSpecs.length === 0) return null;
	const contextDir = join(outDir, "context");
	mkdirSync(contextDir, { recursive: true });
	const entries = [];
	for (const spec of stagedSpecs) {
		const rangeMatch = spec.match(STAGED_CONTEXT_RANGE);
		const sourcePath = rangeMatch ? spec.slice(0, rangeMatch.index) : spec;
		const source = requireAbsoluteExistingPath(sourcePath, "--stage-context");
		const range = rangeMatch ? { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]) } : null;
		if (range && range.start > range.end) fail(`--stage-context invalid line range: ${spec}`);
		let content = readFileSync(source, "utf8");
		if (range) {
			const lines = content.split("\n");
			if (range.end > lines.length) fail(`--stage-context range end ${range.end} exceeds ${sourcePath} (${lines.length} lines)`);
			content = lines.slice(range.start - 1, range.end).join("\n");
		}
		if (Buffer.byteLength(content, "utf8") > STAGED_CONTEXT_MAX_RANGE_BYTES) fail(`--stage-context source exceeds ${STAGED_CONTEXT_MAX_RANGE_BYTES} bytes: ${spec}`);
		const relativeSource = source.replace(/\\/g, "/");
		const name = entries.some((entry) => entry.source === relativeSource)
			? `${entries.filter((entry) => entry.source === relativeSource).length + 1}-${basename(source)}`
			: basename(source);
		if (entries.some((entry) => entry.name === name)) fail(`--stage-context duplicate file name: ${name}`);
		writeFileSync(join(contextDir, name), content, "utf8");
		entries.push({
			source: relativeSource,
			name,
			lineRange: range ? `${range.start}-${range.end}` : null,
			bytes: Buffer.byteLength(content, "utf8"),
			sha256: createHash("sha256").update(content, "utf8").digest("hex"),
		});
	}
	if (entries.length > STAGED_CONTEXT_MAX_FILES) fail(`--stage-context exceeds ${STAGED_CONTEXT_MAX_FILES} files`);
	const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
	if (totalBytes > STAGED_CONTEXT_MAX_TOTAL_BYTES) fail(`--stage-context exceeds ${STAGED_CONTEXT_MAX_TOTAL_BYTES} total bytes`);
	writeFileSync(join(contextDir, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, "utf8");
	return { contextDir, wslContextDir: toWslPath(contextDir), entries, totalBytes };
}

function artifactEntries(runDir, manifestPath) {
	const entries = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (path === manifestPath) continue;
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) {
				const content = readFileSync(path);
				entries.push({
					path: relative(runDir, path).replaceAll("\\", "/"),
					bytes: content.length,
					sha256: createHash("sha256").update(content).digest("hex"),
				});
			}
		}
	};
	visit(runDir);
	return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function assistantText(message) {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function escapeExtendedRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function linuxProcessGroupAlive(groupId) {
	for (const entry of readdirSync("/proc", { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		try {
			const stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
			if (Number(fields[2]) === groupId && !["Z", "X"].includes(fields[0])) return true;
		} catch { /* process exited while /proc was scanned */ }
	}
	return false;
}

function terminateProcessTree(pid) {
	// WSL workers own a process group; Windows uses the exact wsl.exe tree.
	// Try graceful termination first, then force the same bounded target.
	if (WSL_MODE) {
		try { process.kill(-pid, "SIGTERM"); } catch { /* checked below */ }
		const deadline = Date.now() + TERMINATE_GRACE_MS;
		while (Date.now() < deadline) {
			if (!linuxProcessGroupAlive(pid)) return "terminated";
			sleepSync(100);
		}
		try { process.kill(-pid, "SIGKILL"); } catch { /* checked below */ }
		const forceDeadline = Date.now() + TERMINATE_GRACE_MS;
		while (Date.now() < forceDeadline) {
			if (!linuxProcessGroupAlive(pid)) return "force_terminated";
			sleepSync(100);
		}
		return "termination_failed";
	}
	if (!windowsProcessAlive(pid)) return "not_running";
	spawnSync("taskkill.exe", ["/PID", String(pid), "/T"], { windowsHide: true, encoding: "utf8" });
	const deadline = Date.now() + TERMINATE_GRACE_MS;
	while (Date.now() < deadline) {
		if (!windowsProcessAlive(pid)) return "terminated";
		sleepSync(100);
	}
	if (windowsProcessAlive(pid)) {
		spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
		const forceDeadline = Date.now() + TERMINATE_GRACE_MS;
		while (Date.now() < forceDeadline) {
			if (!windowsProcessAlive(pid)) return "force_terminated";
			sleepSync(100);
		}
		return "termination_failed";
	}
	return "terminated";
}

const options = parseArgs(process.argv.slice(2));
const WSL_MODE = options.wslMode || process.platform === "linux";
if (options.check) checkInstallation();
if (options.statusDir) {
	if (!isAbsolute(options.statusDir)) fail("--status-dir must be an absolute Windows path");
	runStatusCommand(options.statusDir);
}
if ((options.requireChange || options.allowedChanges.length > 0) && !options.autonomous) {
	fail("--require-change and --allow-change require --autonomous");
}
if (options.autonomous && options.autonomousGates.length === 0) {
	fail("--autonomous requires at least one explicit --autonomous-gate");
}
if (options.noTools && options.noStagedContext) {
	fail("--no-staged-context is only valid with file tools enabled");
}
const taskChunkMaxBytes = parseIntOption(
	options.taskPartBytes ?? DEFAULT_TASK_CHUNK_MAX_BYTES,
	"--task-part-bytes",
	{ min: 200, max: 8192 },
);
const inlineTaskBytes = parseIntOption(
	options.inlineTaskBytes ?? DEFAULT_INLINE_TASK_MAX_BYTES,
	"--inline-task-bytes",
	{ min: 200, max: 8192 },
);
const requestedTransport = options.transport ?? "rpc";
if (!["rpc", "cli"].includes(requestedTransport)) fail("--transport must be rpc or cli");
let runMetadata;
try {
	runMetadata = normalizeRunMetadata(options);
} catch (error) {
	fail(error.message);
}

if (options.prepareCommand) {
	const runId = randomUUID();
	const threadId = options.threadId ?? "default";
	const projectId = options.projectId ?? "default";
	// Artifacts live outside the delegated worktree so run output never
	// pollutes Git state and never depends on repo-local ignore rules.
	const runsRoot = "C:\\Project-Prime\\runs";
	const resolvedOutDir = options.outDir ?? join(runsRoot, projectId, threadId, runId);
	const parts = ["/usr/bin/node", windowsPathToWslPath(join(SCRIPT_DIR, "delegate.mjs")), "--wsl-mode"];
	if (options.cwd) parts.push("--cwd", windowsPathToWslPath(options.cwd));
	if (options.promptFile) parts.push("--prompt-file", windowsPathToWslPath(options.promptFile));
	parts.push("--out-dir", windowsPathToWslPath(resolvedOutDir));
	parts.push("--run-id", runId);
	if (options.threadId) parts.push("--thread-id", options.threadId);
	if (options.projectId) parts.push("--project-id", options.projectId);
	if (options.timeoutMs) parts.push("--timeout-ms", options.timeoutMs);
	if (options.startupGraceMs) parts.push("--startup-grace-ms", options.startupGraceMs);
	if (options.idleTimeoutMs) parts.push("--idle-timeout-ms", options.idleTimeoutMs);
	if (options.maxInfraRestarts) parts.push("--max-infra-restarts", options.maxInfraRestarts);
	if (options.restartDelayMs) parts.push("--restart-delay-ms", options.restartDelayMs);
	if (options.noChangeTimeoutMs) parts.push("--no-change-timeout-ms", options.noChangeTimeoutMs);
	if (options.noChangeMaxToolCalls) parts.push("--no-change-max-tool-calls", options.noChangeMaxToolCalls);
	if (options.repeatedToolFailureLimit) parts.push("--repeated-tool-failure-limit", options.repeatedToolFailureLimit);
	if (options.runawayTurnsLimit !== undefined) parts.push("--runaway-turns-limit", options.runawayTurnsLimit);
	if (options.taskPartBytes) parts.push("--task-part-bytes", options.taskPartBytes);
	if (options.inlineTaskBytes) parts.push("--inline-task-bytes", options.inlineTaskBytes);
	for (const spec of options.stagedContext) parts.push("--stage-context", windowsPathToWslPath(spec));
	if (options.noStagedContext) parts.push("--no-staged-context");
	if (options.provider) parts.push("--provider", options.provider);
	if (options.model) parts.push("--model", options.model);
	if (options.thinking) parts.push("--thinking", options.thinking);
	if (options.taskId) parts.push("--task-id", options.taskId);
	if (options.workPackageId) parts.push("--work-package-id", options.workPackageId);
	if (options.taskType) parts.push("--task-type", options.taskType);
		if (options.delegationMode) parts.push("--delegation-mode", options.delegationMode);
		if (options.transport) parts.push("--transport", options.transport);
	if (options.noTools) parts.push("--no-tools");
	if (options.fullEvents) parts.push("--full-events");
	if (options.requireChange) parts.push("--require-change");
	if (options.autonomous) parts.push("--autonomous");
	if (options.autonomousMaxContinuations) parts.push("--autonomous-max-continuations", options.autonomousMaxContinuations);
	if (options.autonomousMaxTurns) parts.push("--autonomous-max-turns", options.autonomousMaxTurns);
	if (options.autonomousMaxTokens) parts.push("--autonomous-max-tokens", options.autonomousMaxTokens);
	for (const g of options.autonomousGates) parts.push("--autonomous-gate", g);
	for (const c of options.allowedChanges) parts.push("--allow-change", c);
	process.stdout.write(shellJoin(parts) + "\n");
	process.exit(0);
}

const cwd = requireAbsoluteExistingPath(options.cwd, "--cwd");
const promptFile = requireAbsoluteExistingPath(options.promptFile, "--prompt-file");
const timeoutMs = parseIntOption(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "--timeout-ms", { min: 1 });
const startupGraceMs = parseIntOption(options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS, "--startup-grace-ms", { min: 1 });
const idleTimeoutMs = parseIntOption(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, "--idle-timeout-ms", { min: 1 });
const maxInfraRestarts = parseIntOption(options.maxInfraRestarts ?? DEFAULT_MAX_INFRA_RESTARTS, "--max-infra-restarts", { min: 0, max: 3 });
const restartDelayMs = parseIntOption(options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS, "--restart-delay-ms", { min: 0 });
const noChangeTimeoutMs = parseIntOption(
	options.noChangeTimeoutMs ?? DEFAULT_NO_CHANGE_TIMEOUT_MS,
	"--no-change-timeout-ms",
	{ min: 1 },
);
const noChangeMaxToolCalls = parseIntOption(
	options.noChangeMaxToolCalls ?? DEFAULT_NO_CHANGE_MAX_TOOL_CALLS,
	"--no-change-max-tool-calls",
	{ min: 1 },
);
const repeatedToolFailureLimit = parseIntOption(
	options.repeatedToolFailureLimit ?? DEFAULT_REPEATED_TOOL_FAILURE_LIMIT,
	"--repeated-tool-failure-limit",
	{ min: 1 },
);
const runawayTurnsLimit = parseIntOption(
	options.runawayTurnsLimit ?? DEFAULT_RUNAWAY_TURNS_LIMIT,
	"--runaway-turns-limit",
	{ min: 0, max: 10 },
);
const autonomousMaxContinuations = parseIntOption(options.autonomousMaxContinuations ?? DEFAULT_AUTONOMOUS_MAX_CONTINUATIONS, "--autonomous-max-continuations", { min: 1 });
const autonomousMaxTurns = options.autonomousMaxTurns === undefined
	? null
	: parseIntOption(options.autonomousMaxTurns, "--autonomous-max-turns", { min: 1 });
const autonomousMaxTokens = parseIntOption(options.autonomousMaxTokens ?? DEFAULT_AUTONOMOUS_MAX_TOKENS, "--autonomous-max-tokens", { min: 1 });

const prompt = readFileSync(promptFile, "utf8").trim();
if (!prompt) fail("--prompt-file is empty");

const readBatchingRules = options.noTools
	? []
	: [
		"Batch reads in one tool call with a heredoc-free shell command per batch, for example:",
		`sed -n '1,200p' file1.md && sed -n '300,420p' src/code.php && grep -n 'keyword' src/other.php`,
	];
const workerRulesBase = [
	"You are a delegated coding worker. Work only in cwd.",
	"Do not commit, push, deploy, alter credentials, or perform destructive cleanup.",
	"For split tasks, read the manifest and every ordered part in one tool call, then stitch all parts into the full prompt.",
	"Use targeted reads and batch independent reads in one tool call. Do not open worker-prompt.md; it is only an audit artifact.",
	"Once a target range is found, do not reread overlapping ranges unless earlier output was missing.",
...readBatchingRules,
	"Reading budget: finish all exploration in at most 4 tool calls, keep every read batched, and never reread a file. Every tool call after the 4th must follow the first allowed edit.",
	"Run only focused checks for the bounded change. Leave full integration and regression suites to Codex after this worker session exits.",
	options.requireChange
		? `The no-change watchdog kills this process after ${noChangeTimeoutMs} ms or ${noChangeMaxToolCalls} tool calls without a file change. Make the first allowed edit within the first 4 tool calls, before writing assertions.`
		: "Do not edit unless the task explicitly requests it.",
	options.autonomous ? "The host runs final gates. Return changed files, checks, and blockers." : "Return one concise final report.",
];
const auditTaskContractBase = [...workerRulesBase, "", "TASK:", prompt].join("\n");
const taskBytes = Buffer.byteLength(prompt, "utf8");
if (options.noTools && Buffer.byteLength(auditTaskContractBase, "utf8") > inlineTaskBytes) {
	fail(`--no-tools effective payload exceeds ${inlineTaskBytes} UTF-8 bytes`);
}

const runId = options.runId ?? randomUUID();
const wslCwd = toWslPath(cwd);
const gitContext = resolveWslGitContext(cwd, wslCwd);
const outDir = resolve(options.outDir ?? join(cwd, ".prime-delegate", "runs", runId));
ensureOutputIgnored({ cwd, wslCwd, outDir, gitContext });
mkdirSync(outDir, { recursive: true });

let stagedContext = null;
if (!options.noStagedContext && !options.noTools) {
	stagedContext = stageContextFiles({ stagedSpecs: options.stagedContext, outDir });
}
const wslStagedContextDir = stagedContext ? stagedContext.wslContextDir : null;
const stagedContextRule = wslStagedContextDir
	? `All task context is pre-staged under ${wslStagedContextDir} (see context/manifest.json for exact sources). Batch-read every file there in one tool call before anything else, and rely on it instead of reading those sources from the worktree.`
	: null;
const workerRules = [...workerRulesBase];
if (stagedContextRule) {
	workerRules.splice(workerRules.indexOf("Once a target range is found, do not reread overlapping ranges unless earlier output was missing.") + 1, 0, stagedContextRule);
}
const auditTaskContract = [...workerRules, "", "TASK:", prompt].join("\n");
const effectiveTaskContractBytes = Buffer.byteLength(auditTaskContract, "utf8");

const eventsPath = join(outDir, "events.jsonl");
const stderrPath = join(outDir, "stderr.log");
const summaryPath = join(outDir, "summary.json");
const auditSummaryPath = join(outDir, "audit-summary.json");
const workerPromptPath = join(outDir, "worker-prompt.md");
const healthPath = join(outDir, "health.json");
const runManifestPath = join(outDir, "run-manifest.json");
const runtimeBinDir = join(outDir, "runtime-bin");
const events = createWriteStream(eventsPath, { encoding: "utf8" });
const errors = createWriteStream(stderrPath, { encoding: "utf8" });
if (options.requireChange && gitContext.baseline !== "") {
	fail("--require-change requires a clean delegated worktree");
}
const primeVersion = readPrimeVersion();

writeFileSync(workerPromptPath, `${auditTaskContract}\n`, "utf8");

let primeTask = auditTaskContract;
const taskSha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
let taskPartCount = 0;
let maxTaskPartBytes = 0;
let transportMode;
let inlineTaskEndMarker = null;
let inlineFallbackUsed = false;
function configureTaskParts() {
	transportMode = "task-parts";
	inlineTaskEndMarker = null;
	const taskPartsDir = join(outDir, "task-parts");
	mkdirSync(taskPartsDir, { recursive: true });
	const taskParts = splitUtf8ByBytes(prompt, taskChunkMaxBytes).map((content, index) => {
		const name = `part-${String(index + 1).padStart(3, "0")}.txt`;
		const bytes = Buffer.byteLength(content, "utf8");
		writeFileSync(join(taskPartsDir, name), content, "utf8");
		return { order: index + 1, name, bytes, sha256: createHash("sha256").update(content, "utf8").digest("hex") };
	});
	taskPartCount = taskParts.length;
	maxTaskPartBytes = Math.max(...taskParts.map((part) => part.bytes), 0);
	writeFileSync(join(taskPartsDir, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, taskBytes, taskSha256, maxPartBytes: taskChunkMaxBytes, parts: taskParts }, null, 2)}\n`, "utf8");
	const wslTaskPartsDir = toWslPath(taskPartsDir);
	primeTask = [
		`TASK MANIFEST: ${wslTaskPartsDir}/manifest.json`,
		`TASK PARTS: ${taskParts.map((part) => `${wslTaskPartsDir}/${part.name}`).join(" ")}`,
		"Read the manifest and every exact TASK PARTS path once in order in one tool call.",
		"Verify the stitched task: `cat <every TASK PARTS path in order> | sha256sum` must equal the manifest taskSha256. If it differs, stop without editing and report a task_integrity_mismatch in the final report.",
		"After a matching checksum, implement immediately.",
		"",
		...workerRules,
	].join("\n");
}
if (options.noTools) {
	transportMode = "inline";
} else if (taskBytes <= inlineTaskBytes) {
	transportMode = "inline";
	inlineTaskEndMarker = randomUUID().replaceAll("-", "").slice(0, 16);
	primeTask = `Before executing TASK, verify the final received line is exactly "TASK END MARKER: ${inlineTaskEndMarker}". If it is missing or altered, stop without editing and report task_integrity_mismatch.\n\n${auditTaskContract}\n\nTASK END MARKER: ${inlineTaskEndMarker}`;
} else {
	configureTaskParts();
}
const transport = {
	mode: transportMode,
	protocol: requestedTransport,
	taskBytes,
	effectiveTaskContractBytes,
	effectiveInitialPromptBytes: Buffer.byteLength(primeTask, "utf8"),
	wireBytes: requestedTransport === "rpc"
		? Buffer.byteLength(`${JSON.stringify({ id: "delegate-prompt", type: "prompt", message: primeTask })}\n`, "utf8")
		: Buffer.byteLength(primeTask, "utf8"),
	handshakeAccepted: requestedTransport === "rpc" ? false : null,
	promptAccepted: requestedTransport === "rpc" ? false : null,
	inlineByteLimit: INLINE_TASK_MAX_BYTES,
	partByteLimit: taskChunkMaxBytes,
	taskSha256,
	partCount: taskPartCount,
	maxPartBytes: maxTaskPartBytes,
	inlineTaskEndMarker,
	inlineFallbackUsed,
};

function buildRuntimeEnvironment() {
	if (!WSL_MODE) return [];
	const environment = [];
	const windowsPowerShell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
	const nativePowerShell = spawnSync("bash", ["-lc", "command -v powershell >/dev/null 2>&1"], { encoding: "utf8" });
	if (nativePowerShell.status !== 0 && existsSync(windowsPowerShell)) {
		mkdirSync(runtimeBinDir, { recursive: true });
		const wrapperPath = join(runtimeBinDir, "powershell");
		writeFileSync(wrapperPath, `#!/bin/sh\nexec '${windowsPowerShell}' "$@"\n`, "utf8");
		chmodSync(wrapperPath, 0o755);
		environment.push(`PATH=${runtimeBinDir}:${process.env.PATH ?? ""}`);
	}
	return environment;
}

const runtimeEnvironment = buildRuntimeEnvironment();

function buildPrimeArgs() {
	const primeArgs = [...PRIME_AGENT_COMMAND, "--mode", requestedTransport === "rpc" ? "rpc" : "json", "--no-session", "--cwd", wslCwd];
	if (options.noTools) primeArgs.push("--no-tools");
	if (options.provider) primeArgs.push("--provider", options.provider);
	if (options.model) primeArgs.push("--model", options.model);
	if (options.thinking) primeArgs.push("--thinking", options.thinking);
	if (options.autonomous) {
		primeArgs.push("--autonomous");
		primeArgs.push("--autonomous-max-continuations", String(autonomousMaxContinuations));
		if (autonomousMaxTurns !== null) primeArgs.push("--autonomous-max-turns", String(autonomousMaxTurns));
		primeArgs.push("--autonomous-max-tokens", String(autonomousMaxTokens));
		primeArgs.push("--autonomous-timeout-ms", String(timeoutMs));
		for (const gate of options.autonomousGates) primeArgs.push("--autonomous-gate", gate);
		if (options.requireChange) {
			primeArgs.push("--autonomous-gate", "test -n \"$(git status --porcelain)\"");
		}
		if (options.allowedChanges.length > 0) {
			const allowedPattern = options.allowedChanges.map(escapeExtendedRegex).join("|");
			primeArgs.push("--autonomous-gate", `test -z "$(git status --porcelain | cut -c4- | grep -Ev '^(${allowedPattern})$')"`);
		}
	}
	if (requestedTransport === "cli") {
		const promptArgument = buildWorkerPromptArgument({ workerPrompt: primeTask });
		primeArgs.push("--", promptArgument);
	}
	const environment = [...gitContext.environment, ...runtimeEnvironment];
	return environment.length > 0 ? ["env", ...environment, ...primeArgs] : primeArgs;
}

const startedAt = new Date().toISOString();
const overallDeadlineMs = Date.now() + timeoutMs;
let health = createHealth({
	startedAt,
	startupGraceMs,
	idleTimeoutMs,
	noChangeTimeoutMs,
	noChangeMaxToolCalls,
	repeatedToolFailureLimit,
	stagedContextRule,
	restartDelayMs,
	overallTimeoutMs: timeoutMs,
	maxInfraRestarts,
	processHost: WSL_MODE ? "wsl" : "windows",
});
atomicWriteJson(healthPath, health);

let attempt = 0;
let restartCount = 0;
let restartReasons = [];
const attempts = [];
let finalized = false;
let finalExitCode = 1;
let terminalStatus = null;
let terminalReason = null;

let child = null;
let stdoutBuffer = "";
let finalText = "";
let eventCount = 0;
let persistedEventCount = 0;
let droppedStreamingEventCount = 0;
let parseErrors = 0;
let attemptEventCount = 0;
let attemptStderrBytes = 0;
let attemptStderrPreview = "";
let attemptProtocol = createProtocolState();
let finalProtocol = evaluateProtocol(attemptProtocol);
let lastClassification = null;
let firstEventSeen = false;
let attemptClosed = true;
let pendingCondition = null;
let timedOut = false;
let spawnFailed = false;

let startupTimer = null;
let idleTimer = null;
let noChangeTimer = null;
let overallTimer = null;
let healthWriteTimer = null;
let lastChildExitCode = null;
let lastChildSignal = null;
let forcedTerminalReason = null;
let noChangeWindowStartedAt = null;
let rpcStateId = null;
let rpcPromptId = null;
let repeatedToolFailure = { fingerprint: null, count: 0, toolName: null };
let finalUnauthorizedChanges = [];
let currentTurnToolCalls = 0;
let currentTurnHadText = false;
let runawayStreak = 0;
let runawayTurnsObserved = 0;

function flushHealth() {
	if (healthWriteTimer) {
		clearTimeout(healthWriteTimer);
		healthWriteTimer = null;
	}
	atomicWriteJson(healthPath, health);
}

function scheduleHealthWrite() {
	if (healthWriteTimer || finalized) return;
	healthWriteTimer = setTimeout(() => {
		healthWriteTimer = null;
		atomicWriteJson(healthPath, health);
	}, HEALTH_WRITE_INTERVAL_MS);
}

function shouldPersistEvent(event) {
	return options.fullEvents || !["message_update", "tool_execution_update"].includes(event?.type);
}

function processPrimeEvent(event, line = JSON.stringify(event)) {
	eventCount++;
	attemptEventCount++;
	recordProtocolEvent(attemptProtocol, event);
	if (event.type === "message_end") finalText = assistantText(event.message) || finalText;
	if (event.type === "agent_end" && Array.isArray(event.messages)) {
		for (const message of event.messages) finalText = assistantText(message) || finalText;
	}
	if (shouldPersistEvent(event)) {
		// Persist with a delegate-side capture timestamp; original event keys stay first.
		const captured = { ...event, capturedAt: new Date().toISOString() };
		events.write(`${JSON.stringify(captured)}\n`);
		persistedEventCount++;
	} else {
		droppedStreamingEventCount++;
	}
	onValidEvent(event);
}

function failRpcTransport(reason, detail) {
	forcedTerminalReason = reason;
	lastClassification = {
		kind: "failed",
		reason,
		terminalStatus: STATUS.FAILED,
		failureClass: "transport",
		failureOwner: "delegate_skill",
	};
	if (detail) errors.write(`${detail}\n`);
	terminateChild(reason);
}

function writeRpcPrompt() {
	const command = `${JSON.stringify({ id: rpcPromptId, type: "prompt", message: primeTask })}\n`;
	child.stdin.end(command, "utf8");
}

function processRpcResponse(response) {
	if (response.id === rpcStateId) {
		const sessionId = response.success && response.data?.sessionId;
		if (!sessionId) {
			failRpcTransport("rpc_handshake_failed", response.error ?? "RPC get_state did not return sessionId");
			return;
		}
		transport.handshakeAccepted = true;
		processPrimeEvent({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: new Date().toISOString(),
			cwd: wslCwd,
			synthetic: true,
			source: "delegate_rpc",
		});
		writeRpcPrompt();
		return;
	}
	if (response.id === rpcPromptId) {
		if (!response.success) {
			failRpcTransport("rpc_prompt_rejected", response.error ?? "RPC prompt was rejected");
			return;
		}
		transport.promptAccepted = true;
		armNoChangeTimer();
	}
}

function processEventLine(rawLine) {
	const line = rawLine.trim();
	if (!line) return;
	try {
		const event = JSON.parse(line);
		if (requestedTransport === "rpc" && event.type === "response") {
			processRpcResponse(event);
			return;
		}
		processPrimeEvent(event, line);
	} catch {
		if (requestedTransport === "rpc" && !transport.handshakeAccepted) {
			failRpcTransport("rpc_handshake_malformed", `Malformed RPC response: ${line.slice(0, 500)}`);
			return;
		}
		parseErrors++;
		recordProtocolParseError(attemptProtocol);
		events.write(`${JSON.stringify({ type: "parse_error", preview: line.slice(0, 500) })}\n`);
		persistedEventCount++;
	}
}

function onValidEvent(event) {
	if (forcedTerminalReason) return;
	if ([FAILURE_KIND.REPEATED_TOOL_FAILURE, FAILURE_KIND.MAX_TURNS_EXHAUSTED, FAILURE_KIND.RUNAWAY_TURNS].includes(pendingCondition)) return;
	const wasFirstEvent = !firstEventSeen;
	firstEventSeen = true;
	if (wasFirstEvent && requestedTransport !== "rpc") armNoChangeTimer();
	const now = Date.now();
	const toolCall = event?.type === "tool_execution_start";
	const turnStart = event?.type === "turn_start";
	health = recordValidEvent(health, { now, toolCall, turnStart });
	if (options.autonomous && autonomousMaxTurns !== null && turnStart && health.attemptTurnCount > autonomousMaxTurns) {
		pendingCondition = FAILURE_KIND.MAX_TURNS_EXHAUSTED;
		appendSyntheticEvent({
			kind: FAILURE_KIND.MAX_TURNS_EXHAUSTED,
			limit: autonomousMaxTurns,
			observed: health.attemptTurnCount,
		});
		terminateChild(FAILURE_KIND.MAX_TURNS_EXHAUSTED);
		return;
	}
	if (options.requireChange && !health.changeDetectedAt && toolCall) {
		const porcelain = currentGitPorcelain();
		if (!porcelain.ok) {
			forcedTerminalReason = porcelain.error;
			terminateChild(porcelain.error);
			return;
		}
		if (porcelain.value !== gitContext.baseline) {
			health = updateHealth(health, { changeDetectedAt: new Date(now).toISOString(), lastReason: "change_detected", now });
			clearTimeout(noChangeTimer);
			noChangeTimer = null;
			noChangeWindowStartedAt = null;
		} else if (shouldStopForNoChange({
			requireChange: true,
			elapsedMs: noChangeWindowStartedAt === null ? 0 : now - noChangeWindowStartedAt,
			timeoutMs: noChangeWindowStartedAt === null ? Infinity : noChangeTimeoutMs,
			toolCallCount: health.attemptToolCallCount,
			maxToolCalls: noChangeMaxToolCalls,
		})) {
			pendingCondition = FAILURE_KIND.NO_CHANGE_PROGRESS;
			terminateChild(FAILURE_KIND.NO_CHANGE_PROGRESS);
			return;
		}
	}
	if (turnStart) {
		currentTurnToolCalls = 0;
		currentTurnHadText = false;
	}
	if (event?.type === "tool_execution_start") {
		currentTurnToolCalls++;
	}
	if (event?.type === "message_end") {
		currentTurnHadText = currentTurnHadText || assistantText(event.message).length > 0;
	}
	if (event?.type === "turn_end") {
		const message = event?.message ?? null;
		const step = stepRunawayTurnTracking({
			streak: runawayStreak,
			limit: runawayTurnsLimit,
			stopReason: event?.stopReason ?? message?.stopReason ?? null,
			toolCalls: currentTurnToolCalls,
			hadText: currentTurnHadText,
		});
		runawayStreak = step.streak;
		runawayTurnsObserved = Math.max(runawayTurnsObserved, step.streak);
		currentTurnToolCalls = 0;
		currentTurnHadText = false;
		if (step.stop) {
			pendingCondition = FAILURE_KIND.RUNAWAY_TURNS;
			appendSyntheticEvent({
				kind: FAILURE_KIND.RUNAWAY_TURNS,
				limit: runawayTurnsLimit,
				streak: step.streak,
				outputTokens: message?.usage?.output ?? null,
			});
			terminateChild(FAILURE_KIND.RUNAWAY_TURNS);
			return;
		}
	}
	if (event?.type === "tool_execution_end") {
		repeatedToolFailure = recordRepeatedToolFailure(repeatedToolFailure, event, { investigate: !options.requireChange });
		health = updateHealth(health, {
			repeatedToolFailureCount: repeatedToolFailure.count,
			repeatedToolFailureTool: repeatedToolFailure.toolName,
			now,
		});
		if ((options.requireChange ? health.changeDetectedAt : true) && repeatedToolFailure.count >= repeatedToolFailureLimit) {
			pendingCondition = FAILURE_KIND.REPEATED_TOOL_FAILURE;
			appendSyntheticEvent({
				kind: FAILURE_KIND.REPEATED_TOOL_FAILURE,
				count: repeatedToolFailure.count,
				toolName: repeatedToolFailure.toolName,
			});
			terminateChild(FAILURE_KIND.REPEATED_TOOL_FAILURE);
			return;
		}
	}
	if (wasFirstEvent) flushHealth();
	else scheduleHealthWrite();
	if (startupTimer) {
		clearTimeout(startupTimer);
		startupTimer = null;
	}
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(onIdleTimeout, idleTimeoutMs);
}

function appendSyntheticEvent(event) {
	const line = { type: "watchdog_event", ...event, attempt, at: new Date().toISOString() };
	events.write(`${JSON.stringify(line)}\n`);
	persistedEventCount++;
	return line;
}

function writeHealthWithReason(reason) {
	health = updateHealth(health, { lastReason: reason, now: Date.now() });
	flushHealth();
}

function terminateChild(reason) {
	writeHealthWithReason(reason);
	clearTimeout(startupTimer);
	startupTimer = null;
	clearTimeout(idleTimer);
	idleTimer = null;
	clearTimeout(noChangeTimer);
	noChangeTimer = null;
	const pid = child?.pid;
	if (!pid) return;
	const result = terminateProcessTree(pid);
	appendSyntheticEvent({ kind: "terminate", reason, result });
	if (result === "termination_failed") {
		pendingCondition = null;
		forcedTerminalReason = "process_termination_failed";
		health = recordTerminal(health, { status: STATUS.FAILED, reason: forcedTerminalReason });
		flushHealth();
	}
}

function onStartupTimeout() {
	if (finalized || attemptClosed || firstEventSeen) return;
	pendingCondition = FAILURE_KIND.STARTUP_TIMEOUT;
	terminateChild("startup_timeout");
}

function onIdleTimeout() {
	if (finalized || attemptClosed) return;
	pendingCondition = FAILURE_KIND.IDLE_TIMEOUT;
	terminateChild("idle_timeout");
}

function armNoChangeTimer() {
	if (!options.requireChange || noChangeTimer) return;
	noChangeWindowStartedAt = Date.now();
	noChangeTimer = setTimeout(onNoChangeTimeout, noChangeTimeoutMs);
}

function onNoChangeTimeout() {
	if (finalized || attemptClosed || !options.requireChange || health.changeDetectedAt) return;
	const porcelain = currentGitPorcelain();
	if (!porcelain.ok) {
		forcedTerminalReason = porcelain.error;
		terminateChild(porcelain.error);
		return;
	}
	if (porcelain.value !== gitContext.baseline) {
		health = updateHealth(health, {
			changeDetectedAt: new Date().toISOString(),
			lastReason: "change_detected",
			now: Date.now(),
		});
		noChangeTimer = null;
		flushHealth();
		return;
	}
	pendingCondition = FAILURE_KIND.NO_CHANGE_PROGRESS;
	terminateChild(FAILURE_KIND.NO_CHANGE_PROGRESS);
}

function onOverallTimeout() {
	if (finalized) return;
	timedOut = true;
	pendingCondition = null;
	if (child && !attemptClosed) {
		terminateChild("overall_timeout");
	} else {
		// No child in flight (e.g. waiting out a restart delay): finalize now.
		finalize(STATUS.TIMED_OUT, "overall_timeout", "overall_deadline_exhausted");
	}
}

function spawnAttempt() {
	attempt++;
	attemptEventCount = 0;
	attemptStderrBytes = 0;
	attemptStderrPreview = "";
	attemptProtocol = createProtocolState();
	firstEventSeen = false;
	attemptClosed = false;
	pendingCondition = null;
	timedOut = false;
	spawnFailed = false;
	forcedTerminalReason = null;
	rpcStateId = `delegate-state-${attempt}`;
	rpcPromptId = `delegate-prompt-${attempt}`;
	repeatedToolFailure = { fingerprint: null, count: 0, toolName: null };
	noChangeWindowStartedAt = null;
	currentTurnToolCalls = 0;
	currentTurnHadText = false;
	runawayStreak = 0;
	transport.handshakeAccepted = requestedTransport === "rpc" ? false : null;
	transport.promptAccepted = requestedTransport === "rpc" ? false : null;
	stdoutBuffer = "";
	const attemptStartedAt = new Date().toISOString();
	attempts.push({ attempt, startedAt: attemptStartedAt });

	const primeArgs = buildPrimeArgs();
	if (requestedTransport === "rpc") {
		child = WSL_MODE
			? spawn(primeArgs[0], primeArgs.slice(1), { cwd: wslCwd, detached: true, stdio: ["pipe", "pipe", "pipe"] })
			: spawn("wsl.exe", ["--cd", wslCwd, "--", ...primeArgs], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	} else {
		const primeCmd = shellJoin(primeArgs);
		const fullCmd = `cd ${shellQuote(wslCwd)} && ${primeCmd}`;
		child = WSL_MODE ? spawn("bash", ["-lc", fullCmd], { detached: true, stdio: ["ignore", "pipe", "pipe"] }) : spawn("wsl.exe", ["bash", "-lc", fullCmd], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	}

	health = recordAttemptStart(health, { attempt, childPid: child.pid, now: Date.now() });
	health.attemptStartedAt = attemptStartedAt;
	flushHealth();

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk;
		let newline = stdoutBuffer.indexOf("\n");
		while (newline !== -1) {
			processEventLine(stdoutBuffer.slice(0, newline));
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
			newline = stdoutBuffer.indexOf("\n");
		}
	});
	child.stderr.on("data", (chunk) => {
		const text = String(chunk);
		attemptStderrBytes += Buffer.byteLength(text, "utf8");
		if (attemptStderrPreview.length < STDERR_PREVIEW_MAX_BYTES) {
			attemptStderrPreview = (attemptStderrPreview + text).slice(0, STDERR_PREVIEW_MAX_BYTES);
		}
	});
	child.stderr.pipe(errors, { end: false });
	child.on("error", (error) => {
		errors.write(`${error.stack || error.message}\n`);
		spawnFailed = true;
		attemptStderrBytes += Buffer.byteLength(error.stack || error.message, "utf8");
		if (!attemptClosed) onChildClose(null, null);
	});
	child.on("close", (code, signal) => {
		if (!attemptClosed) onChildClose(code, signal);
	});
	if (requestedTransport === "rpc") {
		child.stdin.on("error", (error) => {
			if (!attemptClosed && !forcedTerminalReason) failRpcTransport("rpc_stdin_failed", error.message);
		});
		child.stdin.write(`${JSON.stringify({ id: rpcStateId, type: "get_state" })}\n`, "utf8");
	}

	startupTimer = setTimeout(onStartupTimeout, startupGraceMs);
	// The no-change window starts only after the prompt is accepted, so slow
	// startup/handshake never consumes the worker's no-change budget.
	if (!overallTimer) overallTimer = setTimeout(onOverallTimeout, Math.max(0, overallDeadlineMs - Date.now()));
	process.stdout.write(`${JSON.stringify({ type: "attempt_start", attempt, childPid: child.pid, startedAt: attemptStartedAt })}\n`);
}

function currentGitPorcelain() {
	const command = gitContext.environment.length > 0
		? ["env", ...gitContext.environment, "git", "status", "--porcelain"]
		: ["git", "status", "--porcelain"];
	const cmd = `cd ${shellQuote(wslCwd)} && ${shellJoin(command)}`;
	const result = runWslBashSync(cmd, { timeout: 60000 });
	if (result.status !== 0 || result.error) {
		return { ok: false, error: "git_status_failed" };
	}
	return { ok: true, value: result.stdout };
}

function currentGitChangedPaths() {
	const command = gitContext.environment.length > 0
		? ["env", ...gitContext.environment, "git", "status", "--porcelain=v1", "-z"]
		: ["git", "status", "--porcelain=v1", "-z"];
	const cmd = `cd ${shellQuote(wslCwd)} && ${shellJoin(command)}`;
	const result = runWslBashSync(cmd, { timeout: 60000 });
	if (result.status !== 0 || result.error) return { ok: false, error: "git_status_failed" };
	return { ok: true, paths: parsePorcelainV1Z(result.stdout) };
}

function onChildClose(code, signal) {
	if (finalized || attemptClosed) return;
	attemptClosed = true;
	clearTimeout(startupTimer);
	startupTimer = null;
	clearTimeout(idleTimer);
	idleTimer = null;
	clearTimeout(noChangeTimer);
	noChangeTimer = null;
	processEventLine(stdoutBuffer);
	stdoutBuffer = "";
	// The trailing flush may have re-armed the idle timer; drop it now.
	clearTimeout(idleTimer);
	idleTimer = null;
	clearTimeout(noChangeTimer);
	noChangeTimer = null;

	const protocol = evaluateProtocol(attemptProtocol);
	const classification = classifyChildExit({
		exitCode: code,
		signal,
		attemptEventCount,
		stderrPreview: attemptStderrPreview,
		watchdogCondition: pendingCondition,
		timedOut,
		spawnFailed,
		protocolComplete: protocol.complete,
	});
	finalProtocol = protocol;
	lastClassification = classification;

	attempts[attempts.length - 1] = {
		...attempts[attempts.length - 1],
		finishedAt: new Date().toISOString(),
		exitCode: code,
		signal,
		eventCount: attemptEventCount,
		kind: classification.kind,
		reason: classification.reason,
		protocol,
	};
	lastChildExitCode = code;
	lastChildSignal = signal;

	appendSyntheticEvent({ kind: "attempt_end", outcome: classification.kind, reason: classification.reason, exitCode: code });
	if (forcedTerminalReason) {
		if (forcedTerminalReason.startsWith("rpc_")) {
			lastClassification = {
				kind: "failed",
				reason: forcedTerminalReason,
				terminalStatus: STATUS.FAILED,
				failureClass: "transport",
				failureOwner: "delegate_skill",
			};
		}
		finalize(STATUS.FAILED, forcedTerminalReason, forcedTerminalReason);
		return;
	}
	if (transportMode === "inline" && finalText.trim() === "task_integrity_mismatch") {
		const porcelainResult = currentGitPorcelain();
		if (!porcelainResult.ok || porcelainResult.value !== gitContext.baseline || options.noTools || inlineFallbackUsed) {
			finalize(STATUS.FAILED, "task_integrity_mismatch", "inline_integrity_fallback_unavailable", porcelainResult.ok ? porcelainResult.value : undefined);
			return;
		}
		inlineFallbackUsed = true;
		finalText = "";
		configureTaskParts();
		Object.assign(transport, {
			mode: transportMode,
			effectiveInitialPromptBytes: Buffer.byteLength(primeTask, "utf8"),
			wireBytes: requestedTransport === "rpc" ? Buffer.byteLength(`${JSON.stringify({ id: "delegate-prompt", type: "prompt", message: primeTask })}\n`, "utf8") : Buffer.byteLength(primeTask, "utf8"),
			partCount: taskPartCount,
			maxPartBytes: maxTaskPartBytes,
			inlineTaskEndMarker,
			inlineFallbackUsed,
		});
		appendSyntheticEvent({ kind: "inline_integrity_fallback", nextTransportMode: "task-parts" });
		spawnAttempt();
		return;
	}

	if (options.allowedChanges.length > 0) {
		const changedPaths = currentGitChangedPaths();
		if (!changedPaths.ok) {
			lastClassification = {
				kind: "failed",
				reason: changedPaths.error,
				terminalStatus: STATUS.FAILED,
				failureClass: "git",
				failureOwner: "delegate_skill",
			};
			finalize(STATUS.FAILED, changedPaths.error, "git_status_failed");
			return;
		}
		const allowed = new Set(options.allowedChanges);
		finalUnauthorizedChanges = changedPaths.paths.filter((path) => !allowed.has(path));
		if (finalUnauthorizedChanges.length > 0) {
			const porcelainResult = currentGitPorcelain();
			if (!porcelainResult.ok) {
				lastClassification = {
					kind: "failed",
					reason: porcelainResult.error,
					terminalStatus: STATUS.FAILED,
					failureClass: "git",
					failureOwner: "delegate_skill",
				};
				finalize(STATUS.FAILED, porcelainResult.error, "git_status_failed");
				return;
			}
			lastClassification = {
				kind: "failed",
				reason: "unauthorized_change",
				terminalStatus: STATUS.FAILED,
				failureClass: "contract",
				failureOwner: "prime_agent",
			};
			attempts[attempts.length - 1].kind = "failed";
			attempts[attempts.length - 1].reason = "unauthorized_change";
			appendSyntheticEvent({ kind: "unauthorized_change", count: finalUnauthorizedChanges.length });
			finalize(STATUS.FAILED, "unauthorized_change", "unauthorized_change", porcelainResult.value);
			return;
		}
	}

	if (runMetadata.delegationMode === "investigate") {
		const porcelainResult = currentGitPorcelain();
		if (!porcelainResult.ok) {
			lastClassification = {
				kind: "failed",
				reason: porcelainResult.error,
				terminalStatus: STATUS.FAILED,
				failureClass: "git",
				failureOwner: "delegate_skill",
			};
			finalize(STATUS.FAILED, porcelainResult.error, "git_status_failed");
			return;
		}
		if (porcelainResult.value !== gitContext.baseline) {
			lastClassification = {
				kind: "failed",
				reason: "read_only_violation",
				terminalStatus: STATUS.FAILED,
				failureClass: "contract",
				failureOwner: "prime_agent",
			};
			attempts[attempts.length - 1].kind = "failed";
			attempts[attempts.length - 1].reason = "read_only_violation";
			appendSyntheticEvent({ kind: "read_only_violation" });
			finalize(STATUS.FAILED, "read_only_violation", "investigate_worktree_changed", porcelainResult.value);
			return;
		}
	}

	if (classification.kind === "completed" && options.requireChange) {
		const porcelainResult = currentGitPorcelain();
		if (!porcelainResult.ok) {
			lastClassification = {
				kind: "failed",
				reason: porcelainResult.error,
				terminalStatus: STATUS.FAILED,
				failureClass: "git",
				failureOwner: "delegate_skill",
			};
			finalize(STATUS.FAILED, porcelainResult.error, "git_status_failed");
			return;
		}
		if (porcelainResult.value === gitContext.baseline) {
			lastClassification = {
				kind: "failed",
				reason: "required_change_missing",
				terminalStatus: STATUS.FAILED,
				failureClass: "contract",
				failureOwner: "prime_agent",
			};
			attempts[attempts.length - 1].kind = "failed";
			attempts[attempts.length - 1].reason = "required_change_missing";
			appendSyntheticEvent({ kind: "required_change_missing" });
			finalize(STATUS.FAILED, "required_change_missing", "required_change_missing");
			return;
		}
		finalize(STATUS.COMPLETED, classification.reason, "completed_not_restartable", porcelainResult.value);
		return;
	}

	if (classification.kind === "completed" || classification.kind === "timed_out" || classification.kind === "failed" || classification.kind === "config_error") {
		const porcelain = [FAILURE_KIND.REPEATED_TOOL_FAILURE, FAILURE_KIND.MAX_TURNS_EXHAUSTED, FAILURE_KIND.RUNAWAY_TURNS].includes(classification.reason)
			? currentGitPorcelain()
			: null;
		finalize(
			classification.terminalStatus,
			classification.reason,
			`${classification.kind}_not_restartable`,
			porcelain?.ok ? porcelain.value : undefined,
		);
		return;
	}

	// Infrastructure failure: compare the worktree against the attempt-1 baseline.
	const porcelainResult = currentGitPorcelain();
	if (!porcelainResult.ok) {
		finalize(STATUS.FAILED, porcelainResult.error, "git_status_failed");
		return;
	}
	const porcelain = porcelainResult.value;
	const worktreeMatchesBaseline = porcelain === gitContext.baseline;
	const restartDecision = decideRestart({
		kind: classification.kind,
		worktreeMatchesBaseline,
		restartCount,
		maxInfraRestarts,
		now: Date.now(),
		overallDeadlineMs,
		restartDelayMs,
		startupGraceMs,
	});

	if (restartDecision.restart) {
		restartCount++;
		restartReasons.push({ attempt, kind: classification.kind, reason: classification.reason });
		health = recordRestarting(health, { reason: `restart_after_${classification.kind}`, restartCount });
		flushHealth();
		appendSyntheticEvent({ kind: "restart", reason: classification.reason, restartCount, maxInfraRestarts });
		process.stdout.write(`${JSON.stringify({ type: "restart_scheduled", attempt, restartCount, reason: classification.reason, delayMs: restartDelayMs })}\n`);
		setTimeout(() => {
			if (!finalized) spawnAttempt();
		}, restartDelayMs);
		return;
	}

	const terminal = terminalStatusFor({ kind: classification.kind, restartDecision });
	const worktreeDiff = worktreeMatchesBaseline ? undefined : porcelain;
	finalize(terminal, `${classification.kind}:${restartDecision.reason}`, restartDecision.reason, worktreeDiff);
}

function finalize(status, reason, decisionReason, worktreeDiff) {
	if (finalized) return;
	finalized = true;
	attemptClosed = true;
	clearTimeout(startupTimer);
	startupTimer = null;
	clearTimeout(idleTimer);
	idleTimer = null;
	clearTimeout(noChangeTimer);
	noChangeTimer = null;
	clearTimeout(overallTimer);
	overallTimer = null;
	clearTimeout(healthWriteTimer);
	healthWriteTimer = null;
	processEventLine(stdoutBuffer);
	stdoutBuffer = "";
	clearTimeout(idleTimer);
	idleTimer = null;

	terminalStatus = status;
	terminalReason = reason;
	finalExitCode = status === STATUS.COMPLETED ? 0 : 1;
	health = recordTerminal(health, { status, reason });
	flushHealth();

	// Marker for later worktree cleanup. Written after all Git checks and
	// diff capture so it never affects read-only or allowlist validation.
	const taskCompleteMarker = {
		runId,
		status,
		terminalReason: reason,
		taskId: runMetadata?.taskId ?? null,
	};
	const finishedAt = new Date().toISOString();
	taskCompleteMarker.finishedAt = finishedAt;
	try {
		writeFileSync(join(cwd, ".prime-task-complete.json"), JSON.stringify(taskCompleteMarker, null, 2) + "\n", "utf8");
	} catch {}
	const summary = {
		schemaVersion: SUMMARY_SCHEMA_VERSION,
		runId,
		delegateVersion: DELEGATE_VERSION,
		primeVersion,
		taskId: runMetadata.taskId,
		workPackageId: runMetadata.workPackageId,
		taskType: runMetadata.taskType,
		delegationMode: runMetadata.delegationMode,
		status,
		terminalReason,
		decisionReason,
		failureClass: lastClassification?.failureClass ?? (status === STATUS.COMPLETED ? null : "unknown"),
		failureOwner: lastClassification?.failureOwner ?? (status === STATUS.COMPLETED ? null : "unknown"),
		exitCode: lastChildExitCode,
		signal: lastChildSignal,
		startedAt,
		finishedAt,
		timeoutMs,
		startupGraceMs,
		idleTimeoutMs,
		noChangeTimeoutMs,
		noChangeMaxToolCalls,
		repeatedToolFailureLimit,
		taskChunkMaxBytes,
		stagedContext: stagedContext
			? {
				dir: stagedContext.contextDir,
				wslDir: stagedContext.wslContextDir,
				entryCount: stagedContext.entries.length,
				totalBytes: stagedContext.totalBytes,
			}
			: null,
		repeatedToolFailureCount: health.repeatedToolFailureCount,
		repeatedToolFailureTool: health.repeatedToolFailureTool,
		runawayTurnsLimit,
		runawayTurnsObserved,
		observedTurnCount: health.attemptTurnCount,
		maxInfraRestarts,
		restartDelayMs,
		autonomous: options.autonomous,
		autonomousMaxContinuations: options.autonomous ? autonomousMaxContinuations : null,
		autonomousMaxTurns: options.autonomous ? autonomousMaxTurns : null,
		autonomousMaxTokens: options.autonomous ? autonomousMaxTokens : null,
		autonomousGateCount: options.autonomousGates.length,
		attemptCount: attempt,
		restartCount,
		restartReasons,
		attempts,
		cwd,
		wslCwd,
		gitContextMode: gitContext.mode,
		promptFile,
		eventCaptureMode: options.fullEvents ? "full" : "semantic-compact",
		transport,
		protocolComplete: finalProtocol.complete,
		protocol: finalProtocol,
		requireChange: options.requireChange,
		allowedChanges: options.allowedChanges,
		unauthorizedChanges: finalUnauthorizedChanges,
		eventCount,
		persistedEventCount,
		droppedStreamingEventCount,
		parseErrors,
		finalText,
		worktreeDiff,
		healthPath,
		artifacts: { eventsPath, stderrPath, summaryPath, auditSummaryPath, workerPromptPath, healthPath, runManifestPath, ...(stagedContext ? { stagedContextManifestPath: join(stagedContext.contextDir, "manifest.json") } : {}) },
	};
	writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
	let pendingStreams = 2;
	const finish = () => {
		pendingStreams--;
		if (pendingStreams !== 0) return;
		// Both streams flushed: audit the complete accumulated events/stderr.
		const audit = spawnSync(process.execPath, [
			join(SCRIPT_DIR, "summarize-events.mjs"),
			"--events", eventsPath,
			"--summary", summaryPath,
			"--stderr", stderrPath,
			"--output", auditSummaryPath,
		], { encoding: "utf8", windowsHide: true });
		summary.auditSummaryStatus = audit.status === 0 ? "created" : "failed";
		if (audit.status !== 0) summary.auditSummaryError = (audit.stderr || audit.stdout).trim().slice(0, 1000);
		writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
		const auditSummary = audit.status === 0 ? JSON.parse(readFileSync(auditSummaryPath, "utf8")) : {};
		const artifacts = artifactEntries(outDir, runManifestPath);
		const eventsArtifact = artifacts.find((artifact) => artifact.path === "events.jsonl");
		atomicWriteJson(runManifestPath, sanitize({
			schemaVersion: 1,
			runId,
			completed: true,
			generatedAt: new Date().toISOString(),
			run: {
				status: summary.status,
				terminalReason: summary.terminalReason,
				failureClass: summary.failureClass,
				failureOwner: summary.failureOwner,
				taskId: summary.taskId,
				workPackageId: summary.workPackageId,
				taskType: summary.taskType,
				delegationMode: summary.delegationMode,
				delegateVersion: summary.delegateVersion,
				primeVersion: summary.primeVersion,
			},
			captureMode: summary.eventCaptureMode,
			primeEventSchemaVersion: finalProtocol.sessionVersion,
			eventCounts: {
				total: eventCount,
				persisted: persistedEventCount,
				dropped: droppedStreamingEventCount,
				byType: auditSummary.eventTypes ?? {},
			},
			protocolEvidence: finalProtocol,
			refineSourceAvailable: finalProtocol.sessionCount === 1 && Boolean(eventsArtifact?.bytes),
			eventsSha256: eventsArtifact?.sha256 ?? null,
			artifacts,
		}));
		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
		process.exit(finalExitCode);
	};
	events.end(finish);
	errors.end(finish);
}

function onInterruptSignal(signal) {
	if (finalized) return;
	appendSyntheticEvent({ kind: "interrupted", signal });
	lastClassification = {
		kind: "failed",
		reason: "interrupted",
		terminalStatus: STATUS.FAILED,
		failureClass: "process",
		failureOwner: "environment",
	};
	writeHealthWithReason("interrupted");
	terminateChild(`interrupted_${signal.toLowerCase()}`);
	if (forcedTerminalReason) {
		lastClassification = {
			kind: "failed",
			reason: forcedTerminalReason,
			terminalStatus: STATUS.FAILED,
			failureClass: "process",
			failureOwner: "environment",
		};
		finalize(STATUS.FAILED, forcedTerminalReason, forcedTerminalReason);
		return;
	}
	finalize(STATUS.FAILED, "interrupted", `interrupted_by_${signal.toLowerCase()}`);
}

process.on("SIGINT", () => onInterruptSignal("SIGINT"));
process.on("SIGTERM", () => onInterruptSignal("SIGTERM"));

spawnAttempt();
