import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Update } from "grammy/types";
import type { Reply, Request } from "../src/protocol.ts";
import { createLogger } from "../src/runtime.ts";
import { Bridge, type DaemonLink, SocketLink, TelegramApiError, type TelegramPort, retryTransformer, telegramCommand, TelegramUnknown } from "../src/telegram.ts";
import { markdownToTelegramHtml, splitForTelegram } from "../src/telegram-format.ts";
import type { ViewItem, ViewState } from "../src/transcript.ts";
import { openTestDaemon, tempDir, until } from "./helpers.ts";

const USER = 4242;
const log = createLogger({ sink: () => {} });
// A valid 2x2 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC";
const IMAGE = { type: "image" as const, mimeType: "image/png", data: PNG };

type Call = { op: "send" | "edit" | "draft" | "typing" | "download"; text?: string; mode?: string; id?: number };

/** A Telegram that records what the bridge does; `refuse` makes it turn down a kind of call. */
function fakePort(refuse: { rich?: boolean; draft?: boolean } = {}) {
	const calls: Call[] = [];
	let next = 100;
	const port: TelegramPort = {
		async send(_chat, text, mode) {
			if (mode === "rich" && refuse.rich) throw new TelegramApiError("sendRichMessage", 400, "Bad Request: can't parse rich message");
			calls.push({ op: "send", text, mode, id: next });
			return next++;
		},
		async editHtml(_chat, id, html) {
			calls.push({ op: "edit", id, text: html });
		},
		async draft(_chat, id, markdown) {
			if (refuse.draft) throw new TelegramApiError("sendRichMessageDraft", 400, "Bad Request: drafts are not available");
			calls.push({ op: "draft", id, text: markdown });
		},
		async typing() {
			calls.push({ op: "typing" });
		},
		async download() {
			calls.push({ op: "download" });
			return new Uint8Array(Buffer.from(PNG, "base64"));
		},
		async setCommands() {},
	};
	const sends = () => calls.filter((c) => c.op === "send");
	return { port, calls, sends };
}

let nextUpdate = 1;
function message(fields: Record<string, unknown>, options: { from?: number; chat?: number; type?: string; date?: number } = {}): Update {
	const id = nextUpdate++;
	return {
		update_id: id,
		message: {
			message_id: id,
			date: options.date ?? Math.floor(Date.now() / 1000),
			chat: { id: options.chat ?? USER, type: options.type ?? "private", first_name: "Alex" },
			from: { id: options.from ?? USER, is_bot: false, first_name: "Alex" },
			...fields,
		},
	} as unknown as Update;
}

/** A bridge on a real test daemon, through the socket as `june telegram` runs. */
async function onDaemon(t: { after(fn: () => unknown): void }, responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0], extra: { prepareImage?: (bytes: Uint8Array, mime: string) => Promise<typeof IMAGE> } = {}) {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses(responses);
	let daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	const telegram = fakePort();
	const stateFile = join(tmp.paths.state, "telegram.json");
	const link = new SocketLink(tmp.paths.socket, log);
	const bridge = new Bridge({ port: telegram.port, link, chatId: USER, allowedUserIds: [USER], stateFile, log, ...extra });
	bridge.start();
	const running = link.run((reply) => bridge.view(reply), () => bridge.disconnected());
	const stop = async () => {
		link.stop();
		await bridge.stop();
		await running;
	};
	t.after(stop);
	await until(() => {
		try {
			return JSON.parse(readFileSync(stateFile, "utf8")).seen !== undefined;
		} catch {
			return false;
		}
	});
	const inputs = async () => (await daemon.root.context(BG)).entries.filter((e) => e.kind === "june.input").map((e) => e.data as { source: string; text: string; imageCount?: number });
	const reopen = async () => {
		await daemon.close();
		daemon = await openTestDaemon({ ...tmp, faux });
	};
	return { tmp, faux, telegram, bridge, stateFile, inputs, reopen, stop, daemon: () => daemon };
}

test("a Telegram message is answered once, even when Telegram delivers it again, and nothing is resent after either process restarts", async (t) => {
	const { tmp, faux, telegram, bridge, stateFile, inputs, reopen, stop } = await onDaemon(t, [
		fauxAssistantMessage("Hello **there**."),
		fauxAssistantMessage("Still here."),
		fauxAssistantMessage("And again."),
	]);
	assert.equal(statSync(stateFile).mode & 0o777, 0o600, "the state file is private");
	const hi = message({ text: "hi" });
	await bridge.handle(hi);
	await bridge.handle(hi);
	await until(() => telegram.sends().length >= 1);
	await sleep(300);
	await bridge.idle();
	assert.deepEqual(telegram.sends().map((c) => [c.mode, c.text]), [["rich", "Hello **there**."]], "one answer, as rich Markdown");
	assert.deepEqual((await inputs()).map((i) => [i.source, i.text]), [["telegram", "hi"]], "one submission");

	// The daemon restarts: the bridge reconnects, takes the reset, sends nothing again, and answers what comes next.
	await reopen();
	await bridge.handle(message({ text: "still there?" }));
	await until(() => telegram.sends().length >= 2);
	await sleep(300);
	await bridge.idle();
	assert.deepEqual(telegram.sends().map((c) => c.text), ["Hello **there**.", "Still here."], "a daemon restart resends nothing");

	// The bridge restarts on the same state file: an old update is a duplicate, old answers are not resent.
	await stop();
	const telegram2 = fakePort();
	const link2 = new SocketLink(tmp.paths.socket, log);
	const bridge2 = new Bridge({ port: telegram2.port, link: link2, chatId: USER, allowedUserIds: [USER], stateFile, log });
	const running2 = link2.run((reply) => bridge2.view(reply));
	t.after(async () => {
		link2.stop();
		await bridge2.stop();
		await running2;
	});
	await bridge2.handle(hi);
	await sleep(300);
	await bridge2.idle();
	assert.equal(telegram2.sends().length, 0, "a bridge restart resends nothing and takes no old update");
	await bridge2.handle(message({ text: "and now?" }));
	await until(() => telegram2.sends().length >= 1);
	await sleep(300);
	assert.deepEqual(telegram2.sends().map((c) => c.text), ["And again."]);
	assert.equal(faux.state.callCount, 3);
	assert.equal((await inputs()).length, 3);
});

test("a photo with its caption, and an image sent as a file, reach June inline", async (t) => {
	let seen = 0;
	const { telegram, bridge, inputs } = await onDaemon(
		t,
		[
			(ctx) => {
				const last = ctx.messages.findLast((m) => m.role !== "system")!;
				seen += Array.isArray(last.content) ? last.content.filter((b) => b.type === "image").length : 0;
				return fauxAssistantMessage("Nice photo.");
			},
			(ctx) => {
				const last = ctx.messages.findLast((m) => m.role !== "system")!;
				seen += Array.isArray(last.content) ? last.content.filter((b) => b.type === "image").length : 0;
				return fauxAssistantMessage("Nice screenshot.");
			},
		],
		{ prepareImage: async () => IMAGE },
	);
	await bridge.handle(message({ photo: [{ file_id: "small", file_unique_id: "s", width: 1, height: 1 }, { file_id: "big", file_unique_id: "b", width: 2, height: 2 }], caption: "look at this" }));
	await until(() => telegram.sends().length >= 1);
	await bridge.handle(message({ document: { file_id: "doc", file_unique_id: "d", mime_type: "image/png", file_name: "shot.png" } }));
	await until(() => telegram.sends().length >= 2);
	assert.deepEqual((await inputs()).map((i) => [i.text, i.imageCount]), [["look at this", 1], ["", 1]]);
	assert.equal(seen, 2, "June saw both images");
	assert.deepEqual(telegram.sends().map((c) => c.text), ["Nice photo.", "Nice screenshot."]);
});

test("an image file is decoded for the model, and one that cannot be read gets a reply instead", async (t) => {
	const { telegram, bridge, inputs } = await onDaemon(t, [fauxAssistantMessage("Got it.")]);
	await bridge.handle(message({ document: { file_id: "doc", file_unique_id: "d", mime_type: "image/png" }, caption: "screenshot" }));
	await until(() => telegram.sends().length >= 1);
	assert.deepEqual((await inputs()).map((i) => [i.text, i.imageCount]), [["screenshot", 1]]);
	telegram.port.download = async () => new Uint8Array([1, 2, 3]);
	await bridge.handle(message({ document: { file_id: "bad", file_unique_id: "x", mime_type: "image/png" } }));
	await until(() => telegram.sends().length >= 2);
	assert.match(telegram.sends()[1]!.text!, /^I couldn't read that image/);
	assert.equal((await inputs()).length, 1, "nothing was submitted for it");
});

test("commands go to the daemon once and answer as plain messages; help is the bridge's own", async (t) => {
	const { telegram, bridge, inputs } = await onDaemon(t, []);
	const status = message({ text: "/status" });
	await bridge.handle(status);
	await bridge.handle(status);
	await bridge.handle(message({ text: "/help" }));
	await bridge.handle(message({ text: "/stop@JuneBot" }));
	await until(() => telegram.sends().length >= 3);
	await sleep(200);
	const texts = telegram.sends().map((c) => c.text!);
	assert.equal(texts.length, 3, "the redelivered /status ran once");
	assert.ok(telegram.sends().every((c) => c.mode === "plain"));
	assert.ok(texts.some((x) => /^June .*\nModel: faux\/faux-1/s.test(x)), texts.join("\n---\n"));
	assert.ok(texts.some((x) => /\/compact - /.test(x) && !/\/reload/.test(x)), "help lists Telegram's commands");
	assert.ok(texts.includes("Nothing is running."));
	assert.equal((await inputs()).length, 0);
	assert.deepEqual(telegramCommand("/new"), { name: "new", args: "" });
	assert.deepEqual(telegramCommand("/compact keep the plan"), { name: "compact", args: "keep the plan" });
	assert.equal(telegramCommand("/reload"), undefined, "terminal-only commands are text here");
	assert.equal(telegramCommand("/todo buy milk"), undefined);
});

test("a PDF goes to June's inbox with its caption, and one over the download limit gets a reply instead", async (t) => {
	let told = "";
	const { tmp, telegram, bridge, inputs } = await onDaemon(t, [
		(ctx) => {
			const last = ctx.messages.at(-1)!;
			told = typeof last.content === "string" ? last.content : "";
			return fauxAssistantMessage("Read it.");
		},
	]);
	const pdf = Buffer.from("%PDF-1.4 fake report");
	telegram.port.download = async () => new Uint8Array(pdf);
	await bridge.handle(message({ document: { file_id: "p", file_unique_id: "p", mime_type: "application/pdf", file_name: "report.pdf", file_size: pdf.length }, caption: "what does this say?" }));
	await until(() => telegram.sends().length >= 1);
	const [input] = (await inputs()) as { text: string; files?: { name: string; size: number; path: string }[] }[];
	assert.equal(input!.text, "what does this say?");
	assert.equal(input!.files?.length, 1);
	const { path } = input!.files![0]!;
	assert.ok(path.startsWith(join(tmp.paths.state, "inbox") + "/"), path);
	assert.deepEqual(readFileSync(path), pdf);
	assert.match(told, /^what does this say\?\n\n\[file report\.pdf, application\/pdf, 20 B, saved at .+-report\.pdf\]$/);
	assert.deepEqual(telegram.sends().map((c) => c.text), ["Read it."]);

	let downloads = 0;
	telegram.port.download = async () => (downloads++, new Uint8Array(pdf));
	await bridge.handle(message({ document: { file_id: "big", file_unique_id: "b", mime_type: "application/pdf", file_name: "huge.pdf", file_size: 21 * 1024 * 1024 } }));
	await until(() => telegram.sends().length >= 2);
	assert.equal(telegram.sends()[1]!.text, "I couldn't take huge.pdf: bots can download files up to 20 MB");
	assert.equal(downloads, 0, "nothing was downloaded");
	assert.equal((await inputs()).length, 1, "nothing was submitted for it");
});

test("voice notes, audio, video, and stickers are refused with a reply, and strangers are ignored", async (t) => {
	const { telegram, bridge, inputs } = await onDaemon(t, []);
	await bridge.handle(message({ voice: { file_id: "v", file_unique_id: "v", duration: 3 } }));
	await bridge.handle(message({ audio: { file_id: "a", file_unique_id: "a", duration: 3 } }));
	await bridge.handle(message({ video: { file_id: "m", file_unique_id: "m", width: 1, height: 1, duration: 3 } }));
	await bridge.handle(message({ animation: { file_id: "g", file_unique_id: "g", width: 1, height: 1, duration: 1 }, document: { file_id: "g", file_unique_id: "g", mime_type: "video/mp4" } }));
	await bridge.handle(message({ sticker: { file_id: "s", file_unique_id: "s", type: "regular", width: 1, height: 1, is_animated: false, is_video: false } }));
	await bridge.handle(message({ text: "hi June" }, { from: 999, chat: 999 }));
	await bridge.handle(message({ text: "hi all" }, { chat: -100, type: "group" }));
	await bridge.handle(message({ text: "old news" }, { date: Math.floor(Date.now() / 1000) - 3600 }));
	await sleep(300);
	assert.deepEqual(telegram.sends().map((c) => c.text), [
		...Array(5).fill("I can only take text, images, and files here: send a message, a photo, or a file."),
	]);
	assert.equal((await inputs()).length, 0, "a stranger, a group, and a message from before a first start reach no one");
});

// ---- The view side, with the daemon's replies given directly ----

const STATE: ViewState = { running: false, background: 0, queued: 0, model: "faux-1", compacting: false, expression: "idle" };
const user = (id: number, source: string, text = "hi"): ViewItem => ({ kind: "user", id: String(id), source, text });
const june = (id: number | string, text: string, answers: string, extra: Partial<Extract<ViewItem, { kind: "assistant" }>> = {}): ViewItem => ({ kind: "assistant", id: String(id), text, streaming: false, answers, ...extra });
const patter = (id: number, text: string): ViewItem => ({ kind: "patter", id: String(id), text });

const link: DaemonLink = { request: async (request: Request): Promise<Reply> => ({ type: "accepted", requestId: request.requestId, submissionId: 1 }) };

async function viewBridge(t: { after(fn: () => unknown): void }, items: ViewItem[], state: Partial<ViewState> = {}, options: { refuse?: { rich?: boolean; draft?: boolean }; stateFile?: string } = {}) {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const telegram = fakePort(options.refuse);
	const stateFile = options.stateFile ?? join(tmp.dir, "telegram.json");
	const bridge = new Bridge({ port: telegram.port, link, chatId: USER, allowedUserIds: [USER], stateFile, log, timing: { typingMs: 60, draftMs: 30, draftRefreshMs: 200, tickMs: 10 } });
	bridge.start();
	t.after(() => bridge.stop());
	let shown = items;
	bridge.view({ type: "view", reset: true, items, state: { ...STATE, ...state }, earlier: false });
	await bridge.idle();
	const put = async (item: ViewItem, next: Partial<ViewState> | undefined = undefined) => {
		shown = [...shown.filter((i) => i.id !== item.id), item];
		bridge.view({ type: "view", changes: [{ op: "put", item, after: shown.at(-2)?.id ?? null }], ...(next ? { state: { ...STATE, ...next } } : {}) });
		await bridge.idle();
	};
	const drop = async (id: string, next?: Partial<ViewState>) => {
		shown = shown.filter((i) => i.id !== id);
		bridge.view({ type: "view", changes: [{ op: "drop", id }], ...(next ? { state: { ...STATE, ...next } } : {}) });
		await bridge.idle();
	};
	const reset = async (next: ViewItem[] = shown) => {
		shown = next;
		bridge.view({ type: "view", reset: true, items: next, state: STATE, earlier: false });
		await bridge.idle();
	};
	return { telegram, bridge, stateFile, put, drop, reset };
}

test("a first start sends nothing it finds; later replies to Telegram are sent, and others are not", async (t) => {
	const { telegram, put } = await viewBridge(t, [user(1, "telegram"), june(2, "Old answer.", "telegram")]);
	assert.equal(telegram.sends().length, 0, "a reset sends nothing by itself");
	await put(user(3, "telegram", "and now?"));
	await put(june(4, "Now this.", "telegram"));
	await put(user(5, "tui", "from the desk"));
	await put(june(6, "Desk answer.", "tui"));
	await put(june(7, "", "telegram", { thinking: "Looking" }));
	assert.deepEqual(telegram.sends().map((c) => c.text), ["Now this."]);
});

test("June's Org reaches Telegram as the Markdown it renders", async (t) => {
	const { telegram, put } = await viewBridge(t, [user(1, "telegram")]);
	await put(user(2, "telegram", "where?"));
	await put(june(3, "It is *here*, in =~/org/todo.org=, see [[https://a.ca][A]].", "telegram"));
	assert.deepEqual(telegram.sends().map((c) => c.text), ["It is **here**, in `~/org/todo.org`, see [A](https://a.ca)."]);
});

test("a notice reaches Telegram only when it is routed there", async (t) => {
	const { telegram, put } = await viewBridge(t, [user(1, "telegram")]);
	await put(june(2, "Your audit finished.", "work", { alert: "telegram" }));
	await put(june(3, "The build is green.", "follow", { alert: "gui" }));
	await put(june(4, "Heartbeat note.", "heartbeat"));
	await put(june("failure:9", "", "telegram", { error: "model error: overloaded" }));
	await put(june(5, "", "telegram", { error: "aborted" }));
	assert.deepEqual(telegram.sends().map((c) => c.text), ["Your audit finished.", "⚠ model error: overloaded"]);
});

test("a failed attempt with no words stays off Telegram; the run's own failure is what reports it", async (t) => {
	const { telegram, put } = await viewBridge(t, [user(1, "telegram")]);
	await put(june(2, "", "telegram", { error: "Request timed out." }));
	await put(june(3, "Done, the retry worked.", "telegram"));
	await put(june(4, "Half an answer", "telegram", { error: "connection reset" }));
	assert.deepEqual(telegram.sends().map((c) => c.text), ["Done, the retry worked.", "Half an answer\n\n⚠ connection reset"]);
});

test("patter grows one message per wait, and June's answer ends the wait", async (t) => {
	const { telegram, put } = await viewBridge(t, [user(1, "telegram")], { running: true });
	await put(user(10, "telegram", "build it"));
	await put(patter(11, "Tubes are clogged."));
	await put({ kind: "tool", id: "call:a", name: "bash", summary: "", status: "running" });
	await put(patter(12, "Still poking the robot."));
	await put(june(13, "Built.", "telegram"));
	await put(patter(14, "Round two."));
	assert.deepEqual(
		telegram.calls.filter((c) => c.op === "send" || c.op === "edit").map((c) => [c.op, c.text]),
		[
			["send", "🦘 <i>Tubes are clogged.</i>"],
			["edit", "🦘 <i>Tubes are clogged.</i>\n\n🦘 <i>Still poking the robot.</i>"],
			["send", "Built."],
			["send", "🦘 <i>Round two.</i>"],
		],
	);
	const edit = telegram.calls.find((c) => c.op === "edit")!;
	assert.equal(edit.id, telegram.sends()[0]!.id, "the edit is to the wait's own message");
	await put(user(15, "tui", "from the desk"));
	await put(patter(16, "Desk patter."));
	assert.equal(telegram.calls.filter((c) => c.op === "send" || c.op === "edit").length, 4, "no patter once the user is at the terminal");
});

test("an open patter message keeps growing after a bridge restart, and nothing is sent twice", async (t) => {
	const first = await viewBridge(t, [user(1, "telegram")], { running: true });
	await first.put(patter(2, "One."));
	await first.bridge.stop();
	const second = await viewBridge(t, [user(1, "telegram"), patter(2, "One.")], { running: true }, { stateFile: first.stateFile });
	assert.equal(second.telegram.calls.filter((c) => c.op !== "typing").length, 0);
	await second.put(patter(3, "Two."));
	assert.deepEqual(second.telegram.calls.filter((c) => c.op === "edit").map((c) => [c.id, c.text]), [[100, "🦘 <i>One.</i>\n\n🦘 <i>Two.</i>"]]);
	await second.reset();
	assert.equal(second.telegram.calls.filter((c) => c.op === "send" || c.op === "edit").length, 1, "a later reset sends nothing");
});

test("typing while June works on a Telegram message, and her streaming reply as a draft", async (t) => {
	const { telegram, put, drop } = await viewBridge(t, [user(5, "telegram")], { running: true });
	await sleep(200);
	const typing = telegram.calls.filter((c) => c.op === "typing").length;
	assert.ok(typing >= 2, `typing repeats while June works: ${typing}`);
	await put(june("live", "Here is", "telegram", { streaming: true }), { running: true });
	await sleep(60);
	await put(june("live", "Here is the answer", "telegram", { streaming: true }), { running: true });
	await sleep(60);
	const drafts = telegram.calls.filter((c) => c.op === "draft");
	assert.deepEqual(drafts.map((c) => [c.id, c.text]).at(-1), [5, "Here is the answer"], "the draft follows the stream");
	await sleep(300);
	assert.ok(telegram.calls.filter((c) => c.op === "draft").length > drafts.length, "a quiet draft is refreshed");
	await drop("live");
	await put(june(6, "Here is the answer.", "telegram"), { running: false });
	const after = telegram.calls.length;
	await sleep(200);
	assert.equal(telegram.calls.length, after, "nothing more once June is idle");
	assert.equal(telegram.sends().at(-1)!.text, "Here is the answer.");
	await put(user(7, "tui"), { running: true });
	await sleep(200);
	assert.equal(telegram.calls.length, after + 0, "no typing for a terminal message");
	await put(user(8, "telegram"), { background: 1 });
	await sleep(150);
	assert.ok(telegram.calls.slice(after).some((c) => c.op === "typing"), "typing while background work runs");
});

test("a refused draft falls back to typing, and a refused rich message to HTML", async (t) => {
	const { telegram, put } = await viewBridge(t, [user(5, "telegram")], { running: true }, { refuse: { rich: true, draft: true } });
	await put(june("live", "Streaming", "telegram", { streaming: true }), { running: true });
	await sleep(200);
	assert.equal(telegram.calls.filter((c) => c.op === "draft").length, 0);
	assert.ok(telegram.calls.filter((c) => c.op === "typing").length >= 2);
	await put(june(6, "**Bold** <b>tag</b>", "telegram"), { running: false });
	assert.deepEqual(telegram.sends().map((c) => [c.mode, c.text]), [["html", "<b>Bold</b> &lt;b&gt;tag&lt;/b&gt;"]]);
});

test("Markdown becomes Telegram HTML in messages under 4,096 characters", () => {
	assert.equal(markdownToTelegramHtml("# Plan\n**a** _b_ `c<d` [x](https://e.com)\n> quote"), '<b>Plan</b>\n<b>a</b> <i>b</i> <code>c&lt;d</code> <a href="https://e.com">x</a>\n<blockquote>quote</blockquote>');
	const long = `${"word ".repeat(1500)}\n\n\`\`\`ts\n${"const x = 1;\n".repeat(400)}\`\`\``;
	const chunks = splitForTelegram(long);
	assert.ok(chunks.length > 1);
	assert.ok(chunks.every((c) => c.html.length <= 4096 && c.markdown.length <= 4096));
	const code = chunks.filter((c) => c.markdown.includes("const x"));
	assert.ok(code.length > 1, "the code block spans messages");
	assert.ok(code.every((c) => c.markdown.includes("```ts\n") && c.markdown.trimEnd().endsWith("```")), "each part of a split fence is opened and closed");
	assert.ok(code.slice(1).every((c) => c.markdown.startsWith("```ts\n")), "a split fence is reopened");
});

test("the retry policy waits out 429s and never resends a message Telegram may have taken", async () => {
	const waits: number[] = [];
	const retry = retryTransformer({ wait: async (ms) => waits.push(ms) });
	let calls = 0;
	const flaky = async () => (++calls === 1 ? { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } } : { ok: true, result: 1 });
	assert.deepEqual(await retry(flaky, "sendMessage", {}), { ok: true, result: 1 });
	assert.deepEqual(waits, [2000]);
	calls = 0;
	await assert.rejects(retry(async () => (++calls, { ok: false, error_code: 502, description: "Bad Gateway" }), "sendMessage", {}), TelegramUnknown);
	assert.equal(calls, 1, "a 5xx on a send is not retried");
	calls = 0;
	await assert.rejects(retry(async () => (++calls, Promise.reject(new Error("socket hang up"))), "sendRichMessage", {}), TelegramUnknown);
	assert.equal(calls, 1, "nor is a network error");
	calls = 0;
	assert.deepEqual(await retry(async () => (++calls < 3 ? Promise.reject(new Error("reset")) : { ok: true, result: true }), "editMessageText", {}), { ok: true, result: true });
	assert.equal(calls, 3, "an edit is safe to retry");
});

test("a submit waiting for an absent daemon gives up when the bridge stops", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const link = new SocketLink(join(tmp.dir, "nobody.sock"), log);
	const running = link.run(() => {});
	const pending = link.request({ op: "submit", requestId: "update:1", text: "hi", source: "telegram" }, { retry: true });
	await sleep(50);
	link.stop();
	await assert.rejects(pending, /stopping/);
	await running;
});
