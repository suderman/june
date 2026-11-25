import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { Boards, loadAgenda, type Task } from "../src/board.ts";
import { headingOf, type TaskEdit, TaskEdits } from "../src/board-edit.ts";
import { Client } from "../src/protocol.ts";
import { createLogger } from "../src/runtime.ts";
import { Herdr, runProcess } from "../src/tools/herdr.ts";
import { openTestDaemon, tempDir, testConfig, until } from "./helpers.ts";

const task = (extra: Partial<Task> = {}): Task => ({ key: "id:t1", id: "t1", file: "work/demo/demo.org", line: 3, level: 1, title: "Hand off", state: "EVAL", tags: [], path: [], project: "Demo", sessions: [], ...extra });

test("each board edit is one org-edit call that names the task and expects the state the board showed", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const config = testConfig(tmp.dir, { dispatch: { hosts: ["kit", "cog"], host: "kit", agent: "pi", agents: ["pi", "claude"] } });
	const calls: string[][] = [];
	const edits = new TaskEdits(config, async (argv) => {
		assert.deepEqual(argv.slice(0, 4), ["env", "ORG_EDIT_PROTECTED=asana.org", "ORG_EDIT_WAIT=25", "bash"], "it waits its turn behind a dispatcher pass");
		calls.push(argv.slice(5));
		return "ok\n";
	});
	const file = join(config.org.root, "work/demo/demo.org");
	await edits.apply(task(), { action: "state", state: "DONE" }, "r1");
	await edits.apply(task(), { action: "assign", agent: "claude", host: "cog" }, "r2");
	await edits.apply(task({ sessions: ["herdr:kit/claude:abc@t1"] }), { action: "reply", text: " Always kit. ", resume: true }, "r3");
	await edits.apply(task({ id: undefined, path: ["Parent"] }), { action: "schedule", when: "fri 9:00" }, "r4");
	assert.deepEqual(await edits.apply(task({ revision: "a".repeat(64) }), { action: "title", title: " Hand it off " }, "r5"), { text: "ok\n", key: "id:t1" });
	assert.deepEqual(await edits.apply(task({ id: undefined, path: ["P"], revision: "b".repeat(64) }), { action: "title", title: "New" }, "r6"), { text: "ok\n", key: "work/demo/demo.org::*P/New" }, "a rename moves an outline key");
	await edits.apply(task({ state: "TODO" }), { action: "assign", agent: "pi", when: "sat 9:00" }, "r7");
	await edits.apply(task({ file: "asana.org", protected: true, state: "TODO" }), { action: "state", state: "DONE" }, "r8");
	await edits.apply(task({ state: "AUTO", revision: "c".repeat(64) }), { action: "schedule", when: "2026-11-30 09:00" }, "r9");
	await edits.apply(task({ state: "DONE" }), { action: "state", state: "PROG", undo: true }, "r10");
	assert.deepEqual(calls, [
		["todo", file, "id:t1", "DONE", "--expect", "EVAL"],
		["todo", file, "id:t1", "AUTO", "--expect", "EVAL", "--request", "r2", "--host", "cog", "--agent", "claude", "--who", "Alex", "--note", "Handed to claude on cog from June's board."],
		["reply", file, "id:t1", JSON.stringify({ who: "Alex", text: "Always kit." })],
		["todo", file, "id:t1", "AUTO", "--expect", "EVAL", "--request", "r3", "--host", "kit", "--agent", "claude", "--who", "Alex", "--note", "Resumed with claude on kit from June's board."],
		["schedule", file, "Parent / Hand off", "fri 9:00"],
		["update-task", file, "id:t1", JSON.stringify({ revision: "a".repeat(64), request: "r5", note: "Alex renamed it from June's board.", title: "Hand it off" })],
		["update-task", file, "P / Hand off", JSON.stringify({ revision: "b".repeat(64), request: "r6", note: "Alex renamed it from June's board.", title: "New" })],
		["schedule", file, "id:t1", "sat 9:00"],
		["todo", file, "id:t1", "AUTO", "--expect", "TODO", "--request", "r7", "--host", "kit", "--agent", "pi", "--who", "Alex", "--note", "Handed to pi on kit from June's board."],
		["todo", join(config.org.root, "asana.org"), "id:t1", "DONE", "--expect", "TODO", "--protected"],
		["reschedule-task", file, "id:t1", "2026-11-30 09:00", JSON.stringify({ revision: "c".repeat(64), request: "r9", note: "Moved from June's board.", who: "Alex" })],
		["todo", file, "id:t1", "PROG", "--expect", "DONE"],
	]);
	assert.equal(headingOf(task({ id: undefined, path: ["A", "B"] })), "A / B / Hand off");
	const refused: [TaskEdit, Partial<Task>, RegExp][] = [
		[{ action: "state", state: "AUTO" as never }, {}, /assign a clanker for AUTO/],
		[{ action: "state", state: "TODO" }, { state: undefined }, /no state/],
		[{ action: "assign", agent: "codex" }, {}, /Agent must be one of/],
		[{ action: "assign", agent: "pi", host: "lux" }, {}, /Host must be one of/],
		[{ action: "assign", agent: "pi" }, { state: "PROG" }, /Only a TODO, EVAL or HOLD/],
		[{ action: "reply", text: "  " }, {}, /needs words/],
		[{ action: "deadline", when: "fri\nSCHEDULED: <x>" }, {}, /Give a date/],
		[{ action: "nope" } as never, {}, /Unknown edit/],
		[{ action: "title", title: "two\nlines" }, { revision: "a".repeat(64) }, /one line/],
		[{ action: "title", title: "Fine" }, {}, /no revision/],
		[{ action: "state", state: "HOLD" }, { protected: true, file: "asana.org" }, /only TODO or DONE/],
		[{ action: "reply", text: "Hi" }, { protected: true, file: "asana.org" }, /only TODO or DONE/],
		[{ action: "assign", agent: "pi", when: "x".repeat(61) }, {}, /Give a date/],
		[{ action: "reply", text: "Back to you", resume: true }, { state: "PROG" }, /Only a TODO, EVAL or HOLD/],
		[{ action: "schedule", when: "fri 9:00" }, { state: "AUTO", revision: "c".repeat(64) }, /Pick a date and time/],
		[{ action: "schedule", when: "2026-11-30" }, { state: "AUTO", id: undefined }, /once the board has its ID/],
		[{ action: "state", state: "EVAL" }, { state: "TODO" }, /TODO does not go to EVAL; its next states are PROG, HOLD, DONE/],
		[{ action: "state", state: "PROG" }, { state: "AUTO" }, /AUTO does not go to PROG/],
		[{ action: "state", state: "PROG" }, { state: "DONE" }, /DONE does not go to PROG/, ],
	];
	for (const [edit, extra, error] of refused) await assert.rejects(edits.apply(task(extra), edit, "r"), error);
	assert.equal(calls.length, 12, "a refused edit runs nothing; undoing PROG to DONE goes back");
});

test("a board edit reports org-edit's own words, and says when the dispatcher held the file too long", async () => {
	const tmp = await tempDir();
	const config = testConfig(tmp.dir, { dispatch: { hosts: ["kit"], host: "kit" } });
	const busy = new TaskEdits(config, async () => { throw Object.assign(new Error("env ...: Command failed"), { exitCode: 75, stderr: "dispatcher or task edit busy; read the task again before retrying\n" }); });
	await assert.rejects(busy.apply(task(), { action: "state", state: "DONE" }, "r"), /held the file for over 25 s/);
	const silent = new TaskEdits(config, async () => { throw Object.assign(new Error("env ...: Command failed"), { exitCode: 1, stderr: "" }); });
	await assert.rejects(silent.apply(task(), { action: "state", state: "DONE" }, "r"), /without saying why/);
	const refuses = new TaskEdits(config, async () => { throw Object.assign(new Error("env ...: long command"), { exitCode: 255, stderr: "Loading x\nexpected EVAL, found AUTO; read the task again\n" }); });
	await assert.rejects(refuses.apply(task(), { action: "state", state: "DONE" }, "r"), (e: Error) => e.message === "expected EVAL, found AUTO; read the task again");
	await tmp.cleanup();
});

let hasEmacs = false;
try { execFileSync("emacs", ["--version"], { stdio: "ignore" }); hasEmacs = true; } catch { /* The org-edit test needs Emacs. */ }

test("through this checkout's org-edit, a board edits a task, refuses a stale state, replies and resumes", { skip: !hasEmacs }, async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	await mkdir(join(root, "work", "demo"), { recursive: true });
	await mkdir(join(tmp.dir, "run"));
	const file = join(root, "work", "demo", "demo.org");
	await writeFile(file, "#+TITLE: Demo\n\n* EVAL Hand off\n:PROPERTIES:\n:ID: 5b0c6c4e-1111-4222-8333-444455556666\n:HOST: kit\n:AGENT: pi\n:REVIEW: agent\n:ASKED: [2026-11-21 Sat 01:00]\n:END:\nBody.\n\n** Dialog\n- Agent [2026-11-18 Wed 15:40]: Kit or cog?\n\n* TODO Plain\n\n* TODO Rename me\n:PROPERTIES:\n:ID: 6c1d7d5f-2222-4333-8444-555566667777\n:END:\n");
	// Its own lock, state and Org root, never the live dispatcher's.
	const env = { ...process.env, HC_TERMINAL_ID: undefined, HOME: tmp.dir, XDG_RUNTIME_DIR: join(tmp.dir, "run"), XDG_STATE_HOME: join(tmp.dir, "state"), ORG_DISPATCH_HOST: "kit", ORG_DISPATCH_ROOT: join(root, "work"), ORG_DISPATCH_EMACS_INIT: join(tmp.dir, "none"), JUNE_CONFIG_DIR: join(tmp.dir, "june"), TZDIR: process.env.TZDIR ?? "/etc/zoneinfo" };
	const run = (argv: readonly string[], timeoutMs: number) => runProcess(["env", "-u", "HC_TERMINAL_ID", "-u", "CLAUDECODE", "-u", "PI_SESSION_ID", ...Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`), ...argv], timeoutMs);
	const config = testConfig(tmp.dir, { org: { root, agendaFiles: join(tmp.dir, "agenda"), people: join(root, "people.org") }, dispatch: { hosts: ["kit", "cog"], host: "kit", agent: "pi", agents: ["pi", "claude"] } });
	const edits = new TaskEdits(config, run);
	const handOff = task({ id: "5b0c6c4e-1111-4222-8333-444455556666", file: "work/demo/demo.org", host: "kit", agent: "pi" });
	await edits.apply(handOff, { action: "reply", text: "Always kit.\nCog only launches what kit hands it.", resume: true }, "board:r1");
	let text = await readFile(file, "utf8");
	assert.match(text, /^\* AUTO Hand off/m, "reply and resume sets AUTO");
	assert.match(text, /^- Alex \[.+\]: Always kit\.\n {2}Cog only launches what kit hands it\.$/m);
	assert.match(text, /^- Alex \[.+\]: Resumed with pi on kit from June's board\.$/m, "the resume is the user's, not June's");
	assert.match(text, /:REVIEW: +agent/, "the user's own resume keeps the heading's review");
	assert.doesNotMatch(text, /:DEPLOY:|June \[/);
	assert.doesNotMatch(text, /:ASKED:/, "leaving EVAL answers the question");
	await assert.rejects(edits.apply(handOff, { action: "state", state: "HOLD" }, "r2"), /expected EVAL, found AUTO/, "the board's stale state is refused");
	const plain = task({ id: undefined, title: "Plain", state: "TODO", file: "work/demo/demo.org" });
	await edits.apply(plain, { action: "schedule", when: "2026-11-28 09:30" }, "r3");
	await edits.apply(plain, { action: "state", state: "PROG" }, "r4");
	text = await readFile(file, "utf8");
	assert.match(text, /^\* PROG Plain\nSCHEDULED: <2026-11-28 Sat 09:30>$/m);
	// The export's revision is the one update-task checks, so a rename from the board goes through.
	const list = join(tmp.dir, "agenda-files");
	await writeFile(list, `${file}\n`);
	const agenda = await loadAgenda(list, root, run, {});
	const exported = agenda.tasks["id:6c1d7d5f-2222-4333-8444-555566667777"]!;
	assert.match(exported.revision ?? "", /^[0-9a-f]{64}$/);
	await edits.apply(exported, { action: "title", title: "Renamed" }, "board:r5");
	text = await readFile(file, "utf8");
	assert.match(text, /^\* TODO Renamed$/m);
	await edits.apply(agenda.tasks["id:5b0c6c4e-1111-4222-8333-444455556666"]!, { action: "title", title: "Handed off" }, "board:r7");
	assert.match(await readFile(file, "utf8"), /^\* AUTO Handed off$/m, "a queued task can be renamed");
	const running = Object.values(agenda.tasks).find((t) => t.title === "Plain")!;
	await assert.rejects(edits.apply(running, { action: "title", title: "No" }, "board:r8"), /never running work/);
	await assert.rejects(edits.apply(exported, { action: "title", title: "Again" }, "board:r6"), /revision changed/, "a stale revision is refused");
	// A protected file takes the user's TODO or DONE and nothing else; org-edit refuses any other write to it.
	const asana = join(root, "asana.org");
	await writeFile(asana, "* TODO Mirrored task\n:PROPERTIES:\n:ID: asana-1\n:ASANA_COMPLETED: false\n:END:\n");
	const mirrored = task({ id: "asana-1", key: "id:asana-1", file: "asana.org", title: "Mirrored task", state: "TODO", protected: true });
	await edits.apply(mirrored, { action: "state", state: "DONE" }, "board:r8");
	assert.match(await readFile(asana, "utf8"), /^\* DONE Mirrored task\nCLOSED: \[/m);
	await assert.rejects(run(["bash", join(import.meta.dirname, "../org/edit/org-edit"), "todo", asana, "id:asana-1", "TODO"], 60_000), /rebuilt by another program/, "without --protected, org-edit refuses");
	await assert.rejects(run(["bash", join(import.meta.dirname, "../org/edit/org-edit"), "todo", asana, "id:asana-1", "HOLD", "--protected"], 60_000), /only TODO or DONE/);
	await assert.rejects(run(["bash", join(import.meta.dirname, "../org/edit/org-edit"), "todo", file, "id:6c1d7d5f-2222-4333-8444-555566667777", "DONE", "--protected"], 60_000), /not a protected file/);
});

test("a client edits a task by key, and the boards refresh at once", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const config = testConfig(tmp.dir);
	const raw = { today: "2026-11-21", days: [{ date: "2026-11-21", entries: [] }], tasks: { "id:t1": { file: join(tmp.dir, "org", "w.org"), line: 1, level: 1, title: "Hand off", state: "EVAL", id: "t1", tags: [], path: [], sessions: [] } } };
	let exports = 0;
	const boards = new Boards({ config: { ...config, org: { ...config.org, root: join(tmp.dir, "org") } }, herdr: new Herdr(config.herdr, async () => JSON.stringify({ terminals: [] })), seenFile: join(tmp.dir, "seen.json"), log: createLogger({ sink: () => {} }), run: async () => { exports++; return JSON.stringify(raw); } });
	const applied: unknown[] = [];
	await openTestDaemon({ ...tmp, faux: fauxProvider(), boards, edits: { apply: async (task, edit, request) => { applied.push([task.key, edit, request.startsWith("board:")]); return { text: "* PROG Hand off\n", key: task.key }; } } });
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const reply = await client.request({ op: "task", requestId: randomUUID(), key: "id:t1", edit: { action: "state", state: "PROG" } });
	assert.deepEqual(reply.type === "task" ? [reply.key, reply.text] : reply, ["id:t1", "* PROG Hand off"]);
	assert.deepEqual(applied, [["id:t1", { action: "state", state: "PROG" }, true]]);
	await until(async () => exports >= 2, 10_000);
	const missing = await client.request({ op: "task", requestId: randomUUID(), key: "id:gone", edit: { action: "state", state: "DONE" } });
	assert.equal(missing.type, "error");
});

test("a task's next edit waits for the agenda to be read again, so it sees what the last one wrote", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const config = testConfig(tmp.dir);
	let state = "TODO";
	const raw = () => ({ today: "2026-11-21", days: [{ date: "2026-11-21", entries: [] }], tasks: { "id:t1": { file: join(tmp.dir, "org", "w.org"), line: 1, level: 1, title: "Hand off", state, id: "t1", tags: [], path: [], sessions: [] } } });
	// The export is slow, as it is on kit; the answer to an edit must not wait for it.
	const boards = new Boards({ config: { ...config, org: { ...config.org, root: join(tmp.dir, "org") } }, herdr: new Herdr(config.herdr, async () => JSON.stringify({ terminals: [] })), seenFile: join(tmp.dir, "seen.json"), log: createLogger({ sink: () => {} }),
		run: async () => { await new Promise((r) => setTimeout(r, 300)); return JSON.stringify(raw()); } });
	const saw: string[] = [];
	await openTestDaemon({ ...tmp, faux: fauxProvider(), boards, edits: { apply: async (task, edit) => { saw.push(task.state ?? ""); state = (edit as { state: string }).state; return { text: "", key: task.key }; } } });
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	await client.request({ op: "agenda", requestId: randomUUID() });
	const started = Date.now();
	const first = await client.request({ op: "task", requestId: randomUUID(), key: "id:t1", edit: { action: "state", state: "PROG" } });
	assert.equal(first.type, "task");
	assert.ok(Date.now() - started < 250, "answered before the agenda is read again");
	const second = await client.request({ op: "task", requestId: randomUUID(), key: "id:t1", edit: { action: "state", state: "DONE" } });
	assert.equal(second.type, "task");
	assert.deepEqual(saw, ["TODO", "PROG"], "the second edit saw the first one's state");
});
