import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "../src/avatar.ts";
import { EXPRESSION, expressionRules, loadManifest, parsePick, pickRequest, replyToPick, resolvePick, startExpressions } from "../src/expression.ts";
import type { Reply } from "../src/protocol.ts";
import { silentLogger } from "../src/runtime.ts";
import { fold, type ViewItem, type ViewState } from "../src/transcript.ts";

const manifest: Manifest = {
	version: 1,
	size: [256, 256],
	expressions: { idle: { file: "idle.png", play: "still" } },
	poses: {
		"smug-chin-on-hand": { file: "p/s.svg", size: [10, 10], expression: "smug", description: "chin on hand", face: [0.3, 0.1, 0.4, 0.3], mouth: [0.5, 0.35], facing: "right" },
		"working-typing-laptop": { file: "p/w.svg", size: [10, 10], expression: "determined", activity: "working", description: "typing", face: [0.3, 0.1, 0.4, 0.3], mouth: [0.5, 0.35], facing: "right" },
	},
};

const say = (id: string, text: string, extra: Partial<Extract<ViewItem, { kind: "assistant" }>> = {}): ViewItem => ({ kind: "assistant", id, text, streaming: false, answers: "gui", ...extra });
const ask = (id: string, text: string): ViewItem => ({ kind: "user", id, source: "gui", text });
const idle = { running: false, compacting: false };

test("the rules list every expression with its frequency, the reaction poses, and the rules that keep faces honest", () => {
	const rules = expressionRules(manifest);
	assert.match(rules, /- indignant \(rare\): /);
	assert.match(rules, /- smug-chin-on-hand \(smug\): chin on hand/);
	assert.doesNotMatch(rules, /working-typing-laptop/, "poses that show her at work are never a reaction");
	assert.match(rules, /Pout is for when/);
	assert.match(rules, /never wry, smug, or pout/);
	assert.doesNotMatch(expressionRules(undefined), /\bposes?\b/i, "without an avatar set, no poses to name");
});

test("a pick is a known expression, and a pose only when the set has it as a reaction", () => {
	assert.deepEqual(parsePick('{"expression": "wry", "pose": null}', manifest), { expression: "wry" });
	assert.deepEqual(parsePick('Sure: {"expression":"smug","pose":"smug-chin-on-hand"}', manifest), { expression: "smug", pose: "smug-chin-on-hand" });
	assert.deepEqual(parsePick('{"expression":"smug","pose":"no-such-pose"}', manifest), { expression: "smug" });
	assert.deepEqual(parsePick('{"expression":"determined","pose":"working-typing-laptop"}', manifest), { expression: "determined" });
	assert.equal(parsePick('{"expression":"thinking"}', manifest), null, "not in the vocabulary");
	assert.equal(parsePick("wry", manifest), null);
	assert.equal(parsePick("{not json}", manifest), null);
});

test("the reply to pick is the newest settled one, once the run has ended, with the message it answers", () => {
	const items = [ask("1", "any mail?"), say("2", "checking"), { kind: "tool", id: "c", name: "bash", summary: "", status: "done" } as ViewItem, say("3", "two need a reply.")];
	assert.deepEqual(replyToPick(items, idle, new Set()), { reply: items[3], said: "any mail?", earlier: [], doing: { tools: ["bash"], asides: [] } });
	assert.equal(replyToPick(items, { running: true, compacting: false }, new Set()), null, "not while she works");
	assert.equal(replyToPick(items, idle, new Set(["3"])), null, "not twice");
	assert.equal(replyToPick([...items.slice(0, 3), say("3", "two", { expression: "warm" })], idle, new Set()), null, "already has a face");
	assert.equal(replyToPick([...items, ask("4", "thanks")], idle, new Set()), null, "the user has spoken since: nothing new to pick");
	assert.equal(replyToPick([ask("1", "hi"), say("2", "", { error: "timeout" })], idle, new Set()), null, "a failed reply has no face");
	assert.deepEqual(replyToPick([say("2", "good morning.")], idle, new Set()), { reply: say("2", "good morning."), said: "", earlier: [], doing: { tools: [], asides: [] } }, "she spoke first");
});

test("the pass sees up to two earlier exchanges for context, clipped, and asks about the newest reply only", () => {
	const long = "x".repeat(600);
	const items = [
		ask("1", "first"),
		say("2", "one"),
		ask("3", "nicknames are my thing"),
		say("4", "thinking", { private: true }),
		say("5", "hmm. skipper, maybe.", { expression: "wry" }),
		ask("6", long),
		say("7", "fair."),
		ask("8", "you win."),
		{ kind: "tool", id: "c1", name: "org_search", summary: "query=bet", status: "done" } as ViewItem,
		{ kind: "tool", id: "c2", name: "bash", summary: "command=false", status: "error" } as ViewItem,
		{ kind: "patter", id: "p1", text: "conceding gracefully, as ever." } as ViewItem,
		say("9", "a hollow victory."),
	];
	const next = replyToPick(items, idle, new Set());
	assert.equal(next?.reply.id, "9");
	assert.deepEqual(next?.earlier.map((e) => e.said.slice(0, 22)), ["nicknames are my thing", "x".repeat(22)], "the two exchanges before, oldest first");
	assert.equal(next?.earlier[0]!.replied, "hmm. skipper, maybe.", "June's settled reply, not a private look");
	assert.equal(next?.earlier[1]!.said.length, 400, "each clipped");
	assert.deepEqual(next?.doing, { tools: ["org_search query=bet", "bash command=false (failed)"], asides: ["conceding gracefully, as ever."] }, "what else is in the panel");
	const request = pickRequest(next!.said, next!.reply.text, next!.earlier, next!.doing);
	assert.match(request, /^Earlier, for context only:\n.*nicknames are my thing\nJune \(face: wry\): hmm\. skipper, maybe\./, "with the face each earlier panel got");
	assert.match(request, /Now, the panel to choose for\.\n.* wrote:\nyou win\.\n\nWhile answering, June used: org_search query=bet; bash command=false \(failed\)\n\nHer asides meanwhile: conceding gracefully, as ever\.\n\nJune replied:\na hollow victory\.$/);
	assert.doesNotMatch(pickRequest("hi", "hello", [], { tools: [], asides: [] }), /While|asides/, "nothing done, nothing said");
	assert.doesNotMatch(pickRequest("hi", "hello", []), /Earlier/, "no context, no preamble");
});

test("the fold puts a pick on its reply and the newest on the state, and keeps it out of everything else", () => {
	const entries = [
		{ id: 1, kind: "june.input", data: { source: "gui", text: "you win." }, model: [{ role: "user", content: "[gui] you win." }] },
		{ id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "a hollow victory." }] }] },
		{ id: 3, kind: "june.expression", data: { for: "2", expression: "wry", pose: "smug-chin-on-hand" } },
	];
	const { items, state } = fold(entries, {});
	assert.deepEqual(items, [
		{ kind: "user", id: "1", source: "gui", text: "you win." },
		{ kind: "assistant", id: "2", text: "a hollow victory.", streaming: false, answers: "gui", alert: "gui", expression: "wry", pose: "smug-chin-on-hand", artVersion: "3" },
	]);
	assert.equal(state.expression, "wry");
	assert.equal(fold(entries.slice(0, 2), {}).state.expression, "idle", "none yet");
	assert.equal(fold([...entries.slice(0, 2), { id: 3, kind: "june.expression", data: { for: "99", expression: "smug" } }], {}).state.expression, "idle", "a pick for a reply not in view is ignored");
});

test("the pass picks once for each reply that settles after it starts, and never backfills", async () => {
	let send: (reply: Reply) => void = () => {};
	const written: unknown[] = [];
	const asked: string[] = [];
	const models = {
		getModel: () => ({}),
		completeSimple: async (_model: unknown, request: { messages: { content: string }[] }) => {
			asked.push(request.messages[1]!.content);
			return { stopReason: "stop", content: [{ type: "text", text: '{"expression": "wry", "pose": "smug-chin-on-hand"}' }] };
		},
	};
	const state = (running: boolean): ViewState => ({ running, background: 0, queued: 0, model: "", compacting: false, expression: "idle" });
	const pass = startExpressions({
		root: { submit: async (input: { entry: unknown }) => void written.push(input.entry) } as never,
		models: models as never,
		model: { provider: "p", modelId: "m", thinkingLevel: "off" },
		files: () => ({ soulFile: "/no/such/SOUL.org" }) as never,
		manifest: () => manifest,
		attach: async (s) => {
			send = s;
			s({ type: "view", reset: true, items: [ask("1", "old"), say("2", "an old reply")], state: state(false), earlier: false });
			return { stop: async () => {} };
		},
		log: silentLogger,
	});
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(written.length, 0, "the old reply keeps no face");

	send({ type: "view", changes: [{ op: "put", item: ask("3", "you win."), after: "2" }], state: state(true) });
	send({ type: "view", changes: [{ op: "put", item: say("4", "a hollow", { streaming: true }), after: "3" }] });
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(written.length, 0, "nothing while she is still writing");

	send({ type: "view", changes: [{ op: "put", item: say("4", "a hollow victory, but i'll take it."), after: "3" }], state: state(false) });
	await new Promise((r) => setTimeout(r, 10));
	const saved = written[0] as { kind: string; data: Record<string, unknown> };
	assert.equal(saved.kind, EXPRESSION);
	assert.equal(saved.data.for, "4");
	assert.equal(saved.data.expression, "wry");
	assert.equal(saved.data.pose, "smug-chin-on-hand");
	assert.equal(saved.data.side, "left");
	assert.equal(saved.data.take, 0);
	assert.equal(typeof saved.data.selectedAt, "number");
	assert.equal(typeof saved.data.revision, "string");
	assert.match(asked[0]!, /you win\.[\s\S]*a hollow victory, but i'll take it\./);

	send({ type: "view", changes: [], state: state(false) });
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(written.length, 1, "once per reply");
	await pass.stop();
});

test("the daemon merges both inventories and resolves a concrete pose once at millisecond precision", () => {
	const dir = mkdtempSync(join(tmpdir(), "june-picks-"));
	try {
		const personal = { ...manifest, poses: { "smug-chin-on-hand": { ...manifest.poses!["smug-chin-on-hand"]!, description: "personal" } } };
		writeFileSync(join(dir, "personal.json"), JSON.stringify(personal));
		writeFileSync(join(dir, "base.json"), JSON.stringify(manifest));
		const merged = loadManifest([join(dir, "personal.json"), join(dir, "base.json")], silentLogger)!;
		assert.equal(Object.keys(merged.poses!).length, 2);
		assert.equal(merged.poses!["smug-chin-on-hand"]!.description, "personal");
		const at = 1793880000123;
		const poses = { ...manifest.poses, second: { ...manifest.poses!["smug-chin-on-hand"]!, added: new Date(at).toISOString() }, future: { ...manifest.poses!["smug-chin-on-hand"]!, added: new Date(at + 1).toISOString() } };
		const pick = resolvePick({ expression: "smug" }, { ...manifest, poses }, say("x", "", { pose: "smug-chin-on-hand", side: "left" }) as Extract<ViewItem, { kind: "assistant" }>, at, () => 0.99);
		assert.deepEqual(pick, { expression: "smug", pose: "second", side: "right", selectedAt: at });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

function director(entries: Parameters<typeof fold>[0][number][] = [
	{ id: 1, kind: "june.input", data: { source: "gui", text: "you win" }, model: [{ role: "user", content: "you win", timestamp: 1793800000000 }] },
	{ id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "a hollow victory" }], timestamp: 1793800000123 }] },
	{ id: 3, kind: EXPRESSION, data: { for: "2", expression: "smug", pose: "smug-chin-on-hand", side: "left", selectedAt: 1793800000456, take: 0, revision: "original", context: { said: "you win", earlier: [{ said: "an old joke", replied: "a dry answer" }] } } },
]) {
	let receive: (reply: Reply) => void = () => {};
	const asked: string[] = [];
	let gate: Promise<void> | undefined;
	let answer = '{"expression":"smug","pose":"smug-chin-on-hand"}';
	const reset = () => receive({ type: "view", reset: true, ...fold(entries, {}) });
	const pass = startExpressions({
		root: { submit: async (input: { entry: { kind: string; data: unknown } }) => { entries.push({ id: entries.length + 1, ...input.entry }); reset(); } } as never,
		models: { getModel: () => ({}), completeSimple: async (_model: unknown, request: { messages: { content: string }[] }) => { asked.push(request.messages[1]!.content); await gate; return { stopReason: "stop", content: [{ type: "text", text: answer }] }; } } as never,
		model: { provider: "p", modelId: "m", thinkingLevel: "off" }, files: () => ({}) as never, manifest: () => manifest,
		attach: async (send) => { receive = send; reset(); return { stop: async () => {} }; }, log: silentLogger,
	});
	return { pass, entries, asked, reset, item: () => fold(entries, {}).items.find((i): i is Extract<ViewItem, { kind: "assistant" }> => i.kind === "assistant" && i.id === "2")!, hold: (wait: Promise<void> | undefined) => { gate = wait; }, answer: (text: string) => { answer = text; } };
}

test("retakes preserve context, are replay safe, reject overlap, and Back restores the exact take after restart", async () => {
	const d = director();
	let release!: () => void;
	d.hold(new Promise((r) => { release = r; }));
	const first = d.pass.change("retake", "2", "original", "first");
	assert.equal(d.pass.change("retake", "2", "original", "first"), first, "duplicate in-flight request shares one model call");
	await assert.rejects(d.pass.change("restore", "2", "original", "overlap"), /already choosing/);
	release(); await first;
	assert.equal(d.asked.length, 1);
	assert.match(d.asked[0]!, /an old joke/);
	assert.match(d.asked[0]!, /Earlier takes were not right/);
	assert.equal(d.item().take, 1);
	assert.equal(d.item().side, "left", "another take keeps the side the panel has shown");
	await assert.rejects(d.pass.change("retake", "2", "original", "stale"), /panel changed/);
	const length = d.entries.length;
	await d.pass.change("retake", "2", "original", "first");
	assert.equal(d.entries.length, length, "completed request does not append again");
	await d.pass.stop();
	const resumed = director(d.entries);
	await resumed.pass.change("restore", "2", resumed.item().artVersion!, "back");
	assert.equal(resumed.asked.length, 0, "Back makes no model call");
	assert.equal(resumed.item().take, 0);
	assert.equal(resumed.item().pose, "smug-chin-on-hand");
	assert.equal(resumed.item().side, "left");
	assert.equal(resumed.item().expressionAt, 1793800000456, "Back restores the original availability cutoff, not the retake time");
	assert.equal(resumed.item().at, 1793800000123, "lighting stays at the reply time");
	await assert.rejects(resumed.pass.change("restore", "2", resumed.item().artVersion!, "too-far"), /No earlier take/);
	await resumed.pass.change("retake", "2", resumed.item().artVersion!, "second");
	assert.equal(resumed.item().take, 2, "retaking after Back does not reuse an ordinal");
	assert.equal(resumed.item().takes!.at(-1)!.previous, 0);
	await resumed.pass.stop();
});

test("Back and Forward browse every saved take in creation order, survive restart, and never call the model", async (t) => {
	const d = director(); t.after(() => d.pass.stop());
	const art = (item: ReturnType<typeof d.item>) => [item.expression, item.pose, item.side, item.expressionAt, item.at];
	const original = art(d.item());
	await assert.rejects(d.pass.change("advance", "2", "original", "no-next"), /No later take/);
	assert.equal(d.asked.length, 0);
	await d.pass.change("retake", "2", "original", "first");
	const first = art(d.item());
	await d.pass.change("restore", "2", d.item().artVersion!, "back");
	await d.pass.change("retake", "2", d.item().artVersion!, "branch");
	const second = art(d.item());
	assert.equal(d.item().take, 2);
	assert.equal(d.item().takes!.at(-1)!.previous, 0, "creation provenance is kept, not used to skip saved takes");
	await d.pass.change("restore", "2", d.item().artVersion!, "back-to-first");
	assert.equal(d.item().take, 1, "Back visits the preceding saved take, including an earlier branch");
	assert.deepEqual(art(d.item()), first);
	await d.pass.change("restore", "2", d.item().artVersion!, "back-to-original");
	assert.deepEqual(art(d.item()), original);
	assert.equal(d.asked.length, 2, "only Another take uses the model");
	await d.pass.stop();
	const resumed = director(d.entries); t.after(() => resumed.pass.stop());
	const revision = resumed.item().artVersion!;
	await resumed.pass.change("advance", "2", revision, "forward");
	assert.equal(resumed.item().take, 1);
	assert.deepEqual(art(resumed.item()), first);
	const length = resumed.entries.length;
	await resumed.pass.change("advance", "2", revision, "forward");
	assert.equal(resumed.entries.length, length, "Forward replay appends nothing");
	await assert.rejects(resumed.pass.change("advance", "2", revision, "stale-forward"), /panel changed/);
	await resumed.pass.change("advance", "2", resumed.item().artVersion!, "forward-to-second");
	assert.deepEqual(art(resumed.item()), second);
	await assert.rejects(resumed.pass.change("advance", "2", resumed.item().artVersion!, "past-end"), /No later take/);
	assert.equal(resumed.item().takes!.length, 3, "navigation never adds or deletes a saved choice");
	assert.equal(resumed.asked.length, 0);
});

test("Back restores an unpicked legacy reply without guessing its stand-in in the daemon", async () => {
	const d = director();
	d.entries.pop(); d.reset();
	await d.pass.change("retake", "2", "", "legacy-take");
	assert.equal(d.item().take, 1);
	await d.pass.change("restore", "2", d.item().artVersion!, "legacy-back");
	assert.equal(d.item().expression, undefined);
	assert.equal(d.item().pose, undefined);
	assert.equal(d.item().side, undefined);
	assert.equal(d.item().take, 0);
	assert.equal(d.item().at, 1793800000123);
	const saved = d.item().takes!.find((t) => t.take === 1)!;
	await d.pass.change("advance", "2", d.item().artVersion!, "legacy-forward");
	assert.equal(d.item().take, 1);
	assert.equal(d.item().pose, saved.pose);
	assert.equal(d.item().side, saved.side);
	assert.equal(d.item().expressionAt, saved.selectedAt);
	assert.equal(d.asked.length, 1, "Forward reuses the saved choice even for a legacy reply");
	await d.pass.stop();
});

test("retaking an older panel never puts its expression on live June", () => {
	const entries = [
		{ id: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "older" }] }] },
		{ id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "newer" }] }] },
		{ id: 3, kind: EXPRESSION, data: { for: "2", expression: "wry" } },
		{ id: 4, kind: EXPRESSION, data: { for: "1", expression: "warm", take: 1 } },
	];
	assert.equal(fold(entries, {}).state.expression, "wry");
});

test("failed and stale retakes leave the art and conversation alone; a later pick clears an omitted pose", async () => {
	const d = director();
	d.answer("not JSON");
	await assert.rejects(d.pass.change("retake", "2", "original", "bad"), /could not choose/);
	assert.equal(d.entries.length, 3);
	d.answer('{"expression":"smug"}');
	let release!: () => void;
	d.hold(new Promise((r) => { release = r; }));
	const request = d.pass.change("retake", "2", "original", "gone");
	d.entries.splice(0); d.reset(); release();
	await assert.rejects(request, /panel changed/);
	assert.equal(d.entries.length, 0);
	await d.pass.stop();
	const other = director();
	other.entries.push({ id: 4, kind: EXPRESSION, data: { for: "2", expression: "wry", selectedAt: 1793880000999 } });
	const item = other.item();
	assert.equal(item.pose, undefined, "a later unnamed pick must not retain the old pose");
	assert.equal(item.side, undefined);
	assert.equal(item.expressionAt, 1793880000999);
	await other.pass.stop();
});
