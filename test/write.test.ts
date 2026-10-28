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
		SCHOOL.replace("- Office: 555-0100\n\n", "- Office: 555-0100\n\n** TODO Leave to pick up the kids\n"),
		"a level below, after a blank line that ends the list, and none after the bare heading",
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
		"#+TITLE: Garden\n#+CATEGORY: garden\n\n* TODO Order soil\nTwelve bags.\n- topsoil\n- compost\n\n* PROG Build the raised beds\nCedar, not pine.\n",
	);
	assert.deepEqual(f.runs, [], "no dates, no Org call");
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
