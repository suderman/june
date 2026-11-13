import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { expireImages, GONE, keepImage, restoreImage, restoreMessages } from "../src/kept-images.ts";
import { createPayloadsExtension } from "../src/payloads.ts";
import { Client } from "../src/protocol.ts";
import { createCodingExtension } from "../src/tools/coding.ts";
import { ask, openTestDaemon, routed, tempDir, until } from "./helpers.ts";

const png = Buffer.from("not really a png, but bytes all the same").toString("base64");
const image = { type: "image" as const, data: png, mimeType: "image/png" };

test("an image is kept once under its hash and restored as the same bytes, or as a note once it is gone", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const dir = join(tmp.dir, "images");
	const ref = keepImage(dir, image);
	assert.match(ref, /^\[kept image [0-9a-f]{64} image\/png\]$/);
	assert.equal(keepImage(dir, image), ref, "the same image twice is one file");
	assert.equal((await readdir(dir)).length, 1);
	assert.deepEqual(restoreImage(dir, ref), image);
	assert.equal(restoreImage(dir, "just text"), undefined);

	const messages: Message[] = [
		{ role: "user", content: ref, timestamp: 1 },
		{ role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: ref }, { type: "text", text: "after" }], isError: false, timestamp: 2 },
	];
	const restored = restoreMessages(dir, messages);
	assert.equal(restored[0], messages[0], "only tool results are restored");
	assert.deepEqual((restored[1] as Extract<Message, { role: "toolResult" }>).content, [image, { type: "text", text: "after" }]);
	assert.equal(restoreMessages(dir, [messages[0]!]).length, 1);
	assert.equal(restoreMessages(dir, [messages[0]!])[0], messages[0]);

	await rm(dir, { recursive: true });
	assert.deepEqual(restoreImage(dir, ref), { type: "text", text: GONE });
});

test("expiry deletes images untouched for 30 days and stray temporary files, and nothing else", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const dir = join(tmp.dir, "images");
	const old = keepImage(dir, image).split(" ")[2]!;
	const fresh = keepImage(dir, { type: "image", data: Buffer.from("other").toString("base64"), mimeType: "image/jpeg" }).split(" ")[2]!;
	await writeFile(join(dir, `${fresh}.x.tmp`), "partial");
	await writeFile(join(dir, "README"), "not mine");
	const now = Date.now();
	const ago = (days: number) => new Date(now - days * 86_400_000);
	await utimes(join(dir, old), ago(31), ago(31));
	await utimes(join(dir, `${fresh}.x.tmp`), ago(2), ago(2));
	assert.equal(await expireImages(dir, now), 2);
	assert.deepEqual((await readdir(dir)).sort(), [fresh, "README"].sort());
	assert.equal(await expireImages(join(tmp.dir, "missing"), now), 0);
});

test("a tool's image is stored as a reference, and every request still carries the image", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const snap = defineTool({
		name: "snap",
		description: "Return a picture",
		parameters: obj({}),
		replay: "safe",
		execute: async () => ({ output: [{ type: "text", text: "here it is" }, image] }),
	});
	const seen: string[] = [];
	const imageIn = (context: TranscriptContext) => {
		const result = context.messages.find((m) => m.role === "toolResult");
		return result?.role === "toolResult" ? result.content.find((b) => b.type === "image") : undefined;
	};
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("snap", {})], { stopReason: "toolUse" }),
		(context: TranscriptContext) => {
			seen.push(imageIn(context)?.type === "image" ? (imageIn(context) as { data: string }).data : "missing");
			return fauxAssistantMessage("A picture.");
		},
		(context: TranscriptContext) => {
			seen.push(imageIn(context)?.type === "image" ? (imageIn(context) as { data: string }).data : "missing");
			return fauxAssistantMessage("Still a picture.");
		},
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [defineExtension({ name: "snap", tools: [snap] })] });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "take a picture")).text, "A picture.");
	assert.equal((await ask(tmp.paths.socket, "and again?")).text, "Still a picture.");
	assert.deepEqual(seen, [png, png], "the model sees the image in this run and the next");

	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const history = await client.request({ op: "history", requestId: randomUUID() });
	assert.equal(history.type, "history");
	const stored = (history.type === "history" ? history.entries : []).find((e) => e.kind === "pi.tool-result");
	const content = JSON.stringify(stored?.model);
	assert.match(content, /\[kept image [0-9a-f]{64} image\/png\]/);
	assert.ok(!content.includes(png), "the database holds the reference, not the bytes");
	const hash = /kept image ([0-9a-f]{64})/.exec(content)![1]!;
	const file = join(tmp.paths.state, "images", hash);
	assert.ok(existsSync(file));
	assert.equal((await readFile(file)).toString("base64"), png);
});

test("read's own images, with their structured output, are kept the same way", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	// A 1x1 PNG.
	const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const path = join(tmp.dir, "pixel.png");
	await writeFile(path, Buffer.from(pixel, "base64"));
	let seen = "";
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
		(context: TranscriptContext) => {
			const result = context.messages.find((m) => m.role === "toolResult");
			const block = result?.role === "toolResult" ? result.content.find((b) => b.type === "image") : undefined;
			seen = block?.type === "image" ? block.data : JSON.stringify(result);
			return fauxAssistantMessage("One pixel.");
		},
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "look at it")).text, "One pixel.");
	assert.equal(seen, pixel);
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const history = await client.request({ op: "history", requestId: randomUUID() });
	const stored = JSON.stringify((history.type === "history" ? history.entries : []).find((e) => e.kind === "pi.tool-result")?.model);
	assert.match(stored, /kept image [0-9a-f]{64} image\/png/);
	assert.ok(!stored.includes(pixel));
	assert.ok(!/"isError":true/.test(stored), stored);
});

test("images in June's working context are kept the same way", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const path = join(tmp.dir, "art.png");
	await writeFile(path, Buffer.from(pixel, "base64"));
	let seen = "";
	const faux = fauxProvider();
	faux.setResponses(routed(
		[
			fauxAssistantMessage([fauxToolCall("work", { brief: "Judge the art." })], { stopReason: "toolUse" }),
			fauxAssistantMessage("on it"),
			fauxAssistantMessage("Judged."),
		],
		[
			fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
			(context: TranscriptContext) => {
				const result = context.messages.find((m) => m.role === "toolResult");
				const block = result?.role === "toolResult" ? result.content.find((b) => b.type === "image") : undefined;
				seen = block?.type === "image" ? block.data : "missing";
				return fauxAssistantMessage("Report: it is one pixel.");
			},
		],
	));
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	await ask(tmp.paths.socket, "judge the art");
	await until(() => seen !== "");
	assert.equal(seen, pixel, "the working context sees the image");
	assert.equal((await readdir(join(tmp.paths.state, "images"))).length, 1, "and it is kept as a file");
	const { DatabaseSync } = await import("node:sqlite");
	await until(async () => JSON.stringify((await daemon.root.context(BG)).messages).includes("Judged."));
	await daemon.close();
	const db = new DatabaseSync(tmp.paths.database, { readOnly: true });
	const rows = db.prepare("select record from entries where record like '%toolResult%'").all() as { record: string }[];
	db.close();
	assert.ok(rows.some((r) => /kept image [0-9a-f]{64}/.test(r.record)));
	assert.ok(!rows.some((r) => r.record.includes(pixel)), "no conversation in the database holds the bytes");
});

test("request bodies are saved only while the payloads directory exists, and never change the request", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const dir = join(tmp.dir, "payloads");
	const before = (createPayloadsExtension(dir, (error) => assert.fail(error.message)).hooks![0] as { handlers: { beforeProviderRequest: (request: { model: { id: string }; payload: unknown }) => unknown } }).handlers.beforeProviderRequest;
	assert.equal(before({ model: { id: "m" }, payload: { input: "one" } }), undefined);
	assert.equal(existsSync(dir), false, "off by default: nothing is written and no directory is made");
	await mkdir(dir);
	assert.equal(before({ model: { id: "m" }, payload: { input: "two" } }), undefined, "the payload goes out unchanged");
	const files = await readdir(dir);
	assert.equal(files.length, 1);
	assert.match(files[0]!, /-m\.json$/);
	assert.deepEqual(JSON.parse(await readFile(join(dir, files[0]!), "utf8")), { input: "two" });
});
