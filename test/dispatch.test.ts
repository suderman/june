import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Dispatch, insertAfterPreamble, taskBody } from "../src/tools/dispatch.ts";
import { Herdr } from "../src/tools/herdr.ts";
import { Org } from "../src/tools/org.ts";
import { tempDir, testConfig } from "./helpers.ts";

const PROJECT = `#+TITLE: Portal
#+CATEGORY: portal

Repositories:
- portal: [[file:~/src/studio/portal/][local]]

* PROG Existing thread
Body.
`;

async function fixture() {
	const tmp = await tempDir();
	const root = join(tmp.dir, "org");
	const project = join(root, "work/studio/portal/portal.org");
	await mkdir(join(root, "work/studio/portal"), { recursive: true });
	await writeFile(project, PROJECT);
	await writeFile(join(root, "asana.org"), "* TODO mirrored\n");
	await writeFile(join(root, "other.org"), "* TODO not on the agenda\n");
	const agenda = join(tmp.dir, "agenda");
	await writeFile(agenda, `${project}\n${join(root, "asana.org")}\n`);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: agenda }, dispatch: { hosts: ["kit", "cog"] } };
	const runs: string[][] = [];
	const dispatch = new Dispatch(new Org(root), config, async (argv) => {
		runs.push([...argv]);
		if (argv[0] === "org-edit") return JSON.stringify({ id: "resume123", title: "Existing thread", host: "kit", written: true });
		if (argv[0] === "org-dispatch") {
			const { projects } = await new Org(root).projects();
			await writeFile(agenda, projects.map(({ file }) => join(root, file)).join("\n"));
		}
		return "Queued task\t~/src/studio/portal\tsettling\n";
	});
	return { ...tmp, root, project, dispatch, runs, config };
}

const request = { file: "work/studio/portal/portal.org", title: "Investigate the flaky login test", host: "kit", review: true, key: "inst:7" };
const body = "June queued this because Alex asked for it.\n\n** Scope\nFind why login fails one run in ten.";

test("a queued task is a new first heading with one host tag, written once per key", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const first = await f.dispatch.queue({ ...request, body });
	assert.equal(first.written, true);
	const again = await f.dispatch.queue({ ...request, body });
	assert.equal(again.written, false, "a replay finds the heading it wrote");
	assert.equal(again.id, first.id);
	const text = await readFile(f.project, "utf8");
	assert.equal(text.match(/^\* AUTO /gm)?.length, 1);
	assert.match(
		text,
		/Repositories:\n- portal: \[\[file:~\/src\/studio\/portal\/\]\[local\]\]\n\n\* AUTO Investigate the flaky login test :kit:\n:PROPERTIES:\n:ID: [0-9a-f-]{36}\n:JUNE_REQUEST: inst:7\n:END:\nJune queued this because Alex asked for it.\n\n\*\* Scope\nFind why login fails one run in ten.\n\n\* PROG Existing thread\n/,
	);
});

test("queueing refuses files and requests the dispatcher should not get", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await assert.rejects(f.dispatch.queue({ ...request, body, file: "asana.org" }), /does not write asana.org/);
	await assert.rejects(f.dispatch.queue({ ...request, body, file: "other.org" }), /not an agenda file/);
	await assert.rejects(f.dispatch.queue({ ...request, body, host: "lux" }), /only for kit, cog/);
	await assert.rejects(f.dispatch.queue({ ...request, body: "* Sneaky\nsplit" }), /first-level heading/);
	await assert.rejects(f.dispatch.queue({ ...request, body, title: "Fix it :cog:" }), /keyword or tags/);
	await writeFile(join(f.root, "work/studio/portal/portal.sync-conflict-20261025-ABC.org"), "");
	await assert.rejects(f.dispatch.queue({ ...request, body }), /conflict copy/);
	assert.equal(await readFile(f.project, "utf8"), PROJECT);
});

test("new GitHub projects and one-offs get discoverable records without overwriting metadata", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const project = { domain: "studio", project: "new-repo", title: "New repo", github: "https://github.com/studio/new-repo", dir: f.dir };
	const created = await f.dispatch.createProject(project);
	assert.equal(created.file, "work/studio/new-repo/new-repo.org");
	assert.equal(created.created, true);
	const path = join(f.root, created.file);
	const before = await readFile(path, "utf8");
	assert.equal(before, `#+TITLE: New repo\n#+CATEGORY: new-repo\n\nRepositories:\n- new-repo: [[file:${f.dir}/][local]] | [[https://github.com/studio/new-repo][GitHub]]\n`);
	assert.equal((await f.dispatch.createProject({ ...project, title: "Do not replace" })).created, false);
	assert.equal(await readFile(path, "utf8"), before);
	const queued = await f.dispatch.queue({ ...request, body, file: created.file });
	assert.equal(queued.written, true);
	assert.equal((await f.dispatch.queue({ ...request, body, file: created.file })).id, queued.id);
	const oneoff = await f.dispatch.createProject({ domain: "june", project: "check-disk-space", title: "Check disk space", github: "", dir: "" });
	assert.equal(await readFile(join(f.root, oneoff.file), "utf8"), "#+TITLE: Check disk space\n#+CATEGORY: check-disk\n");
	await f.dispatch.queue({ ...request, body, file: oneoff.file });
	const text = await readFile(join(f.root, oneoff.file), "utf8");
	assert.doesNotMatch(text, /:DIR:|Repositories:/);
	assert.doesNotMatch(text, /^:REVIEW: no$/m, "a lookup still needs review, even when June is the reviewer");
});

test("project creation refuses bad paths, metadata, conflicts, and symlink escapes", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const project = { domain: "june", project: "check-disk", title: "Disk check" };
	for (const bad of ["../outside", "archive", ".hidden", "disk.sync-conflict-ABC", "a/b"])
		await assert.rejects(f.dispatch.createProject({ ...project, project: bad }), /plain directory names/);
	await assert.rejects(f.dispatch.createProject({ ...project, title: "title\n* AUTO Surprise" }), /one non-empty line/);
	await assert.rejects(f.dispatch.createProject({ ...project, github: "https://example.com/a/b" }), /github must/);
	await assert.rejects(f.dispatch.createProject({ ...project, dir: join(f.dir, "absent") }), /not a directory/);
	await mkdir(join(f.root, "work/june/check-disk"), { recursive: true });
	await writeFile(join(f.root, "work/june/check-disk/check-disk.sync-conflict-ABC.org"), "conflict");
	await assert.rejects(f.dispatch.createProject(project), /conflict copy/);
	await symlink(f.dir, join(f.root, "work/escape"));
	await assert.rejects(f.dispatch.createProject({ ...project, domain: "escape" }), /leaves the Org root/);
	await assert.rejects(readFile(join(f.dir, "check-disk/check-disk.org")), /ENOENT/);
	assert.equal(await readFile(f.project, "utf8"), PROJECT);
});

test("an undiscovered new record stays empty and can be retried after agenda refresh", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const stale = new Dispatch(new Org(f.root), f.config, async () => "");
	const project = { domain: "june", project: "check-disk", title: "Disk check" };
	await assert.rejects(stale.createProject(project), /not an agenda file/);
	const file = "work/june/check-disk/check-disk.org";
	assert.doesNotMatch(await readFile(join(f.root, file), "utf8"), /^\* /m);
	await assert.rejects(stale.queue({ ...request, body, file }), /not an agenda file/);
	assert.equal((await f.dispatch.createProject(project)).created, false);
	assert.equal((await f.dispatch.queue({ ...request, body, file })).written, true);
});

test("resume uses the shared org-edit command with an expected state and request key", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await writeFile(f.project, PROJECT.replace("* PROG Existing thread", "* HOLD Existing thread"));
	const herdr = new Herdr(f.config.herdr, async () => "{}");
	const result = await f.dispatch.resume({ file: request.file, heading: "Existing thread", expected: "HOLD", host: "kit", note: "Alex chose option A.", key: "inst:8" }, herdr);
	assert.equal(result.id, "resume123");
	assert.deepEqual(f.runs.at(-1), ["org-edit", "todo", f.project, "Existing thread", "AUTO", "--expect", "HOLD", "--request", "inst:8", "--host", "kit", "--note", "Alex chose option A."]);
	assert.equal((await readFile(f.project, "utf8")).match(/^\* /gm)?.length, 1, "no duplicate heading written by June");
	await assert.rejects(f.dispatch.resume({ file: request.file, heading: "Existing thread", expected: "TODO", host: "lux", note: "Alex asked.", key: "inst:9" }, herdr), /No allowed dispatcher/);
	await assert.rejects(f.dispatch.resume({ file: "asana.org", heading: "mirrored", expected: "TODO", host: "kit", note: "Alex asked.", key: "inst:9" }, herdr), /does not write/);
});

test("resume refuses a working or blocked linked agent, but allows idle and a replay", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const session = "12345678-abcd-abcd-abcd-123456789abc";
	await writeFile(f.project, `* HOLD Existing thread\n:PROPERTIES:\n:ID: resume123\n:END:\n\n** Sessions\n- [[herdr:kit/pi:${session}@w1:p1][worker]]\n`);
	const resume = { file: request.file, heading: "id:resume123", expected: "HOLD" as const, host: "kit", note: "Alex answered.", key: "inst:8" };
	let status = "working";
	const herdr = new Herdr(f.config.herdr, async (args) => args.includes("agent")
		? JSON.stringify({ result: { agents: [{ agent: "pi", agent_status: status, pane_id: "w1:p1", agent_session: { value: `${session}.jsonl` } }] } })
		: "{}");
	await assert.rejects(f.dispatch.resume(resume, herdr), /active agent/);
	status = "blocked";
	await assert.rejects(f.dispatch.resume(resume, herdr), /active agent/);
	assert.equal(f.runs.length, 0, "no edit while an agent needs attention");
	status = "idle";
	await f.dispatch.resume(resume, herdr);
	assert.equal(f.runs.length, 1);
	status = "working";
	await writeFile(f.project, (await readFile(f.project, "utf8")).replace(":ID: resume123", ":ID: resume123\n:JUNE_REQUEST: inst:8"));
	await f.dispatch.resume(resume, herdr);
	assert.equal(f.runs.length, 2, "a replay still reaches org-edit to recover its saved result");
});

test("completion closes only June-created EVAL tasks, refuses stale states, and leaves DONE unchanged", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const parts = taskBody({ reason: "Alex asked for a lookup.", scope: "Check uptime.", checklist: ["Verify answer"] });
	const queued = await f.dispatch.queue({ ...request, body: parts });
	const original = await readFile(f.project, "utf8");
	const evalText = original.replace("* AUTO Investigate", "* EVAL Investigate");
	const calls: string[][] = [];
	const dispatch = new Dispatch(new Org(f.root), f.config, async (args) => {
		calls.push([...args]);
		const text = await readFile(f.project, "utf8");
		if (!text.includes("* EVAL Investigate")) throw new Error("Expected EVAL, found HOLD");
		await writeFile(f.project, text.replace("* EVAL Investigate", "* DONE Investigate"));
		return "* DONE Investigate the flaky login test\n";
	});
	await assert.rejects(dispatch.complete(request.file, `id:${queued.id}`), /Expected EVAL, found AUTO/);
	await writeFile(f.project, evalText);
	const result = await dispatch.complete(request.file, request.title);
	assert.equal(result.written, true);
	assert.equal(result.id, queued.id);
	assert.deepEqual(calls[0], ["org-edit", "todo", f.project, `id:${queued.id}`, "DONE", "--expect", "EVAL"]);
	const done = await readFile(f.project, "utf8");
	assert.equal(done, evalText.replace("* EVAL Investigate", "* DONE Investigate"), "no unrelated content is changed");
	assert.equal((await dispatch.complete(request.file, `id:${queued.id}`)).written, false);
	assert.equal(calls.length, 1, "replay makes no second edit");
	assert.equal(await readFile(f.project, "utf8"), done);
	for (const state of ["PROG", "HOLD", "TODO"]) {
		await writeFile(f.project, original.replace("* AUTO Investigate", `* ${state} Investigate`));
		await assert.rejects(dispatch.complete(request.file, request.title), /Expected EVAL/);
	}
	// A resume adds JUNE_REQUEST to Alex's task. That alone does not transfer ownership.
	await writeFile(f.project, evalText.replace(/^Queued by June: .+\n/m, ""));
	await assert.rejects(dispatch.complete(request.file, request.title), /only tasks she created/);
	await assert.rejects(dispatch.complete("asana.org", "mirrored"), /does not write/);
});

test("the nudge starts the dispatcher unit and reports its scan", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	assert.match(await f.dispatch.nudge(), /settling/);
	assert.deepEqual(f.runs[0], ["systemctl", "--user", "start", "org-dispatch.service"]);
	await f.dispatch.kick();
	assert.deepEqual(f.runs.at(-1), ["systemctl", "--user", "start", "--no-block", "org-dispatch.service"], "queueing does not wait for the launch");
});

test("the body always has the same shape, whatever the model sends", () => {
	assert.equal(
		taskBody({ reason: "Alex asked for a docs check.", scope: "Check the docs.\n\n\n\nReport only.", checklist: ["Compare docs", "- [ ] Report findings", "- Leave files alone"] }),
		"Queued by June: Alex asked for a docs check.\n\n** Scope\nCheck the docs.\n\nReport only.\n\n** Checklist\n- [ ] Compare docs\n- [ ] Report findings\n- [ ] Leave files alone",
	);
	assert.throws(() => taskBody({ reason: "two\nlines", scope: "x", checklist: ["a"] }), /reason is one non-empty line/);
	assert.throws(() => taskBody({ reason: "r", scope: "x", checklist: [] }), /at least one item/);
});

test("queueing refuses a working directory that does not exist", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await assert.rejects(f.dispatch.queue({ ...request, body, dir: join(f.dir, "nope") }), /not a directory/);
	assert.equal((await f.dispatch.queue({ ...request, body, dir: f.dir })).written, true);
});

test("insertion keeps a file without headings and one that starts with a heading valid", () => {
	assert.equal(insertAfterPreamble("#+TITLE: X\n", "* AUTO A :kit:\n"), "#+TITLE: X\n\n* AUTO A :kit:\n");
	assert.equal(insertAfterPreamble("* TODO B\n", "* AUTO A :kit:\n"), "* AUTO A :kit:\n\n* TODO B\n");
});

const hasDispatcher = (() => {
	try {
		execFileSync("sh", ["-c", "command -v org-dispatch"]);
		return true;
	} catch {
		return false;
	}
})();

test("completion through installed org-edit writes CLOSED and refuses a concurrent state change", async (t) => {
	try { execFileSync("sh", ["-c", "command -v org-edit"]); }
	catch { t.skip("org-edit is not installed"); return; }
	const f = await fixture();
	t.after(f.cleanup);
	await f.dispatch.queue({ ...request, body: taskBody({ reason: "Alex asked.", scope: "Read only.", checklist: ["Verify"] }) });
	const evalText = (await readFile(f.project, "utf8")).replace("* AUTO Investigate", "* EVAL Investigate");
	await writeFile(f.project, evalText);
	let race = false;
	const dispatch = new Dispatch(new Org(f.root), f.config, async (args) => {
		if (race) await writeFile(f.project, evalText.replace("* EVAL Investigate", "* HOLD Investigate"));
		return execFileSync(args[0]!, args.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	});
	await dispatch.complete(request.file, request.title);
	const done = await readFile(f.project, "utf8");
	assert.match(done, /^\* DONE Investigate.+\nCLOSED: \[.+\]/m);
	assert.match(done, /Queued by June: Alex asked\./);
	assert.match(done, /\* PROG Existing thread\nBody\./);
	assert.equal((await dispatch.complete(request.file, request.title)).written, false);
	assert.equal(await readFile(f.project, "utf8"), done);
	await writeFile(f.project, evalText);
	race = true;
	await assert.rejects(dispatch.complete(request.file, request.title), /expected EVAL.*found HOLD/i);
	assert.equal(await readFile(f.project, "utf8"), evalText.replace("* EVAL Investigate", "* HOLD Investigate"));
});

test("org-dispatch itself sees the task June wrote", { skip: !hasDispatcher && "org-dispatch is not installed" }, async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await f.dispatch.queue({ ...request, body });
	const init = join(f.dir, "init.el");
	await writeFile(init, `(require 'org)\n(setq org-agenda-files (directory-files-recursively ${JSON.stringify(join(f.root, "work"))} "\\\\.org\\\\'"))\n`);
	const options = {
		encoding: "utf8" as const,
		env: {
			...process.env,
			ORG_DISPATCH_HOST: "kit",
			ORG_DISPATCH_ROOT: join(f.root, "work"),
			ORG_DISPATCH_EMACS_INIT: init,
			XDG_STATE_HOME: join(f.dir, "state"),
		},
	};
	const out = execFileSync("org-dispatch", ["scan"], options);
	assert.match(out, /^Investigate the flaky login test\t.*\tnew$/m, "June's complete request skips settling");
	const actual = new Dispatch(new Org(f.root), { ...f.config, org: { root: f.root, agendaFiles: join(f.dir, "state/org-dispatch/agenda-files") } },
		async (argv) => execFileSync(argv[0]!, argv.slice(1), options));
	const project = await actual.createProject({ domain: "june", project: "new-oneoff", title: "New one-off" });
	await actual.queue({ ...request, file: project.file, title: "Check free disk space", body, key: "inst:9" });
	const scan = execFileSync("org-dispatch", ["scan"], options);
	assert.match(scan, new RegExp(`^Check free disk space\\t${join(f.root, "work/june/new-oneoff")}\\tnew$`, "m"), "a one-off uses its own project directory, without a DIR override");
});
