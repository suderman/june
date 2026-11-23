import assert from "node:assert/strict";
import { test } from "node:test";
import { choose, familyOf, findCard, launchArgs, parseRoster } from "../src/roster.ts";

const ROSTER = `#+TITLE: Roster

* Bolt
:PROPERTIES:
:HOST: kit
:HARNESS: claude
:MODEL: claude-opus-5-5
:EFFORT: high
:AVATAR: roster/bolt.png
:END:
Careful and thorough.

** Habits
Reads before editing.

* Rivet Jr :fast:
:PROPERTIES:
:HOST: kit
:HARNESS: codex
:EFFORT: max
:END:
Quick fixes.

* Broken
:PROPERTIES:
:HARNESS: gemini
:EFFORT: huge
:END:
`;

test("ROSTER.org cards take their properties, keep child headings as instructions, and report what is missing", () => {
	const [bolt, rivet, broken] = parseRoster(ROSTER);
	assert.deepEqual(bolt, {
		name: "Bolt",
		slug: "bolt",
		host: "kit",
		harness: "claude",
		model: "claude-opus-5-5",
		effort: "high",
		avatar: "roster/bolt.png",
		instructions: "Careful and thorough.\n\n** Habits\nReads before editing.",
		problems: [],
	});
	assert.deepEqual([rivet!.name, rivet!.slug, rivet!.harness, rivet!.model, rivet!.problems], ["Rivet Jr", "rivet-jr", "codex", undefined, []]);
	assert.deepEqual(broken!.problems, [":HARNESS: gemini is not one of claude, codex, pi, agy", "no :HOST:", ":EFFORT: huge is not one of low, medium, high, xhigh, max"]);
	assert.equal(findCard(parseRoster(ROSTER), "RIVET JR")?.slug, "rivet-jr");
});

test("each harness starts with the card's model, effort and instructions in its own flags", () => {
	const card = (harness: string, extra = {}) => ({ name: "Bolt", slug: "bolt", host: "kit", harness: harness as any, model: "m-1", effort: "max", instructions: "Be careful.", problems: [], ...extra });
	assert.deepEqual(launchArgs(card("claude"), "go"), ["--model", "m-1", "--effort", "max", "--append-system-prompt", "Be careful.", "--name", "Bolt", "go"]);
	assert.deepEqual(launchArgs(card("codex")), ["--model", "m-1", "-c", 'model_reasoning_effort="xhigh"', "-c", 'developer_instructions="Be careful."']);
	assert.deepEqual(launchArgs(card("pi", { model: "gpt-6.2-sol" })), ["--model", "openai-codex/gpt-6.2-sol", "--thinking", "max", "--append-system-prompt", "Be careful.", "--name", "Bolt"]);
	assert.deepEqual(launchArgs(card("pi", { model: "cliproxyapi/gpt-6.2-sol", effort: undefined, instructions: "" })), ["--model", "cliproxyapi/gpt-6.2-sol", "--name", "Bolt"]);
	assert.deepEqual(launchArgs(card("agy"), "go"), ["--model", "m-1", "--effort", "max", "--prompt-interactive", "Be careful.\n\ngo"]);
	assert.deepEqual(launchArgs(card("agy")), ["--model", "m-1", "--effort", "max"]);
});

test("the first available candidate wins unless a later one would otherwise lose quota at a reset within hours", () => {
	const bolt = { name: "bolt", available: true, reason: "idle", weekly: 60, hours: 90, rate: 0.67 };
	const gyro = { name: "gyro", available: true, reason: "idle", weekly: 40, hours: 3, rate: 13.3 };
	const rivet = { name: "rivet", available: true, reason: "idle", weekly: 20, hours: 5, rate: 4 };
	assert.deepEqual(choose([bolt, rivet]), { chosen: "rivet", why: "rivet goes ahead of bolt: 20% would be lost at its reset in 5h" });
	assert.equal(choose([bolt, rivet, gyro]).chosen, "gyro", "the fastest-expiring later candidate goes");
	assert.equal(choose([{ ...bolt, hours: 2 }, gyro]).chosen, "bolt", "the first keeps its turn when it is expiring too");
	assert.equal(choose([bolt, { ...gyro, weekly: 3 }]).chosen, "bolt", "a few percent is not worth jumping the order");
	assert.equal(choose([bolt, { ...gyro, hours: 8 }]).chosen, "bolt", "eight hours away is not yet expiring");
	assert.equal(choose([{ ...bolt, available: false, reason: "busy (working)" }, { name: "sprocket", available: true, reason: "idle" }]).chosen, "sprocket");
	assert.deepEqual(choose([{ name: "x", available: false, reason: "busy (working)" }]), { why: "x: busy (working)" });
	const card = { name: "Gyro", slug: "gyro", harness: "agy" as const, model: "gemini-4-neon", instructions: "", problems: [] };
	assert.match("Gemini Models", familyOf(card)!);
	assert.equal(familyOf({ ...card, harness: "claude" }), undefined);
});
