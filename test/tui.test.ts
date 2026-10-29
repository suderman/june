import assert from "node:assert/strict";
import { writeFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { clipboardInput, imageInput, validateImages } from "../src/images.ts";
import { Client, type Reply } from "../src/protocol.ts";
import { ask, openTestDaemon, tempDir } from "./helpers.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { orgToMarkdown } from "../src/org.ts";
import { Transcript } from "../src/transcript.ts";
import { compactingStatus } from "../src/tui.ts";

// A valid 2x2 PNG, with red, green, blue and white pixels.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC";
const IMAGE = { type: "image" as const, mimeType: "image/png", data: PNG };

test("pasted screenshot paths and clipboard markers become inline images, leaving text and URLs alone", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const path = join(tmp.dir, "screen shot.png");
	await writeFile(path, Buffer.from(PNG, "base64"));
	const pasted = new Map([["[image 1]", IMAGE], ["[image 2]", IMAGE]]);
	for (const token of [`'${path}'`, `"${path}"`, path.replaceAll(" ", "\\ ")]) {
		const input = await imageInput(`explain ${token}\n[image 1]`, pasted);
		assert.equal(input.text, "explain");
		assert.deepEqual(input.images, [IMAGE, IMAGE], "Buffer-backed files decode and survive the worker transfer");
	}
	assert.deepEqual(await imageInput("[image 2]", pasted), { text: "", images: [IMAGE] }, "image-only input and deleted markers work");
	assert.deepEqual(await imageInput("hi https://example.com/shot.png"), { text: "hi https://example.com/shot.png", images: [] });
	assert.deepEqual(await imageInput("plain text\n"), { text: "plain text\n", images: [] });
	assert.equal((await imageInput(`'${path}' https://example.com/shot.png`)).text, "https://example.com/shot.png");
	await assert.rejects(imageInput("[image 1]"), /no longer attached/);
	await assert.rejects(imageInput(join(tmp.dir, "missing.png")), /ENOENT/);
	await writeFile(path, "not a PNG");
	await assert.rejects(imageInput(`'${path}'`), /cannot be decoded/);
	await truncate(path, 21 * 1024 * 1024);
	await assert.rejects(imageInput(`'${path}'`), /exceeds 20 MiB/);
	assert.throws(() => validateImages(Array(11).fill(IMAGE)), /at most 10/);
	assert.throws(() => validateImages([{ ...IMAGE, data: "not base64" }]), /Invalid image/);
	assert.throws(() => validateImages([{ ...IMAGE, data: "A".repeat(DEFAULT_IMAGE_LIMITS.maxBytes + 1) }]), /Invalid image/);
	validateImages([{ ...IMAGE, data: "A".repeat(4 * 1024 * 1024) }]);
	assert.throws(() => validateImages(Array(6).fill({ ...IMAGE, data: "A".repeat(4 * 1024 * 1024) })), /exceed 20 MiB/);
});

test("Wayland clipboard paste prefers the current image, preserves text, and reports unavailable or invalid contents", async () => {
	const calls: string[][] = [];
	const run = async (args: readonly string[]) => {
		calls.push([...args]);
		return args[0] === "--list-types" ? Buffer.from("text/plain;charset=utf-8\nimage/png\n") : Buffer.from(PNG, "base64");
	};
	assert.deepEqual(await clipboardInput(run), { image: IMAGE });
	assert.deepEqual(calls, [["--list-types"], ["--type", "image/png", "--no-newline"]]);
	assert.deepEqual(await clipboardInput(async (args) => Buffer.from(args[0] === "--list-types" ? "text/plain;charset=utf-8" : "one\ntwo\n")), { text: "one\ntwo\n" });
	await assert.rejects(clipboardInput(async () => { throw new Error("no Wayland clipboard"); }), /no Wayland/);
	await assert.rejects(clipboardInput(async () => Buffer.from("application/octet-stream")), /no image or text/);
	await assert.rejects(clipboardInput(async (args) => Buffer.from(args[0] === "--list-types" ? "image/png" : "bad PNG")), /cannot be decoded/);
});

test("terminal images reach the model, persist through restart, and reconnect with attachment counts", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([(ctx) => {
		const user = ctx.messages.findLast((m) => m.role === "user");
		assert.deepEqual(user?.content, [{ type: "text", text: "[kitty] what is this?" }, IMAGE]);
		return fauxAssistantMessage("four pixels");
	}]);
	let daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	const client = await Client.open(tmp.paths.socket);
	try {
		const settled = new Promise<Reply>((resolve) => client.on((r) => r.type === "settled" && resolve(r)));
		assert.equal((await client.request({ op: "submit", requestId: "image", text: "what is this?", images: [IMAGE], source: "kitty", wait: true })).type, "accepted");
		assert.deepEqual(await settled, { type: "settled", requestId: "image", status: "done", text: "four pixels" });
		const duplicate = await client.request({ op: "submit", requestId: "image", text: "what is this?", images: [IMAGE], source: "kitty" });
		assert.equal(duplicate.type, "accepted");
		assert.equal(faux.state.callCount, 1, "socket retries do not resubmit an image");
		const bad = await client.request({ op: "submit", requestId: "bad", text: "", images: [{ ...IMAGE, data: "invalid" }], source: "kitty" });
		assert.equal(bad.type, "error");
	} finally { client.close(); }
	await daemon.close();
	const resumed = fauxProvider();
	resumed.setResponses([(ctx) => {
		assert.ok(ctx.messages.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "image" && b.data === PNG)), "the image is still in context after restart");
		return fauxAssistantMessage("still four pixels");
	}]);
	daemon = await openTestDaemon({ ...tmp, faux: resumed });
	assert.equal((await ask(tmp.paths.socket, "remember?", "text", "kitty")).text, "still four pixels");
	const snapshot = await daemon.root.context(BG);
	const transcript = new Transcript();
	const watcher = await Client.open(tmp.paths.socket);
	try {
		const attached = await watcher.request({ op: "attach", requestId: "reconnect" });
		assert.equal(attached.type, "snapshot");
		if (attached.type === "snapshot") transcript.load(attached.snapshot);
	} finally { watcher.close(); }
	const user = transcript.items.find((i) => i.kind === "user" && i.imageCount);
	assert.deepEqual(user, { kind: "user", id: String(snapshot.entries.find((e) => e.kind === "june.input")!.id), source: "kitty", text: "what is this?", imageCount: 1 });
	assert.equal(JSON.stringify(snapshot.entries.find((e) => e.kind === "june.input")?.data).includes(PNG), false, "metadata does not duplicate base64");
});

test("image-only submission is allowed, but text-only models and malformed image payloads reject before submission", async (t) => {
	for (const input of [["text", "image"], ["text"]] as const) {
		const tmp = await tempDir();
		t.after(tmp.cleanup);
		const faux = fauxProvider({ models: [{ id: "faux-1", input: [...input] }] });
		faux.setResponses([fauxAssistantMessage("image received")]);
		const daemon = await openTestDaemon({ ...tmp, faux });
		t.after(() => daemon.close());
		const client = await Client.open(tmp.paths.socket);
		try {
			const reply = await client.request({ op: "submit", requestId: "only", text: "", images: [IMAGE], source: "kitty" });
			if (input.length === 2) assert.equal(reply.type, "accepted");
			else {
				assert.deepEqual(reply, { type: "error", requestId: "only", message: "The current model does not support images" });
				assert.equal((await daemon.root.context(BG)).entries.some((e) => e.kind === "june.input"), false);
				assert.equal(faux.state.callCount, 0);
			}
		} finally { client.close(); }
	}
});

test("the compaction line hops, changes chores, counts time, and keeps its width", () => {
	const plain = (ms: number) => compactingStatus(ms).replace(/\x1b\[[0-9;]*m/g, "");
	const frames = [0, 250, 500, 750, 1000, 1250, 1500, 1750].map(plain);
	assert.equal(new Set(frames).size, 8, "the kangaroo moves every frame");
	const columns = frames.map((f) => f.indexOf("🦘"));
	assert.ok(columns.every((at, i) => i === 0 || at < columns[i - 1]!), "she only hops left, the way she faces");
	assert.equal(plain(2000).indexOf("🦘"), columns[0], "then she starts again from the right");
	assert.equal(new Set([0, 250, 1750].map((ms) => visibleWidth(compactingStatus(ms)))).size, 1, "the line does not jitter");
	assert.match(compactingStatus(42_000), /0:42/);
	const chore = (ms: number) => /🦘[· ]* (.+)…/.exec(plain(ms))?.[1];
	assert.ok(chore(1000) && chore(7000) && chore(1000) !== chore(7000), "the chore changes every six seconds");
	assert.match(compactingStatus(65_000), /1:05/);
	assert.match(compactingStatus(65_000), /nearly there|don't rush me|big swag/, "past a minute she gets defensive");
});

test("the transcript knows while a compaction runs, from events or a reconnect snapshot", () => {
	const transcript = new Transcript();
	assert.equal(transcript.compacting, undefined);
	transcript.apply([{ type: "compaction_start", taskId: 1, reason: "manual", blocking: false } as never]);
	const since = transcript.compacting;
	assert.ok(since !== undefined && since <= Date.now());
	transcript.apply([{ type: "compaction_start", taskId: 2, reason: "threshold", blocking: true } as never]);
	assert.equal(transcript.compacting, since, "a second start keeps the first time");
	transcript.apply([{ type: "compaction_end", taskId: 1, reason: "manual" } as never]);
	assert.equal(transcript.compacting, undefined);
	const snapshot = { entries: [], inbox: [], tools: [], compactions: [{ taskId: 3 }], agent: {} } as never;
	transcript.load(snapshot);
	assert.ok(transcript.compacting !== undefined, "a client that attaches mid-compaction shows it too");
});

test("June's Org replies render as Markdown in the terminal, leaving paths and Markdown alone", () => {
	const org = "* Plan\nSome *bold*, /italic/ and =code=, see [[https://a.ca][A]].\nA path /home/alex/src/ and **markdown** stay.\n#+begin_src sh\necho *x*\n#+end_src";
	assert.equal(
		orgToMarkdown(org),
		"# Plan\nSome **bold**, *italic* and `code`, see [A](https://a.ca).\nA path /home/alex/src/ and **markdown** stay.\n```sh\necho *x*\n```",
	);
	assert.equal(orgToMarkdown("queued in =~/org/work/emacs.org=."), "queued in `~/org/work/emacs.org`.", "verbatim may start with the other marker");
	assert.equal(orgToMarkdown("set =a b= then =c=, not ==x=="), "set `a b` then `c`, not ==x==", "each span ends at its own marker");
});

test("a watch, work, follow, or heartbeat notice shows only June's words, whether it came through Telegram or the terminal", () => {
	const user = (id: number, text: string) => ({ id, kind: "pi.user", model: [{ role: "user", content: text }] });
	const said = (id: number, text: string, tool = false) => ({
		id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [...(tool ? [{ type: "toolCall", id: `c${id}`, name: "org_read_task", arguments: {} }] : []), { type: "text", text }] }],
	});
	const entries = [
		user(1, "hi"),
		said(2, "hello"),
		user(3, "[watch] Dispatched tasks you did not queue changed since you last heard:\n- «Snape» on kit is now EVAL."),
		said(4, "", true),
		said(5, "Snape's uptime report is at EVAL."),
		{ id: 6, kind: "june.input", data: { source: "watch", text: "1 dispatched task changed" } },
		user(7, "[watch] Dispatched tasks you did not queue changed since you last heard:\n- «Pirate» on kit is DONE."),
		said(8, "The pirate report is done."),
		user(9, "[heartbeat] A private heartbeat."),
		said(10, "QUIET"),
		user(11, "[follow] The task «Ship» is EVAL."),
		said(12, "Ship is ready."),
		{ id: 13, kind: "june.input", data: { source: "work", text: "report: Jon asks about Home Assistant" } },
		user(14, "[work] Home Assistant runs on hub."),
		said(15, "yes, it runs on hub."),
	];
	const transcript = new Transcript();
	transcript.load({ entries, inbox: [], tools: [], compactions: [], agent: {} } as never);
	const shown = transcript.items.map((i) => (i.kind === "user" ? `${i.source} › ${i.text}` : i.kind === "assistant" ? `june: ${i.blocks.map((b) => b.text ?? "").join("")}` : i.kind));
	assert.deepEqual(shown, ["telegram › hi", "june: hello", "june: Snape's uptime report is at EVAL.", "june: The pirate report is done.", "june: Ship is ready.", "june: yes, it runs on hub."]);
});
