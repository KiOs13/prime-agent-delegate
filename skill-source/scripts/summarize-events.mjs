#!/usr/bin/env node

import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { sanitize, sanitizeString } from "./sanitize.mjs";

const MAX_ITEMS = 40;

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!["--events", "--summary", "--stderr", "--output"].includes(arg)) fail(`Unknown argument: ${arg}`);
		const value = argv[++i];
		if (!value) fail(`Missing value for ${arg}`);
		options[arg.slice(2)] = value;
	}
	for (const name of ["events", "summary", "stderr", "output"]) {
		if (!options[name]) fail(`Missing --${name}`);
	}
	return options;
}

function compact(value, limit = 1200) {
	let text;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	text = sanitizeString(text).replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function increment(target, key) {
	const normalized = String(key || "unknown");
	target[normalized] = (target[normalized] || 0) + 1;
}

function pushLimited(target, value) {
	if (target.length < MAX_ITEMS) target.push(value);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { readError: error.message };
	}
}

function stderrTail(path) {
	try {
		const text = readFileSync(path, "utf8");
		return compact(text.slice(-16 * 1024), 4000);
	} catch (error) {
		return `unavailable: ${error.message}`;
	}
}

const options = parseArgs(process.argv.slice(2));
const run = readJson(options.summary);
const eventTypes = {};
const tools = {};
const models = {};
const failures = [];
const toolInvocations = [];
const invocationCounts = new Map();
let lineCount = 0;
let parseErrors = 0;

const lines = createInterface({ input: createReadStream(options.events, { encoding: "utf8" }), crlfDelay: Infinity });
for await (const line of lines) {
	if (!line.trim()) continue;
	lineCount++;
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		parseErrors++;
		continue;
	}
	increment(eventTypes, event.type);
	if (event.toolName) {
		const tool = tools[event.toolName] ||= { started: 0, completed: 0, failed: 0 };
		if (event.type === "tool_execution_start") {
			tool.started++;
			const args = compact(event.args, 500);
			pushLimited(toolInvocations, { tool: event.toolName, args });
			const key = `${event.toolName}\0${args}`;
			invocationCounts.set(key, (invocationCounts.get(key) || 0) + 1);
		}
		if (event.type === "tool_execution_end") {
			tool.completed++;
			if (event.isError) tool.failed++;
		}
	}
	for (const candidate of [event, event.message].filter(Boolean)) {
		const provider = candidate.provider || candidate.api;
		const model = candidate.model || candidate.responseModel;
		if (provider || model) increment(models, `${provider || "unknown"}/${model || "unknown"}`);
	}
	const failed = event.isError === true || ["failed", "timed_out", "error"].includes(String(event.status || "").toLowerCase()) || /error|fail/i.test(String(event.type || ""));
	if (failed) pushLimited(failures, { type: event.type || "unknown", tool: event.toolName || undefined, detail: compact(event.result || event.error || event.message || event, 700) });
}

const repeatedToolInvocations = [...invocationCounts.entries()]
	.filter(([, count]) => count > 1)
	.map(([key, count]) => {
		const [tool, args] = key.split("\0", 2);
		return { tool, args, count };
	})
	.sort((left, right) => right.count - left.count)
	.slice(0, MAX_ITEMS);
const turnsUsed = eventTypes.turn_end ?? eventTypes.turn_start ?? 0;
const configuredMaxTurns = Number(run.autonomousMaxTurns) || null;

const audit = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	run: {
		status: run.status,
		exitCode: run.exitCode,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		eventCaptureMode: run.eventCaptureMode || "legacy-full",
		eventCount: run.eventCount,
		persistedEventCount: run.persistedEventCount ?? lineCount,
		droppedStreamingEventCount: run.droppedStreamingEventCount ?? 0,
		turnsUsed,
		configuredMaxTurns,
		turnLimitOvershoot: configuredMaxTurns === null ? 0 : Math.max(0, turnsUsed - configuredMaxTurns),
		completionGateConfigured: (Number(run.autonomousGateCount) || 0) > 0,
		terminalAssistantMessagePresent: Boolean(run.finalText),
		finalText: compact(run.finalText, 2000),
	},
	source: {
		eventsPath: options.events,
		bytes: statSync(options.events).size,
		lineCount,
		parseErrors: parseErrors + (Number(run.parseErrors) || 0),
	},
	eventTypes,
	models,
	tools,
	toolInvocations,
	repeatedToolInvocations,
	failures,
	stderrTail: stderrTail(options.stderr),
	reviewGuidance: [
		"Review this file and summary.json first; do not load events.jsonl into model context by default.",
		"Independently inspect git diff and rerun required acceptance checks.",
		"Use targeted streaming filters on events.jsonl only when this summary shows a discrepancy.",
	],
};

writeFileSync(options.output, `${JSON.stringify(sanitize(audit), null, 2)}\n`, "utf8");
