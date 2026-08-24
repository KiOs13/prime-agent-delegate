#!/usr/bin/env node

import { createHash } from "node:crypto";
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
function makeChange() {
	if (scenario === "no-change") return;
	if (!(args.includes("--autonomous") || process.env.PRIME_AGENT_DELEGATE_FAKE_FORCE_CHANGE === "1") || !cwd || !existsSync(cwd)) return;
	writeFileSync(
		join(cwd, process.env.PRIME_AGENT_DELEGATE_FAKE_CHANGE ?? "fake-prime-output.txt"),
		"created by fake Prime\n",
		"utf8",
	);
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const normal = [
	{ type: "session", version: 3 },
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

function emitScenario({ includeSession = true } = {}) {
	const lifecycle = includeSession ? normal : normal.slice(1);
	if (scenario === "no-events") return;
	if (scenario === "provider-429" || scenario === "provider-503") {
		for (const event of lifecycle.slice(0, includeSession ? 2 : 1)) emit(event);
		process.stderr.write(scenario === "provider-429" ? "HTTP 429 rate limit exceeded\n" : "HTTP 503 Service Unavailable\n");
		process.exitCode = 1;
		return;
	}
	if (scenario === "task-spec") {
		for (const event of lifecycle.slice(0, includeSession ? 2 : 1)) emit(event);
		process.stderr.write("Invalid task contract\n");
		process.exitCode = 1;
		return;
	}
	if (scenario === "malformed") {
		for (const event of lifecycle) emit(event);
		process.stdout.write("{malformed\n");
		return;
	}
	if (scenario === "missing-agent-end") {
		for (const event of lifecycle.slice(0, -1)) emit(event);
		return;
	}
	if (scenario === "unmatched-tool") {
		for (const event of lifecycle) emit(event);
		emit({ type: "tool_execution_end", toolCallId: "missing" });
		return;
	}
	if (scenario === "repeated-tool-failure") {
		for (const event of lifecycle.slice(0, includeSession ? 3 : 2)) emit(event);
		for (let index = 1; index <= 12; index++) {
			const toolCallId = `failed-tool-${index}`;
			emit({ type: "tool_execution_start", toolCallId, toolName: "ipython" });
			emit({
				type: "tool_execution_end",
				toolCallId,
				toolName: "ipython",
				result: { content: [{ type: "text", text: "Kernel has been shut down" }], details: { durationMs: index } },
				isError: true,
			});
		}
		return;
	}
	for (const event of lifecycle) emit(event);
}

if (args[args.indexOf("--mode") + 1] === "rpc") {
	let input = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		input += chunk;
		let newline = input.indexOf("\n");
		while (newline !== -1) {
			const line = input.slice(0, newline).replace(/\r$/, "");
			input = input.slice(newline + 1);
			if (line) {
				if (scenario === "rpc-malformed-handshake") {
					process.stdout.write("{malformed\n");
					continue;
				}
				const command = JSON.parse(line);
				if (command.type === "get_state") {
					emit(scenario === "rpc-reject-handshake"
						? { id: command.id, type: "response", command: "get_state", success: false, error: "rejected" }
						: { id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: "fake-rpc-session" } });
				} else if (command.type === "prompt") {
					const expected = process.env.PRIME_AGENT_DELEGATE_FAKE_EXPECT_PROMPT_SHA256;
					const actual = createHash("sha256").update(command.message, "utf8").digest("hex");
					if (expected && actual !== expected) {
						emit({ id: command.id, type: "response", command: "prompt", success: false, error: `prompt sha mismatch: ${actual}` });
						continue;
					}
					if (scenario === "rpc-reject-prompt") {
						emit({ id: command.id, type: "response", command: "prompt", success: false, error: "rejected" });
						continue;
					}
					makeChange();
					emit({ id: command.id, type: "response", command: "prompt", success: true });
					emitScenario({ includeSession: false });
				}
			}
			newline = input.indexOf("\n");
		}
	});
	process.stdin.resume();
} else {
	const prompt = args.at(-1) ?? "";
	if (prompt.includes("TASK MANIFEST:") && !prompt.startsWith("TASK MANIFEST:")) {
		process.stderr.write("TASK MANIFEST must be the first split-prompt instruction\n");
		process.exit(2);
	}
	makeChange();
	emitScenario();
}
