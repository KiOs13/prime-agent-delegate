#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
	process.stdout.write("prime-agent 0.8.0-test\n");
	process.exit(0);
}
if (args.includes("status") && args.includes("--json")) {
	process.stdout.write("[]\n");
	process.exit(0);
}

const scenario = process.env.PRIME_AGENT_DELEGATE_FAKE_SCENARIO ?? "normal";
const cwdIndex = args.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : null;
if ((args.includes("--autonomous") || process.env.PRIME_AGENT_DELEGATE_FAKE_FORCE_CHANGE === "1") && cwd && existsSync(cwd)) {
	writeFileSync(
		join(cwd, process.env.PRIME_AGENT_DELEGATE_FAKE_CHANGE ?? "fake-prime-output.txt"),
		"created by fake Prime\n",
		"utf8",
	);
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const normal = [
	{ type: "session", version: 1 },
	{ type: "agent_start" },
	{ type: "turn_start" },
	{ type: "message_start" },
	{ type: "message_update", delta: "streamed-secret-token" },
	{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "complete message" }] } },
	{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } },
	{ type: "tool_execution_update", toolCallId: "tool-1", delta: "partial result" },
	{ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: { content: "complete tool result" } },
	{ type: "turn_end" },
	{ type: "agent_end", messages: [] },
];

if (scenario === "no-events") process.exit(0);
if (scenario === "provider-429" || scenario === "provider-503") {
	emit({ type: "session", version: 1 });
	emit({ type: "agent_start" });
	process.stderr.write(scenario === "provider-429" ? "HTTP 429 rate limit exceeded\n" : "HTTP 503 Service Unavailable\n");
	process.exit(1);
}
if (scenario === "task-spec") {
	emit({ type: "session", version: 1 });
	emit({ type: "agent_start" });
	process.stderr.write("Invalid task contract\n");
	process.exit(1);
}
if (scenario === "malformed") {
	for (const event of normal) emit(event);
	process.stdout.write("{malformed\n");
	process.exit(0);
}
if (scenario === "missing-agent-end") {
	for (const event of normal.slice(0, -1)) emit(event);
	process.exit(0);
}
if (scenario === "unmatched-tool") {
	for (const event of normal) emit(event);
	emit({ type: "tool_execution_end", toolCallId: "missing" });
	process.exit(0);
}
for (const event of normal) emit(event);
