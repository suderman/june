import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Client } from "../src/protocol.ts";
import { createCodingExtension } from "../src/tools/coding.ts";
import { ask, openTestDaemon, tempDir, until } from "./helpers.ts";

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const system = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
const last = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.findLast((m) => m.role !== "system"));
// Durable keeps earlier prompt updates in the transcript; later sections replace earlier ones by name.
const sections = (ctx: TranscriptContext) => JSON.stringify(Object.assign({}, ...ctx.messages.filter((m) => m.role === "system").map((m) => m.sections)));
const inWorker = (ctx: TranscriptContext) => system(ctx).includes("You are June's working context");
const focusConfig = { model: { provider: "faux", modelId: "faux-1", thinkingLevel: "off", focus: { provider: "faux", modelId: "faux-2", thinkingLevel: "off" } } };
const twoModels = (options = {}) => fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }], ...options });

test("work runs a brief in its own context and only the report reaches the main thread", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([
		(ctx) => {
			assert.ok(!inWorker(ctx));
			assert.match(system(ctx), /"name":"work"/);
			return call("work", { brief: "Find the secret word in the scratch file." });
		},
		(ctx) => {
			assert.ok(inWorker(ctx), "the brief runs under the working-context instructions");
			assert.doesNotMatch(system(ctx), /"name":"work"/, "no working context inside a working context");
			assert.match(last(ctx), /Find the secret word/);
			return call("bash", { command: "printf 'noise line\\n%.0s' $(seq 50); echo secret=wombat" });
		},
		(ctx) => {
			assert.match(last(ctx), /secret=wombat/);
			return fauxAssistantMessage("Report: the secret word is wombat.");
		},
		(ctx) => {
			assert.ok(!inWorker(ctx));
			assert.match(last(ctx), /Report: the secret word is wombat\./);
			return fauxAssistantMessage("It's wombat.");
		},
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "what's the secret word?")).text, "It's wombat.");
	const main = JSON.stringify((await daemon.root.context(BG)).messages);
	assert.match(main, /Report: the secret word is wombat/);
	assert.doesNotMatch(main, /noise line/, "shell output stays in the working context");
	assert.doesNotMatch(main, /secret=wombat/);
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
		step(() => call("work", { brief: "Audit the task carefully.", focus: true })),
		step(() => fauxAssistantMessage("Audit report.")),
		step(() => fauxAssistantMessage("Audited.")),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config: focusConfig });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "focus and write it up")).text, "Written.");
	assert.deepEqual(used, ["main:faux-1", "main:faux-2", "main:faux-1"], "focus applies from the next request, both ways");
	assert.equal((await ask(tmp.paths.socket, "audit it")).text, "Audited.");
	assert.deepEqual(used.slice(3), ["main:faux-1", "worker:faux-2", "main:faux-1"], "a focused brief leaves the main thread relaxed");
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

test("a restart resumes the same working context without rerunning the brief, and /stop aborts it", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const log = join(tmp.dir, "log");
	const slow = fauxProvider({ tokensPerSecond: 20 });
	slow.setResponses([
		call("work", { brief: "Count the log." }),
		() => call("bash", { command: `echo ran >> ${log}` }),
		() => fauxAssistantMessage(`${"thinking ".repeat(200)}done`),
	]);
	let daemon = await openTestDaemon({ ...tmp, faux: slow, extensions: [createCodingExtension()] });
	let client = await Client.open(tmp.paths.socket);
	await client.request({ op: "submit", requestId: "r", text: "count it", source: "kitty" });
	await until(() => existsSync(log));
	await new Promise((r) => setTimeout(r, 200));
	await daemon.close();
	client.close();

	const fast = fauxProvider();
	fast.setResponses([
		(ctx) => {
			assert.ok(inWorker(ctx), "the working context resumes its own reply");
			return fauxAssistantMessage("Report: one run.");
		},
		(ctx) => {
			assert.match(last(ctx), /Report: one run\./);
			return fauxAssistantMessage("Counted once.");
		},
	]);
	daemon = await openTestDaemon({ ...tmp, faux: fast, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "count it", "r", "kitty")).text, "Counted once.");
	assert.equal(await readFile(log, "utf8"), "ran\n", "the brief's command ran once");

	const stuck = fauxProvider({ tokensPerSecond: 5 });
	let working = false;
	stuck.setResponses([
		call("work", { brief: "Take forever." }),
		() => {
			working = true;
			return fauxAssistantMessage("slow ".repeat(500));
		},
	]);
	await daemon.close();
	daemon = await openTestDaemon({ ...tmp, faux: stuck, extensions: [createCodingExtension()] });
	client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	await client.request({ op: "submit", requestId: "s", text: "take forever", source: "kitty" });
	await until(() => working);
	await client.request({ op: "command", requestId: "stop", name: "stop" });
	await until(async () => !(await daemon.status()).busy);
	const busy = (await daemon.harness.inspect(BG)).submissions.filter((s) => s.status === "placed" || s.status === "queued");
	assert.deepEqual(busy, [], "nothing keeps running in the working context");
});
