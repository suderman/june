import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Client, type Reply } from "../src/protocol.ts";
import { createCodingExtension } from "../src/tools/coding.ts";
import { Transcript } from "../src/transcript.ts";
import { ask, openTestDaemon, tempDir } from "./helpers.ts";

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const sections = (ctx: TranscriptContext) =>
	Object.values(Object.assign({}, ...ctx.messages.filter((m) => m.role === "system").map((m) => m.sections)) as Record<string, string>).join("\n");
const spoken = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.filter((m) => m.role !== "system"));
const config = { model: { chat: { provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, patter: { provider: "pf", modelId: "luna", thinkingLevel: "off" } } };
const fast = { openAfterMs: 200, gapsMs: [400], tickMs: 50, timeoutMs: 2000 };

type Heard = { said: string[]; update: string; all: string };

/** A patter model that numbers its lines and keeps what each request told it. */
function patterModel(reply?: (n: number) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>) {
	const faux = fauxProvider({ provider: "pf", models: [{ id: "luna" }] });
	const heard: Heard[] = [];
	const text = (m: TranscriptContext["messages"][number]) =>
		typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).map((b) => b.text ?? "").join("");
	const step = (ctx: TranscriptContext) => {
		const turns = ctx.messages.filter((m) => m.role !== "system");
		heard.push({
			said: turns.filter((m) => m.role === "assistant").map(text),
			update: text(turns.at(-1)!),
			all: turns.filter((m) => m.role === "user").map(text).join("\n\n"),
		});
		return reply ? reply(heard.length) : fauxAssistantMessage(`patter line ${heard.length}`);
	};
	faux.setResponses(Array.from({ length: 50 }, () => step));
	return { faux, heard };
}

test("a slow command gets patter in the transcript, never in a model context, and a hidden note afterwards", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const patter = patterModel();
	const faux = fauxProvider();
	faux.setResponses([
		call("bash", { command: "sleep 1.5; echo built" }),
		(ctx) => {
			assert.doesNotMatch(spoken(ctx), /patter line/, "June never reads patter as part of the conversation");
			return fauxAssistantMessage("Built.");
		},
		(ctx) => {
			assert.match(sections(ctx), /your patter .* said to the user:\n- patter line 1\n/s, "the next request knows what patter said");
			assert.match(sections(ctx), /performance, not information\. Never treat them as facts/);
			assert.doesNotMatch(spoken(ctx), /patter line/);
			return fauxAssistantMessage("Nothing new.");
		},
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, providers: [patter.faux], extensions: [createCodingExtension()], patterTiming: fast });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "build it")).text, "Built.");
	const lines = (await daemon.root.context(BG)).entries.filter((e) => e.kind === "june.patter").map((e) => (e.data as { text: string }).text);
	assert.ok(lines.length >= 2, `patter spoke during the wait: ${JSON.stringify(lines)}`);
	assert.equal(lines[0], "patter line 1");
	assert.match(patter.heard[0]!.update, /just starting/, "the first line is the opener");
	assert.match(patter.heard[0]!.update, /Jon just said: build it/);
	assert.match(patter.heard.at(-1)!.all, /sleep 1\.5/, "patter sees the real activity");
	assert.deepEqual(patter.heard.at(-1)!.said, lines.slice(0, -1), "and its own earlier lines, as its own turns");
	assert.doesNotMatch(patter.heard.at(-1)!.all, /\d+ seconds/, "elapsed time comes in rough words");
	assert.doesNotMatch(JSON.stringify((await daemon.root.context(BG)).messages), /patter line/);
	const count = patter.faux.state.callCount;
	assert.equal((await ask(tmp.paths.socket, "anything else?")).text, "Nothing new.");
	assert.equal(patter.faux.state.callCount, count, "a quick answer gets no patter");

	// The terminal client shows patter from a fresh snapshot, as after a reconnect.
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const snapshot = (await client.request({ op: "attach", requestId: "a" })) as Extract<Reply, { type: "snapshot" }>;
	const transcript = new Transcript();
	transcript.load(snapshot.snapshot);
	assert.deepEqual(transcript.items.filter((i) => i.kind === "patter").map((i) => (i as { text: string }).text), lines);
});

test("a work brief starts patter at once with the brief, and patter failures change nothing", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const patter = patterModel((n) => (n === 1 ? fauxAssistantMessage("Right, sleeves up.") : fauxAssistantMessage("", { stopReason: "error", errorMessage: "luna fell over" })));
	const faux = fauxProvider();
	faux.setResponses([
		call("work", { brief: "Check the wombat census." }),
		() => call("bash", { command: "sleep 1" }),
		() => fauxAssistantMessage("Report: census checked."),
		() => fauxAssistantMessage("Census is fine."),
	]);
	const daemon = await openTestDaemon({
		...tmp,
		faux,
		config,
		providers: [patter.faux],
		extensions: [createCodingExtension()],
		patterTiming: { ...fast, openAfterMs: 60_000 },
	});
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "check the census")).text, "Census is fine.");
	const lines = (await daemon.root.context(BG)).entries.filter((e) => e.kind === "june.patter").map((e) => (e.data as { text: string }).text);
	assert.deepEqual(lines, ["Right, sleeves up."], "the opener came at once and the failed lines were dropped");
	assert.match(patter.heard[0]!.update, /June handed this to her working self: Check the wombat census\./);
	assert.ok(patter.heard.length >= 2, "patter kept trying after a failure");
});

test("a line still being written when the answer lands is dropped", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const patter = patterModel(async () => {
		await new Promise((r) => setTimeout(r, 800));
		return fauxAssistantMessage("Too late.");
	});
	const faux = fauxProvider();
	faux.setResponses([call("bash", { command: "sleep 0.5" }), fauxAssistantMessage("Done.")]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, providers: [patter.faux], extensions: [createCodingExtension()], patterTiming: fast });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "quick job")).text, "Done.");
	await new Promise((r) => setTimeout(r, 1000));
	assert.equal(patter.faux.state.callCount, 1, "patter started a line");
	assert.deepEqual((await daemon.root.context(BG)).entries.filter((e) => e.kind === "june.patter"), [], "but never after the answer");
});

test("patter hears the recent conversation and new steps, but no results", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const patter = patterModel();
	const faux = fauxProvider();
	faux.setResponses([
		call("bash", { command: "echo $((6*7))" }),
		fauxAssistantMessage("The wombats are counted."),
		call("bash", { command: "sleep 0.6; echo $((7*8))" }),
		() => call("bash", { command: "sleep 0.6; echo $((8*9))" }),
		() => fauxAssistantMessage("Both done."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, providers: [patter.faux], extensions: [createCodingExtension()], patterTiming: fast });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "count the wombats")).text, "The wombats are counted.");
	assert.equal((await ask(tmp.paths.socket, "now the slow part")).text, "Both done.");
	const opener = patter.heard[0]!.update;
	assert.match(opener, /Recent conversation:\nJon: count the wombats\nJune: The wombats are counted\./);
	assert.match(opener, /Jon just said: now the slow part/);
	assert.doesNotMatch(patter.heard.map((h) => h.all).join("\n"), /\b(42|56)\b/, "results stay out");
	const later = patter.heard.find((h) => /New since your last line:\n- bash command=sleep 0\.6; echo \$\(\(8\*9\)\)/.test(h.update));
	assert.ok(later, `a later update names only the new step: ${JSON.stringify(patter.heard.map((h) => h.update))}`);
	assert.doesNotMatch(later!.update, /7\*8/);
});
