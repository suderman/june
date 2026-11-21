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
import { openTestDaemon, tempDir, testConfig } from "./helpers.ts";

const task = (extra: Partial<Task> = {}): Task => ({ key: "id:t1", id: "t1", file: "work/demo/demo.org", line: 3, level: 1, title: "Hand off", state: "EVAL", tags: [], path: [], project: "Demo", sessions: [], ...extra });

test("each board edit is one org-edit call that names the task and expects the state the board showed", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const config = testConfig(tmp.dir, { dispatch: { hosts: ["kit", "cog"], host: "kit", agent: "pi", agents: ["pi", "claude"] } });
	const calls: string[][] = [];
	const edits = new TaskEdits(config, async (argv) => { calls.push(argv.slice(2)); return "ok\n"; });
	const file = join(config.org.root, "work/demo/demo.org");
	await edits.apply(task(), { action: "state", state: "DONE" }, "r1");
	await edits.apply(task(), { action: "assign", agent: "claude", host: "cog" }, "r2");
	await edits.apply(task({ sessions: ["herdr:kit/claude:abc@t1"] }), { action: "reply", text: " Always kit. ", resume: true }, "r3");
	await edits.apply(task({ id: undefined, path: ["Parent"] }), { action: "schedule", when: "fri 9:00" }, "r4");
	await edits.apply(task({ revision: "a".repeat(64) }), { action: "title", title: " Hand it off " }, "r5");
	assert.deepEqual(calls, [
		["todo", file, "id:t1", "DONE", "--expect", "EVAL"],
		["todo", file, "id:t1", "AUTO", "--expect", "EVAL", "--request", "r2", "--host", "cog", "--agent", "claude", "--note", "Alex assigned it to claude on cog from June's board."],
		["reply", file, "id:t1", JSON.stringify({ who: "Alex", text: "Always kit." })],
		["todo", file, "id:t1", "AUTO", "--expect", "EVAL", "--request", "r3", "--host", "kit", "--agent", "claude", "--note", "Alex replied in Dialog and resumed it from June's board."],
		["schedule", file, "Parent / Hand off", "fri 9:00"],
		["update-task", file, "id:t1", JSON.stringify({ revision: "a".repeat(64), request: "r5", note: "Alex renamed it from June's board.", title: "Hand it off" })],
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
	];
	for (const [edit, extra, error] of refused) await assert.rejects(edits.apply(task(extra), edit, "r"), error);
	assert.equal(calls.length, 6, "a refused edit runs nothing");
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
	await writeFile(file, "#+TITLE: Demo\n\n* EVAL Hand off\n:PROPERTIES:\n:ID: 5b0c6c4e-1111-4222-8333-444455556666\n:HOST: kit\n:AGENT: pi\n:ASKED: [2026-11-21 Sat 01:00]\n:END:\nBody.\n\n** Dialog\n- Agent [2026-11-18 Wed 15:40]: Kit or cog?\n\n* TODO Plain\n\n* TODO Rename me\n:PROPERTIES:\n:ID: 6c1d7d5f-2222-4333-8444-555566667777\n:END:\n");
	// Its own lock, state and Org root, never the live dispatcher's.
	const env = { ...process.env, HC_TERMINAL_ID: undefined, HOME: tmp.dir, XDG_RUNTIME_DIR: join(tmp.dir, "run"), XDG_STATE_HOME: join(tmp.dir, "state"), ORG_DISPATCH_ROOT: join(root, "work"), ORG_DISPATCH_EMACS_INIT: join(tmp.dir, "none"), JUNE_CONFIG_DIR: join(tmp.dir, "june"), TZDIR: process.env.TZDIR ?? "/etc/zoneinfo" };
	const run = (argv: readonly string[], timeoutMs: number) => runProcess(["env", "-u", "HC_TERMINAL_ID", "-u", "CLAUDECODE", "-u", "PI_SESSION_ID", ...Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`), ...argv], timeoutMs);
	const config = testConfig(tmp.dir, { org: { root, agendaFiles: join(tmp.dir, "agenda"), people: join(root, "people.org") }, dispatch: { hosts: ["kit", "cog"], host: "kit", agent: "pi", agents: ["pi", "claude"] } });
	const edits = new TaskEdits(config, run);
	const handOff = task({ id: "5b0c6c4e-1111-4222-8333-444455556666", file: "work/demo/demo.org", host: "kit", agent: "pi" });
	await edits.apply(handOff, { action: "reply", text: "Always kit.\nCog only launches what kit hands it.", resume: true }, "board:r1");
	let text = await readFile(file, "utf8");
	assert.match(text, /^\* AUTO Hand off/m, "reply and resume sets AUTO");
	assert.match(text, /^- Alex \[.+\]: Always kit\.\n {2}Cog only launches what kit hands it\.$/m);
	assert.match(text, /Alex replied in Dialog and resumed it from June's board\./);
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
	await assert.rejects(edits.apply(agenda.tasks["id:5b0c6c4e-1111-4222-8333-444455556666"]!, { action: "title", title: "No" }, "board:r7"), /never queued or running/);
	await assert.rejects(edits.apply(exported, { action: "title", title: "Again" }, "board:r6"), /revision changed/, "a stale revision is refused");
});

test("a client edits a task by key, and the boards refresh at once", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const config = testConfig(tmp.dir);
	const raw = { today: "2026-11-21", days: [{ date: "2026-11-21", entries: [] }], tasks: { "id:t1": { file: join(tmp.dir, "org", "w.org"), line: 1, level: 1, title: "Hand off", state: "EVAL", id: "t1", tags: [], path: [], sessions: [] } } };
	let exports = 0;
	const boards = new Boards({ config: { ...config, org: { ...config.org, root: join(tmp.dir, "org") } }, herdr: new Herdr(config.herdr, async () => JSON.stringify({ terminals: [] })), seenFile: join(tmp.dir, "seen.json"), log: createLogger({ sink: () => {} }), run: async () => { exports++; return JSON.stringify(raw); } });
	const applied: unknown[] = [];
	await openTestDaemon({ ...tmp, faux: fauxProvider(), boards, edits: { apply: async (task, edit, request) => { applied.push([task.key, edit, request.startsWith("board:")]); return "* PROG Hand off\n"; } } });
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const reply = await client.request({ op: "task", requestId: randomUUID(), key: "id:t1", edit: { action: "state", state: "PROG" } });
	assert.deepEqual(reply.type === "task" ? [reply.key, reply.text] : reply, ["id:t1", "* PROG Hand off"]);
	assert.deepEqual(applied, [["id:t1", { action: "state", state: "PROG" }, true]]);
	assert.ok(exports >= 2, "the agenda was read again after the edit");
	const missing = await client.request({ op: "task", requestId: randomUUID(), key: "id:gone", edit: { action: "state", state: "DONE" } });
	assert.equal(missing.type, "error");
});
