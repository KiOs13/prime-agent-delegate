#!/usr/bin/env node

// scripts/test-delegate-watchdog.mjs
//
// Dependency-free unit tests for the delegate watchdog decisions and health
// helpers. No Prime Agent, WSL, network, or credentials are touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FAILURE_KIND,
	SCHEMA_VERSION,
	SUMMARY_SCHEMA_VERSION,
	DELEGATE_VERSION,
	STATUS,
	atomicWriteJson,
	buildWorkerPromptArgument,
	classifyChildExit,
	createProtocolState,
	createHealth,
	decodeCapturedOutput,
	decideRestart,
	evaluateHealthStatus,
	evaluateProtocol,
	healthHeartbeatAge,
	isInfraFailure,
	isKnownConfigurationError,
	isLinuxProcessRunningFromStat,
	isTerminal,
	normalizeRunMetadata,
	parsePorcelainV1Z,
	parseIntegerOption,
	primeFailureReason,
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
	terminalStatusFor,
} from "./delegate-watchdog.mjs";

const ALIVE_PID = 4242;
const dead = () => false;
const aliveOnly = (pid) => pid === ALIVE_PID;

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const FUTURE = NOW + 24 * 60 * 60 * 1000;

function baseHealth(overrides = {}) {
	return createHealth({
		attempt: 1,
		childPid: ALIVE_PID,
		startupGraceMs: 90000,
		idleTimeoutMs: 300000,
		restartDelayMs: 5000,
		overallTimeoutMs: 1800000,
		now: NOW,
		...overrides,
	});
}

function restartArgs(overrides = {}) {
	return {
		kind: FAILURE_KIND.STARTUP_TIMEOUT,
		worktreeMatchesBaseline: true,
		restartCount: 0,
		maxInfraRestarts: 1,
		now: NOW,
		overallDeadlineMs: FUTURE,
		restartDelayMs: 5000,
		startupGraceMs: 90000,
		...overrides,
	};
}

test("health schema and derived booleans", () => {
	const health = baseHealth();
	assert.equal(health.schemaVersion, SCHEMA_VERSION);
	assert.equal(health.status, STATUS.STARTING);
	assert.equal(health.healthy, true);
	assert.equal(health.active, true);
	assert.equal(health.attempt, 1);
	assert.equal(health.restartCount, 0);
	assert.equal(health.maxInfraRestarts, 1);
	assert.equal(health.childPid, ALIVE_PID);
	assert.equal(health.startupGraceMs, 90000);
	assert.equal(health.idleTimeoutMs, 300000);
	assert.equal(health.overallTimeoutMs, 1800000);
	assert.equal(health.firstEventAt, null);
	assert.equal(health.lastEventAt, null);
	assert.equal(health.eventCount, 0);
});

test("recordValidEvent: starting -> running, first/last/eventCount, heartbeat age", () => {
	let health = baseHealth();
	health = recordValidEvent(health, { now: NOW + 1000 });
	assert.equal(health.status, STATUS.RUNNING);
	assert.equal(health.firstEventAt, new Date(NOW + 1000).toISOString());
	assert.equal(health.lastEventAt, new Date(NOW + 1000).toISOString());
	assert.equal(health.eventCount, 1);
	assert.equal(health.attemptEventCount, 1);
	assert.equal(health.lastReason, "valid_event");
	health = recordValidEvent(health, { now: NOW + 2000 });
	assert.equal(health.eventCount, 2);
	assert.equal(health.firstEventAt, new Date(NOW + 1000).toISOString(), "first event stays pinned");
	assert.equal(health.lastEventAt, new Date(NOW + 2000).toISOString());
	assert.equal(healthHeartbeatAge(health, NOW + 2500), 500);
});

test("recordAttemptStart resets per-attempt fields, keeps cumulative eventCount", () => {
	let health = baseHealth();
	health = recordValidEvent(health, { now: NOW + 1000 });
	health = recordAttemptStart(health, { attempt: 2, childPid: 777, now: NOW + 5000 });
	assert.equal(health.status, STATUS.STARTING);
	assert.equal(health.attempt, 2);
	assert.equal(health.childPid, 777);
	assert.equal(health.eventCount, 1, "cumulative across attempts");
	assert.equal(health.attemptEventCount, 0);
	assert.equal(health.firstEventAt, null);
	assert.equal(health.lastEventAt, null);
	assert.equal(health.lastReason, "attempt_started");
});

test("no-change watchdog stops only required unchanged work", () => {
	assert.equal(shouldStopForNoChange({ requireChange: false, elapsedMs: 999999, toolCallCount: 999 }), false);
	assert.equal(shouldStopForNoChange({ requireChange: true, changeDetected: true, elapsedMs: 999999, toolCallCount: 999 }), false);
	assert.equal(shouldStopForNoChange({ requireChange: true, elapsedMs: 599999, timeoutMs: 600000, toolCallCount: 79, maxToolCalls: 80 }), false);
	assert.equal(shouldStopForNoChange({ requireChange: true, elapsedMs: 600000, timeoutMs: 600000, toolCallCount: 0, maxToolCalls: 80 }), true);
	assert.equal(shouldStopForNoChange({ requireChange: true, elapsedMs: 0, timeoutMs: 600000, toolCallCount: 80, maxToolCalls: 80 }), true);
});

test("repeated tool failure tracker ignores volatile fields and resets", () => {
	let state = recordRepeatedToolFailure({}, {
		type: "tool_execution_end",
		toolCallId: "one",
		toolName: "ipython",
		result: { content: [{ type: "text", text: "Kernel has  been shut down" }], details: { durationMs: 10 } },
		isError: true,
	});
	assert.equal(state.count, 1);
	state = recordRepeatedToolFailure(state, {
		type: "tool_execution_end",
		toolCallId: "two",
		toolName: "ipython",
		result: { content: [{ type: "text", text: "Kernel has been shut down" }], details: { durationMs: 999 } },
		isError: true,
	});
	assert.equal(state.count, 2);
	state = recordRepeatedToolFailure(state, {
		type: "tool_execution_end",
		toolName: "ipython",
		result: { content: "Different failure" },
		isError: true,
	});
	assert.equal(state.count, 1);
	assert.deepEqual(recordRepeatedToolFailure(state, {
		type: "tool_execution_end",
		toolName: "ipython",
		result: { content: "ok" },
	}), { fingerprint: null, count: 0, toolName: null });
});

test("repeated tool failure in investigate mode detects errors without isError flag", () => {
	// Simulate real IPython kernel crash: isError NOT set, error only in content text
	let state = recordRepeatedToolFailure({}, {
		type: "tool_execution_end",
		toolCallId: "one",
		toolName: "ipython",
		result: { content: [{ type: "text", text: "Kernel has been shut down. stderr tail:" }] },
	}, { investigate: true });
	assert.equal(state.count, 1, "should detect kernel crash from content text");

	state = recordRepeatedToolFailure(state, {
		type: "tool_execution_end",
		toolCallId: "two",
		toolName: "ipython",
		result: { content: [{ type: "text", text: "Kernel has been shut down. stderr tail:" }] },
	}, { investigate: true });
	assert.equal(state.count, 2, "should increment on same fingerprint");

	// Non-error result resets even in investigate mode
	state = recordRepeatedToolFailure(state, {
		type: "tool_execution_end",
		toolName: "ipython",
		result: { content: "all good" },
	}, { investigate: true });
	assert.deepEqual(state, { fingerprint: null, count: 0, toolName: null });

	// Different error pattern also detected
	state = recordRepeatedToolFailure({}, {
		type: "tool_execution_end",
		toolName: "ipython",
		result: { content: "forked kernel exited unexpectedly pid=12345" },
	}, { investigate: true });
	assert.equal(state.count, 1, "should detect forked kernel crash");
});

test("repeated tool failure in implement mode ignores errors without isError flag", () => {
	// In implement/prototype mode, errors without isError should NOT be counted
	// to protect partial diff from premature termination
	const state = recordRepeatedToolFailure({}, {
		type: "tool_execution_end",
		toolCallId: "one",
		toolName: "ipython",
		result: { content: [{ type: "text", text: "Kernel has been shut down" }] },
	}, { investigate: false });
	assert.deepEqual(state, { fingerprint: null, count: 0, toolName: null },
		"implement mode should not detect content-only errors");
});

test("repeated tool failures are terminal Prime loops", () => {
	const cls = classifyChildExit({ watchdogCondition: FAILURE_KIND.REPEATED_TOOL_FAILURE });
	assert.equal(cls.kind, "failed");
	assert.equal(cls.reason, FAILURE_KIND.REPEATED_TOOL_FAILURE);
	assert.equal(cls.failureClass, "tool_loop");
	assert.equal(cls.failureOwner, "prime_agent");
	assert.equal(decideRestart(restartArgs({ kind: cls.kind })).restart, false);
});

test("launcher turn limit is a terminal Prime limit", () => {
	const cls = classifyChildExit({ watchdogCondition: FAILURE_KIND.MAX_TURNS_EXHAUSTED });
	assert.equal(cls.kind, "failed");
	assert.equal(cls.reason, "max_turns_exhausted");
	assert.equal(cls.failureClass, "prime_limit");
	assert.equal(cls.failureOwner, "prime_agent");
	assert.equal(decideRestart(restartArgs({ kind: cls.kind })).restart, false);
});

test("worker receives the task contract inline without an @file lookup", () => {
	assert.equal(
		buildWorkerPromptArgument({ workerPrompt: "Implement the bounded task." }),
		"Implement the bounded task.",
	);
	assert.throws(() => buildWorkerPromptArgument({ workerPrompt: "  " }), /non-empty string/);
});

test("V2 metadata defaults and validation", () => {
	assert.equal(SUMMARY_SCHEMA_VERSION, 2);
	assert.equal(DELEGATE_VERSION, "2.0.0");
	assert.deepEqual(normalizeRunMetadata({ autonomous: false, requireChange: false }), {
		taskId: null,
		workPackageId: null,
		taskType: "investigation",
		delegationMode: "investigate",
	});
	assert.deepEqual(normalizeRunMetadata({
		autonomous: true,
		requireChange: true,
		taskId: "T053",
		workPackageId: "wp.transport-1",
		taskType: "implementation",
		delegationMode: "implement",
	}), {
		taskId: "T053",
		workPackageId: "wp.transport-1",
		taskType: "implementation",
		delegationMode: "implement",
	});
	assert.throws(() => normalizeRunMetadata({ delegationMode: "implement", autonomous: false }), /requires/);
	assert.throws(() => normalizeRunMetadata({ delegationMode: "investigate", requireChange: true }), /incompatible/);
	assert.throws(() => normalizeRunMetadata({ taskId: "../bad" }), /must match/);
	assert.throws(() => normalizeRunMetadata({ taskType: "unknown" }), /must be one of/);
});

test("UTF-8 byte splitting preserves Unicode code points and limits", () => {
	const value = "abc Привет 世界 😀 xyz";
	const parts = splitUtf8ByBytes(value, 8);
	assert.equal(parts.join(""), value);
	for (const part of parts) assert.ok(Buffer.byteLength(part, "utf8") <= 8);
	assert.deepEqual(splitUtf8ByBytes("😀😀", 4), ["😀", "😀"]);
	assert.throws(() => splitUtf8ByBytes("😀", 3), /smaller than one Unicode code point/);
});

test("NUL-delimited porcelain parsing preserves exact paths and renames", () => {
	assert.deepEqual(
		parsePorcelainV1Z(" M plain.txt\0?? spaced name.txt\0R  renamed.txt\0old.txt\0?? Юникод.txt\0"),
		["plain.txt", "spaced name.txt", "renamed.txt", "old.txt", "Юникод.txt"],
	);
});

test("protocol lifecycle requires complete balanced evidence", () => {
	const state = createProtocolState();
	for (const event of [
		{ type: "session", version: 3 },
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "tool_execution_start", toolCallId: "call-1" },
		{ type: "tool_execution_end", toolCallId: "call-1" },
		{ type: "turn_end" },
		{ type: "agent_end" },
	]) recordProtocolEvent(state, event);
	assert.deepEqual(evaluateProtocol(state), {
		complete: true,
		sessionCount: 1,
		sessionVersion: 3,
		agentStartCount: 1,
		agentEndCount: 1,
		turnStartCount: 1,
		turnEndCount: 1,
		openTurnCount: 0,
		openToolCallCount: 0,
		duplicateToolStarts: 0,
		unmatchedToolEnds: 0,
		malformedLines: 0,
	});
	recordProtocolParseError(state);
	assert.equal(evaluateProtocol(state).complete, false);
});

test("protocol detects missing terminal and unmatched tools", () => {
	const state = createProtocolState();
	recordProtocolEvent(state, { type: "session", version: 3 });
	recordProtocolEvent(state, { type: "agent_start" });
	recordProtocolEvent(state, { type: "tool_execution_end", toolCallId: "missing" });
	const result = evaluateProtocol(state);
	assert.equal(result.complete, false);
	assert.equal(result.agentEndCount, 0);
	assert.equal(result.unmatchedToolEnds, 1);
});

test("Linux process stat treats zombies as terminated", () => {
	assert.equal(isLinuxProcessRunningFromStat("123 (bash) S 1 2 3"), true);
	assert.equal(isLinuxProcessRunningFromStat("123 (prime agent) R 1 2 3"), true);
	assert.equal(isLinuxProcessRunningFromStat("123 (bash) Z 1 2 3"), false);
	assert.equal(isLinuxProcessRunningFromStat("123 (bash) X 1 2 3"), false);
	assert.equal(isLinuxProcessRunningFromStat(""), false);
});

test("captured WSL output decodes UTF-8 and UTF-16LE", () => {
	assert.equal(decodeCapturedOutput(Buffer.from("0.7.4\n", "utf8")), "0.7.4\n");
	assert.equal(decodeCapturedOutput(Buffer.from("\uFEFF0.7.4\r\n", "utf16le")), "0.7.4\r\n");
	assert.equal(decodeCapturedOutput("plain"), "plain");
});

test("healthy startup decision: live pid, fresh heartbeat, exit 0", () => {
	const health = baseHealth();
	const result = evaluateHealthStatus(health, { now: NOW + 1000, isProcessAlive: aliveOnly });
	assert.equal(result.healthy, true);
	assert.equal(result.active, true);
	assert.equal(result.stale, false);
	assert.equal(result.reason, "healthy");
	assert.equal(result.exitCode, 0);
	assert.equal(result.status, STATUS.STARTING);
	assert.equal(result.thresholdMs, 90000);
});

test("healthy running decision: events keep heartbeat fresh", () => {
	let health = baseHealth();
	health = recordValidEvent(health, { now: NOW + 1000 });
	const result = evaluateHealthStatus(health, { now: NOW + 2000, isProcessAlive: aliveOnly });
	assert.equal(result.healthy, true);
	assert.equal(result.active, true);
	assert.equal(result.reason, "healthy");
	assert.equal(result.thresholdMs, 300000);
});

test("startup timeout: classification, restart allowed, status eval stale", () => {
	const cls = classifyChildExit({ watchdogCondition: FAILURE_KIND.STARTUP_TIMEOUT });
	assert.equal(cls.kind, FAILURE_KIND.STARTUP_TIMEOUT);
	assert.equal(isInfraFailure(cls.kind), true);
	const decision = decideRestart(restartArgs({ kind: cls.kind }));
	assert.deepEqual(decision, { restart: true, reason: FAILURE_KIND.STARTUP_TIMEOUT });

	// Health view: no event yet and startup grace elapsed -> stale/unhealthy.
	const health = baseHealth({ attemptStartedAt: new Date(NOW - 100000).toISOString() });
	const result = evaluateHealthStatus(health, { now: NOW, isProcessAlive: aliveOnly });
	assert.equal(result.stale, true);
	assert.equal(result.healthy, false);
	assert.equal(result.reason, "stale_heartbeat");
	assert.equal(result.exitCode, 1);
});

test("idle timeout: classification, restart allowed, status eval stale", () => {
	const cls = classifyChildExit({ watchdogCondition: FAILURE_KIND.IDLE_TIMEOUT });
	assert.equal(cls.kind, FAILURE_KIND.IDLE_TIMEOUT);
	assert.equal(isInfraFailure(cls.kind), true);
	const decision = decideRestart(restartArgs({ kind: cls.kind }));
	assert.deepEqual(decision, { restart: true, reason: FAILURE_KIND.IDLE_TIMEOUT });

	// Health view: running but last event older than idle timeout -> stale.
	let health = baseHealth();
	health = recordValidEvent(health, { now: NOW - 400000 });
	const result = evaluateHealthStatus(health, { now: NOW, isProcessAlive: aliveOnly });
	assert.equal(result.stale, true);
	assert.equal(result.healthy, false);
	assert.equal(result.reason, "stale_heartbeat");
});

test("changed worktree blocks restart -> unresponsive_with_changes", () => {
	const decision = decideRestart(restartArgs({ worktreeMatchesBaseline: false }));
	assert.deepEqual(decision, { restart: false, reason: "worktree_changed" });
	const terminal = terminalStatusFor({ kind: FAILURE_KIND.STARTUP_TIMEOUT, restartDecision: decision });
	assert.equal(terminal, STATUS.UNRESPONSIVE_WITH_CHANGES);
	assert.equal(isTerminal(terminal), true);
});

test("restart budget exhaustion -> restart_exhausted", () => {
	const decision = decideRestart(restartArgs({ restartCount: 1, maxInfraRestarts: 1 }));
	assert.deepEqual(decision, { restart: false, reason: "restart_budget_exhausted" });
	const terminal = terminalStatusFor({ kind: FAILURE_KIND.IDLE_TIMEOUT, restartDecision: decision });
	assert.equal(terminal, STATUS.RESTART_EXHAUSTED);
});

test("overall deadline exhaustion blocks restart -> restart_exhausted", () => {
	const decision = decideRestart(restartArgs({ now: FUTURE - 1000, overallDeadlineMs: FUTURE }));
	assert.equal(decision.restart, false);
	assert.equal(decision.reason, "overall_deadline_exhausted");
	const terminal = terminalStatusFor({ kind: FAILURE_KIND.EXIT_BEFORE_FIRST_EVENT, restartDecision: decision });
	assert.equal(terminal, STATUS.RESTART_EXHAUSTED);

	// Enough room left: restart still allowed right up to the boundary.
	const allowed = decideRestart(restartArgs({ kind: FAILURE_KIND.EXIT_BEFORE_FIRST_EVENT, now: FUTURE - 95000, overallDeadlineMs: FUTURE }));
	assert.deepEqual(allowed, { restart: true, reason: FAILURE_KIND.EXIT_BEFORE_FIRST_EVENT });
});

test("maxInfraRestarts=0 never restarts", () => {
	const decision = decideRestart(restartArgs({ maxInfraRestarts: 0 }));
	assert.deepEqual(decision, { restart: false, reason: "restart_budget_exhausted" });
});

test("nonzero exit after valid event (gate/code failure) does not restart", () => {
	const cls = classifyChildExit({ exitCode: 3, attemptEventCount: 5 });
	assert.equal(cls.kind, "failed");
	assert.equal(cls.reason, "nonzero_exit_after_event");
	assert.equal(cls.terminalStatus, STATUS.FAILED);
	const decision = decideRestart(restartArgs({ kind: cls.kind }));
	assert.deepEqual(decision, { restart: false, reason: "failed_not_restartable" });
	assert.equal(terminalStatusFor({ kind: cls.kind, restartDecision: decision }), STATUS.FAILED);
});

test("Prime autonomous failures have precise terminal reasons", () => {
	const cases = [
		["Autonomous run stopped before terminal evidence; maxTurns reached (36/12)", "max_turns_exhausted"],
		["maxTokens reached (80000/80000)", "max_tokens_exhausted"],
		["maxContinuations reached (3/3)", "max_continuations_exhausted"],
		["timeoutMs reached (300000/300000)", "prime_timeout"],
		["Autonomous quality gate still failing after attempt 3/3", "gate_failed"],
	];
	for (const [stderrPreview, reason] of cases) {
		assert.equal(primeFailureReason(stderrPreview), reason);
		const cls = classifyChildExit({ exitCode: 1, attemptEventCount: 1, stderrPreview });
		assert.equal(cls.reason, reason);
		assert.equal(cls.terminalStatus, STATUS.FAILED);
	}
	assert.equal(primeFailureReason("ordinary process error"), null);
});

test("provider failures are classified deterministically", () => {
	for (const [stderrPreview, reason] of [
		["HTTP 429 rate limit exceeded", "provider_rate_limited"],
		["503 Service Unavailable", "provider_unavailable"],
		["request failed: ECONNRESET", "provider_network_error"],
	]) {
		const cls = classifyChildExit({ exitCode: 1, attemptEventCount: 1, stderrPreview });
		assert.equal(cls.reason, reason);
		assert.equal(cls.failureClass, "provider");
		assert.equal(cls.failureOwner, "provider");
	}
});

test("invalid task contract has task_spec ownership", () => {
	const cls = classifyChildExit({
		exitCode: 1,
		attemptEventCount: 1,
		stderrPreview: "Invalid task contract",
	});
	assert.equal(cls.reason, "task_contract_invalid");
	assert.equal(cls.failureClass, "contract");
	assert.equal(cls.failureOwner, "task_spec");
});

test("exit zero requires complete protocol evidence", () => {
	const cls = classifyChildExit({ exitCode: 0, attemptEventCount: 3, protocolComplete: false });
	assert.equal(cls.kind, "failed");
	assert.equal(cls.reason, "protocol_incomplete");
	assert.equal(cls.terminalStatus, STATUS.FAILED);
	assert.equal(cls.failureClass, "protocol");
	assert.equal(cls.failureOwner, "prime_agent");
});

test("normal exit does not restart", () => {
	const cls = classifyChildExit({ exitCode: 0 });
	assert.equal(cls.kind, "completed");
	assert.equal(cls.terminalStatus, STATUS.COMPLETED);
	const decision = decideRestart(restartArgs({ kind: cls.kind }));
	assert.deepEqual(decision, { restart: false, reason: "completed_not_restartable" });
});

test("overall timeout does not restart", () => {
	const cls = classifyChildExit({ timedOut: true, exitCode: null });
	assert.equal(cls.kind, "timed_out");
	assert.equal(cls.terminalStatus, STATUS.TIMED_OUT);
	const decision = decideRestart(restartArgs({ kind: cls.kind }));
	assert.deepEqual(decision, { restart: false, reason: "timed_out_not_restartable" });
});

test("known config/argument/spawn errors do not restart", () => {
	const withStderr = classifyChildExit({ exitCode: 2, attemptEventCount: 0, stderrPreview: "Unknown argument: --bad" });
	assert.equal(withStderr.kind, "config_error");
	assert.equal(isKnownConfigurationError("Missing value for --cwd"), true);
	assert.equal(isKnownConfigurationError("listen ENOTSUP: operation not supported on socket /mnt/c/tmp/daemon.sock"), true);
	assert.equal(isKnownConfigurationError("temporary transport failure"), false);
	const spawnFail = classifyChildExit({ spawnFailed: true });
	assert.equal(spawnFail.kind, "config_error");
	for (const cls of [withStderr, spawnFail]) {
		const decision = decideRestart(restartArgs({ kind: cls.kind }));
		assert.equal(decision.restart, false);
		assert.equal(terminalStatusFor({ kind: cls.kind, restartDecision: decision }), STATUS.FAILED);
	}
});

test("silent or generic stderr exit before first event is restartable", () => {
	for (const stderrPreview of ["", "temporary transport failure"]) {
		const cls = classifyChildExit({ exitCode: 1, attemptEventCount: 0, stderrPreview });
		assert.equal(cls.kind, FAILURE_KIND.EXIT_BEFORE_FIRST_EVENT);
		assert.deepEqual(decideRestart(restartArgs({ kind: cls.kind })), { restart: true, reason: FAILURE_KIND.EXIT_BEFORE_FIRST_EVENT });
	}
});

test("terminated by signal is a failed attempt, not restartable", () => {
	const cls = classifyChildExit({ exitCode: null, signal: "SIGTERM", attemptEventCount: 2 });
	assert.equal(cls.kind, "failed");
	assert.equal(cls.reason, "terminated_by_signal_SIGTERM");
});

test("terminal health/status evaluation", () => {
	const cases = [
		{ status: STATUS.COMPLETED, healthy: true, active: false, reason: "terminal_completed", exitCode: 0 },
		{ status: STATUS.FAILED, healthy: false, active: false, reason: "terminal_failed", exitCode: 1 },
		{ status: STATUS.TIMED_OUT, healthy: false, active: false, reason: "terminal_timed_out", exitCode: 1 },
		{ status: STATUS.UNRESPONSIVE_WITH_CHANGES, healthy: false, active: false, reason: "terminal_unresponsive_with_changes", exitCode: 1 },
		{ status: STATUS.RESTART_EXHAUSTED, healthy: false, active: false, reason: "terminal_restart_exhausted", exitCode: 1 },
	];
	for (const c of cases) {
		const health = baseHealth({ status: c.status });
		const result = evaluateHealthStatus(health, { now: NOW, isProcessAlive: aliveOnly });
		assert.equal(result.healthy, c.healthy, `${c.status} healthy`);
		assert.equal(result.active, c.active, `${c.status} active`);
		assert.equal(result.reason, c.reason, `${c.status} reason`);
		assert.equal(result.exitCode, c.exitCode, `${c.status} exit`);
		assert.equal(result.stale, false, `${c.status} not stale`);
	}
});

test("restarting is healthy during restart window and stale afterwards", () => {
	let health = baseHealth();
	health = recordRestarting(health, { reason: "restart_after_startup_timeout", restartCount: 1, now: NOW });
	const fresh = evaluateHealthStatus(health, { now: NOW + 1000, isProcessAlive: dead });
	assert.equal(fresh.healthy, true);
	assert.equal(fresh.active, true);
	assert.equal(fresh.reason, "restarting");
	assert.equal(fresh.thresholdMs, 95000);
	const stale = evaluateHealthStatus(health, { now: NOW + 95001, isProcessAlive: dead });
	assert.equal(stale.healthy, false);
	assert.equal(stale.active, false);
	assert.equal(stale.reason, "stale_restart");
});

test("active attempt with dead PID is unhealthy", () => {
	let health = baseHealth();
	health = recordValidEvent(health, { now: NOW });
	const result = evaluateHealthStatus(health, { now: NOW + 1000, isProcessAlive: dead });
	assert.equal(result.active, false);
	assert.equal(result.healthy, false);
	assert.equal(result.reason, "child_pid_not_alive");
	assert.equal(result.exitCode, 1);
});

test("active status with missing PID is unhealthy", () => {
	const health = baseHealth({ childPid: null });
	const result = evaluateHealthStatus(health, { now: NOW, isProcessAlive: aliveOnly });
	assert.equal(result.active, false);
	assert.equal(result.healthy, false);
	assert.equal(result.reason, "missing_child_pid");
	assert.equal(result.exitCode, 1);
});

test("missing health.json evaluates unhealthy", () => {
	const result = evaluateHealthStatus(null, { now: NOW, isProcessAlive: aliveOnly });
	assert.equal(result.healthy, false);
	assert.equal(result.reason, "missing_health");
	assert.equal(result.exitCode, 1);
});

test("recordRestarting / recordTerminal transitions", () => {
	let health = baseHealth();
	health = recordRestarting(health, { reason: "restart_after_startup_timeout", restartCount: 1, now: NOW + 10 });
	assert.equal(health.status, STATUS.RESTARTING);
	assert.equal(health.healthy, true);
	assert.equal(health.active, true);
	assert.equal(health.restartCount, 1);
	assert.equal(health.childPid, null);
	assert.equal(health.lastReason, "restart_after_startup_timeout");
	health = recordTerminal(health, { status: STATUS.RESTART_EXHAUSTED, reason: "restart_budget_exhausted", now: NOW + 20 });
	assert.equal(health.status, STATUS.RESTART_EXHAUSTED);
	assert.equal(health.healthy, false);
	assert.equal(health.active, false);
	assert.equal(health.childPid, null);
	assert.equal(health.lastReason, "restart_budget_exhausted");
	assert.equal(health.updatedAt, new Date(NOW + 20).toISOString());
});

test("integer option boundaries", () => {
	assert.equal(parseIntegerOption("90000", { min: 1, name: "--startup-grace-ms" }), 90000);
	assert.equal(parseIntegerOption("300000", { min: 1, name: "--idle-timeout-ms" }), 300000);
	assert.equal(parseIntegerOption("0", { min: 0, max: 3, name: "--max-infra-restarts" }), 0);
	assert.equal(parseIntegerOption("3", { min: 0, max: 3, name: "--max-infra-restarts" }), 3);
	assert.equal(parseIntegerOption("1", { min: 0, max: 3, name: "--max-infra-restarts" }), 1);
	assert.equal(parseIntegerOption("0", { min: 0, name: "--restart-delay-ms" }), 0);
	assert.equal(parseIntegerOption("5000", { min: 0, name: "--restart-delay-ms" }), 5000);
	assert.throws(() => parseIntegerOption("0", { min: 1, name: "--startup-grace-ms" }), RangeError);
	assert.throws(() => parseIntegerOption("4", { min: 0, max: 3, name: "--max-infra-restarts" }), RangeError);
	assert.throws(() => parseIntegerOption("-1", { min: 0, name: "--restart-delay-ms" }), RangeError);
	assert.throws(() => parseIntegerOption("1.5", { min: 1, name: "--startup-grace-ms" }), RangeError);
	assert.throws(() => parseIntegerOption("abc", { min: 1, name: "--startup-grace-ms" }), RangeError);
	assert.throws(() => parseIntegerOption("", { min: 1, name: "--startup-grace-ms" }), RangeError);
	assert.throws(() => parseIntegerOption(null, { min: 1, name: "--startup-grace-ms" }), RangeError);
	assert.throws(() => parseIntegerOption(undefined, { min: 1, name: "--startup-grace-ms" }), RangeError);
	assert.throws(() => parseIntegerOption(NaN, { min: 1, name: "--startup-grace-ms" }), RangeError);
});

test("atomic health JSON write/read round trip and failure modes", () => {
	const dir = mkdtempSync(join(tmpdir(), "delegate-watchdog-test-"));
	const healthPath = join(dir, "health.json");
	try {
		const first = baseHealth();
		atomicWriteJson(healthPath, first);
		assert.deepEqual(readHealth(healthPath), first);
		// Overwrite atomically with a terminal snapshot.
		const terminal = recordTerminal(first, { status: STATUS.COMPLETED, reason: "normal_exit", now: NOW + 100 });
		atomicWriteJson(healthPath, terminal);
		assert.deepEqual(readHealth(healthPath), terminal);
		// No leftover temp files.
		const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp-"));
		assert.deepEqual(leftovers, []);
		// Missing file and invalid JSON both read as null.
		assert.equal(readHealth(join(dir, "nope.json")), null);
		writeFileSync(healthPath, "{ not json", "utf8");
		assert.equal(readHealth(healthPath), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("health helpers: isTerminal / isInfraFailure", () => {
	assert.equal(isTerminal(STATUS.COMPLETED), true);
	assert.equal(isTerminal(STATUS.RUNNING), false);
	assert.equal(isTerminal(STATUS.STARTING), false);
	assert.equal(isTerminal(STATUS.RESTARTING), false);
	assert.equal(isInfraFailure(FAILURE_KIND.STARTUP_TIMEOUT), true);
	assert.equal(isInfraFailure(FAILURE_KIND.IDLE_TIMEOUT), true);
	assert.equal(isInfraFailure(FAILURE_KIND.EXIT_BEFORE_FIRST_EVENT), true);
	assert.equal(isInfraFailure("failed"), false);
});
