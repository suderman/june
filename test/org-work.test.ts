import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { clean, createOrgWorkCleanup, survey } from "../src/org-work.ts";
import { createLogger } from "../src/runtime.ts";
import { tempDir } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", cwd, ...args], { stdio: "pipe" }).toString();

test("a runtime folder goes once every thread naming it is DONE or archived and closed long enough ago, and stays otherwise", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org-work");
	const org = join(tmp.dir, "org");
	const folder = (dir: string, file = "out.txt") => { mkdirSync(join(root, dir), { recursive: true }); writeFileSync(join(root, dir, file), "x".repeat(1000)); };
	for (const d of ["w/p/2026-10-01-old-done", "w/p/2026-11-20-recent-done", "w/p/2026-10-02-open", "w/p/2026-10-03-art", "w/p/2026-10-04-nobody", "w/p/2026-10-05-archived", "w/p/2026-10-06-unsaved", "w/p/review-loop/rl-1"]) folder(d);
	mkdirSync(join(org, "work", "p", "archive"), { recursive: true });
	writeFileSync(join(org, "work", "p", "p.org"), [
		"* DONE Old work", "CLOSED: [2026-10-02 Fri 10:00]", "Files: [[file:~/.local/state/org-work/w/p/2026-10-01-old-done/][kit: old]]", "",
		"* DONE Fresh work", "CLOSED: [2026-11-20 Fri 10:00]", "=kit:~/.local/state/org-work/w/p/2026-11-20-recent-done/out.txt=", "",
		"* PROG Ongoing", "Uses =~/.local/state/org-work/w/p/2026-10-02-open=.", "",
		"* DONE Art", "CLOSED: [2026-10-04 Sun 10:00]", "=~/.local/state/org-work/w/p/2026-10-03-art=", "",
		"* DONE Kept git", "CLOSED: [2026-10-07 Wed 10:00]", "=~/.local/state/org-work/w/p/2026-10-06-unsaved=", "",
		"* DONE Reviewed", "CLOSED: [2026-10-08 Thu 10:00]", ":PROPERTIES:", ":ID:       rl-1", ":END:", "",
	].join("\n"));
	writeFileSync(join(org, "work", "p", "archive", "2026.org"), "* DONE Long gone\n=~/.local/state/org-work/w/p/2026-10-05-archived=\n");
	const keep = join(tmp.dir, "provenance.txt");
	writeFileSync(keep, "made from org-work/w/p/2026-10-03-art/run-7\n");
	// A git copy with a commit no remote has.
	const repo = join(root, "w/p/2026-10-06-unsaved/repo");
	mkdirSync(repo);
	git(repo, "init", "-q");
	writeFileSync(join(repo, "a"), "a");
	git(repo, "add", "a");
	git(repo, "commit", "-q", "-m", "local only");
	const options = { root, org, afterDays: 14, keep: [keep], today: "2026-11-21" };
	const verdicts = Object.fromEntries((await survey(options)).map((f) => [f.dir.split("/").at(-1), f.verdict]));
	assert.deepEqual(verdicts, {
		"2026-10-01-old-done": "delete",
		"2026-11-20-recent-done": "recent",
		"2026-10-02-open": "open",
		"2026-10-03-art": "keep",
		"2026-10-04-nobody": "unlinked",
		"2026-10-05-archived": "delete",
		"2026-10-06-unsaved": "unsaved",
		"rl-1": "delete",
	});
	// A read-only folder the user owns still goes.
	execFileSync("chmod", ["-w", join(root, "w/p/2026-10-01-old-done")]);
	const record = join(org, "cleanup.org");
	const result = await clean({ ...options, record, log: createLogger({ sink: () => {} }) });
	assert.deepEqual(result.deleted.map((f) => f.dir).sort(), ["w/p/2026-10-01-old-done", "w/p/2026-10-05-archived", "w/p/review-loop/rl-1"]);
	assert.equal(result.failed.length, 0);
	assert.ok(!existsSync(join(root, "w/p/2026-10-01-old-done")) && existsSync(join(root, "w/p/2026-10-06-unsaved/repo")));
	const text = readFileSync(record, "utf8");
	assert.match(text, /^\* 2026-11-21: 3 folders/m);
	assert.match(text, /=w\/p\/2026-10-01-old-done= \(0\.0 GB\): DONE 2026-10-02 Old work/);
	assert.match(text, /Waiting for the user: 2 \(1 with unsaved git work, 1 named by no thread\)/);
});

test("the tidy runs once a week, from its day and hour, across restarts", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	let at = new Date(2026, 10, 21, 23, 0); // a Saturday
	let runs = 0;
	const make = () => createOrgWorkCleanup({ config: { day: "sun", at: "03:30" }, state: tmp.dir, clean: async () => { runs++; }, log: createLogger({ sink: () => {} }), now: () => at, tickMs: 5 });
	let tidy = make();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(runs, 0, "not on Saturday");
	at = new Date(2026, 10, 22, 3, 0);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(runs, 0, "not before 03:30");
	at = new Date(2026, 10, 22, 3, 31);
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(runs, 1);
	tidy.stop();
	tidy = make();
	await new Promise((r) => setTimeout(r, 30));
	tidy.stop();
	assert.equal(runs, 1, "a restart the same day does not run it again");
	at = new Date(2026, 10, 29, 4, 0);
	tidy = make();
	await new Promise((r) => setTimeout(r, 30));
	tidy.stop();
	assert.equal(runs, 2, "next Sunday it runs again");
});
