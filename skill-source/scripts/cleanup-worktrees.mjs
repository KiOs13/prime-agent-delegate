#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WORKTREES_ROOT = process.env.PRIME_DELEGATE_WORKTREES_ROOT
	? resolve(process.env.PRIME_DELEGATE_WORKTREES_ROOT)
	: "C:\\Project-Prime\\worktrees";
const DEFAULT_MIN_AGE_HOURS = 168;
const MARKER_NAME = ".prime-task-complete.json";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const options = { apply: false, deleteBranches: false, minAgeHours: DEFAULT_MIN_AGE_HOURS, project: null };
	const valueArgs = new Set(["--project", "--min-age-hours"]);
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--apply") options.apply = true;
		else if (arg === "--delete-branches") options.deleteBranches = true;
		else if (valueArgs.has(arg)) {
			const value = argv[++index];
			if (!value) fail(`Missing value for ${arg}`);
			if (arg === "--project") options.project = value;
			else options.minAgeHours = Number(value);
		} else fail(`Unknown argument: ${arg}`);
	}
	if (!Number.isFinite(options.minAgeHours) || options.minAgeHours < 0) fail("--min-age-hours must be a number >= 0");
	return options;
}

function git(args, cwd) {
	return spawnSync("git", cwd ? ["-C", cwd, ...args] : args, { encoding: "utf8", windowsHide: true });
}

function normalizePath(value) {
	return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function listWorktrees(root, projectFilter) {
	if (!existsSync(root)) return [];
	const results = [];
	for (const project of readdirSync(root, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		if (projectFilter && project.name !== projectFilter) continue;
		const projectPath = join(root, project.name);
		for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const worktreePath = join(projectPath, entry.name);
			if (!existsSync(join(worktreePath, ".git"))) continue;
			results.push({ project: project.name, slug: entry.name, path: worktreePath });
		}
	}
	return results;
}

function mainRepoFor(worktreePath, root) {
	let content;
	try {
		content = readFileSync(join(worktreePath, ".git"), "utf8").trim();
	} catch {
		return null;
	}
	const match = content.match(/^gitdir:\s*(.+)$/);
	if (!match) return null;
	const repoMatch = match[1].trim().match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/);
	if (!repoMatch) return null;
	const mainRepo = repoMatch[1];
	const normalizedRoot = normalizePath(root);
	const normalizedRepo = normalizePath(mainRepo);
	if (normalizedRepo === normalizedRoot || normalizedRepo.startsWith(`${normalizedRoot}/`)) return null;
	return existsSync(mainRepo) ? mainRepo : null;
}

function evaluate(entry, minAgeHours, now) {
	const skip = (reason, detail) => ({ ...entry, candidate: false, reason, detail, marker: null, ageHours: null, mainRepo: null });
	const markerPath = join(entry.path, MARKER_NAME);
	if (!existsSync(markerPath)) return skip("no_marker");
	let marker;
	try {
		marker = JSON.parse(readFileSync(markerPath, "utf8"));
	} catch {
		return skip("invalid_marker");
	}
	if (!marker || typeof marker !== "object" || !UUID_PATTERN.test(String(marker.runId ?? ""))) return skip("invalid_marker");
	const finishedAt = Date.parse(String(marker.finishedAt ?? ""));
	if (!Number.isFinite(finishedAt)) return skip("invalid_marker");
	const ageHours = (now - finishedAt) / 3.6e6;
	if (ageHours < minAgeHours) return skip("too_young", `${ageHours.toFixed(1)}h`);
	const status = git(["status", "--porcelain"], entry.path);
	if (status.status !== 0) return skip("git_status_failed", (status.stderr || status.stdout || "").trim().slice(0, 200));
	const dirtyLines = status.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => line !== `?? ${MARKER_NAME}`);
	if (dirtyLines.length > 0) return skip("dirty", dirtyLines.slice(0, 5).join("; "));
	const mainRepo = mainRepoFor(entry.path, WORKTREES_ROOT);
	if (!mainRepo) return skip("not_a_worktree");
	return { ...entry, candidate: true, reason: "CANDIDATE", detail: null, marker, ageHours, mainRepo };
}

function removeWorktree(entry, deleteBranches) {
	const markerPath = join(entry.path, MARKER_NAME);
	const branchResult = git(["rev-parse", "--abbrev-ref", "HEAD"], entry.path);
	const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
	let markerContent = null;
	try {
		markerContent = readFileSync(markerPath, "utf8");
	} catch {}
	try {
		rmSync(markerPath);
	} catch {}
	const remove = git(["-C", entry.mainRepo, "worktree", "remove", entry.path]);
	if (remove.status !== 0) {
		if (markerContent !== null) {
			try {
				writeFileSync(markerPath, markerContent);
			} catch {}
		}
		return { ok: false, branch, branchWarning: null, reason: (remove.stderr || remove.stdout || "").trim().slice(0, 200) };
	}
	let branchWarning = null;
	if (deleteBranches && branch && branch !== "HEAD") {
		const deletion = git(["branch", "-d", branch], entry.mainRepo);
		if (deletion.status !== 0) branchWarning = "branch_not_merged";
	}
	git(["worktree", "prune"], entry.mainRepo);
	return { ok: true, branch, branchWarning, reason: null };
}

function formatAge(ageHours) {
	if (ageHours === null) return "-";
	if (ageHours < 48) return `${ageHours.toFixed(1)}h`;
	return `${(ageHours / 24).toFixed(1)}d`;
}

const options = parseArgs(process.argv.slice(2));
const entries = listWorktrees(WORKTREES_ROOT, options.project).map((entry) => evaluate(entry, options.minAgeHours, Date.now()));

const width = { project: 8, slug: 8, age: 4, status: 9, reason: 6, detail: 6 };
for (const entry of entries) {
	width.project = Math.max(width.project, entry.project.length);
	width.slug = Math.max(width.slug, entry.slug.length);
	width.status = Math.max(width.status, (entry.marker?.status ?? "-").length);
	width.reason = Math.max(width.reason, entry.reason.length);
	width.detail = Math.max(width.detail, (entry.detail ?? "").length);
}
const header = ["project", "slug", "age", "status", "reason", "detail"]
	.map((name, index) => [width.project, width.slug, width.age, width.status, width.reason, width.detail][index] ? name.padEnd([width.project, width.slug, width.age, width.status, width.reason, width.detail][index]) : name)
	.join("  ");
process.stdout.write(`${header}\n`);
for (const entry of entries) {
	const cells = [
		entry.project.padEnd(width.project),
		entry.slug.padEnd(width.slug),
		formatAge(entry.ageHours).padEnd(width.age),
		(entry.marker?.status ?? "-").padEnd(width.status),
		entry.reason.padEnd(width.reason),
		(entry.detail ?? "").padEnd(width.detail),
	];
	process.stdout.write(`${cells.join("  ").trimEnd()}\n`);
}

const candidates = entries.filter((entry) => entry.candidate);
const skipped = entries.filter((entry) => !entry.candidate);
process.stdout.write(`\n${candidates.length} candidates, ${skipped.length} skipped\n`);

if (!options.apply) {
	process.stdout.write("dry-run: pass --apply to delete\n");
	process.exit(0);
}

let failures = 0;
for (const entry of candidates) {
	const result = removeWorktree(entry, options.deleteBranches);
	if (result.ok) {
		const warning = result.branchWarning ? ` (${result.branchWarning}: ${result.branch})` : "";
		process.stdout.write(`REMOVED ${entry.project}/${entry.slug}${warning}\n`);
	} else {
		failures++;
		process.stdout.write(`REMOVE_FAILED ${entry.project}/${entry.slug}: ${result.reason}\n`);
	}
}
process.exit(failures > 0 ? 1 : 0);
