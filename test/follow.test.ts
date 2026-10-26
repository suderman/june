import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createDispatchExtension } from "../src/tools/dispatch.ts";
import { decide, FOLLOW_DEFAULTS } from "../src/tools/follow.ts";
import { Herdr } from "../src/tools/herdr.ts";
import { Org } from "../src/tools/org.ts";
import { ask, openTestDaemon, tempDir, testConfig, until } from "./helpers.ts";

const input = { id: "abc12345", title: "Check docs", host: "kit", queuedAt: 0 };
const min = 60_000;

test("follow reports each transition once and stays quiet otherwise", () => {
	const at = (state: string, last: string, now = 3 * min, agent?: string) =>
		decide(input, { state, missing: false, file: "todo.org", ...(agent ? { agent } : {}) }, last, now, FOLLOW_DEFAULTS);
	assert.equal(at("AUTO", "AUTO").say, undefined, "settling is silent");
	assert.match(at("AUTO", "AUTO", 8 * min).say ?? "", /has not launched 8 minutes/);
	assert.equal(at("AUTO", "stalled", 9 * min).say, undefined, "a stall is reported once");
	assert.equal(at("PROG", "AUTO").say, undefined, "working is silent");
	assert.match(at("PROG", "PROG", 3 * min, "blocked").say ?? "", /blocked, waiting for a person/);
	assert.equal(at("PROG", "blocked", 3 * min, "blocked").signal, "blocked", "still blocked is the same signal");
	assert.equal(at("HOLD", "PROG").done, false);
	assert.deepEqual([at("EVAL", "PROG").done, at("EVAL", "PROG").signal], [true, "EVAL"]);
	assert.deepEqual([at("TODO", "PROG").done, at("TODO", "PROG").say], [true, undefined], "taken back is silent");
	const gone = decide(input, { state: undefined, missing: true }, "PROG", min, FOLLOW_DEFAULTS);
	assert.equal(gone.done, true);
	assert.equal(decide(input, { state: "PROG", missing: false }, "PROG", 8 * 24 * 60 * min, FOLLOW_DEFAULTS).done, true, "follows expire");
});

test("a queued task is followed through the daemon until it reaches EVAL", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "todo.org");
	await mkdir(root, { recursive: true });
	await writeFile(file, "#+TITLE: Todo\n");
	await writeFile(join(tmp.dir, "agenda"), `${file}\n`);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: join(tmp.dir, "agenda") }, dispatch: { hosts: ["kit"] } };
	const herdr = new Herdr(config.herdr, async () => JSON.stringify({ result: { agent: { agent_status: "working" } } }));
	const dispatch = createDispatchExtension(config, new Org(root), herdr, "inst", async () => "", {
		intervalMs: 40,
		launchMs: 60_000,
		maxMs: 3_600_000,
	});

	const faux = fauxProvider();
	const queue = { file: "todo.org", title: "Check docs", reason: "Jon asked for a docs check.", scope: "Check the docs.", checklist: ["Compare docs and code"], host: "kit" };
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("org_queue_task", queue)], { stopReason: "toolUse" }),
		fauxAssistantMessage("Queued it; I'll tell you when it lands."),
		fauxAssistantMessage("The docs check reached EVAL."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, extensions: [dispatch] });
	t.after(() => daemon.close());

	const asked = await ask(tmp.paths.socket, "queue a docs check");
	assert.equal(asked.text, "Queued it; I'll tell you when it lands.");
	const follows = async () =>
		(await daemon.root.context(BG)).entries.filter((e) => e.kind === "june.input" && (e.data as { source?: string })?.source === "follow");

	// The dispatcher launches it, then the agent finishes at EVAL.
	const text = await readFile(file, "utf8");
	await writeFile(file, text.replace("* AUTO Check docs", "* PROG Check docs"));
	await new Promise((r) => setTimeout(r, 200));
	assert.equal((await follows()).length, 0, "launch and work are silent");
	await writeFile(file, (await readFile(file, "utf8")).replace("* PROG Check docs", "* EVAL Check docs"));
	await until(async () => (await follows()).length === 1);
	assert.match(JSON.stringify((await follows())[0]!.data), /is now EVAL/);
	await until(async () => !(await daemon.status()).busy && faux.state.callCount === 3);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal((await follows()).length, 1, "reported once; the follow task ended");
	const inspection = await daemon.harness.inspect(BG);
	assert.equal(inspection.tasks.filter((task) => task.record.kind === "june.follow").length, 0);
});

test("resuming after EVAL and HOLD follows each new run without duplicate reports", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "todo.org");
	await mkdir(root, { recursive: true });
	await writeFile(file, "#+TITLE: Todo\n");
	await writeFile(join(tmp.dir, "agenda"), `${file}\n`);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: join(tmp.dir, "agenda") }, dispatch: { hosts: ["kit"] } };
	let kicks = 0;
	const extension = createDispatchExtension(config, new Org(root), new Herdr(config.herdr, async () => "{}"), "inst", async (args) => {
		if (args[0] === "systemctl") { kicks++; return ""; }
		assert.equal(args[0], "org-edit");
		const text = await readFile(file, "utf8");
		const expected = args[args.indexOf("--expect") + 1]!;
		assert.ok(text.includes(`* ${expected} Check docs`));
		const key = args[args.indexOf("--request") + 1]!;
		await writeFile(file, text.replace(`* ${expected} Check docs`, "* AUTO Check docs").replace(/:JUNE_REQUEST: .+/, `:JUNE_REQUEST: ${key}`));
		const id = /^:ID: (.+)$/m.exec(text)![1]!;
		return JSON.stringify({ id, title: "Check docs", host: "kit", written: true });
	}, { intervalMs: 40, launchMs: 60_000, maxMs: 3_600_000 });
	const faux = fauxProvider();
	const resume = (expected: "EVAL" | "HOLD") => fauxAssistantMessage([fauxToolCall("org_resume_task", {
		file: "todo.org", heading: "Check docs", expected, host: "kit", note: "Jon asked for another pass.",
	})], { stopReason: "toolUse" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("org_queue_task", { file: "todo.org", title: "Check docs", reason: "Jon asked.", scope: "Check docs.", checklist: ["Compare"], host: "kit" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Queued."), fauxAssistantMessage("Ready for review."),
		resume("EVAL"), fauxAssistantMessage("Resumed."), fauxAssistantMessage("The agent has a question."),
		resume("HOLD"), fauxAssistantMessage("Resumed again."), fauxAssistantMessage("Finished."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, extensions: [extension] });
	t.after(() => daemon.close());
	const reports = async () => (await daemon.root.context(BG)).entries.filter((e) => (e.data as { source?: string })?.source === "follow");
	await ask(tmp.paths.socket, "queue it");
	const originalId = /^:ID: (.+)$/m.exec(await readFile(file, "utf8"))![1];
	for (const [index, state] of ["EVAL", "HOLD", "DONE"].entries()) {
		if (index > 0) await ask(tmp.paths.socket, "resume it");
		await writeFile(file, (await readFile(file, "utf8")).replace("* AUTO Check docs", `* ${state} Check docs`));
		await until(async () => (await reports()).length === index + 1 && !(await daemon.status()).busy && faux.state.callCount === (index + 1) * 3);
		assert.match(JSON.stringify((await reports()).at(-1)!.data), new RegExp(state));
	}
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal((await reports()).length, 3);
	assert.equal(kicks, 3, "each queue or resume nudges dispatcher");
	const final = await readFile(file, "utf8");
	assert.equal(/^:ID: (.+)$/m.exec(final)![1], originalId);
	assert.equal(final.match(/^\* /gm)?.length, 1, "resume never creates another task");
	const inspection = await daemon.harness.inspect(BG);
	assert.equal(inspection.tasks.filter((task) => task.record.kind === "june.follow").length, 0, "superseded HOLD watcher also ended");
});

test("following survives a daemon restart", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "todo.org");
	await mkdir(root, { recursive: true });
	await writeFile(file, "#+TITLE: Todo\n");
	await writeFile(join(tmp.dir, "agenda"), `${file}\n`);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: join(tmp.dir, "agenda") }, dispatch: { hosts: ["kit"] } };
	const extension = () =>
		createDispatchExtension(config, new Org(root), new Herdr(config.herdr, async () => "{}"), "inst", async () => "", {
			intervalMs: 40,
			launchMs: 60_000,
			maxMs: 3_600_000,
		});
	const queue = { file: "todo.org", title: "Check docs", reason: "Jon asked.", scope: "Check the docs.", checklist: ["Compare"], host: "kit" };
	const before = fauxProvider();
	before.setResponses([fauxAssistantMessage([fauxToolCall("org_queue_task", queue)], { stopReason: "toolUse" }), fauxAssistantMessage("Queued.")]);
	let daemon = await openTestDaemon({ ...tmp, faux: before, config, extensions: [extension()] });
	await ask(tmp.paths.socket, "queue it");
	await daemon.close();

	await writeFile(file, (await readFile(file, "utf8")).replace("* AUTO Check docs", "* DONE Check docs"));
	const after = fauxProvider();
	after.setResponses([fauxAssistantMessage("It finished.")]);
	daemon = await openTestDaemon({ ...tmp, faux: after, config, extensions: [extension()] });
	t.after(() => daemon.close());
	await until(async () => after.state.callCount === 1, 5000);
	const reports = (await daemon.root.context(BG)).entries.filter((e) => (e.data as { source?: string })?.source === "follow");
	assert.equal(reports.length, 1);
	assert.match(JSON.stringify(reports[0]!.data), /is now DONE/);
});
