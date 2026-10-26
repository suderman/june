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
	const queue = { file: "todo.org", title: "Check docs", body: "June queued this because Jon asked.", host: "kit" };
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
	const queue = { file: "todo.org", title: "Check docs", body: "June queued this.", host: "kit" };
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
