import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runProcess } from "../src/tools/herdr.ts";
import { Org } from "../src/tools/org.ts";
import { OrgWrites } from "../src/tools/write.ts";
import { tempDir, testConfig } from "./helpers.ts";

const SCHOOL = `#+TITLE: School

* Pickup
Doors open at 15:30.

** Contacts
- Office: 555-0100

* Field trip
:PROPERTIES:
:ID: trip-1
:END:
`;

const PROJECT = `#+TITLE: Garden
#+CATEGORY: garden

* PROG Build the raised beds
Cedar, not pine.
`;

async function fixture(run?: (argv: readonly string[]) => Promise<string>) {
	const tmp = await tempDir();
	const root = join(tmp.dir, "org");
	await mkdir(join(root, "life"), { recursive: true });
	await mkdir(join(root, "work/home/garden"), { recursive: true });
	const school = join(root, "life/school.org");
	const garden = join(root, "work/home/garden/garden.org");
	await writeFile(school, SCHOOL);
	await writeFile(garden, PROJECT);
	await writeFile(join(root, "asana.org"), "* TODO mirrored\n");
	await writeFile(join(root, "inbox.org"), "* captured\n");
	await writeFile(join(root, "elsewhere.org"), "* TODO off the agenda\n");
	const agenda = join(tmp.dir, "agenda");
	await writeFile(agenda, [school, garden, join(root, "asana.org"), join(root, "inbox.org")].join("\n"));
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: agenda, people: join(root, "people.org") } };
	const runs: string[][] = [];
	const writes = new OrgWrites(new Org(root), config, async (argv) => {
		runs.push([...argv]);
		if (run) return run(argv);
		if (argv[1] === "date" && argv[2] === "next tuesday") throw new Error("org-edit: unclear date");
		return argv[1] === "date" ? "<2026-10-30 Fri>" : `** TODO ${argv[3]}\nDEADLINE: <2026-10-30 Fri 15:25>\n`;
	});
	return { ...tmp, root, school, garden, writes, runs, config };
}

test("a TODO goes last under the heading it concerns, written once, with dates set by Org", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const task = { file: "life/school.org", under: "Pickup", title: "Leave to pick up the kids", deadline: "today 15:25" };
	const first = await f.writes.addTask(task);
	assert.deepEqual([first.heading, first.written], ["Pickup / Leave to pick up the kids", true]);
	assert.equal(
		await readFile(f.school, "utf8"),
		SCHOOL.replace("- Office: 555-0100\n\n", "- Office: 555-0100\n\n** TODO Leave to pick up the kids\n:PROPERTIES:\n:JUNE_CREATED: yes\n:END:\n"),
		"a level below, after a blank line that ends the list, and none after the property drawer",
	);
	assert.deepEqual(f.runs, [
		["org-edit", "date", "today 15:25"],
		["org-edit", "deadline", f.school, "Pickup / Leave to pick up the kids", "today 15:25"],
	]);
	const again = await f.writes.addTask(task);
	assert.equal(again.written, false, "a replay or a second ask finds the open TODO");
	assert.equal((await readFile(f.school, "utf8")).match(/Leave to pick up/g)?.length, 1);

	await assert.rejects(f.writes.addTask({ ...task, title: "Pack lunches", scheduled: "next tuesday" }), /unclear date/);
	assert.doesNotMatch(await readFile(f.school, "utf8"), /Pack lunches/, "a bad date is refused before anything is written");
});

test("without a parent, a TODO is a first heading after the preamble, newest first", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await f.writes.addTask({ file: "work/home/garden/garden.org", title: "Order soil", body: "Twelve bags.\n- topsoil\n- compost" });
	assert.equal(
		await readFile(f.garden, "utf8"),
		"#+TITLE: Garden\n#+CATEGORY: garden\n\n* TODO Order soil\n:PROPERTIES:\n:JUNE_CREATED: yes\n:END:\nTwelve bags.\n- topsoil\n- compost\n\n* PROG Build the raised beds\nCedar, not pine.\n",
	);
	assert.deepEqual(f.runs, [], "no dates, no Org call");
});

test("a plain heading has no keyword, sits where a TODO would, and is written once", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const meeting = { file: "work/home/garden/garden.org", title: "Garden planning meeting", body: "- [[file:2026-10-30-planning/notes.txt][Transcript]]", todo: false };
	assert.equal((await f.writes.addTask(meeting)).written, true);
	assert.equal((await f.writes.addTask(meeting)).written, false);
	assert.equal(
		await readFile(f.garden, "utf8"),
		"#+TITLE: Garden\n#+CATEGORY: garden\n\n* Garden planning meeting\n- [[file:2026-10-30-planning/notes.txt][Transcript]]\n\n* PROG Build the raised beds\nCedar, not pine.\n",
	);
});

test("June writes only agenda files that are hers to write, and only text that keeps their shape", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const add = (over: object) => f.writes.addTask({ file: "life/school.org", title: "Pack lunches", ...over });
	await assert.rejects(add({ file: "asana.org" }), /does not write asana.org/);
	await assert.rejects(add({ file: "inbox.org" }), /does not write inbox.org/);
	await assert.rejects(add({ file: "elsewhere.org" }), /not an agenda file/);
	await writeFile(f.school.replace(".org", ".sync-conflict-x.org"), "");
	await assert.rejects(add({}), /conflict copy/);
	const g = await fixture();
	t.after(g.cleanup);
	const add2 = (over: object) => g.writes.addTask({ file: "life/school.org", title: "Pack lunches", ...over });
	await assert.rejects(add2({ title: "TODO Pack lunches" }), /keyword or tags/);
	await assert.rejects(add2({ title: "Pack lunches :kit:" }), /keyword or tags/);
	await assert.rejects(add2({ under: "Pickup", body: "** Sneaky sibling" }), /heading of level 2/);
	await assert.rejects(add2({ body: "DEADLINE: <2026-10-30 Fri>" }), /Dates go in/);
	await assert.rejects(add2({ under: "Nowhere" }), /No heading "Nowhere"/);
	assert.equal(await readFile(g.school, "utf8"), SCHOOL);
});

test("a note joins the end of a heading's own text, once, and keeps the Org layout", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await f.writes.addNote("life/school.org", "Pickup", "From Monday, doors open at 15:20.");
	await f.writes.addNote("life/school.org", "Pickup", "From Monday, doors open at 15:20.");
	await f.writes.addNote("life/school.org", "id:trip-1", "Permission slip due Friday.");
	assert.equal(
		await readFile(f.school, "utf8"),
		SCHOOL.replace("Doors open at 15:30.\n", "Doors open at 15:30.\n\nFrom Monday, doors open at 15:20.\n").replace(":END:\n", ":END:\nPermission slip due Friday.\n"),
		"before the subheading, with no blank line after a drawer",
	);
});

test("states change through Org with the state just read; AUTO is not June's to set or take", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await assert.rejects(f.writes.setState("work/home/garden/garden.org", "Build the raised beds", "DONE", "TODO"), /Expected TODO, found PROG/);
	assert.equal(f.runs.length, 0);
	await f.writes.setState("work/home/garden/garden.org", "Build the raised beds", "DONE", "PROG");
	assert.deepEqual(f.runs.at(-1), ["org-edit", "todo", f.garden, "Build the raised beds", "DONE", "--expect", "PROG"]);
	await f.writes.setState("life/school.org", "Pickup", "TODO", "");
	assert.deepEqual(f.runs.at(-1), ["org-edit", "todo", f.school, "Pickup", "TODO"], "a heading with no state is expected as empty");
	await assert.rejects(f.writes.setState("work/home/garden/garden.org", "Build the raised beds", "AUTO" as never, "PROG"), /AUTO has its own tools/);
	await writeFile(f.garden, PROJECT.replace("PROG", "AUTO"));
	await assert.rejects(f.writes.setState("work/home/garden/garden.org", "Build the raised beds", "DONE", "AUTO"), /belongs to the dispatcher/);
	await writeFile(f.garden, PROJECT.replace("PROG", "DONE"));
	const runs = f.runs.length;
	assert.equal((await f.writes.setState("work/home/garden/garden.org", "Build the raised beds", "DONE", "PROG")).written, false, "already there is a replay");
	assert.equal(f.runs.length, runs);
	await f.writes.setDate("life/school.org", "School / Pickup".replace("School / ", ""), "scheduled", "none");
	assert.deepEqual(f.runs.at(-1), ["org-edit", "schedule", f.school, "Pickup", "none"]);
});

test("task content updates use the guarded backend, never direct writes or a dispatcher kick", async (t) => {
	const f = await fixture(async () => 'loading agenda\n{"id":"trip-1","title":"Verify access","state":"TODO","written":true}\n');
	t.after(f.cleanup);
	const request = { file: "life/school.org", heading: "id:trip-1", revision: "a".repeat(64), title: "Verify access", scope: "Check access.\n- Keep permissions.", note: "Alex approved the new wording.", key: "fixture:1" };
	assert.deepEqual(await f.writes.updateTask(request), { file: request.file, id: "trip-1", title: request.title, state: "TODO", written: true });
	assert.deepEqual(f.runs, [["org-edit", "update-task", f.school, request.heading, JSON.stringify({ revision: request.revision, title: request.title, scope: request.scope, note: request.note, request: request.key })]]);
	assert.equal(await readFile(f.school, "utf8"), SCHOOL, "only the backend writes");
	await assert.rejects(f.writes.updateTask({ ...request, file: "asana.org" }), /does not write asana.org/);
	await assert.rejects(f.writes.updateTask({ ...request, file: "elsewhere.org" }), /not an agenda file/);
	assert.equal(f.runs.length, 1);
	const old = await fixture(async () => { throw new Error("usage: org-edit todo|schedule|deadline FILE HEADING ARG, org-edit date WHEN"); });
	t.after(old.cleanup);
	await assert.rejects(old.writes.updateTask(request), /installed org-edit cannot update task content yet and wrote nothing/);
});

test("task content edits round-trip org_read_task revisions through the real private Emacs backend", async (t) => {
	try {
		execFileSync("sh", ["-c", "command -v emacs"]);
	} catch {
		t.skip("emacs is not installed");
		return;
	}
	const f = await fixture();
	t.after(f.cleanup);
	await mkdir(f.paths.runtime, { recursive: true });
	const script = fileURLToPath(new URL("../org/edit/org-edit", import.meta.url));
	const org = new Org(f.root);
	const writes = new OrgWrites(org, f.config, (argv) => runProcess([
		"env", `HOME=${f.dir}`, `XDG_RUNTIME_DIR=${f.paths.runtime}`, `XDG_STATE_HOME=${f.paths.state}`,
		`ORG_DISPATCH_ROOT=${f.root}`, `ORG_DISPATCH_EMACS_INIT=${join(f.dir, "no-init.el")}`,
		"bash", script, ...argv.slice(1),
	], 60_000));
	await writeFile(f.garden, PROJECT.replace("Cedar, not pine.", "The estimate is approved. 🌲\n\n** Scope\nOld scope.\n\n** Checklist\n- [X] Approve estimate.\n\n** Dialog\n- Alex: Keep earlier evidence."));
	const before = await org.read("work/home/garden/garden.org", "Build the raised beds");
	// This is a manual PROG task, still deliberately refused until it is paused.
	await assert.rejects(writes.updateTask({ file: before.file, heading: "Build the raised beds", revision: before.revision, title: "Verify access", note: "Alex asked.", key: "fixture:blocked" }), /only plain, TODO, HOLD or EVAL/);
	await writeFile(f.garden, (await readFile(f.garden, "utf8")).replace("* PROG", "* HOLD"));
	const paused = await org.read("work/home/garden/garden.org", "Build the raised beds");
	const request = { file: paused.file, heading: "Build the raised beds", revision: paused.revision, title: "Verify access 🌲", scope: "Check access.\n- Do not deploy.", note: "Alex approved the estimate; access is next.", key: "fixture:edit" };
	const result = await writes.updateTask(request);
	assert.equal(result.written, true);
	const after = await org.read(paused.file, `id:${result.id}`);
	assert.match(after.text, /^\* HOLD Verify access 🌲\n/);
	assert.match(after.text, /The estimate is approved. 🌲/);
	assert.match(after.text, /\*\* Scope\nCheck access.\n- Do not deploy.\n\n\*\* Checklist\n- \[X\] Approve estimate./);
	assert.match(after.text, /\*\* Dialog\n- Alex: Keep earlier evidence./);
	assert.match(after.text, /Previous content \(JSON\): .*Old scope/);
	assert.equal((await writes.updateTask(request)).written, false, "replay finds its receipt after a title-only selector has changed");
	assert.equal((await org.read(paused.file, `id:${result.id}`)).revision, after.revision);
	await assert.rejects(writes.updateTask({ ...request, heading: `id:${result.id}`, key: "fixture:stale", scope: "Different scope." }), /task revision changed/);
});

test("through this checkout's org-edit, a TODO gets its deadline and later closes as Emacs would", async (t) => {
	try {
		execFileSync("sh", ["-c", "command -v emacs"]);
	} catch {
		t.skip("emacs is not installed");
		return;
	}
	const script = fileURLToPath(new URL("../org/edit/org-edit", import.meta.url));
	const f = await fixture((argv) => runProcess(["bash", script, ...argv.slice(1)], 60_000));
	t.after(f.cleanup);
	const added = await f.writes.addTask({ file: "life/school.org", under: "Pickup", title: "Leave to pick up the kids", deadline: "2026-10-28 15:25" });
	assert.match(added.planning ?? "", /DEADLINE: <2026-10-28 Wed 15:25>/);
	await f.writes.setState("life/school.org", "Pickup / Leave to pick up the kids", "DONE", "TODO");
	const text = await readFile(f.school, "utf8");
	assert.match(text, /\n\*\* DONE Leave to pick up the kids\nCLOSED: \[[^\]]+\] DEADLINE: <2026-10-28 Wed 15:25>\n/);
	assert.match(text, /\n\* Field trip\n/, "the rest of the file is untouched");
});
