import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { admitNotice, surfaceFor } from "../src/notify.ts";
import { createCodingExtension } from "../src/tools/coding.ts";
import type { ViewItem } from "../src/transcript.ts";
import { ask, attachView, openTestDaemon, routed, tempDir, until } from "./helpers.ts";

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const last = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.findLast((m) => m.role !== "system"));
const inputs = async (daemon: { root: { context(c: typeof BG): Promise<{ entries: readonly { kind: string; data?: unknown }[] }> } }) =>
	(await daemon.root.context(BG)).entries.filter((e) => e.kind === "june.input").map((e) => e.data as { source: string; text: string; surface?: string });
const reply = (items: readonly ViewItem[], text: string) => items.find((i): i is Extract<ViewItem, { kind: "assistant" }> => i.kind === "assistant" && i.text === text);

test("a [work] report alerts Telegram after a Telegram message and the terminal after a terminal one", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses(routed(
		[
			call("work", { brief: "Find the first word." }),
			fauxAssistantMessage("on it"),
			(ctx) => {
				assert.match(last(ctx), /\[work\] Report: wombat\./);
				return fauxAssistantMessage("It's wombat.");
			},
			call("work", { brief: "Find the second word." }),
			fauxAssistantMessage("on that too"),
			(ctx) => {
				assert.match(last(ctx), /\[work\] Report: numbat\./);
				return fauxAssistantMessage("It's numbat.");
			},
		],
		[() => fauxAssistantMessage("Report: wombat."), () => fauxAssistantMessage("Report: numbat.")],
	));
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());

	assert.equal((await ask(tmp.paths.socket, "first word?", "a", "telegram")).text, "on it");
	await until(() => reply(view.items(), "It's wombat.") !== undefined);
	assert.equal(reply(view.items(), "It's wombat.")!.alert, "telegram", "the report's answer goes to Telegram");
	assert.equal(reply(view.items(), "on it")!.alert, undefined, "the bridge sends a direct answer by answers, not alert");

	assert.equal((await ask(tmp.paths.socket, "second word?", "b", "tui")).text, "on that too");
	await until(() => reply(view.items(), "It's numbat.") !== undefined);
	assert.equal(reply(view.items(), "It's numbat.")!.alert, "gui", "after a terminal message the report stays on the terminal surface");

	const reports = (await inputs(daemon)).filter((d) => d.source === "work");
	assert.deepEqual(reports.map((d) => d.surface), ["telegram", "gui"]);
});

test("a report admitted across a restart is admitted once, routed to Telegram", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const log = join(tmp.dir, "log");
	const slow = fauxProvider({ tokensPerSecond: 20 });
	slow.setResponses(routed(
		[call("work", { brief: "Count the log." }), fauxAssistantMessage("on it")],
		[() => call("bash", { command: `echo ran >> ${log}` }), () => fauxAssistantMessage(`${"thinking ".repeat(200)}done`)],
	));
	let daemon = await openTestDaemon({ ...tmp, faux: slow, extensions: [createCodingExtension()] });
	assert.equal((await ask(tmp.paths.socket, "count it", "c", "telegram")).text, "on it");
	await until(() => existsSync(log));
	await daemon.close();

	const fast = fauxProvider();
	fast.setResponses(routed([fauxAssistantMessage("Counted once.")], [() => fauxAssistantMessage("Report: one run.")]));
	daemon = await openTestDaemon({ ...tmp, faux: fast, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());
	await until(() => reply(view.items(), "Counted once.") !== undefined);
	assert.equal(reply(view.items(), "Counted once.")!.alert, "telegram");
	await new Promise((r) => setTimeout(r, 300));
	assert.deepEqual((await inputs(daemon)).filter((d) => d.source === "work").map((d) => d.surface), ["telegram"], "one report");

	// The same request id admitted again, as a rerun after a crash would, finds the first submission.
	const notice = { requestId: "notice:again", content: "[follow] the task reached EVAL", source: "follow", label: "the task reached EVAL" };
	const first = await daemon.root.commit((tx) => admitNotice(tx, daemon.root, daemon.root.id, notice), BG);
	await daemon.close();
	daemon = await openTestDaemon({ ...tmp, faux: fast, extensions: [createCodingExtension()] });
	const again = await daemon.root.commit((tx) => admitNotice(tx, daemon.root, daemon.root.id, notice), BG);
	assert.equal(again, first);
	await until(async () => (await daemon.harness.submission(first, BG))?.status(BG).then((s) => s.status !== "queued" && s.status !== "placed") ?? false);
	assert.equal((await inputs(daemon)).filter((d) => d.source === "follow").length, 1, "admitted once");
});

test("the surface is where the user last spoke, reading stored and pre-bridge messages", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok"), fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	const surface = () => daemon.root.commit((tx) => surfaceFor(tx, daemon.root.id), BG);
	const append = (kind: string, text: string, data?: object) =>
		daemon.root.commit((tx) => tx.appendEntry(daemon.root.id, { kind, model: [{ role: "user", content: text, timestamp: Date.now() }], ...(data ? { data } : {}) } as never), BG);

	assert.equal(await surface(), "gui", "nobody has spoken: the terminal");
	await append("pi.user", "hi from the phone");
	assert.equal(await surface(), "telegram", "an untagged message from before the bridge came from Telegram");
	await append("pi.user", "[work] Report: done.");
	await append("june.input", "[heartbeat] look", { source: "heartbeat", text: "heartbeat", surface: "gui" });
	assert.equal(await surface(), "telegram", "June's own inputs say nothing about where the user is");
	await append("june.input", "[kitty] at the desk", { source: "kitty", text: "at the desk" });
	assert.equal(await surface(), "gui", "the stored terminal source");
	await ask(tmp.paths.socket, "from the phone", "p", "telegram");
	assert.equal(await surface(), "telegram");
	await ask(tmp.paths.socket, "from june ask", "q", "cli");
	assert.equal(await surface(), "gui");
});

test("a heartbeat that speaks alerts where the user last spoke; a quiet one alerts nothing", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const base = new Date();
	let clock = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 10, 0);
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage("hello"),
		fauxAssistantMessage("Heater on soon?"),
		fauxAssistantMessage("hi again"),
		fauxAssistantMessage("Clinic in an hour."),
		fauxAssistantMessage("QUIET"),
	]);
	const daemon = await openTestDaemon({
		...tmp,
		faux,
		config: { heartbeat: { enabled: true, everyMinutes: 60, chattingMinutes: 15 } },
		heartbeatClock: { now: () => clock, tickMs: 50 },
	});
	t.after(() => daemon.close());
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());

	assert.equal((await ask(tmp.paths.socket, "hi", "h1", "telegram")).text, "hello");
	await until(() => reply(view.items(), "Heater on soon?") !== undefined, 10_000);
	assert.equal(reply(view.items(), "Heater on soon?")!.alert, "telegram");

	assert.equal((await ask(tmp.paths.socket, "hi", "h2", "tui")).text, "hi again");
	clock = new Date(clock.getTime() + 61 * 60_000);
	await until(() => reply(view.items(), "Clinic in an hour.") !== undefined, 10_000);
	assert.equal(reply(view.items(), "Clinic in an hour.")!.alert, "gui");

	clock = new Date(clock.getTime() + 61 * 60_000);
	await until(() => faux.state.callCount >= 5, 10_000);
	await until(async () => (await inputs(daemon)).filter((d) => d.source === "heartbeat").length === 3);
	await until(async () => !(await daemon.status()).busy);
	const view2 = await attachView(tmp.paths.socket, { detail: true });
	t.after(() => view2.close());
	const quiet = view2.items().filter((i) => i.kind === "assistant" && i.text.trim() === "QUIET");
	assert.equal(quiet.length, 1);
	assert.equal((quiet[0] as Extract<ViewItem, { kind: "assistant" }>).alert, undefined, "a quiet heartbeat alerts nothing");
	assert.deepEqual((await inputs(daemon)).filter((d) => d.source === "heartbeat").map((d) => d.surface), ["telegram", "gui", "gui"]);
});
