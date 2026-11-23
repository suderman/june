import assert from "node:assert/strict";
import { test } from "node:test";
import { findCard, launchArgs, parseRoster } from "../src/roster.ts";

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
