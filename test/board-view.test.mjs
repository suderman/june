// The boards as the clients draw them (desktop/board.mjs), shared by the desktop client and the phone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agendaView, agentsView, boardLayout, dayHeading, dialogKind, entryMeta, harnessOf, stampShort, startOf, stateRows, taskDetail, taskLink } from "../desktop/board.mjs";

test("three columns fit a 1400 px window with the strip a little narrower, and tabs take over below about 1300", () => {
	assert.deepEqual(boardLayout(1400), { columns: true, side: 268, gap: 20, strip: 784 });
	assert.equal(boardLayout(1700).strip, 820, "never wider than the strip's own width");
	assert.equal(boardLayout(1296).columns, true);
	assert.deepEqual(boardLayout(1295), { columns: false, side: 0, gap: 20, strip: 820 });
	assert.equal(boardLayout(390).strip, 390);
});

const task = (key, extra = {}) => ({ key, file: "work/demo/demo.org", line: 7, level: 1, title: key, tags: [], path: [], project: "Demo", sessions: [], ...extra });

test("the agenda reads as overdue, today, and the week with each day named once, in plain words", () => {
	const agenda = {
		generatedAt: 0, today: "2026-11-21",
		overdue: [{ task: "a", type: "past-scheduled", extra: "Sched. 3x:", date: "2026-11-18" }],
		days: [
			{ date: "2026-11-21", entries: [{ task: "b", type: "scheduled", time: "04:30", extra: "Scheduled:" }, { task: "c", type: "timestamp", time: "10:00" }] },
			{ date: "2026-11-22", entries: [{ task: "d", type: "deadline", extra: "Deadline:" }, { task: "e", type: "block", extra: "(2/5):" }] },
			{ date: "2026-11-23", entries: [] },
		],
		tasks: { a: task("a", { state: "TODO" }), b: task("b", { state: "AUTO", agent: "pi", host: "kit" }), c: task("c"), d: task("d", { state: "TODO" }), e: task("e") },
		counts: { TODO: 2, AUTO: 1, PROG: 0 }, projects: [{ file: "work/demo/demo.org", title: "Demo", counts: { TODO: 2, AUTO: 1 } }],
	};
	const v = agendaView(agenda);
	assert.deepEqual(v.sections.map((s) => [s.id, s.title, s.rows.length]), [["overdue", "OVERDUE · 1", 1], ["today", "TODAY · SAT NOV 21", 2], ["week", "THIS WEEK", 2]]);
	assert.equal(v.sections[0].rows[0].meta, "scheduled 3 days ago · Demo");
	assert.equal(v.sections[1].rows[0].meta, "scheduled · pi on kit · Demo", "an AUTO task says who runs it and where");
	assert.deepEqual(v.sections[2].rows.map((r) => [r.day, r.meta]), [["Sun", "due · Demo"], ["", "day 2 of 5 · Demo"]]);
	assert.equal(v.sections[1].rows[0].link, "file:~/org/work/demo/demo.org::7");
	assert.deepEqual(v.counts, [{ state: "AUTO", n: 1 }, { state: "TODO", n: 2 }]);
	assert.deepEqual(v.projects[0].counts, [{ state: "AUTO", n: 1 }, { state: "TODO", n: 2 }]);
	assert.deepEqual(stateRows(agenda, "TODO").map((r) => r.title), ["a", "d"]);
	assert.deepEqual(agendaView(null).sections, []);
});

test("small words: days, links, prefixes, start times and harnesses", () => {
	assert.equal(dayHeading("2026-11-22"), "SUN NOV 22");
	assert.equal(taskLink(undefined), null);
	assert.equal(entryMeta({ extra: "In   7 d.:", type: "upcoming-deadline" }, task("x")), "due in 7 days · Demo");
	assert.equal(entryMeta({ extra: "1 d. ago:", type: "deadline" }, task("x")), "deadline 1 day ago · Demo");
	assert.equal(startOf("<2026-11-21 Sat 04:30 ++1d>", "2026-11-21"), "today 04:30");
	assert.equal(startOf("<2026-11-27 Fri>", "2026-11-21"), "Fri");
	assert.deepEqual([harnessOf("pi"), harnessOf("claude-code"), harnessOf("codex")], ["pi", "claude", "other"]);
});

test("the agents board puts what needs the user first, in its own words, and links each card where it opens", () => {
	const now = Date.UTC(2026, 10, 21, 8);
	const agents = {
		generatedAt: now, hosts: [{ host: "kit", ok: true }, { host: "cog", ok: false, error: "down" }],
		workers: [
			{ host: "kit", terminal: "t7", agent: "pi", status: "blocked", cwd: "/w", title: "Allow: systemctl stop?", herdrLink: "herdr:kit/pi:s@t7", taskKey: "id:run" },
			{ host: "kit", terminal: "t9", agent: "claude", status: "working", cwd: "/home/jon/src/demo", taskKey: "id:build" },
			{ host: "kit", terminal: "t2", agent: "pi", status: "idle", cwd: "/home/jon/org" },
		],
		needs: [
			{ level: 1, kind: "blocked", task: "id:run", worker: { host: "kit", terminal: "t7" } },
			{ level: 2, kind: "asks", task: "id:ask" },
			{ level: 2, kind: "review", task: "id:done" },
		],
		queued: ["id:later"], reviewing: ["id:rev"], recent: ["id:old"],
		tasks: {
			"id:run": task("id:run", { title: "Validate stopping", state: "PROG" }),
			"id:build": task("id:build", { title: "Build it", state: "PROG" }),
			"id:ask": task("id:ask", { title: "Hand off", state: "EVAL", host: "cog", sessions: ["herdr:cog/claude:abc@t2"], dialog: [{ who: "Agent", text: "Kit or cog?\nSecond line." }, { who: "Alex", text: "Thinking." }] }),
			"id:done": task("id:done", { title: "Serve it", state: "EVAL", headline: { text: "Feeds are live.", state: "EVAL", at: now - 60_000 } }),
			"id:later": task("id:later", { title: "Steady", state: "AUTO", agent: "pi", host: "kit", scheduled: "<2026-11-21 Sat 23:30>" }),
			"id:rev": task("id:rev", { title: "Reviewed", state: "EVAL" }),
			"id:old": task("id:old", { title: "Report", state: "DONE", headline: { text: "All green.", state: "DONE", at: now - 7_200_000 } }),
		},
	};
	const v = agentsView(agents, now, "2026-11-21", "Alex");
	assert.deepEqual(v.needs.map((n) => [n.label, n.title, n.line, n.harness, n.where, n.link]), [
		["NEEDS PERMISSION", "Validate stopping", "Allow: systemctl stop?", "pi", "kit · t7", "herdr:kit/pi:s@t7"],
		["ASKS YOU", "Hand off", "Kit or cog?", "claude", "cog · EVAL", "file:~/org/work/demo/demo.org::7"],
		["READY FOR YOUR REVIEW", "Serve it", "Feeds are live.", "other", "EVAL", "file:~/org/work/demo/demo.org::7"],
	]);
	assert.deepEqual(v.working.map((w) => [w.title, w.harness]), [["Build it", "claude"]]);
	assert.deepEqual(v.idle.map((w) => [w.title, w.link]), [["org", null]], "a blocked worker is a need, not idle; a bare terminal names its directory");
	assert.deepEqual(v.queued.map((q) => [q.title, q.who, q.when]), [["Steady", "pi on kit", "today 23:30"]]);
	assert.deepEqual(v.recent.map((r) => [r.title, r.when]), [["Report", "2 h"]]);
	assert.equal(v.summary, "1 at work on kit");
	assert.deepEqual(v.down, ["cog"]);
});

test("a task's page names who works it, what it waits on, and draws its Dialog by who wrote each entry", () => {
	const t = task("id:ask", {
		title: "Hand off", state: "EVAL", host: "cog", review: "agent", scheduled: "<2026-11-22 Sun 09:00>", path: ["Parent"],
		sessions: ["herdr:kit/pi:a@t1", "herdr:cog/claude:b@t2"], headline: { text: "Kit or cog?", state: "EVAL" }, asked: "[2026-11-21 Sat 01:00]",
		dialog: [{ who: "Dispatcher", at: "[2026-11-18 Wed 14:02]", text: "started claude on cog" }, { who: "Agent", at: "[2026-11-18 Wed 15:40]", text: "Kit or cog?" }, { who: "June", at: "[2026-11-18 Wed 15:41]", text: "It's yours." }, { who: "Alex", at: "[2026-11-19 Thu]", text: "Thinking." }],
	});
	const d = taskDetail(t, "Alex", "2026-11-21");
	assert.equal(d.facts, "claude on cog · scheduled Sun 09:00 · agent review");
	assert.equal(d.herdr, "herdr:cog/claude:b@t2");
	assert.equal(d.emacs, "file:~/org/work/demo/demo.org::7");
	assert.equal(d.path, "Parent");
	assert.equal(d.asked, true);
	assert.deepEqual(d.dialog.map((e) => [e.kind, e.at]), [["dispatcher", "Nov 18 14:02"], ["agent", "Nov 18 15:40"], ["june", "Nov 18 15:41"], ["user", "Nov 19"]]);
	assert.equal(taskDetail(undefined, "Alex", ""), null);
	assert.equal(dialogKind("Pi", "Alex"), "agent");
	assert.equal(stampShort("nonsense"), "");
});
