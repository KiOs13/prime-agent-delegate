#!/usr/bin/env node

// tests/test-summarize-events.mjs
//
// Unit tests for summarize-events.mjs, covering tool call statistics
// (totalToolCalls, failedToolCalls) and basic event processing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const SUMMARIZE = join(SCRIPT_DIR, "..", "skill-source", "scripts", "summarize-events.mjs");

function writeEvents(path, events) {
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, lines, "utf8");
}

function runSummarize({ events, summary, stderr, output }) {
    return spawnSync(process.execPath, [
        SUMMARIZE,
        "--events", events,
        "--summary", summary,
        "--stderr", stderr,
        "--output", output,
    ], { encoding: "utf8" });
}

test("summarize-events computes totalToolCalls and failedToolCalls", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarize-events-"));
    try {
        const eventsPath = join(dir, "events.jsonl");
        const summaryPath = join(dir, "summary.json");
        const stderrPath = join(dir, "stderr.log");
        const outputPath = join(dir, "audit-summary.json");

        writeFileSync(summaryPath, JSON.stringify({
            runId: "test-1",
            status: "completed",
            exitCode: 0,
            startedAt: "2026-01-01T00:00:00Z",
            finishedAt: "2026-01-01T00:10:00Z",
            eventCount: 6,
            finalText: "done",
        }), "utf8");
        writeFileSync(stderrPath, "", "utf8");

        writeEvents(eventsPath, [
            { type: "session", version: 3 },
            { type: "agent_start" },
            { type: "turn_start" },
            { type: "tool_execution_start", toolName: "read", toolCallId: "tc1", args: { path: "a.ts" } },
            { type: "tool_execution_end", toolName: "read", toolCallId: "tc1", isError: false },
            { type: "tool_execution_start", toolName: "write", toolCallId: "tc2", args: { path: "b.ts" } },
            { type: "tool_execution_end", toolName: "write", toolCallId: "tc2", isError: true, result: "permission denied" },
            { type: "tool_execution_start", toolName: "read", toolCallId: "tc3", args: { path: "c.ts" } },
            { type: "tool_execution_end", toolName: "read", toolCallId: "tc3", isError: false },
            { type: "turn_end" },
            { type: "agent_end", messages: [] },
        ]);

        const result = runSummarize({ events: eventsPath, summary: summaryPath, stderr: stderrPath, output: outputPath });
        assert.equal(result.status, 0, `summarize-events failed: ${result.stderr}`);

        const audit = JSON.parse(readFileSync(outputPath, "utf8"));
        assert.equal(audit.run.totalToolCalls, 3, "totalToolCalls should count all tool starts");
        assert.equal(audit.run.failedToolCalls, 1, "failedToolCalls should count only failed tool ends");
        assert.equal(audit.tools.read.started, 2);
        assert.equal(audit.tools.read.failed, 0);
        assert.equal(audit.tools.write.started, 1);
        assert.equal(audit.tools.write.failed, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("summarize-events handles empty events gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarize-events-empty-"));
    try {
        const eventsPath = join(dir, "events.jsonl");
        const summaryPath = join(dir, "summary.json");
        const stderrPath = join(dir, "stderr.log");
        const outputPath = join(dir, "audit-summary.json");

        writeFileSync(eventsPath, "", "utf8");
        writeFileSync(stderrPath, "", "utf8");
        writeFileSync(summaryPath, JSON.stringify({
            runId: "test-2",
            status: "completed",
            exitCode: 0,
            startedAt: "2026-01-01T00:00:00Z",
            finishedAt: "2026-01-01T00:01:00Z",
            eventCount: 0,
            finalText: "",
        }), "utf8");

        const result = runSummarize({ events: eventsPath, summary: summaryPath, stderr: stderrPath, output: outputPath });
        assert.equal(result.status, 0, `summarize-events failed: ${result.stderr}`);

        const audit = JSON.parse(readFileSync(outputPath, "utf8"));
        assert.equal(audit.run.totalToolCalls, 0);
        assert.equal(audit.run.failedToolCalls, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("summarize-events classifies read/write tool calls and tracks first edit", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarize-events-kind-"));
    try {
        const eventsPath = join(dir, "events.jsonl");
        const summaryPath = join(dir, "summary.json");
        const stderrPath = join(dir, "stderr.log");
        const outputPath = join(dir, "audit-summary.json");

        writeFileSync(summaryPath, JSON.stringify({
            runId: "test-3",
            status: "completed",
            exitCode: 0,
            eventCount: 10,
            finalText: "done",
        }), "utf8");
        writeFileSync(stderrPath, "", "utf8");

        writeEvents(eventsPath, [
            { type: "tool_execution_start", toolName: "read", toolCallId: "t1", args: { path: "a.ts" } },
            { type: "tool_execution_end", toolName: "read", toolCallId: "t1", isError: false },
            { type: "tool_execution_start", toolName: "bash", toolCallId: "t2", args: { command: "sed -n '1,50p' main.php" } },
            { type: "tool_execution_end", toolName: "bash", toolCallId: "t2", isError: false },
            { type: "tool_execution_start", toolName: "bash", toolCallId: "t3", args: { command: "echo patched >> main.php" } },
            { type: "tool_execution_end", toolName: "bash", toolCallId: "t3", isError: false },
            { type: "tool_execution_start", toolName: "edit", toolCallId: "t4", args: { path: "main.php", new_string: "x" } },
            { type: "tool_execution_end", toolName: "edit", toolCallId: "t4", isError: false },
            { type: "tool_execution_start", toolName: "ipython", toolCallId: "t5", args: { code: "open('f.txt','w').write('x')" } },
            { type: "tool_execution_end", toolName: "ipython", toolCallId: "t5".replace("t5","t5"), isError: false },
        ]);

        const result = runSummarize({ events: eventsPath, summary: summaryPath, stderr: stderrPath, output: outputPath });
        assert.equal(result.status, 0, `summarize-events failed: ${result.stderr}`);

        const audit = JSON.parse(readFileSync(outputPath, "utf8"));
        assert.equal(audit.run.totalToolCalls, 5);
        assert.equal(audit.run.readToolCalls, 2);
        assert.equal(audit.run.writeToolCalls, 3, "bash echo-append and ipython open('w') count as writes");
        assert.equal(audit.run.editToolCalls, 1, "only dedicated edit tools count as edits");
        assert.equal(audit.run.firstEditToolCallIndex, 3, "first write overall is the bash append at call 3");
        assert.equal(audit.run.firstEditToolName, "bash");
        assert.equal(audit.run.toolCallsBeforeFirstEdit, 2);
        assert.equal(audit.toolInvocations[0].kind, "read");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("summarize-events reports toolCallsBeforeFirstEdit equal to total when no write happens", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarize-events-readonly-"));
    try {
        const eventsPath = join(dir, "events.jsonl");
        const summaryPath = join(dir, "summary.json");
        const stderrPath = join(dir, "stderr.log");
        const outputPath = join(dir, "audit-summary.json");

        writeFileSync(summaryPath, JSON.stringify({
            runId: "test-4",
            status: "failed",
            exitCode: 1,
            eventCount: 4,
            finalText: "",
        }), "utf8");
        writeFileSync(stderrPath, "", "utf8");

        writeEvents(eventsPath, [
            { type: "tool_execution_start", toolName: "read", toolCallId: "t1", args: { path: "a.ts" } },
            { type: "tool_execution_end", toolName: "read", toolCallId: "t1", isError: false },
            { type: "tool_execution_start", toolName: "grep", toolCallId: "t2", args: { pattern: "x", path: "b.ts" } },
            { type: "tool_execution_end", toolName: "grep", toolCallId: "t2", isError: false },
        ]);

        const result = runSummarize({ events: eventsPath, summary: summaryPath, stderr: stderrPath, output: outputPath });
        assert.equal(result.status, 0, `summarize-events failed: ${result.stderr}`);

        const audit = JSON.parse(readFileSync(outputPath, "utf8"));
        assert.equal(audit.run.totalToolCalls, 2);
        assert.equal(audit.run.readToolCalls, 2);
        assert.equal(audit.run.writeToolCalls, 0);
        assert.equal(audit.run.toolCallsBeforeFirstEdit, 2, "no edit means all calls are pre-edit");
        assert.equal(audit.run.firstEditToolCallIndex, null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("summarize-events avoids common false writes and detects Python writes in bash", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarize-events-shell-kind-"));
    try {
        const eventsPath = join(dir, "events.jsonl");
        const summaryPath = join(dir, "summary.json");
        const stderrPath = join(dir, "stderr.log");
        const outputPath = join(dir, "audit-summary.json");

        writeFileSync(summaryPath, JSON.stringify({ runId: "test-5", status: "completed", exitCode: 0 }), "utf8");
        writeFileSync(stderrPath, "", "utf8");
        writeEvents(eventsPath, [
            { type: "tool_execution_start", toolName: "read", args: { content: "not a write" } },
            { type: "tool_execution_start", toolName: "bash", args: { command: "rg needle . 2>/dev/null" } },
            { type: "tool_execution_start", toolName: "bash", args: { command: "python -c \"open('out.txt', 'w').write('x')\"" } },
        ]);

        const result = runSummarize({ events: eventsPath, summary: summaryPath, stderr: stderrPath, output: outputPath });
        assert.equal(result.status, 0, `summarize-events failed: ${result.stderr}`);
        const audit = JSON.parse(readFileSync(outputPath, "utf8"));
        assert.equal(audit.run.readToolCalls, 2);
        assert.equal(audit.run.writeToolCalls, 1);
        assert.equal(audit.run.firstEditToolCallIndex, 3);
        assert.equal(audit.run.toolCallsBeforeFirstEdit, 2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
