#!/usr/bin/env node

// scripts/test-summarize-events.mjs
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
const SUMMARIZE = join(SCRIPT_DIR, "summarize-events.mjs");

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
