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

const task = (state: string, title: string, id: string) => `* ${state} ${title} :kit:\n:PROPERTIES:\n:ID: ${id}\n:END:\nBody.\n`;
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

test("the notice names each task once, with where it lives and what it needs", () => {
	const text = message([
		{ signal: "EVAL", title: "Ship", host: "kit", file: "work/a.org" },
		{ signal: "missing", title: "Gone", host: "cog" },
	]);
	assert.match(text, /- «Ship» \(work\/a\.org\) on kit is now EVAL, ready for review\.\n- «Gone» on cog is missing\./);
});
