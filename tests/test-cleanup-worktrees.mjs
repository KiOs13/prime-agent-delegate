import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../skill-source/scripts/cleanup-worktrees.mjs", import.meta.url).pathname;

function git(args, cwd) {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result;
}

function createMainRepo(root, project, slug) {
	const repo = join(root, "repos", `${project}-${slug}`);
	mkdirSync(repo, { recursive: true });
	git(["init", "-b", "main"], repo);
	git(["config", "user.email", "test@example.com"], repo);
	git(["config", "user.name", "Test"], repo);
	writeFileSync(join(repo, "base.txt"), "base\n");
	git(["add", "."], repo);
	git(["commit", "-m", "init"], repo);
	return repo;
}

function createWorktree(root, project, slug, { markerAgeHours = 200, dirty = false } = {}) {
	const repo = createMainRepo(root, project, slug);
	const worktreePath = join(root, "worktrees", project, slug);
	mkdirSync(join(root, "worktrees", project), { recursive: true });
	git(["worktree", "add", worktreePath, "-b", `codex/prime-agent-${slug}`], repo);
	if (markerAgeHours !== null) {
		const finishedAt = new Date(Date.now() - markerAgeHours * 3.6e6).toISOString();
		writeFileSync(join(worktreePath, ".prime-task-complete.json"), JSON.stringify({
			runId: "01234567-89ab-cdef-0123-456789abcdef",
			status: "completed",
			terminalReason: "completed_not_restartable",
			taskId: null,
			finishedAt,
		}, null, 2) + "\n");
	}
	if (dirty) writeFileSync(join(worktreePath, "untracked.txt"), "dirty\n");
	return { repo, worktreePath };
}

function runCleanup(root, args = []) {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
		env: { ...process.env, PRIME_DELEGATE_WORKTREES_ROOT: join(root, "worktrees") },
	});
}

test("dry-run lists candidates without deleting", () => {
	const root = mkdtempSync(join(tmpdir(), "prime-cleanup-"));
	const { worktreePath } = createWorktree(root, "proj-a", "task-old");
	const result = runCleanup(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /CANDIDATE/);
	assert.match(result.stdout, /1 candidates/);
	assert.match(result.stdout, /dry-run/);
	assert.equal(existsSync(worktreePath), true);
});

test("apply removes old clean worktree and prunes registration", () => {
	const root = mkdtempSync(join(tmpdir(), "prime-cleanup-"));
	const { repo, worktreePath } = createWorktree(root, "proj-a", "task-old");
	const result = runCleanup(root, ["--apply"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /REMOVED proj-a\/task-old/);
	assert.equal(existsSync(worktreePath), false);
	const list = git(["worktree", "list", "--porcelain"], repo).stdout;
	assert.doesNotMatch(list, /worktrees\/proj-a\/task-old/);
});

test("unmarked, young, dirty, and invalid markers are skipped", () => {
	const root = mkdtempSync(join(tmpdir(), "prime-cleanup-"));
	const noMarker = createWorktree(root, "proj-a", "no-marker", { markerAgeHours: null });
	const young = createWorktree(root, "proj-a", "young", { markerAgeHours: 5 });
	const dirty = createWorktree(root, "proj-a", "dirty", { markerAgeHours: 200, dirty: true });
	const broken = createWorktree(root, "proj-a", "broken");
	writeFileSync(join(broken.worktreePath, ".prime-task-complete.json"), "{not json");
	const result = runCleanup(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /no_marker/);
	assert.match(result.stdout, /too_young/);
	assert.match(result.stdout, /dirty/);
	assert.match(result.stdout, /invalid_marker/);
	assert.match(result.stdout, /0 candidates/);
	assert.equal(existsSync(noMarker.worktreePath), true);
	assert.equal(existsSync(young.worktreePath), true);
	assert.equal(existsSync(dirty.worktreePath), true);
	assert.equal(existsSync(broken.worktreePath), true);
});

test("min-age-hours overrides the default and project filters scope", () => {
	const root = mkdtempSync(join(tmpdir(), "prime-cleanup-"));
	const fresh = createWorktree(root, "proj-a", "recent", { markerAgeHours: 2 });
	const other = createWorktree(root, "proj-b", "old-enough", { markerAgeHours: 2 });
	const filtered = runCleanup(root, ["--min-age-hours", "1", "--project", "proj-a"]);
	assert.equal(filtered.status, 0, filtered.stderr);
	assert.match(filtered.stdout, /CANDIDATE/);
	assert.doesNotMatch(filtered.stdout, /proj-b/);
	const applied = runCleanup(root, ["--min-age-hours", "1", "--apply"]);
	assert.equal(applied.status, 0, applied.stderr);
	assert.match(applied.stdout, /REMOVED proj-a\/recent/);
	assert.match(applied.stdout, /REMOVED proj-b\/old-enough/);
	assert.equal(existsSync(fresh.worktreePath), false);
	assert.equal(existsSync(other.worktreePath), false);
});

test("delete-branches removes merged branch and warns on refusal", () => {
	const root = mkdtempSync(join(tmpdir(), "prime-cleanup-"));
	const { repo } = createWorktree(root, "proj-a", "branched");
	const result = runCleanup(root, ["--apply", "--delete-branches"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /REMOVED proj-a\/branched/);
	const branches = git(["branch", "--list", "codex/prime-agent-branched"], repo).stdout.trim();
	assert.equal(branches, "");
});
