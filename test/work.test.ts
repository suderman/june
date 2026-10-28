import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Client } from "../src/protocol.ts";
import { createCodingExtension } from "../src/tools/coding.ts";
import { WorkDoc } from "../src/tools/work.ts";
import { ask, openTestDaemon, routed, tempDir, until } from "./helpers.ts";

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const system = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
const last = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.findLast((m) => m.role !== "system"));
// Durable keeps earlier prompt updates in the transcript; later sections replace earlier ones by name.
const sections = (ctx: TranscriptContext) => JSON.stringify(Object.assign({}, ...ctx.messages.filter((m) => m.role === "system").map((m) => m.sections)));
const inWorker = (ctx: TranscriptContext) => system(ctx).includes("You are June's working context");
const focusConfig = { model: { chat: { provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, focus: { provider: "faux", modelId: "faux-2", thinkingLevel: "off" } } };
const twoModels = (options = {}) => fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }], ...options });
const said = async (daemon: { root: { context(c: typeof BG): Promise<{ messages: readonly unknown[] }> } }) => JSON.stringify((await daemon.root.context(BG)).messages);
const marks = async (daemon: { root: { context(c: typeof BG): Promise<{ entries: readonly { kind: string; data?: unknown }[] }> } }) =>
	(await daemon.root.context(BG)).entries.filter((e) => e.kind === "june.work").map((e) => (e.data as { state: string }).state);

test("work runs a brief in the background and only its report reaches the main thread", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses(routed(
		[
			(ctx) => {
				assert.match(system(ctx), /"name":"work"/);
				return call("work", { brief: "Find the secret word in the scratch file." });
			},
			(ctx) => {
				assert.match(last(ctx), /Started in your working context/, "the call returns at once");
				return fauxAssistantMessage("on it");
			},
			(ctx) => {
				assert.match(last(ctx), /\[work\] Report: the secret word is wombat\./, "the report arrives as a follow-up");
				return fauxAssistantMessage("It's wombat.");
			},
		],
		[
			(ctx) => {
				assert.doesNotMatch(system(ctx), /"name":"work"/, "no working context inside a working context");
				assert.match(last(ctx), /Find the secret word/);
				return call("bash", { command: "printf 'noise line\\n%.0s' $(seq 50); echo secret=wombat" });
			},
			(ctx) => {
				assert.match(last(ctx), /secret=wombat/);
				return fauxAssistantMessage("Report: the secret word is wombat.");
			},
		],
	));
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "what's the secret word?")).text, "on it");
	await until(async () => (await said(daemon)).includes("It's wombat."));
	const main = await said(daemon);
	assert.doesNotMatch(main, /noise line/, "shell output stays in the working context");
	assert.doesNotMatch(main, /secret=wombat/);
	assert.deepEqual(await marks(daemon), ["started", "finished"]);
	assert.deepEqual((await daemon.harness.snapshot(WorkDoc, BG))?.active, {});
	const reports = (await daemon.root.context(BG)).entries.filter((e) => e.kind === "june.input").map((e) => e.data as { source: string; text: string });
	assert.deepEqual(reports.at(-1), { source: "work", text: "report: Find the secret word in the scratch file." });
});

test("June talks with Alex while her working context runs", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses(routed(
		[
			call("work", { brief: "Build the slow thing." }),
			fauxAssistantMessage("on it"),
			(ctx) => {
				assert.match(last(ctx), /how's your day/);
				return fauxAssistantMessage("good, still building");
			},
			fauxAssistantMessage("Built."),
		],
		[() => call("bash", { command: "sleep 1.5; echo built" }), () => fauxAssistantMessage("Report: built.")],
	));
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "build it")).text, "on it");
	assert.equal((await daemon.status()).background, 1);
	assert.equal((await ask(tmp.paths.socket, "how's your day?")).text, "good, still building", "chat answers while the work runs");
	assert.equal((await daemon.status()).background, 1, "and the work is still running");
	await until(async () => (await said(daemon)).includes("Built."));
	assert.equal((await daemon.status()).background, 0);
});

test("June ties her hair up to focus and lets it down to relax, and work can focus alone", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = twoModels();
	const used: string[] = [];
	const step = (fn: (ctx: TranscriptContext) => ReturnType<typeof fauxAssistantMessage>) => (ctx: TranscriptContext, _o: unknown, _s: unknown, model: { id: string }) => {
		used.push(`${inWorker(ctx) ? "worker" : "main"}:${model.id}`);
		return fn(ctx);
	};
	faux.setResponses([
		step((ctx) => {
			assert.match(sections(ctx), /Your hair is down/);
			return call("focus", { on: true, reason: "writing a complete task" });
		}),
		step((ctx) => {
			assert.match(last(ctx), /Hair tied up/);
			assert.match(sections(ctx), /Your hair is tied up/);
			assert.doesNotMatch(sections(ctx), /Your hair is down/);
			return call("focus", { on: false, reason: "done" });
		}),
		step(() => fauxAssistantMessage("Written.")),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config: focusConfig });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "focus and write it up")).text, "Written.");
	assert.deepEqual(used, ["main:faux-1", "main:faux-2", "main:faux-1"], "focus applies from the next request, both ways");
	faux.setResponses(routed(
		[step(() => call("work", { brief: "Audit the task carefully.", focus: true })), step(() => fauxAssistantMessage("on it")), step(() => fauxAssistantMessage("Audited."))],
		[step(() => fauxAssistantMessage("Audit report."))],
	));
	assert.equal((await ask(tmp.paths.socket, "audit it")).text, "on it");
	await until(async () => (await said(daemon)).includes("Audited."));
	assert.deepEqual(used.slice(3).sort(), ["main:faux-1", "main:faux-1", "main:faux-1", "worker:faux-2"], "a focused brief leaves the main thread relaxed");
});

test("a restart and /new each let her hair down", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = twoModels();
	faux.setResponses([call("focus", { on: true, reason: "heads down" }), fauxAssistantMessage("Focused.")]);
	let daemon = await openTestDaemon({ ...tmp, faux, config: focusConfig });
	await ask(tmp.paths.socket, "focus");
	assert.equal((await daemon.root.agent(BG)).model?.modelId, "faux-2");
	await daemon.close();
	daemon = await openTestDaemon({ ...tmp, faux, config: focusConfig });
	t.after(() => daemon.close());
	assert.equal((await daemon.root.agent(BG)).model?.modelId, "faux-1", "a restart starts relaxed");

	faux.setResponses([call("focus", { on: true, reason: "heads down" }), fauxAssistantMessage("Focused.")]);
	await ask(tmp.paths.socket, "focus again");
	assert.equal((await daemon.root.agent(BG)).model?.modelId, "faux-2");
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	await client.request({ op: "command", requestId: "n", name: "new" });
	assert.equal((await daemon.root.agent(BG)).model?.modelId, "faux-1", "a fresh context starts relaxed");
});

test("a restart resumes the same working context without rerunning the brief, and /stop stops it", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const log = join(tmp.dir, "log");
	const slow = fauxProvider({ tokensPerSecond: 20 });
	slow.setResponses(routed(
		[call("work", { brief: "Count the log." }), fauxAssistantMessage("on it")],
		[() => call("bash", { command: `echo ran >> ${log}` }), () => fauxAssistantMessage(`${"thinking ".repeat(200)}done`)],
	));
	let daemon = await openTestDaemon({ ...tmp, faux: slow, extensions: [createCodingExtension()] });
	assert.equal((await ask(tmp.paths.socket, "count it")).text, "on it");
	await until(() => existsSync(log));
	await new Promise((r) => setTimeout(r, 200));
	await daemon.close();

	const fast = fauxProvider();
	fast.setResponses(routed(
		[
			(ctx) => {
				assert.match(last(ctx), /\[work\] Report: one run\./);
				return fauxAssistantMessage("Counted once.");
			},
		],
		[() => fauxAssistantMessage("Report: one run.")],
	));
	daemon = await openTestDaemon({ ...tmp, faux: fast, extensions: [createCodingExtension()] });
	await until(async () => (await said(daemon)).includes("Counted once."));
	assert.equal(await readFile(log, "utf8"), "ran\n", "the brief's command ran once");
	assert.deepEqual(await marks(daemon), ["started", "finished"], "the restart marked it started and finished once each");

	const stuck = fauxProvider({ tokensPerSecond: 5 });
	let working = false;
	stuck.setResponses(routed(
		[call("work", { brief: "Take forever." }), fauxAssistantMessage("on it")],
		[
			() => {
				working = true;
				return fauxAssistantMessage("slow ".repeat(500));
			},
		],
	));
	await daemon.close();
	daemon = await openTestDaemon({ ...tmp, faux: stuck, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "take forever")).text, "on it");
	await until(() => working);
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const reply = (await client.request({ op: "command", requestId: "stop", name: "stop" })) as { text?: string };
	assert.equal(reply.text, "Stopped the background work.");
	assert.deepEqual((await daemon.harness.snapshot(WorkDoc, BG))?.active, {});
	assert.equal((await marks(daemon)).at(-1), "stopped");
	assert.match(await said(daemon), /\[\/stop\] stopped your working context: «Take forever\.»/, "June learns what was stopped");
	const busy = (await daemon.harness.inspect(BG)).submissions.filter((s) => s.status === "placed" || s.status === "queued");
	assert.deepEqual(busy, [], "nothing keeps running in the working context");
	await new Promise((r) => setTimeout(r, 500));
	assert.equal((await said(daemon)).match(/\[work\] Report/g)?.length, 1, "a stopped brief sends no report");
	assert.deepEqual((await marks(daemon)).slice(-1), ["stopped"], "and is not marked finished");
});

test("stopping the turn that handed off a brief stops the brief too", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const slow = fauxProvider({ tokensPerSecond: 5 });
	slow.setResponses(routed([call("work", { brief: "Search every flake." }), fauxAssistantMessage("on it ".repeat(200))], [() => fauxAssistantMessage("slow ".repeat(500))]));
	const daemon = await openTestDaemon({ ...tmp, faux: slow, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	await client.request({ op: "submit", requestId: "f", text: "search the flakes", source: "kitty" });
	await until(async () => (await daemon.status()).background === 1 && (await daemon.status()).busy);
	const reply = (await client.request({ op: "command", requestId: "stop", name: "stop" })) as { text?: string };
	assert.equal(reply.text, "Stopped.");
	assert.deepEqual((await daemon.harness.snapshot(WorkDoc, BG))?.active, {}, "the brief that turn started is stopped with it");
	assert.match(await said(daemon), /\[\/stop\] stopped your working context: «Search every flake\.»/);
	await new Promise((r) => setTimeout(r, 500));
	assert.doesNotMatch(await said(daemon), /\[work\] slow/, "and sends no report");
});
