import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Client, type Reply } from "../src/protocol.ts";
import { createCodingExtension } from "../src/tools/coding.ts";
import { fold, type ViewItem } from "../src/transcript.ts";
import { Transcript } from "../src/tui.ts";
import { ask, attachView, openTestDaemon, tempDir, until } from "./helpers.ts";

const input = (id: number, source: string, text: string, extra: Record<string, unknown> = {}) => ({ id, kind: "june.input", data: { source, text, ...extra }, model: [{ role: "user", content: `[${source}] ${text}` }] });
const said = (id: number, content: unknown[], extra: Record<string, unknown> = {}) => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content, stopReason: "stop", ...extra }] });
const result = (id: number, callId: string, toolName: string, text: string) => ({ id, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], isError: false }] });
const assistants = (items: readonly ViewItem[]) => items.flatMap((i) => (i.kind === "assistant" ? [{ id: i.id, answers: i.answers, ...(i.alert ? { alert: i.alert } : {}) }] : []));

test("answers names the input a reply follows, and only a finished reply to gui, apk, or a routed notice alerts", () => {
	const entries = [
		input(1, "gui", "check the bins"),
		said(2, [{ type: "text", text: "Looking." }, { type: "toolCall", id: "c1", name: "bash", arguments: {} }], { stopReason: "toolUse" }),
		result(3, "c1", "bash", "ok"),
		said(4, [{ type: "text", text: "Bins are out." }]),
		input(5, "apk", "and the car?"),
		said(6, [{ type: "text", text: "Charging." }]),
		input(7, "kitty", "thanks"),
		said(8, [{ type: "text", text: "Any time." }]),
		{ id: 9, kind: "pi.user", model: [{ role: "user", content: "from the phone" }] },
		said(10, [{ type: "text", text: "Hi." }]),
		input(11, "telegram", "from the bridge"),
		said(12, [{ type: "text", text: "Hello." }]),
		input(13, "work", "report: bins", { surface: "telegram" }),
		said(14, [{ type: "text", text: "The bins are done." }]),
		input(15, "heartbeat", "heartbeat", { surface: "apk" }),
		said(16, [{ type: "text", text: "Rain at four." }]),
		input(17, "heartbeat", "heartbeat", { surface: "gui" }),
		said(18, [{ type: "text", text: "QUIET" }]),
		input(19, "follow", "task moved"),
		said(20, [{ type: "text", text: "Your task moved." }]),
		input(21, "apk", "one more"),
	];
	const live = { run: { taskId: 3, inputs: [21], turns: 0 }, generation: { attempt: 1, message: { content: [{ type: "text", text: "Work" }] } } };
	assert.deepEqual(assistants(fold(entries, { "pi.live": live }).items), [
		{ id: "2", answers: "gui" },
		{ id: "4", answers: "gui", alert: "gui" },
		{ id: "6", answers: "apk", alert: "apk" },
		{ id: "8", answers: "tui" },
		{ id: "10", answers: "telegram" },
		{ id: "12", answers: "telegram" },
		{ id: "14", answers: "work", alert: "telegram" },
		{ id: "16", answers: "heartbeat", alert: "apk" },
		{ id: "20", answers: "follow" },
		{ id: "live", answers: "apk" },
	]);
	const unanswered = fold(entries.slice(0, 5), { "pi.live": { runFailure: { taskId: 4, inputs: [5], reason: "model_error", detail: "429" } } }).items;
	assert.deepEqual(unanswered.at(-1), { kind: "assistant", id: "failure:4", text: "", streaming: false, answers: "apk", alert: "apk", error: "model error: 429" });
});

test("stored kitty reads as tui, and every reply keeps the markup June wrote, for each client to render", () => {
	const entries = [
		input(1, "kitty", "old terminal"),
		said(2, [{ type: "text", text: "Use =june= *now*." }]),
		input(3, "telegram", "from the bridge"),
		said(4, [{ type: "text", text: "Use `june` *now*." }]),
		input(5, "gui", "from the desktop client"),
		said(6, [{ type: "text", text: "Use =june= *now*." }]),
	];
	const items = fold(entries, {}).items;
	assert.deepEqual(
		items.map((i) => (i.kind === "user" ? `${i.source} › ${i.text}` : i.kind === "assistant" ? i.text : i.kind)),
		["tui › old terminal", "Use =june= *now*.", "telegram › from the bridge", "Use `june` *now*.", "gui › from the desktop client", "Use =june= *now*."],
	);
});

test("detail shows full thinking, tool output, and June's private looks, a quiet heartbeat included, and keeps every simple item", () => {
	const entries = [
		input(1, "tui", "find it"),
		said(2, [{ type: "thinking", thinking: "**Finding** it\nin two lines" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], { stopReason: "toolUse" }),
		result(3, "c1", "bash", "a\nb"),
		said(4, [{ type: "text", text: "Found it." }]),
		{ id: 5, kind: "june.input", data: { source: "heartbeat", text: "heartbeat" }, model: [{ role: "user", content: "[heartbeat] It is 14:00. Anything?" }] },
		said(6, [{ type: "thinking", thinking: "nothing due" }, { type: "toolCall", id: "c2", name: "org_agenda", arguments: { day: "today" } }], { stopReason: "toolUse" }),
		result(7, "c2", "org_agenda", "empty"),
		said(8, [{ type: "text", text: "QUIET" }]),
		input(9, "heartbeat", "heartbeat", { surface: "gui" }),
		said(10, [{ type: "text", text: "Bins tonight." }]),
		input(11, "tui", "run the long one"),
		said(12, [{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "make" } }], { stopReason: "toolUse" }),
	];
	const live = { run: { taskId: 9, inputs: [11], turns: 1 }, tools: [{ callId: "c3", name: "bash", status: "running", output: "compiling" }] };
	const simple = fold(entries, { "pi.live": live }).items;
	const detail = fold(entries, { "pi.live": live }, false, { detail: true }).items;
	assert.deepEqual(detail, [
		{ kind: "user", id: "1", source: "tui", text: "find it" },
		{ kind: "assistant", id: "2", text: "", streaming: false, answers: "tui", thinking: "**Finding** it\nin two lines" },
		{ kind: "tool", id: "call:c1", name: "bash", summary: "command=ls", status: "done", output: "a\nb" },
		{ kind: "assistant", id: "4", text: "Found it.", streaming: false, answers: "tui" },
		{ kind: "user", id: "5", source: "heartbeat", text: "[heartbeat] It is 14:00. Anything?", private: true },
		{ kind: "assistant", id: "6", text: "", streaming: false, answers: "heartbeat", thinking: "nothing due", private: true },
		{ kind: "tool", id: "call:c2", name: "org_agenda", summary: "day=today", status: "done", output: "empty", private: true },
		{ kind: "assistant", id: "8", text: "QUIET", streaming: false, answers: "heartbeat", private: true },
		{ kind: "user", id: "9", source: "heartbeat", text: "[heartbeat] heartbeat", private: true },
		{ kind: "assistant", id: "10", text: "Bins tonight.", streaming: false, answers: "heartbeat", alert: "gui" },
		{ kind: "user", id: "11", source: "tui", text: "run the long one" },
		{ kind: "tool", id: "call:c3", name: "bash", summary: "command=make", status: "running", output: "compiling" },
	]);
	assert.deepEqual(
		simple.map((i) => i.id),
		detail.filter((i) => !("private" in i)).map((i) => i.id),
		"the simple view is detail without the private items",
	);
	assert.ok(simple.every((i) => !("private" in i) && !("output" in i)));
	assert.equal(simple.find((i) => i.id === "2")?.kind === "assistant" && (simple.find((i) => i.id === "2") as { thinking?: string }).thinking, "Finding it in two lines");

	// A look's stream and running tools are private until her answer shows whether it is a message.
	const look = [...entries.slice(0, 4), input(5, "heartbeat", "heartbeat")];
	const looking = { run: { taskId: 3, inputs: [5], turns: 0 }, generation: { attempt: 1, message: { content: [{ type: "text", text: "Bins" }] } }, tools: [{ callId: "c9", name: "bash", status: "running" }] };
	assert.deepEqual(fold(look, { "pi.live": looking }).items.slice(4), []);
	assert.deepEqual(fold(look, { "pi.live": looking }, false, { detail: true }).items.slice(4), [
		{ kind: "user", id: "5", source: "heartbeat", text: "[heartbeat] heartbeat", private: true },
		{ kind: "assistant", id: "live", text: "Bins", streaming: true, answers: "heartbeat", private: true },
		{ kind: "tool", id: "call:c9", name: "bash", summary: "", status: "running", private: true },
	]);
});

test("a scripted client sees what the terminal shows; detail toggles with a reset and survives a reconnect", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxThinking("**Reading** the file\nin full"), fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("It says *hi*.")]),
		fauxAssistantMessage("Charging."),
		fauxAssistantMessage("Any time."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());

	// The terminal's own transcript, attached as the terminal attaches.
	const terminal = new Transcript();
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	client.on((reply) => reply.type === "view" && terminal.apply(reply));
	await client.request({ op: "attach", requestId: "tui" });
	const gui = await attachView(tmp.paths.socket);
	t.after(() => gui.close());
	const full = await attachView(tmp.paths.socket, { detail: true });
	t.after(() => full.close());

	await ask(tmp.paths.socket, "read it", "g1", "gui");
	await ask(tmp.paths.socket, "and the car?", "a1", "apk");
	await ask(tmp.paths.socket, "thanks", "t1", "tui");
	const settled = (items: readonly ViewItem[]) => {
		const last = items.at(-1);
		return last?.kind === "assistant" && last.text === "Any time.";
	};
	await until(() => settled(terminal.items) && settled(gui.items()) && settled(full.items()) && !gui.state().running);

	assert.deepEqual(gui.items(), terminal.items, "the scripted client and the terminal hold the same items");
	assert.deepEqual(gui.state(), terminal.state);
	assert.deepEqual(assistants(gui.items()), [
		{ id: assistants(gui.items())[0]!.id, answers: "gui" },
		{ id: assistants(gui.items())[1]!.id, answers: "gui", alert: "gui" },
		{ id: assistants(gui.items())[2]!.id, answers: "apk", alert: "apk" },
		{ id: assistants(gui.items())[3]!.id, answers: "tui" },
	]);
	assert.deepEqual(gui.items().map((i) => (i.kind === "assistant" ? i.text : i.kind === "user" ? `${i.source} › ${i.text}` : i.kind)), ["gui › read it", "", "tool", "It says *hi*.", "apk › and the car?", "Charging.", "tui › thanks", "Any time."]);

	const thinking = full.items().find((i) => i.kind === "assistant" && i.thinking);
	assert.equal(thinking?.kind === "assistant" && thinking.thinking, "**Reading** the file\nin full");
	const tool = full.items().find((i) => i.kind === "tool");
	assert.ok(tool?.kind === "tool" && tool.status === "done" && tool.output?.includes("hi"), JSON.stringify(tool));
	const detailed = full.items();

	// Off: a reset to the simple view, the same as the other clients. On again: the complete view as it was.
	const off = await full.detail(false);
	assert.ok(off.type === "view" && "reset" in off);
	assert.deepEqual(full.items(), gui.items());
	const on = await full.detail(true);
	assert.ok(on.type === "view" && "reset" in on);
	assert.deepEqual(full.items(), detailed);

	// A reconnect that asks for detail again gets the same view.
	full.close();
	const again = await attachView(tmp.paths.socket, { detail: true });
	t.after(() => again.close());
	assert.deepEqual(again.items(), detailed);
	assert.deepEqual(gui.items(), terminal.items, "the other connections stayed simple");
});

test("sources: kitty is recorded as tui, Telegram reaches the model untagged, and an unknown source is refused", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("Use =june=."), fauxAssistantMessage("Use `june`.")]);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	await ask(tmp.paths.socket, "from an old terminal", "k1", "kitty");
	await ask(tmp.paths.socket, "from the phone", "m1", "telegram");
	const context = await daemon.root.context(BG);
	const inputs = context.entries.filter((e) => e.kind === "june.input").map((e) => (e.data as { source: string }).source);
	assert.deepEqual(inputs, ["tui", "telegram"]);
	const users = context.messages.filter((m) => m.role === "user").map((m) => m.content);
	assert.deepEqual(users, ["[tui] from an old terminal", "from the phone"]);
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());
	assert.deepEqual(
		view.items().map((i) => (i.kind === "assistant" ? `${i.answers}: ${i.text}` : i.kind === "user" ? `${i.source} › ${i.text}` : i.kind)),
		["tui › from an old terminal", "tui: Use =june=.", "telegram › from the phone", "telegram: Use `june`."],
	);
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const refused: Reply = await client.request({ op: "submit", requestId: "x", text: "hi", source: "fax" as never });
	assert.deepEqual(refused, { type: "error", requestId: "x", message: "Unknown source fax" });
	const unattached: Reply = await client.request({ op: "detail", requestId: "d", on: true });
	assert.deepEqual(unattached, { type: "error", requestId: "d", message: "Not attached" });
});
