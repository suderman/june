import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import { createFollowTask, follow } from "../src/tools/follow.ts";
import { message } from "../src/watch.ts";
import { openTestDaemon, tempDir, until } from "./helpers.ts";

const task = (state: string, title: string, id: string, report?: { line: string; state?: string; at?: number }) =>
	`* ${state} ${title} :kit:\n:PROPERTIES:\n:ID: ${id}\n${report ? `:DISPATCH_HEADLINE: ${report.line}\n${report.state ? `:DISPATCH_HEADLINE_STATE: ${report.state}\n` : ""}${report.at ? `:DISPATCH_HEADLINE_AT: ${report.at}\n` : ""}` : ""}:END:\nBody.\n`;
const lastInput = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.filter((m) => m.role === "user").at(-1));

test("the watch learns what is there, then gathers dispatched news into one notice, in waking hours, at most every gap", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const org = join(tmp.dir, "org");
	const home = join(tmp.dir, "home");
	const records = join(home, ".local/state/org-dispatch");
	await mkdir(org, { recursive: true });
	await mkdir(records, { recursive: true });
	const tasks = join(org, "work.org");
	let mine = "PROG";
	let tidy = "PROG";
	const text = (a: string, c: string) => [task(a, "Ship the site", "task-ship-0001"), task("DONE", "Old audit", "task-old-0002"), task(c, "Fix the build", "task-build-0003"), task(mine, "June's own", "task-mine-0004"), task(tidy, "Tidy notes", "task-tidy-0005")].join("\n");
	const write = (a: string, c: string) => writeFile(tasks, text(a, c));
	await write("PROG", "PROG");
	await writeFile(join(records, "task-mine-0004.json"), JSON.stringify({ id: "task-mine-0004", heading: "June's own", status: "running", started: 100 }));
	await writeFile(join(records, "task-ship-0001.json"), JSON.stringify({ id: "task-ship-0001", heading: "Ship the site", status: "running", started: 100, pane: "w1:p1" }));
	await writeFile(join(records, "task-old-0002.json"), JSON.stringify({ id: "task-old-0002", heading: "Old audit", status: "finished", started: 50 }));
	await writeFile(join(records, "broken.json"), "{not json");
	let cog: object[] | undefined = [];
	let lux: object[] | undefined;
	let blocked = false;
	const run = async (argv: readonly string[]) => {
		const last = argv.at(-1)!;
		if (argv[0] === "ssh" && last.includes("org-dispatch")) {
			const runs = argv.includes("lux") ? lux : cog;
			if (runs === undefined) throw new Error("ssh: connect to host: Connection timed out");
			return runs.map((r) => JSON.stringify(r)).join("\n");
		}
		if (argv.includes("agent") && argv.includes("get")) return JSON.stringify({ result: { agent: { agent_status: argv.at(-1) === "w9:p2" && blocked ? "blocked" : "working" } } });
		throw new Error(`unexpected ${argv.join(" ")}`);
	};
	let clock = new Date(2026, 9, 28, 12, 0).getTime();
	const notices: string[] = [];
	const faux = fauxProvider();
	const answer = (ctx: TranscriptContext) => {
		notices.push(lastInput(ctx));
		return fauxAssistantMessage("noted");
	};
	faux.setResponses([answer, answer, answer, answer, answer]);
	const daemon = await openTestDaemon({
		...tmp,
		faux,
		config: { dispatch: { hosts: ["kit", "cog", "lux"] }, herdr: { session: "default", host: "kit", hosts: { cog: {}, lux: {} }, allowPrompt: false }, watch: { enabled: true, gapMinutes: 10 } },
		watchClock: { now: () => new Date(clock), tickMs: 20, home, run },
	});
	t.after(() => daemon.close());
	// June queued this one herself, so her follow reports it and the watch must not.
	await daemon.harness.commit((tx) => follow(tx, createFollowTask({} as never, {} as never), { id: "task-mine-0004", title: "June's own", host: "kit", queuedAt: Date.now() }, Number(daemon.root.id)), BG);
	const ledger = join(tmp.paths.state, "watch.json");
	const pending = async () => Object.keys(JSON.parse(await readFile(ledger, "utf8").catch(() => '{"pending":{}}')).pending).length;
	await until(async () => (await readFile(ledger, "utf8").catch(() => "")).includes("task-ship-0001"));
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(notices.length, 0, "the first look raises nothing, not even an old DONE");

	// One run reaches EVAL on kit while a new one on cog blocks: one notice carries both.
	mine = "EVAL";
	await write("EVAL", "PROG");
	cog = [{ id: "task-build-0003", heading: "Fix the build", status: "running", started: 200, pane: "w9:p2" }];
	blocked = true;
	await until(() => notices.length === 1);
	assert.match(notices[0]!, /\[watch\] Dispatched tasks you did not queue changed/);
	assert.match(notices[0]!, /«Ship the site» \(work\.org\) on kit is now EVAL/);
	assert.match(notices[0]!, /«Fix the build» \(work\.org\) on cog has an agent blocked/);
	assert.match(notices[0]!, /leave their states alone/);
	assert.doesNotMatch(notices[0]!, /June's own/, "a task June follows is hers to report");

	// The blocked one moves to HOLD within the gap: it waits, then goes once the gap has passed.
	await write("EVAL", "HOLD");
	await until(async () => (await pending()) === 1);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(notices.length, 1, "nothing more inside the gap");
	clock += 11 * 60_000;
	await until(() => notices.length === 2);
	assert.match(notices[1]!, /«Fix the build».*is on HOLD/);
	assert.doesNotMatch(notices[1]!, /Ship the site/, "news already told is not told again");

	// At night news waits for the morning.
	clock = new Date(2026, 9, 28, 23, 0).getTime();
	cog = [{ id: "task-build-0003", heading: "Fix the build", status: "running", started: 300, pane: "w9:p2" }];
	blocked = false;
	await write("EVAL", "PROG");
	await until(async () => (await readFile(ledger, "utf8")).includes(":300"));
	await write("EVAL", "DONE");
	await until(async () => (await pending()) === 1);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(notices.length, 2, "not at 23:00");
	clock = new Date(2026, 9, 29, 5, 30).getTime();
	await until(() => notices.length === 3);
	assert.match(notices[2]!, /«Fix the build».*is DONE/);

	// A host asleep keeps what is known of it, and one first reached later only learns what is there.
	cog = undefined;
	await until(async () => (await readFile(ledger, "utf8")).includes('"hosts":["kit","cog"]'));
	await new Promise((r) => setTimeout(r, 100));
	cog = [{ id: "task-build-0003", heading: "Fix the build", status: "finished", started: 300 }];
	lux = [{ id: "task-ship-0001", heading: "Ship the site", status: "finished", started: 400 }];
	await until(async () => (await readFile(ledger, "utf8")).includes('"lux"'));
	clock += 60 * 60_000;
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(notices.length, 3, "nothing is news after cog wakes or lux is first reached");
	assert.ok((await readFile(ledger, "utf8")).includes("cog:task-build-0003:300"), "cog's run was kept while it slept");

	// org-dispatch drops a run's record as soon as its task leaves PROG; the watch still hears how it ended.
	await writeFile(join(records, "task-tidy-0005.json"), JSON.stringify({ id: "task-tidy-0005", heading: "Tidy notes", status: "running", started: 600 }));
	await until(async () => (await readFile(ledger, "utf8")).includes("kit:task-tidy-0005:600"));
	tidy = "EVAL";
	writeFileSync(tasks, text("EVAL", "DONE"));
	rmSync(join(records, "task-tidy-0005.json"));
	await until(() => notices.length === 4);
	assert.match(notices[3]!, /«Tidy notes» \(work\.org\) on kit is now EVAL/);
	await until(async () => !(await readFile(ledger, "utf8")).includes("task-tidy-0005"));
});

test("the watch carries fresh headlines in a batch, but not missing, unbound or stale ones", async (t) => {
	const tmp = await tempDir();
	const org = join(tmp.dir, "org");
	const home = join(tmp.dir, "home");
	const records = join(home, ".local/state/org-dispatch");
	await mkdir(org);
	await mkdir(records, { recursive: true });
	const file = join(org, "work.org");
	const ids = ["task-fresh-0001", "task-none-0002", "task-old-0003", "task-state-0004", "task-unbound-0005"];
	const fresh = { line: "I checked it.  Docs match!", state: "EVAL", at: 101 };
	const stale = { line: "Old run, do not quote me.", state: "EVAL", at: 50 };
	const wrongState = { line: "Old HOLD, not DONE.", state: "HOLD", at: 101 };
	const unbound = { line: "No freshness data, do not quote me." };
	const session = "01234567-89ab-cdef-0123-456789abcdef";
	const text = (state: string, first = fresh) => [task(state, "Fresh", ids[0]!, first), `** Sessions\n- [[herdr:kit/pi:${session}][worker]]\n`, task(state, "Legacy", ids[1]!), task(state, "Old run", ids[2]!, stale), task(state === "EVAL" ? "DONE" : state, "Old state", ids[3]!, wrongState), task(state, "Unbound", ids[4]!, unbound)].join("\n");
	await writeFile(file, text("PROG", { ...fresh, at: 90 }));
	for (const id of ids) await writeFile(join(records, `${id}.json`), JSON.stringify({ id, status: "running", started: 100 }));
	let clock = new Date(2026, 10, 5, 23).getTime();
	const heard: string[] = [];
	const faux = fauxProvider();
	const answer = (ctx: TranscriptContext) => { heard.push(lastInput(ctx)); return fauxAssistantMessage("noted"); };
	faux.setResponses([answer, answer, answer, answer]);
	const daemon = await openTestDaemon({ ...tmp, faux, config: { dispatch: { hosts: ["kit"] }, watch: { enabled: true, gapMinutes: 1 } }, watchClock: { now: () => new Date(clock), tickMs: 20, home, run: async () => "" } });
	t.after(async () => { await daemon.close(); await tmp.cleanup(); });
	const ledger = join(tmp.paths.state, "watch.json");
	await until(async () => (await readFile(ledger, "utf8").catch(() => "")).includes(ids[0]!));
	writeFileSync(file, text("EVAL"));
	await until(async () => Object.keys(JSON.parse(await readFile(ledger, "utf8")).pending).length === ids.length);
	assert.equal(heard.length, 0, "the existing waking-hours gate still applies");
	clock = new Date(2026, 10, 6, 5, 30).getTime();
	await until(async () => heard.length === 1 && !(await daemon.status()).busy);
	assert.ok(heard[0]!.includes(fresh.line));
	for (const line of [stale.line, wrongState.line, unbound.line]) assert.ok(!heard[0]!.includes(line));
	const reports = async () => (await daemon.root.context(BG)).entries.filter((entry) => entry.kind === "june.input" && (entry.data as { source?: string })?.source === "watch");
	assert.deepEqual((await reports())[0]!.data, { source: "watch", text: "5 dispatched tasks changed", surface: "gui", watch: [{ title: "Fresh", signal: "EVAL", headline: fresh.line, agent: "pi", session }] });

	// Clearing and restoring an old line does not make it new on the next state change.
	writeFileSync(file, text("PROG").replace(/^:DISPATCH_HEADLINE(?:_STATE|_AT)?:.*\n/gm, ""));
	await until(async () => JSON.parse(await readFile(ledger, "utf8")).runs[`kit:${ids[0]}:100`]?.signal === "PROG");
	writeFileSync(file, text("EVAL"));
	clock += 2 * 60_000;
	await until(async () => heard.length === 2 && !(await daemon.status()).busy);
	assert.ok(!heard[1]!.includes(fresh.line));
	assert.deepEqual((await reports())[1]!.data, { source: "watch", text: "5 dispatched tasks changed", surface: "gui" });

	// A new run is not allowed to inherit the old line, even if PROG was missed.
	for (const id of ids) writeFileSync(join(records, `${id}.json`), JSON.stringify({ id, status: "running", started: 200 }));
	clock += 2 * 60_000;
	await until(async () => heard.length === 3 && !(await daemon.status()).busy);
	assert.ok(!heard[2]!.includes(fresh.line));
	assert.deepEqual((await reports())[2]!.data, { source: "watch", text: "5 dispatched tasks changed", surface: "gui" });

	// The worker may freshly author the same words on a later run.
	writeFileSync(file, text("PROG"));
	await until(async () => JSON.parse(await readFile(ledger, "utf8")).runs[`kit:${ids[0]}:200`]?.signal === "PROG");
	writeFileSync(file, text("EVAL", { ...fresh, at: 201 }));
	clock += 2 * 60_000;
	await until(async () => heard.length === 4 && !(await daemon.status()).busy);
	assert.ok(heard[3]!.includes(fresh.line));
	assert.deepEqual((await reports())[3]!.data, (await reports())[0]!.data);
});

test("a delayed watch report keeps its old state news but drops a headline after resume or repeat", async (t) => {
	for (const state of ["PROG", "AUTO", "EVAL"]) await t.test(state, async (t) => {
		const tmp = await tempDir();
		const org = join(tmp.dir, "org");
		const home = join(tmp.dir, "home");
		const records = join(home, ".local/state/org-dispatch");
		await mkdir(org);
		await mkdir(records, { recursive: true });
		const file = join(org, "work.org");
		const id = "task-delay-0001";
		const record = join(records, `${id}.json`);
		const line = "This was the previous round's headline.";
		const text = (state: string, at: number) => task(state, "Delayed", id, { line, state: "EVAL", at });
		await writeFile(file, text("PROG", 90));
		await writeFile(record, JSON.stringify({ id, status: "running", started: 100 }));
		let clock = new Date(2026, 10, 5, 23).getTime();
		const heard: string[] = [];
		const faux = fauxProvider();
		faux.setResponses([(ctx) => { heard.push(lastInput(ctx)); return fauxAssistantMessage("noted"); }]);
		const daemon = await openTestDaemon({ ...tmp, faux, config: { dispatch: { hosts: ["kit"] }, watch: { enabled: true, gapMinutes: 1 } }, watchClock: { now: () => new Date(clock), tickMs: 20, home, run: async () => "" } });
		t.after(async () => { await daemon.close(); await tmp.cleanup(); });
		const ledger = join(tmp.paths.state, "watch.json");
		await until(async () => (await readFile(ledger, "utf8").catch(() => "")).includes(id));
		// Exercise the last read after the dispatcher removes the run record.
		writeFileSync(file, text("EVAL", 101));
		rmSync(record);
		await until(async () => Object.keys(JSON.parse(await readFile(ledger, "utf8")).pending).length === 1);
		assert.deepEqual(JSON.parse(await readFile(ledger, "utf8")).pending[`kit:${id}:100`].report, { title: "Delayed", signal: "EVAL", headline: line });
		writeFileSync(file, text(state, 101));
		writeFileSync(record, JSON.stringify({ id, status: "running", started: 200 }));
		await until(async () => (await readFile(ledger, "utf8")).includes(`kit:${id}:200`));
		clock = new Date(2026, 10, 6, 5, 30).getTime();
		await until(async () => heard.length === 1 && !(await daemon.status()).busy);
		assert.match(heard[0]!, /«Delayed».*is now EVAL/);
		assert.ok(!heard[0]!.includes(line));
		const entry = (await daemon.root.context(BG)).entries.find((entry) => entry.kind === "june.input" && (entry.data as { source?: string })?.source === "watch")!;
		assert.ok(!("watch" in (entry.data as object)), "no structured headline survives either");
	});
});

test("the notice names each task once, with where it lives and what it needs", () => {
	const text = message([
		{ signal: "EVAL", title: "Ship", host: "kit", file: "work/a.org" },
		{ signal: "missing", title: "Gone", host: "cog" },
	]);
	assert.match(text, /- «Ship» \(work\/a\.org\) on kit is now EVAL, ready for review\.\n- «Gone» on cog is missing\./);
});
