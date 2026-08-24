#!/usr/bin/env node

// scripts/delegate-watchdog.mjs
//
// Pure watchdog decision and health helpers for scripts/delegate.mjs.
// Dependency-free so the unit tests in scripts/test-delegate-watchdog.mjs
// can run without Prime Agent, WSL, network, or credentials.
//
// The launcher injects the real Windows process-liveness probe
// (windowsProcessAlive) and the real timers; every decision and health
// transition in this file is a pure function of its inputs.

import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const SCHEMA_VERSION = 1;
export const SUMMARY_SCHEMA_VERSION = 2;
export const DELEGATE_VERSION = "2.0.0";

export const STATUS = Object.freeze({
	STARTING: "starting",
	RUNNING: "running",
	RESTARTING: "restarting",
	COMPLETED: "completed",
	FAILED: "failed",
	TIMED_OUT: "timed_out",
	UNRESPONSIVE_WITH_CHANGES: "unresponsive_with_changes",
	RESTART_EXHAUSTED: "restart_exhausted",
});

export const FAILURE_KIND = Object.freeze({
	STARTUP_TIMEOUT: "startup_timeout",
	IDLE_TIMEOUT: "idle_timeout",
	EXIT_BEFORE_FIRST_EVENT: "exit_before_first_event",
	NO_CHANGE_PROGRESS: "no_change_progress",
	REPEATED_TOOL_FAILURE: "repeated_tool_failure",
});

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const TASK_TYPES = new Set(["implementation", "investigation", "testing", "prototype"]);
const DELEGATION_MODES = new Set(["implement", "prototype", "investigate"]);

export function validateMetadataValue(value, { name, allowed } = {}) {
	if (value == null) return null;
	if (allowed) {
		if (!allowed.has(value)) throw new RangeError(`${name} must be one of: ${[...allowed].join(", ")}`);
		return value;
	}
	if (!ID_PATTERN.test(value)) throw new RangeError(`${name} must match [A-Za-z0-9._-]{1,128}`);
	return value;
}

export function normalizeRunMetadata(options = {}) {
	const delegationMode = validateMetadataValue(
		options.delegationMode ?? (options.autonomous ? "implement" : "investigate"),
		{ name: "--delegation-mode", allowed: DELEGATION_MODES },
	);
	const taskType = validateMetadataValue(
		options.taskType ?? (options.autonomous ? "implementation" : "investigation"),
		{ name: "--task-type", allowed: TASK_TYPES },
	);
	if (delegationMode === "implement" && (!options.autonomous || !options.requireChange)) {
		throw new RangeError("implement mode requires --autonomous --require-change");
	}
	if (delegationMode === "investigate" && options.requireChange) {
		throw new RangeError("investigate mode is incompatible with --require-change");
	}
	return {
		taskId: validateMetadataValue(options.taskId, { name: "--task-id" }),
		workPackageId: validateMetadataValue(options.workPackageId, { name: "--work-package-id" }),
		taskType,
		delegationMode,
	};
}

export function splitUtf8ByBytes(value, maxBytes) {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
	const parts = [];
	let current = "";
	let currentBytes = 0;
	for (const codePoint of String(value)) {
		const bytes = Buffer.byteLength(codePoint, "utf8");
		if (bytes > maxBytes) throw new RangeError("maxBytes is smaller than one Unicode code point");
		if (current && currentBytes + bytes > maxBytes) {
			parts.push(current);
			current = "";
			currentBytes = 0;
		}
		current += codePoint;
		currentBytes += bytes;
	}
	if (current || parts.length === 0) parts.push(current);
	return parts;
}

export function createProtocolState() {
	return {
		sessionCount: 0,
		sessionVersion: null,
		agentStartCount: 0,
		agentEndCount: 0,
		openTurns: 0,
		turnStartCount: 0,
		turnEndCount: 0,
		openToolCalls: new Set(),
		duplicateToolStarts: 0,
		unmatchedToolEnds: 0,
		malformedLines: 0,
	};
}

export function recordProtocolEvent(state, event) {
	switch (event?.type) {
		case "session":
			state.sessionCount++;
			state.sessionVersion ??= event.version ?? null;
			break;
		case "agent_start":
			state.agentStartCount++;
			break;
		case "agent_end":
			state.agentEndCount++;
			break;
		case "turn_start":
			state.turnStartCount++;
			state.openTurns++;
			break;
		case "turn_end":
			state.turnEndCount++;
			state.openTurns--;
			break;
		case "tool_execution_start":
			if (!event.toolCallId || state.openToolCalls.has(event.toolCallId)) state.duplicateToolStarts++;
			else state.openToolCalls.add(event.toolCallId);
			break;
		case "tool_execution_end":
			if (!event.toolCallId || !state.openToolCalls.delete(event.toolCallId)) state.unmatchedToolEnds++;
			break;
	}
	return state;
}

export function recordProtocolParseError(state) {
	state.malformedLines++;
	return state;
}

export function evaluateProtocol(state) {
	const complete =
		state.sessionCount === 1 &&
		state.agentStartCount === 1 &&
		state.agentEndCount === 1 &&
		state.openTurns === 0 &&
		state.turnStartCount === state.turnEndCount &&
		state.openToolCalls.size === 0 &&
		state.duplicateToolStarts === 0 &&
		state.unmatchedToolEnds === 0 &&
		state.malformedLines === 0;
	return {
		complete,
		sessionCount: state.sessionCount,
		sessionVersion: state.sessionVersion,
		agentStartCount: state.agentStartCount,
		agentEndCount: state.agentEndCount,
		turnStartCount: state.turnStartCount,
		turnEndCount: state.turnEndCount,
		openTurnCount: state.openTurns,
		openToolCallCount: state.openToolCalls.size,
		duplicateToolStarts: state.duplicateToolStarts,
		unmatchedToolEnds: state.unmatchedToolEnds,
		malformedLines: state.malformedLines,
	};
}

function result(kind, reason, terminalStatus, failureClass, failureOwner) {
	return { kind, reason, terminalStatus, failureClass, failureOwner };
}

export const TERMINAL_STATUSES = Object.freeze([
	STATUS.COMPLETED,
	STATUS.FAILED,
	STATUS.TIMED_OUT,
	STATUS.UNRESPONSIVE_WITH_CHANGES,
	STATUS.RESTART_EXHAUSTED,
]);

export function isTerminal(status) {
	return TERMINAL_STATUSES.includes(status);
}

export function isInfraFailure(kind) {
	return (
		kind === FAILURE_KIND.STARTUP_TIMEOUT ||
		kind === FAILURE_KIND.IDLE_TIMEOUT ||
		kind === FAILURE_KIND.EXIT_BEFORE_FIRST_EVENT
	);
}

// A status is "active" while a child attempt is expected to be in flight.
export function statusIsActive(status) {
	return status === STATUS.STARTING || status === STATUS.RUNNING || status === STATUS.RESTARTING;
}

// The watchdog's own view of "healthy": in-flight attempts are healthy until
// they hit a watchdog/terminal condition; a successful completion is healthy.
export function statusIsHealthy(status) {
	return statusIsActive(status) || status === STATUS.COMPLETED;
}

export function createHealth(options = {}) {
	const now = options.now ?? Date.now();
	const nowIso = new Date(now).toISOString();
	const health = {
		schemaVersion: SCHEMA_VERSION,
		status: options.status ?? STATUS.STARTING,
		healthy: true,
		active: false,
		attempt: options.attempt ?? 1,
		restartCount: options.restartCount ?? 0,
		maxInfraRestarts: options.maxInfraRestarts ?? 1,
		childPid: options.childPid ?? null,
		startedAt: options.startedAt ?? nowIso,
		attemptStartedAt: options.attemptStartedAt ?? nowIso,
		firstEventAt: options.firstEventAt ?? null,
		lastEventAt: options.lastEventAt ?? null,
		updatedAt: options.updatedAt ?? nowIso,
		eventCount: options.eventCount ?? 0,
		attemptEventCount: options.attemptEventCount ?? 0,
		attemptToolCallCount: options.attemptToolCallCount ?? 0,
		changeDetectedAt: options.changeDetectedAt ?? null,
		lastReason: options.lastReason ?? "initialized",
		processHost: options.processHost ?? "windows",
		startupGraceMs: options.startupGraceMs ?? 90000,
		idleTimeoutMs: options.idleTimeoutMs ?? 300000,
		noChangeTimeoutMs: options.noChangeTimeoutMs ?? 600000,
		noChangeMaxToolCalls: options.noChangeMaxToolCalls ?? 80,
		repeatedToolFailureLimit: options.repeatedToolFailureLimit ?? 8,
		repeatedToolFailureCount: options.repeatedToolFailureCount ?? 0,
		repeatedToolFailureTool: options.repeatedToolFailureTool ?? null,
		restartDelayMs: options.restartDelayMs ?? 5000,
		overallTimeoutMs: options.overallTimeoutMs ?? 30 * 60 * 1000,
	};
	return updateHealth(health, {});
}

// Recompute derived booleans and stamp updatedAt. Pass patch.now to control
// the clock (tests) or patch.updatedAt to pin the timestamp explicitly.
export function updateHealth(health, patch = {}) {
	const now = patch.now ?? Date.now();
	const next = { ...health, ...patch };
	delete next.now;
	next.updatedAt = patch.updatedAt ?? new Date(now).toISOString();
	next.active = statusIsActive(next.status);
	next.healthy = statusIsHealthy(next.status);
	return next;
}

export function recordAttemptStart(health, { attempt, childPid, now = Date.now() } = {}) {
	const iso = new Date(now).toISOString();
	return updateHealth(health, {
		status: STATUS.STARTING,
		attempt,
		childPid,
		attemptStartedAt: iso,
		firstEventAt: null,
		lastEventAt: null,
		eventCount: health.eventCount ?? 0,
		attemptEventCount: 0,
		attemptToolCallCount: 0,
		changeDetectedAt: null,
		repeatedToolFailureCount: 0,
		repeatedToolFailureTool: null,
		lastReason: "attempt_started",
		now,
	});
}

// Called for every valid parsed JSON event on stdout. eventCount is
// cumulative across attempts; attemptEventCount counts the current attempt.
export function recordValidEvent(health, { now = Date.now(), toolCall = false } = {}) {
	const iso = new Date(now).toISOString();
	return updateHealth(health, {
		status: STATUS.RUNNING,
		firstEventAt: health.firstEventAt ?? iso,
		lastEventAt: iso,
		eventCount: (health.eventCount ?? 0) + 1,
		attemptEventCount: (health.attemptEventCount ?? 0) + 1,
		attemptToolCallCount: (health.attemptToolCallCount ?? 0) + (toolCall ? 1 : 0),
		lastReason: "valid_event",
		now,
	});
}

export function recordRestarting(health, { reason, restartCount, now = Date.now() } = {}) {
	return updateHealth(health, {
		status: STATUS.RESTARTING,
		lastReason: reason ?? "restarting",
		childPid: null,
		restartCount: restartCount ?? health.restartCount ?? 0,
		attemptStartedAt: new Date(now).toISOString(),
		firstEventAt: null,
		lastEventAt: null,
		now,
	});
}

export function recordTerminal(health, { status, reason, now = Date.now() } = {}) {
	return updateHealth(health, { status, lastReason: reason ?? status, childPid: null, now });
}

// Heartbeat age in ms: last valid event, else current attempt start, else
// last write. Null when no timestamp is available or it cannot be parsed.
export function healthHeartbeatAge(health, now = Date.now()) {
	const heartbeatAt = health?.lastEventAt ?? health?.attemptStartedAt ?? health?.updatedAt;
	if (!heartbeatAt) return null;
	const ms = Date.parse(heartbeatAt);
	if (Number.isNaN(ms)) return null;
	return Math.max(0, now - ms);
}

// Classify how a child attempt ended. watchdogCondition and timedOut are set
// by the launcher's watchdog timers; everything else is derived from the exit.
export function classifyChildExit({
	exitCode,
	signal,
	attemptEventCount = 0,
	stderrPreview = "",
	watchdogCondition = null,
	timedOut = false,
	spawnFailed = false,
	protocolComplete = true,
} = {}) {
	if (timedOut) {
		return result("timed_out", "overall_timeout", STATUS.TIMED_OUT, "timeout", "delegate_skill");
	}
	if (watchdogCondition === FAILURE_KIND.STARTUP_TIMEOUT) {
		return result(FAILURE_KIND.STARTUP_TIMEOUT, "no_valid_event_within_startup_grace", undefined, "startup", "environment");
	}
	if (watchdogCondition === FAILURE_KIND.IDLE_TIMEOUT) {
		return result(FAILURE_KIND.IDLE_TIMEOUT, "no_valid_event_within_idle_timeout", undefined, "idle", "environment");
	}
	if (watchdogCondition === FAILURE_KIND.NO_CHANGE_PROGRESS) {
		return result("failed", FAILURE_KIND.NO_CHANGE_PROGRESS, STATUS.FAILED, "no_progress", "prime_agent");
	}
	if (watchdogCondition === FAILURE_KIND.REPEATED_TOOL_FAILURE) {
		return result("failed", FAILURE_KIND.REPEATED_TOOL_FAILURE, STATUS.FAILED, "tool_loop", "prime_agent");
	}
	if (spawnFailed) {
		return result("config_error", "spawn_error", STATUS.FAILED, "spawn", "environment");
	}
	if (exitCode === 0) {
		return protocolComplete
			? result("completed", "normal_exit", STATUS.COMPLETED, null, null)
			: result("failed", "protocol_incomplete", STATUS.FAILED, "protocol", "prime_agent");
	}
	if (signal) {
		return result("failed", `terminated_by_signal_${signal}`, STATUS.FAILED, "process", "environment");
	}
	if (attemptEventCount > 0) {
		const reason = primeFailureReason(stderrPreview) ?? "nonzero_exit_after_event";
		if (reason === "provider_rate_limited" || reason === "provider_unavailable" || reason === "provider_network_error") {
			return result("failed", reason, STATUS.FAILED, "provider", "provider");
		}
		if (reason === "task_contract_invalid") return result("failed", reason, STATUS.FAILED, "contract", "task_spec");
		if (reason === "gate_failed") return result("failed", reason, STATUS.FAILED, "gate", "project");
		if (reason?.endsWith("_exhausted") || reason === "prime_timeout") {
			return result("failed", reason, STATUS.FAILED, "prime_limit", "prime_agent");
		}
		return {
			kind: "failed",
			reason,
			terminalStatus: STATUS.FAILED,
			failureClass: "execution",
			failureOwner: "unknown",
		};
	}
	if (isKnownConfigurationError(stderrPreview)) {
		return result("config_error", "nonzero_exit_before_event_with_stderr", STATUS.FAILED, "configuration", "delegate_skill");
	}
	return result(FAILURE_KIND.EXIT_BEFORE_FIRST_EVENT, "nonzero_exit_before_first_event", undefined, "startup", "environment");
}

export function primeFailureReason(stderrPreview) {
	if (typeof stderrPreview !== "string" || stderrPreview === "") return null;
	const text = stderrPreview.slice(-4096);
	if (/maxTurns reached/i.test(text)) return "max_turns_exhausted";
	if (/maxTokens reached/i.test(text)) return "max_tokens_exhausted";
	if (/maxContinuations reached/i.test(text)) return "max_continuations_exhausted";
	if (/timeoutMs reached/i.test(text)) return "prime_timeout";
	if (/Autonomous quality gate still failing/i.test(text)) return "gate_failed";
	if (/\b(?:invalid|malformed) task contract\b/i.test(text)) return "task_contract_invalid";
	if (/(?:HTTP\s*)?429|rate.?limit/i.test(text)) return "provider_rate_limited";
	if (/(?:HTTP\s*)?503|service unavailable/i.test(text)) return "provider_unavailable";
	if (/\b(?:ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b/i.test(text)) return "provider_network_error";
	return null;
}

export function shouldStopForNoChange({
	requireChange = false,
	changeDetected = false,
	elapsedMs = 0,
	timeoutMs = 600000,
	toolCallCount = 0,
	maxToolCalls = 80,
} = {}) {
	if (!requireChange || changeDetected) return false;
	return elapsedMs >= timeoutMs || toolCallCount >= maxToolCalls;
}

function stableErrorText(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(stableErrorText).filter(Boolean).join(" ");
	if (!value || typeof value !== "object") return "";
	return ["text", "message", "error", "stderr", "content"]
		.map((key) => stableErrorText(value[key]))
		.filter(Boolean)
		.join(" ");
}

export function recordRepeatedToolFailure(state = {}, event) {
	if (event?.type !== "tool_execution_end") return state;
	const status = String(event.result?.status ?? event.result?.details?.status ?? "").toLowerCase();
	const failed = event.isError === true || event.result?.isError === true || ["error", "failed", "failure"].includes(status);
	if (!failed) return { fingerprint: null, count: 0, toolName: null };
	const toolName = String(event.toolName ?? "unknown");
	const text = stableErrorText({
		content: event.result?.content,
		error: event.result?.error,
		message: event.result?.message,
		stderr: event.result?.stderr,
	}).replace(/\s+/g, " ").trim().slice(0, 2048) || "unknown_error";
	const fingerprint = `${toolName}\n${text}`;
	return {
		fingerprint,
		count: state.fingerprint === fingerprint ? (state.count ?? 0) + 1 : 1,
		toolName,
	};
}

export function buildWorkerPromptArgument({ workerPrompt } = {}) {
	if (typeof workerPrompt !== "string" || workerPrompt.trim() === "") {
		throw new Error("workerPrompt must be a non-empty string");
	}
	return workerPrompt;
}

export function isLinuxProcessRunningFromStat(stat) {
	if (typeof stat !== "string") return false;
	const closeParen = stat.lastIndexOf(")");
	if (closeParen < 0) return false;
	const state = stat.slice(closeParen + 1).trim().split(/\s+/, 1)[0];
	return state !== "" && state !== "Z" && state !== "X";
}

export function decodeCapturedOutput(value) {
	if (typeof value === "string") return value;
	if (value == null) return "";
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
	if (bytes.length === 0) return "";
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le").replace(/\0+$/g, "");
	let oddNulls = 0;
	for (let index = 1; index < bytes.length; index += 2) {
		if (bytes[index] === 0) oddNulls++;
	}
	if (bytes.length >= 4 && oddNulls >= Math.floor(bytes.length / 4)) {
		return bytes.toString("utf16le").replace(/^\uFEFF/, "").replace(/\0+$/g, "");
	}
	return bytes.toString("utf8");
}

export function isKnownConfigurationError(stderrPreview) {
	if (typeof stderrPreview !== "string" || stderrPreview === "") return false;
	return /(?:unknown argument|missing value for|invalid (?:argument|option|configuration)|configuration (?:error|missing)|must be an? (?:absolute|positive|integer)|listen ENOTSUP: operation not supported on socket)/i.test(stderrPreview.slice(0, 4096));
}

// Decide whether an infra failure may be retried. All four conditions must
// hold; the overall deadline is checked against restart delay + startup grace.
export function decideRestart({
	kind,
	worktreeMatchesBaseline = true,
	restartCount = 0,
	maxInfraRestarts = 1,
	now = Date.now(),
	overallDeadlineMs = Number.POSITIVE_INFINITY,
	restartDelayMs = 5000,
	startupGraceMs = 90000,
} = {}) {
	if (!isInfraFailure(kind)) {
		return { restart: false, reason: `${kind}_not_restartable` };
	}
	if (!worktreeMatchesBaseline) {
		return { restart: false, reason: "worktree_changed" };
	}
	if (restartCount >= maxInfraRestarts) {
		return { restart: false, reason: "restart_budget_exhausted" };
	}
	if (now + restartDelayMs + startupGraceMs > overallDeadlineMs) {
		return { restart: false, reason: "overall_deadline_exhausted" };
	}
	return { restart: true, reason: kind };
}

// Map an attempt outcome to the terminal health status. Returns null when the
// outcome is a permitted restart (status stays "restarting").
export function terminalStatusFor({ kind, restartDecision }) {
	if (restartDecision?.restart) return null;
	switch (kind) {
		case "completed":
			return STATUS.COMPLETED;
		case "timed_out":
			return STATUS.TIMED_OUT;
		case "failed":
		case "config_error":
			return STATUS.FAILED;
		case FAILURE_KIND.STARTUP_TIMEOUT:
		case FAILURE_KIND.IDLE_TIMEOUT:
		case FAILURE_KIND.EXIT_BEFORE_FIRST_EVENT:
			return restartDecision?.reason === "worktree_changed"
				? STATUS.UNRESPONSIVE_WITH_CHANGES
				: STATUS.RESTART_EXHAUSTED;
		default:
			return STATUS.FAILED;
	}
}

// Evaluate a health.json snapshot for --status-dir. active reflects the real
// liveness of the recorded child PID (when the status is active); healthy adds
// heartbeat freshness against the threshold relevant to the current status.
export function evaluateHealthStatus(health, { now = Date.now(), isProcessAlive } = {}) {
	if (!health || typeof health !== "object") {
		return { healthy: false, active: false, stale: false, reason: "missing_health", exitCode: 1, status: null };
	}
	const status = health.status;
	const activeStatus = statusIsActive(status);
	const thresholdMs =
		status === STATUS.STARTING
			? Number(health.startupGraceMs) || 0
			: status === STATUS.RUNNING
				? Number(health.idleTimeoutMs) || 0
				: status === STATUS.RESTARTING
					? (Number(health.restartDelayMs) || 0) + (Number(health.startupGraceMs) || 0)
				: null;
	const heartbeatAgeMs = activeStatus ? healthHeartbeatAge(health, now) : null;
	const stale = activeStatus ? heartbeatAgeMs === null || heartbeatAgeMs > thresholdMs : false;

	let active = false;
	let pidAlive = null;
	if (activeStatus && status !== STATUS.RESTARTING) {
		const pid = health.childPid;
		if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
			pidAlive = typeof isProcessAlive === "function" ? isProcessAlive(pid) : false;
			active = pidAlive;
		}
	}

	let healthy;
	let reason;
	if (status === STATUS.COMPLETED) {
		healthy = true;
		reason = "terminal_completed";
	} else if (status === STATUS.RESTARTING) {
		healthy = !stale;
		active = !stale;
		reason = stale ? "stale_restart" : "restarting";
	} else if (isTerminal(status)) {
		healthy = false;
		reason = `terminal_${status}`;
	} else if (stale) {
		healthy = false;
		reason = "stale_heartbeat";
	} else if (!active) {
		healthy = false;
		reason = typeof health.childPid === "number" && health.childPid > 0 ? "child_pid_not_alive" : "missing_child_pid";
	} else {
		healthy = true;
		reason = "healthy";
	}

	return {
		healthy,
		active,
		stale,
		reason,
		exitCode: healthy ? 0 : 1,
		status,
		heartbeatAgeMs,
		thresholdMs,
		pidAlive,
		childPid: health.childPid,
	};
}

// Validate a CLI integer option. Throws RangeError on out-of-range or
// non-integer input so the launcher can report it as an argument error.
export function parseIntegerOption(value, { min = 1, max = Infinity, name = "value" } = {}) {
	const n = Number(value);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
	}
	return n;
}

// Atomic JSON write: write to a sibling temp file, then rename over the
// destination. Readers never observe a partially written health.json.
export function atomicWriteJson(filePath, value) {
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	try {
		renameSync(tmpPath, filePath);
	} catch (error) {
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			// best effort cleanup
		}
		throw error;
	}
	return filePath;
}

// Read a health.json snapshot. Returns the parsed object or null when the
// file is missing or not valid JSON.
export function readHealth(filePath) {
	let text;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

// Windows process-liveness probe used by the launcher (Windows side). Checks
// the exact PID via tasklist so it never sends a signal to the process.
export function windowsProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	const result = spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.status !== 0) return false;
	// CSV row for a match looks like: "wsl.exe","1234","Console","1","12,345 K"
	return new RegExp(`"${pid}"`).test(result.stdout || "");
}
