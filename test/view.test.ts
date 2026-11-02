import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { attachView as serveView } from "../src/daemon.ts";
import type { Reply } from "../src/protocol.ts";
import { createCodingExtension } from "../src/tools/coding.ts";
import { applyChanges, diff, fold, type ViewItem } from "../src/transcript.ts";
import { ask, attachView, lines, openTestDaemon, tempDir, until } from "./helpers.ts";

const user = (id: number, source: string, text: string) => ({ id, kind: "june.input", data: { source, text }, model: [{ role: "user", content: `[${source}] ${text}` }] });
const said = (id: number, content: unknown[], extra: Record<string, unknown> = {}) => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content, ...extra }] });
const result = (id: number, callId: string, toolName: string, text: string, isError = false) => ({ id, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], isError }] });
const telegram = (id: number, text: string) => ({ id, kind: "pi.user", model: [{ role: "user", content: text }] });

test("the fold: thinking as one line each, tool lines with their status, Org as Markdown, and notes", () => {
	const entries = [
		user(1, "kitty", "find the heading"),
		said(2, [
			{ type: "thinking", thinking: "**Finding** project\nheading" },
			{ type: "toolCall", id: "c1", name: "org_search", arguments: { query: "june", deep: { nested: true } } },
			{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "false" } },
		]),
		result(3, "c1", "org_search", "found"),
		result(4, "c2", "bash", "exit 1\nmore detail", true),
		said(5, [{ type: "text", text: "It is *here*, in =june.org=." }]),
		{ id: 6, kind: "june.patter", data: { text: "rummaging" } },
		{ id: 7, kind: "pi.compaction" },
		{ id: 8, kind: "pi.reset" },
		telegram(9, "and from the phone?"),
		said(10, [{ type: "text", text: "Markdown *stays*." }]),
	];
	const { items, state } = fold(entries, { "pi.agent": { model: { modelId: "terra" }, thinkingLevel: "medium" } });
	assert.deepEqual(items, [
		{ kind: "user", id: "1", source: "tui", text: "find the heading" },
		{ kind: "assistant", id: "2", text: "", streaming: false, answers: "tui", thinking: "Finding project heading" },
		{ kind: "tool", id: "call:c1", name: "org_search", summary: "query=june", status: "done" },
		{ kind: "tool", id: "call:c2", name: "bash", summary: "command=false", status: "error", error: "exit 1" },
		{ kind: "assistant", id: "5", text: "It is **here**, in `june.org`.", streaming: false, answers: "tui" },
		{ kind: "patter", id: "6", text: "rummaging" },
		{ kind: "note", id: "7", text: "earlier conversation compacted" },
		{ kind: "note", id: "8", text: "new context" },
		{ kind: "user", id: "9", source: "telegram", text: "and from the phone?" },
		{ kind: "assistant", id: "10", text: "Markdown *stays*.", streaming: false, answers: "telegram" },
	]);
	assert.deepEqual(state, { running: false, background: 0, queued: 0, model: "terra:medium", compacting: false });
});

test("the fold: the streaming reply, running tools, the queue, and a retry come from pi.live and pi.inbox", () => {
	const entries = [user(1, "kitty", "build it"), said(2, [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "make" } }])];
	const live = {
		run: { taskId: 9, inputs: [1], turns: 1 },
		tools: [{ callId: "c1", name: "bash", status: "running", output: "compiling" }],
		generation: { attempt: 2, message: { content: [{ type: "text", text: "Nearly *done*" }] }, retry: { at: 0, error: "overloaded" } },
	};
	const { items, state } = fold(entries, { "pi.live": live, "pi.inbox": { items: [{}, {}] } });
	assert.deepEqual(items.slice(1), [
		{ kind: "tool", id: "call:c1", name: "bash", summary: "command=make", status: "running" },
		{ kind: "assistant", id: "live", text: "Nearly **done**", streaming: true, answers: "tui" },
	]);
	assert.equal(state.running, true);
	assert.equal(state.queued, 2);
	assert.equal(state.notice, "retrying: overloaded");
	// The run ends without the call's result: it was cut off.
	assert.deepEqual(fold(entries, {}).items[1], { kind: "tool", id: "call:c1", name: "bash", summary: "command=make", status: "error", error: "interrupted" });
});

test("the fold: a run that failed shows why, unless the user stopped it or started afresh", () => {
	const entries = [user(1, "kitty", "hi")];
	const failed = (reason: string, detail?: string) => fold(entries, { "pi.live": { runFailure: { taskId: 4, inputs: [1], reason, ...(detail ? { detail } : {}) } } }).items;
	assert.deepEqual(failed("model_error", "429 Too Many Requests").at(-1), { kind: "assistant", id: "failure:4", text: "", streaming: false, answers: "tui", error: "model error: 429 Too Many Requests" });
	assert.equal(failed("aborted").length, 1);
	assert.equal(failed("reset").length, 1);
	const shown = fold([...entries, said(2, [], { stopReason: "error", errorMessage: "boom" })], { "pi.live": { runFailure: { taskId: 4, inputs: [1], reason: "model_error", detail: "boom" } } }).items;
	assert.deepEqual(shown.at(-1), { kind: "assistant", id: "2", text: "", streaming: false, answers: "tui", error: "boom" }, "an error entry already says it");
	const running = fold(entries, { "pi.live": { run: { taskId: 5, inputs: [2], turns: 0 }, runFailure: { taskId: 4, inputs: [1], reason: "model_error" } } }).items;
	assert.equal(running.length, 1, "a new run clears it");
});

test("the fold: a hidden heartbeat look shows only a real message, in the markup of where the user last spoke", () => {
	const entries = [
		telegram(1, "hi from the phone"),
		said(2, [{ type: "text", text: "hello" }]),
		user(3, "heartbeat", "heartbeat"),
		said(4, [{ type: "thinking", thinking: "checking" }, { type: "toolCall", id: "c9", name: "org_read_task", arguments: {} }]),
		result(5, "c9", "org_read_task", "secret"),
		said(6, [{ type: "text", text: "QUIET" }]),
		user(7, "heartbeat", "heartbeat"),
		said(8, [{ type: "text", text: "Bins *tonight*." }]),
	];
	const live = { run: { taskId: 3, inputs: [7], turns: 0 }, generation: { attempt: 1, message: { content: [{ type: "text", text: "thinking aloud" }] } }, tools: [{ callId: "c10", name: "bash", status: "running" }] };
	assert.deepEqual(lines(fold(entries, { "pi.live": live }).items), ["alex: hi from the phone", "june: hello", "june: Bins *tonight*."], "Markdown, since Alex last spoke from Telegram; the look's stream and tools stay out");
});

test("diff and applyChanges turn any list into any other", () => {
	const item = (id: string, text = id): ViewItem => ({ kind: "note", id, text });
	let seed = 7;
	const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
	for (let round = 0; round < 500; round++) {
		const pick = () => Array.from(new Set(Array.from({ length: random(8) }, () => String.fromCharCode(97 + random(10))))).map((id) => item(id, random(3) === 0 ? `${id}!` : id));
		const before = pick();
		const after = pick();
		const sent = new Map(before.map((i) => [i.id, JSON.stringify(i)]));
		const changes = diff(before, after, sent);
		assert.deepEqual(applyChanges(before, changes), after, JSON.stringify({ before, after, changes }));
		assert.deepEqual(diff(after, after, sent), [], "nothing changed, nothing sent");
	}
});

test("a root replacement starts the view over with a reset", async () => {
	type Listener = (call: { kind: "value"; value: unknown; ops: unknown[]; retired: boolean }, context: unknown) => Promise<void>;
	let listener: Listener | undefined;
	const view = (texts: string[]) => ({ conversation: {}, docs: {}, entries: texts.map((text, i) => ({ id: i + 1, kind: "june.patter", data: { text } })) });
	const root = {
		watch: async () => ({ value: view(["one"]), start: (l: Listener) => (listener = l), stop: async () => ({ kind: "stopped" }) }),
		entries: async () => ({ items: [] }),
	};
	const sent: Reply[] = [];
	const stop = await serveView(root as never, BG, (r) => sent.push(r), "attach-1");
	assert.deepEqual(sent, [{ type: "view", requestId: "attach-1", reset: true, items: [{ kind: "patter", id: "1", text: "one" }], state: { running: false, background: 0, queued: 0, model: "", compacting: false }, earlier: false }]);
	await listener!({ kind: "value", value: view(["one", "two"]), ops: [["p", ["entries"], 1, 0, [{}]]], retired: false }, BG);
	await until(() => sent.length === 2);
	assert.deepEqual(sent[1], { type: "view", changes: [{ op: "put", item: { kind: "patter", id: "2", text: "two" }, after: "1" }] });
	const replacement = view(["fresh"]);
	await listener!({ kind: "value", value: replacement, ops: [["r", replacement]], retired: false }, BG);
	await until(() => sent.length === 3);
	assert.deepEqual(sent[2], { type: "view", reset: true, items: [{ kind: "patter", id: "1", text: "fresh" }], state: { running: false, background: 0, queued: 0, model: "", compacting: false }, earlier: false });
	await stop.stop();
});

test("a streaming reply grows in place as the live item, at most ten times a second, then becomes its entry", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider({ tokensPerSecond: 40 });
	faux.setResponses([fauxAssistantMessage([fauxThinking("Counting wombats"), fauxText(`${"wombat ".repeat(60)}done`)])]);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());
	const started = Date.now();
	const answered = ask(tmp.paths.socket, "count them", "r1", "kitty");
	const growing: string[] = [];
	await until(() => {
		const live = view.items().find((i) => i.id === "live");
		if (live?.kind === "assistant" && live.text && growing.at(-1) !== live.text) growing.push(live.text);
		return growing.length >= 2;
	}, 10_000);
	assert.ok(growing[1]!.startsWith(growing[0]!), "the same item grows");
	assert.equal(view.state().running, true);
	await answered;
	await until(() => !view.state().running);
	const elapsed = Date.now() - started;
	assert.equal(view.items().some((i) => i.id === "live"), false, "the live item is gone");
	const final = view.items().at(-1)!;
	assert.ok(final.kind === "assistant" && final.text.endsWith("done") && final.thinking === "Counting wombats" && !final.streaming);
	assert.notEqual(final.id, "live");
	assert.ok(view.replies.length <= Math.ceil(elapsed / 100) + 3, `${view.replies.length} replies in ${elapsed} ms`);
});

test("tool lines appear while a call runs and settle with its status", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.6; echo hi" }), fauxToolCall("no_such_tool", { query: "x" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Done."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());
	const answered = ask(tmp.paths.socket, "run it", "r1", "kitty");
	await until(() => view.items().some((i) => i.kind === "tool" && i.name === "bash" && i.status === "running"));
	await answered;
	await until(() => lines(view.items()).at(-1) === "june: Done.");
	const tools = view.items().filter((i) => i.kind === "tool");
	assert.deepEqual(tools.map((i) => [i.name, i.status, i.summary]), [["bash", "done", "command=sleep 0.6; echo hi"], ["no_such_tool", "error", "query=x"]]);
	assert.ok(tools[1]!.kind === "tool" && tools[1]!.error, "a failed call says why in one line");
	const again = await attachView(tmp.paths.socket);
	t.after(() => again.close());
	assert.deepEqual(again.items(), view.items(), "a reconnect folds the same items");
});

test("a compaction shows while it runs and leaves a note", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	// The summary request is told apart by what it asks for, so the order of threshold and manual compactions cannot race.
	const step = async (ctx: { messages: unknown[] }) => {
		if (!/summar/i.test(JSON.stringify(ctx.messages.at(-1)))) return fauxAssistantMessage("ok");
		await new Promise((resolve) => setTimeout(resolve, 500));
		return fauxAssistantMessage(`Summary: ${"wombats ".repeat(80)}`);
	};
	faux.setResponses(Array.from({ length: 10 }, () => step as never));
	const daemon = await openTestDaemon({ ...tmp, faux, config: { contextCap: 1000 } });
	t.after(() => daemon.close());
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());
	await ask(tmp.paths.socket, "one ".repeat(300));
	await ask(tmp.paths.socket, "two ".repeat(300));
	const task = await daemon.root.compact(undefined, BG);
	await daemon.harness.waitForTask(task, BG);
	await until(() => view.items().some((i) => i.kind === "note" && i.text === "earlier conversation compacted") && !view.state().compacting);
	const compacting = view.replies.flatMap((r) => (r.state ? [r.state.compacting] : []));
	assert.ok(compacting.includes(true), "the state said so while it ran");
});
