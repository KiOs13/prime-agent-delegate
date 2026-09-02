#!/usr/bin/env node

import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { sanitize, sanitizeString } from "./sanitize.mjs";

const MAX_ITEMS = 40;

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

const WRITE_TOOLS = new Set([
	"write",
	"edit",
	"multi_edit",
	"apply_patch",
	"str_replace_editor",
	"str_replace_based_edit_tool",
	"create_file",
	"write_file",
]);

function classifyToolCall(toolName, args) {
	const name = String(toolName || "").toLowerCase();
	if (WRITE_TOOLS.has(name)) return "write";
	const keys = args && typeof args === "object" ? Object.keys(args) : [];
	if (keys.includes("edits") || keys.includes("new_string") || keys.includes("file_text")) return "write";
	const pythonWrites = /open\([^)]*,\s*['"][wax][+bt]*['"]|write(FileSync|_text|_bytes)|\btee\b/i;
	if (name === "ipython" && typeof args?.code === "string" && pythonWrites.test(args.code)) return "write";
	if (name === "bash" && typeof args?.command === "string") {
		const command = args.command.replace(/\b\d*>\s*\/dev\/null\b|\b\d*>&\d\b/g, "");
		const writes = /(>>|[^|>]>[^>])\s*\S|\bsed\s+(-[^\n]*\s)?-i\b|\btee\b/i.test(command) || pythonWrites.test(command);
		if (writes) return "write";
		return "read";
	}
	return "read";
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
let writeToolCalls = 0;
let readToolCalls = 0;
let editToolCalls = 0;
let firstEditToolCallIndex = null;
let firstEditToolName = null;
let firstEditToolArgsPreview = null;
let toolCallIndex = 0;
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
			toolCallIndex++;
			const classification = classifyToolCall(event.toolName, event.args);
			if (classification === "write") {
				writeToolCalls++;
				if (event.toolName !== "ipython" && event.toolName !== "bash") editToolCalls++;
				if (firstEditToolCallIndex === null) {
					firstEditToolCallIndex = toolCallIndex;
					firstEditToolName = event.toolName;
					firstEditToolArgsPreview = compact(event.args, 300);
				}
			} else {
				readToolCalls++;
			}
			const args = compact(event.args, 500);
			pushLimited(toolInvocations, { tool: event.toolName, args, kind: classification });
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
const totalToolCalls = Object.values(tools).reduce((acc, t) => acc + (t.started || 0), 0);
const failedToolCalls = Object.values(tools).reduce((acc, t) => acc + (t.failed || 0), 0);

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
		totalToolCalls,
		failedToolCalls,
		readToolCalls,
		writeToolCalls,
		editToolCalls,
		toolCallsBeforeFirstEdit: firstEditToolCallIndex === null ? totalToolCalls : firstEditToolCallIndex - 1,
		firstEditToolCallIndex,
		firstEditToolName,
		firstEditToolArgsPreview,
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
		"Check run.toolCallsBeforeFirstEdit and run.writeToolCalls against the reading budget: pre-edit exploration should stay within the worker prompt rules.",
		"Independently inspect git diff and rerun required acceptance checks.",
		"Use targeted streaming filters on events.jsonl only when this summary shows a discrepancy.",
	],
};

writeFileSync(options.output, `${JSON.stringify(sanitize(audit), null, 2)}\n`, "utf8");
