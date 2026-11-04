import assert from "node:assert/strict";
import { test } from "node:test";
import type { Manifest } from "../src/avatar.ts";
import { EXPRESSION, expressionRules, parsePick, pickRequest, replyToPick, startExpressions } from "../src/expression.ts";
import type { Reply } from "../src/protocol.ts";
import { silentLogger } from "../src/runtime.ts";
import { fold, type ViewItem, type ViewState } from "../src/transcript.ts";

const manifest = {
	version: 1,
	size: [256, 256],
	expressions: { idle: { file: "idle.png", play: "still" } },
	poses: {
		"smug-chin-on-hand": { file: "p/s.svg", size: [10, 10], expression: "smug", description: "chin on hand", face: [0.3, 0.1, 0.4, 0.3], mouth: [0.5, 0.35], facing: "right" },
		"working-typing-laptop": { file: "p/w.svg", size: [10, 10], expression: "determined", activity: "working", description: "typing", face: [0.3, 0.1, 0.4, 0.3], mouth: [0.5, 0.35], facing: "right" },
	},
} as unknown as Manifest;

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
	assert.deepEqual(replyToPick(items, idle, new Set()), { reply: items[3], said: "any mail?", earlier: [] });
	assert.equal(replyToPick(items, { running: true, compacting: false }, new Set()), null, "not while she works");
	assert.equal(replyToPick(items, idle, new Set(["3"])), null, "not twice");
	assert.equal(replyToPick([...items.slice(0, 3), say("3", "two", { expression: "warm" })], idle, new Set()), null, "already has a face");
	assert.equal(replyToPick([...items, ask("4", "thanks")], idle, new Set()), null, "the user has spoken since: nothing new to pick");
	assert.equal(replyToPick([ask("1", "hi"), say("2", "", { error: "timeout" })], idle, new Set()), null, "a failed reply has no face");
	assert.deepEqual(replyToPick([say("2", "good morning.")], idle, new Set()), { reply: say("2", "good morning."), said: "", earlier: [] }, "she spoke first");
});

test("the pass sees up to two earlier exchanges for context, clipped, and asks about the newest reply only", () => {
	const long = "x".repeat(600);
	const items = [
		ask("1", "first"),
		say("2", "one"),
		ask("3", "nicknames are my thing"),
		say("4", "thinking", { private: true }),
		say("5", "hmm. skipper, maybe."),
		ask("6", long),
		say("7", "fair."),
		ask("8", "you win."),
		say("9", "a hollow victory."),
	];
	const next = replyToPick(items, idle, new Set());
	assert.equal(next?.reply.id, "9");
	assert.deepEqual(next?.earlier.map((e) => e.said.slice(0, 22)), ["nicknames are my thing", "x".repeat(22)], "the two exchanges before, oldest first");
	assert.equal(next?.earlier[0]!.replied, "hmm. skipper, maybe.", "June's settled reply, not a private look");
	assert.equal(next?.earlier[1]!.said.length, 400, "each clipped");
	const request = pickRequest(next!.said, next!.reply.text, next!.earlier);
	assert.match(request, /^Earlier, for context only:\n.*nicknames are my thing\nJune: hmm\. skipper, maybe\./);
	assert.match(request, /Now, the reply to choose for\.\n.* wrote:\nyou win\.\n\nJune replied:\na hollow victory\.$/);
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
		{ kind: "assistant", id: "2", text: "a hollow victory.", streaming: false, answers: "gui", alert: "gui", expression: "wry", pose: "smug-chin-on-hand" },
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
	assert.deepEqual(written, [{ kind: EXPRESSION, data: { for: "4", expression: "wry", pose: "smug-chin-on-hand" } }]);
	assert.match(asked[0]!, /you win\.[\s\S]*a hollow victory, but i'll take it\./);

	send({ type: "view", changes: [], state: state(false) });
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(written.length, 1, "once per reply");
	await pass.stop();
});
