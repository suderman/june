// The boards as the clients draw them (desktop/board.mjs), shared by the desktop client and the phone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agendaView, agentsView, boardLayout, dayHeading, dayWord, dialogKind, entryMeta, findTask, harnessOf, monthDays, pendingTask, pickerStart, quickDays, stampOf, stampShort, startOf, startsAt, stateRows, taskDetail, taskLink } from "../desktop/board.mjs";

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
	assert.equal(d.facts, "claude on cog · scheduled tomorrow 09:00 · agent review");
	assert.equal(d.herdr, "herdr:cog/claude:b@t2");
	assert.equal(d.emacs, "file:~/org/work/demo/demo.org::7");
	assert.equal(d.path, "Parent");
	assert.equal(d.asked, true);
	assert.deepEqual(d.dialog.map((e) => [e.kind, e.at]), [["dispatcher", "Nov 18 14:02"], ["agent", "Nov 18 15:40"], ["june", "Nov 18 15:41"], ["user", "Nov 19"]]);
	assert.equal(taskDetail(undefined, "Alex", ""), null);
	assert.equal(dialogKind("Pi", "Alex"), "agent");
	const sat = new Date(2026, 10, 21, 8, 0).getTime();
	assert.equal(taskDetail(t, "Alex", "2026-11-21", sat).starts, "tomorrow 09:00", "a schedule still ahead is when it would start");
	assert.equal(startsAt(task("x", { scheduled: "<2026-11-21 Sat 07:30>" }), "2026-11-21", sat), "now");
	assert.equal(startsAt(task("x", { scheduled: "<2026-11-21 Sat 9:30>" }), "2026-11-21", sat), "today 9:30");
	assert.equal(startsAt(task("x"), "2026-11-21", sat), "now");
	assert.deepEqual([d.host, d.agent, d.protected, d.file], ["cog", "claude", false, "work/demo/demo.org"]);
	assert.equal(stampShort("nonsense"), "");
});

test("a page follows its task when the dispatcher gives it an ID", () => {
	const claimed = task("id:new", { title: "Set up forwarding", path: ["Clinic"], file: "work/c/c.org" });
	const tasks = { "id:new": claimed, "id:other": task("id:other") };
	assert.equal(findTask(tasks, "id:new"), claimed);
	assert.equal(findTask(tasks, "work/c/c.org::*Clinic/Set up forwarding"), claimed);
	assert.equal(findTask(tasks, "work/c/c.org::*Gone"), null);
	assert.equal(findTask(null, "x"), null);
});

test("dates are named so they cannot be read as the wrong week", () => {
	const today = "2026-11-21";
	assert.deepEqual(["2026-11-21", "2026-11-22", "2026-11-20", "2026-11-23", "2026-11-27", "2026-11-28", "2026-11-16", "2027-01-04"].map((d) => dayWord(d, today)),
		["today", "tomorrow", "yesterday", "Mon", "Fri", "Nov 28", "Nov 16", "Jan 4 2027"]);
	assert.equal(startOf("<2026-11-16 Mon>", today), "Nov 16", "last Monday is not this Monday");
	assert.equal(startOf("<2026-11-23 Mon 09:00>", today), "Mon 09:00");
});

test("a picker starts from a task's date, offers quick days, and writes what org-edit reads", () => {
	assert.deepEqual(pickerStart("<2026-11-23 Mon 9:00 ++1w>", "2026-11-21"), { date: "2026-11-23", time: "09:00" });
	assert.deepEqual(pickerStart(undefined, "2026-11-21"), { date: "2026-11-21", time: "" });
	assert.deepEqual(quickDays("2026-11-21").map((q) => [q.label, q.date]), [["today", "2026-11-21"], ["tomorrow", "2026-11-22"], ["Mon", "2026-11-23"], ["in a week", "2026-11-28"]]);
	assert.deepEqual(quickDays("2026-11-22").map((q) => q.label), ["today", "tomorrow", "in a week"], "on Sunday, tomorrow is Monday");
	const nov = monthDays(2026, 11, "2026-11-21");
	assert.equal(nov.title, "Nov 2026");
	assert.equal(nov.weeks[0][0].date, "2026-11-01", "November 2026 starts on a Sunday");
	assert.deepEqual(nov.weeks[2].filter((d) => d.today).map((d) => d.date), ["2026-11-21"]);
	assert.equal(nov.weeks[0][0].past, true);
	assert.ok(nov.weeks.every((w) => w.length === 7));
	assert.equal(stampOf("2026-11-23 9:00"), "<2026-11-23 Mon 09:00>");
	assert.equal(stampOf("2026-11-23"), "<2026-11-23 Mon>");
	assert.equal(stampOf("fri"), undefined);
});

test("an edit on its way shows as made, and the page takes no other until it lands", () => {
	const t = task("id:p", { title: "Party", state: "TODO", scheduled: "<2026-11-22 Sun 15:00 ++1w>", dialog: [] });
	assert.equal(pendingTask(t, { action: "state", state: "DONE" }).state, "DONE");
	const handed = pendingTask(t, { action: "assign", agent: "pi", host: "cog", when: "2026-11-23 09:00" });
	assert.deepEqual([handed.state, handed.agent, handed.host, handed.scheduled], ["AUTO", "pi", "cog", "<2026-11-23 Mon 09:00>"]);
	assert.equal(pendingTask(t, { action: "deadline", when: "none" }).deadline, undefined);
	const replied = taskDetail(t, "Alex", "2026-11-21", 0, { change: { action: "reply", text: "On it", resume: true } });
	assert.deepEqual([replied.state, replied.busy, replied.dialog[0].who, replied.dialog[0].at], ["AUTO", true, "Alex", "sending…"]);
	assert.equal(taskDetail(t, "Alex", "2026-11-21", 0).busy, false);
	const agenda = { generatedAt: 0, today: "2026-11-21", overdue: [{ task: "id:p", type: "deadline", date: "2026-11-20" }], days: [{ date: "2026-11-21", entries: [] }], tasks: { "id:p": t }, counts: {}, projects: [] };
	assert.equal(agendaView(agenda, { "id:p": { change: { action: "state", state: "DONE" } } }).sections[0].rows[0].state, "DONE");
	assert.equal(agenda.tasks["id:p"].state, "TODO", "the board itself is left as the daemon sent it");
	assert.deepEqual(stateRows(agenda, "EVAL", { "id:p": { change: { action: "state", state: "EVAL" } } }).map((r) => r.key), ["id:p"]);
	const agents = { generatedAt: 0, user: "Alex", hosts: [], workers: [], needs: [{ level: 2, kind: "review", task: "id:p" }], queued: [], reviewing: [], recent: [], tasks: { "id:p": { ...t, state: "EVAL" } } };
	assert.equal(agentsView(agents, 0, "2026-11-21", "Alex").needs.length, 1);
	assert.equal(agentsView(agents, 0, "2026-11-21", "Alex", { seen: ["id:p"] }).needs.length, 0, "a review opened is seen at once");
});

test("open tasks are listed by state, dated or not, newest-touched projects first, with the rest a tap away", () => {
	const tasks = {};
	const add = (key, extra) => { tasks[key] = task(key, extra); };
	for (let i = 0; i < 7; i++) add(`old${i}`, { state: "TODO", file: "old.org", line: i, project: "Old" });
	add("new", { state: "TODO", file: "new.org", line: 3, project: "Uptime" });
	add("dated", { state: "TODO", file: "new.org", line: 9, project: "Uptime", deadline: "<2026-11-20 Fri>", scheduled: "<2026-11-23 Mon 09:00>" });
	add("prog", { state: "PROG", file: "old.org", line: 20, project: "Old" });
	add("queued", { state: "AUTO", file: "old.org", line: 30, project: "Old" });
	const agenda = { generatedAt: 0, today: "2026-11-21", overdue: [], days: [{ date: "2026-11-21", entries: [] }], tasks, counts: {},
		projects: [{ file: "old.org", title: "Old", counts: {}, changed: 100 }, { file: "new.org", title: "Uptime", counts: {}, changed: 900 }] };
	const v = agendaView(agenda);
	assert.deepEqual(v.lists.map((l) => [l.title, l.n, l.rows.length, l.more]), [["IN PROGRESS", 1, 1, 0], ["TO DO", 9, 5, 4]], "empty states and AUTO are left out");
	assert.equal(v.queued, 1);
	assert.deepEqual(v.lists[1].rows.slice(0, 3).map((r) => r.key), ["new", "dated", "old0"], "a file just changed comes first, in its own order");
	assert.equal(v.lists[1].rows[0].meta, "Uptime", "a task without dates says only its project");
	assert.equal(v.lists[1].rows[1].meta, "Uptime · due yesterday · scheduled Mon 09:00");
	assert.equal(v.lists[1].rows[1].overdue, true);
	assert.equal(stateRows(agenda, "TODO").length, 9);
	assert.deepEqual(agendaView(agenda, { new: { change: { action: "state", state: "PROG" } } }).lists.map((l) => l.n), [2, 8], "an edit on its way moves its row");
});

test("a task repeating every day has a row on each day, each with its own key", () => {
	const daily = task("id:mail", { title: "Check school mail", state: "AUTO", scheduled: "<2026-11-22 Sun 04:30 ++1d>" });
	const entry = { task: "id:mail", type: "scheduled", time: "04:30", date: "2026-11-22" };
	const agenda = { generatedAt: 0, today: "2026-11-21", overdue: [], tasks: { "id:mail": daily }, counts: {}, projects: [],
		days: [{ date: "2026-11-21", entries: [] }, { date: "2026-11-22", entries: [entry] }, { date: "2026-11-23", entries: [entry] }, { date: "2026-11-24", entries: [entry] }] };
	const week = agendaView(agenda).sections.find((s) => s.id === "week");
	assert.equal(week.rows.length, 3);
	assert.equal(new Set(week.rows.map((r) => r.key)).size, 3);
});

test("taps while an edit is on its way queue behind it, the same kind settling on the last", async () => {
	const { enqueue, nextQueued, applyEntry } = await import("../desktop/board.mjs");
	let q = enqueue([], { action: "state", state: "TODO" });
	q = enqueue(q, { action: "state", state: "PROG" });
	q = enqueue(q, { action: "reply", text: "a" });
	q = enqueue(q, { action: "reply", text: "b" });
	assert.deepEqual(q.map((c) => c.state ?? c.text), ["PROG", "a", "b"]);
	assert.deepEqual(nextQueued({ action: "state", state: "PROG" }, [{ action: "state", state: "PROG" }]), [], "back where it already is: nothing to send");
	assert.deepEqual(nextQueued({ action: "state", state: "PROG" }, [{ action: "state", state: "DONE" }]).map((c) => c.state), ["DONE"]);
	const t = task("id:x", { state: "TODO", dialog: [] });
	const shown = applyEntry(t, { applied: [{ action: "state", state: "PROG" }], change: { action: "title", title: "New" }, queue: [{ action: "state", state: "DONE" }] }, "Alex");
	assert.deepEqual([shown.state, shown.title, shown.pending], ["DONE", "New", true]);
	assert.equal(applyEntry(t, { change: { action: "state", state: "EVAL" }, done: true }).pending, false);
});
