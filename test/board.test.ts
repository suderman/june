import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { type Agenda, Boards, loadAgenda, parseDialog, reviewKey, shapeAgenda, shapeAgents, type Task } from "../src/board.ts";
import { Client } from "../src/protocol.ts";
import { createLogger } from "../src/runtime.ts";
import { Herdr } from "../src/tools/herdr.ts";
import { attachView, openTestDaemon, tempDir, testConfig, until } from "./helpers.ts";

const SESSION = "0a1b2c3d-0000-4000-8000-000000000001";

function task(key: string, extra: Partial<Task> = {}): Task {
	return { key, file: "work/demo/demo.org", line: 1, level: 1, title: key, tags: [], path: [], project: "Demo", sessions: [], ...extra };
}

function agenda(tasks: Task[]): Agenda {
	return { generatedAt: 0, today: "2026-11-20", overdue: [], days: [], tasks: Object.fromEntries(tasks.map((t) => [t.key, t])), counts: {}, projects: [] };
}

test("Dialog entries keep who wrote them, their timestamp, and continuation lines", () => {
	assert.deepEqual(parseDialog("- Agent [2026-11-18 Wed 15:40]: Which branch?\n  Main or release.\n- Alex [2026-11-19 Thu]: Main.\n- a loose item"), [
		{ who: "Agent", at: "[2026-11-18 Wed 15:40]", text: "Which branch?\nMain or release." },
		{ who: "Alex", at: "[2026-11-19 Thu]", text: "Main." },
		{ who: "", text: "a loose item" },
	]);
});

test("the agenda splits today's overdue items from today, and shows a deadline this week on its own day", () => {
	const raw = {
		today: "2026-11-20",
		days: [
			{ date: "2026-11-20", entries: [
				{ task: "/o/a.org::3", type: "past-scheduled", extra: "Sched. 2x:", date: "2026-11-18" },
				{ task: "/o/a.org::5", type: "deadline", extra: "2 d. ago:", date: "2026-11-18" },
				{ task: "/o/a.org::9", type: "upcoming-deadline", extra: "In 3 d.:", date: "2026-11-23" },
				{ task: "/o/a.org::11", type: "upcoming-deadline", extra: "In 12 d.:", date: "2026-12-02" },
				{ task: "/o/a.org::7", type: "scheduled", time: "09:30", date: "2026-11-20" },
			] },
			{ date: "2026-11-23", entries: [{ task: "/o/a.org::9", type: "deadline", date: "2026-11-23" }] },
		],
		tasks: Object.fromEntries([3, 5, 7, 9, 11].map((line) => [`/o/a.org::${line}`, { file: "/o/a.org", line, level: 1, title: `t${line}`, state: line === 7 ? "PROG" : "TODO", fileTitle: "A", tags: [], path: [], sessions: [], id: null, dialog: null }])),
	};
	const a = shapeAgenda(raw, "/o");
	assert.deepEqual(a.overdue.map((e) => e.task), ["a.org::3", "a.org::5"]);
	assert.deepEqual(a.days[0]!.entries.map((e) => e.task), ["a.org::7", "a.org::11"], "the deadline on the 23rd waits for its day; timed items first");
	assert.deepEqual(a.days[1]!.entries.map((e) => [e.task, e.type]), [["a.org::9", "deadline"]]);
	assert.equal(a.tasks["a.org::7"]!.file, "a.org");
	assert.deepEqual(a.counts, { TODO: 4, PROG: 1 });
	assert.deepEqual(a.projects, [{ file: "a.org", title: "A", counts: { TODO: 4, PROG: 1 } }]);
});

test("agents join their tasks and rank what needs the user: a blocked worker, then a new review; HOLD and agent reviews are not theirs", () => {
	const now = Date.UTC(2026, 10, 20, 20);
	const tasks = [
		task("id:run", { id: "run", state: "PROG" }),
		task("id:asks", { id: "asks", state: "HOLD", dialog: [{ who: "Agent", at: "[x]", text: "Which branch?" }], sessions: [`herdr:cog/claude:${SESSION}@t4`] }),
		task("id:dev", { id: "dev", state: "EVAL", devReview: true }),
		task("id:rev", { id: "rev", state: "AUTO", reviewParent: "dev" }),
		task("id:checked", { id: "checked", state: "EVAL", reviewParent: "other" }),
		task("id:review", { state: "EVAL", headline: { text: "Done, check it.", state: "EVAL", at: now - 60_000 } }),
		task("id:seen", { state: "EVAL", headline: { text: "Old.", state: "EVAL", at: now - 3_600_000 } }),
		task("id:later", { state: "AUTO", scheduled: "<2026-11-22 Sun 09:00>", host: "kit", agent: "pi" }),
		task("id:sooner", { state: "AUTO", scheduled: "<2026-11-21 Sat 04:30>", host: "kit", agent: "pi" }),
		task("id:finished", { state: "DONE", headline: { text: "All green.", state: "DONE", at: now - 7_200_000 } }),
		task("id:stale", { state: "DONE", headline: { text: "Last week.", state: "DONE", at: now - 8 * 86_400_000 } }),
	];
	const board = agenda(tasks);
	const workers = [
		{ host: "kit", terminal: "t7", agent: "pi", status: "blocked", cwd: "/w", task: "run" },
		{ host: "cog", terminal: "t4", agent: "claude", status: "idle", cwd: "/w", session: SESSION },
		{ host: "kit", terminal: "t9", agent: "claude", status: "working", cwd: "/w" },
	];
	const seen = new Set([reviewKey(board.tasks["id:seen"]!)]);
	const a = shapeAgents({ workers, hosts: [{ host: "kit", ok: true }], agenda: board, seen, now });
	assert.deepEqual(a.workers.map((w) => w.taskKey), ["id:run", "id:asks", undefined]);
	assert.deepEqual(a.needs.map((n) => [n.level, n.kind, n.task]), [[1, "blocked", "id:run"], [2, "review", "id:review"]], "a HOLD with an agent's question waits on the outside world");
	assert.deepEqual(a.reviewing, ["id:dev", "id:checked"]);
	assert.deepEqual(a.needs[0]!.worker, { host: "kit", terminal: "t7" });
	assert.deepEqual(a.queued, ["id:rev", "id:sooner", "id:later"]);
	assert.deepEqual(a.recent, ["id:seen", "id:finished"], "a review already in needs is not repeated; last week is gone");
	assert.deepEqual(Object.keys(a.tasks).sort(), ["id:asks", "id:checked", "id:dev", "id:finished", "id:later", "id:rev", "id:review", "id:run", "id:seen", "id:sooner"]);
});

/** A fake export: the tasks given, as june-agenda.el prints them, on its last line after a log line. */
function exportRun(tasks: () => Record<string, object>) {
	return async (argv: readonly string[]) => {
		if (argv.includes("june-agenda-export")) return `org-dispatch: a log line\n${JSON.stringify({ today: "2026-11-20", days: [{ date: "2026-11-20", entries: [] }], tasks: tasks() })}\n`;
		throw new Error(`unexpected ${argv.join(" ")}`);
	};
}

const evalTask = (title: string, at: number) => ({ file: "/o/w.org", line: 1, level: 1, title, state: "EVAL", tags: [], path: [], sessions: [], headline: title, headlineState: "EVAL", headlineAt: String(at / 1000) });

test("reviews present when marks start count as seen; a new one is a need until it is seen", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const config = testConfig(tmp.dir);
	let tasks: Record<string, object> = { "id:old": evalTask("Old review", 1_000_000) };
	const herdr = new Herdr(config.herdr, async () => JSON.stringify({ terminals: [] }));
	const seenFile = join(tmp.dir, "seen.json");
	const boards = new Boards({ config: { ...config, org: { ...config.org, root: "/o" } }, herdr, seenFile, log: createLogger({ sink: () => {} }), run: exportRun(() => tasks) });
	t.after(() => boards.stop());
	assert.deepEqual((await boards.agents()).value.needs, []);
	tasks = { ...tasks, "id:new": evalTask("New review", 2_000_000) };
	const changed = (await boards.agents(0));
	await boards.agenda(0);
	const after = await boards.agents(0);
	assert.ok(changed.revision);
	assert.deepEqual(after.value.needs.map((n) => n.task), ["id:new"]);
	const marked = await boards.seen(["id:new"]);
	assert.deepEqual(marked.value.needs, []);
	assert.notEqual(marked.revision, after.revision);
	assert.equal(JSON.parse(await readFile(seenFile, "utf8")).length, 2);
});

test("a client asks for the boards, and its view state then carries their revisions", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const config = testConfig(tmp.dir);
	const herdr = new Herdr(config.herdr, async (argv) =>
		argv.includes("ls") ? JSON.stringify({ terminals: [{ address: "t7", agent: "pi", state: "live", status: "blocked" }] }) : JSON.stringify({ address: "t7", state: "live", labels: { "org.task": "w" } }));
	const boards = new Boards({ config: { ...config, org: { ...config.org, root: "/o" } }, herdr, seenFile: join(tmp.dir, "seen.json"), log: createLogger({ sink: () => {} }), run: exportRun(() => ({ "id:w": { ...evalTask("Worker task", 1_000_000), id: "w", state: "PROG" } })), agentsMs: 50 });
	await openTestDaemon({ ...tmp, faux: fauxProvider(), boards });
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());
	assert.equal(view.state().boards, undefined, "no revisions before anyone asks");
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const agendaReply = await client.request({ op: "agenda", requestId: randomUUID() });
	assert.equal(agendaReply.type, "agenda");
	const agentsReply = await client.request({ op: "agents", requestId: randomUUID() });
	assert.ok(agentsReply.type === "agents");
	assert.deepEqual(agentsReply.agents.needs.map((n) => [n.kind, n.task]), [["blocked", "id:w"]]);
	await until(() => view.state().boards?.agents === agentsReply.revision);
	assert.equal(view.state().boards?.agenda, agendaReply.type === "agenda" ? agendaReply.revision : "");
	const refused = await client.request({ op: "seen", requestId: randomUUID(), keys: "id:w" as never });
	assert.equal(refused.type, "error");
});

let hasEmacs = false;
try { execFileSync("emacs", ["--version"], { stdio: "ignore" }); hasEmacs = true; } catch { /* The export test needs Emacs. */ }

/** A Calgary date `days` from today, as Org writes it, with an optional time. */
function stamp(days: number, time = "", open = "<", close = ">"): string {
	const at = new Date(Date.now() + days * 86_400_000);
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Edmonton", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(at).map((p) => [p.type, p.value]));
	return `${open}${parts.year}-${parts.month}-${parts.day} ${parts.weekday}${time ? ` ${time}` : ""}${close}`;
}

test("the Emacs export follows Org's agenda and reads tasks, AUTO defaults, Dialog and sessions", { skip: !hasEmacs }, async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	await mkdir(join(root, "work", "demo"), { recursive: true });
	await mkdir(join(tmp.dir, "june"));
	await writeFile(join(tmp.dir, "june", "config.json"), JSON.stringify({ dispatch: { hosts: ["kit", "cog"], host: "cog", agent: "claude" } }));
	const file = join(root, "work", "demo", "demo.org");
	await writeFile(file, `#+TITLE: Demo

* TODO Overdue thing
DEADLINE: ${stamp(-2)}

* TODO Today thing
SCHEDULED: ${stamp(0, "09:30")}

* Weekly planning
${stamp(0, "14:00")}

* TODO [#A] Due soon :work:
DEADLINE: ${stamp(3)}

* AUTO Queued work
SCHEDULED: ${stamp(1, "23:30")}

* HOLD Waiting for Alex
:PROPERTIES:
:ID: 5b0c6c4e-1111-4222-8333-444455556666
:HEADLINE: Which branch should it use?
:HEADLINE_STATE: HOLD
:END:
** Sessions
- [[herdr:kit/claude:${SESSION}@t9][claude@kit]]

** Dialog
- Agent [2026-11-18 Wed 15:40]: Which branch?
  Main or release.

* EVAL Review of the waiting task
:PROPERTIES:
:REVIEW: yes
:REVIEW_PARENT: 5b0c6c4e-1111-4222-8333-444455556666
:END:

* DONE Finished recently
CLOSED: ${stamp(-1, "10:00", "[", "]")}

* DONE Finished long ago
CLOSED: [2026-01-01 Thu 10:00]

* Plain note
`);
	const list = join(tmp.dir, "agenda-files");
	await writeFile(list, `${file}\n${join(root, "missing.org")}\n`);
	const a = await loadAgenda(list, root, undefined, { JUNE_CONFIG_DIR: join(tmp.dir, "june"), ORG_DISPATCH_HOSTS: "kit cog" });
	const titles = (entries: { task: string }[]) => entries.map((e) => a.tasks[e.task]!.title);
	assert.deepEqual(titles(a.overdue), ["Overdue thing"]);
	assert.deepEqual(titles(a.days[0]!.entries).sort(), ["Today thing", "Weekly planning"]);
	assert.equal(a.days[0]!.entries.find((e) => a.tasks[e.task]!.title === "Today thing")!.time, "09:30");
	assert.deepEqual(a.days.map((d) => titles(d.entries).includes("Due soon")), [false, false, false, true, false, false, false]);
	assert.deepEqual(titles(a.days[1]!.entries), ["Queued work"]);
	const byTitle = Object.fromEntries(Object.values(a.tasks).map((t) => [t.title, t]));
	assert.deepEqual(Object.keys(byTitle).sort(), ["Due soon", "Finished recently", "Overdue thing", "Queued work", "Review of the waiting task", "Today thing", "Waiting for Alex", "Weekly planning"]);
	assert.deepEqual([byTitle["Review of the waiting task"]!.review, byTitle["Review of the waiting task"]!.reviewParent], ["yes", "5b0c6c4e-1111-4222-8333-444455556666"]);
	assert.deepEqual([byTitle["Due soon"]!.priority, byTitle["Due soon"]!.tags], ["A", ["work"]]);
	assert.deepEqual([byTitle["Queued work"]!.host, byTitle["Queued work"]!.agent], ["cog", "claude"]);
	const hold = byTitle["Waiting for Alex"]!;
	assert.equal(hold.key, "id:5b0c6c4e-1111-4222-8333-444455556666");
	assert.deepEqual(hold.dialog, [{ who: "Agent", at: "[2026-11-18 Wed 15:40]", text: "Which branch?\nMain or release." }]);
	assert.deepEqual(hold.sessions, [`herdr:kit/claude:${SESSION}@t9`]);
	assert.deepEqual(hold.headline, { text: "Which branch should it use?", state: "HOLD" });
	assert.equal(byTitle["Today thing"]!.key, "work/demo/demo.org::6");
	assert.equal(byTitle["Today thing"]!.project, "Demo");
	assert.deepEqual(a.counts, { TODO: 3, AUTO: 1, HOLD: 1, EVAL: 1, DONE: 1 });
});
