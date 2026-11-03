import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { localStamp } from "../src/journal.ts";
import { opened, prompt } from "../src/loose.ts";
import { ask, attachView, lines, openTestDaemon, tempDir, until } from "./helpers.ts";

const lastUser = (ctx: TranscriptContext) => {
	const last = ctx.messages.findLast((m) => m.role === "user")!;
	return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
};
const receipt = (state: string) => JSON.parse(readFileSync(join(state, "loose-ends.json"), "utf8")).day as string;
const settle = () => new Promise((r) => setTimeout(r, 300));

test("the evening look belongs to the day its window opened on, in local time", () => {
	assert.equal(opened(new Date(2026, 10, 2, 20, 30), "20:30"), "2026-11-02");
	assert.equal(opened(new Date(2026, 10, 2, 23, 59), "20:30"), "2026-11-02");
	assert.equal(opened(new Date(2026, 10, 3, 0, 15), "20:30"), "2026-11-02", "a window past midnight still looks back on the evening it opened");
});

test("the look asks for a few meaningful gaps, not an audit, and leaves the reply for the journal", () => {
	const text = prompt({ day: "2026-11-02", chatting: false, journal: "*** 2026-11-02 Monday\n**** 14:10 Call with Dana", instructions: "- Never nudge about work after 8." });
	assert.match(text, /^\[heartbeat\] Your evening look for loose ends/, "tagged as a heartbeat, so it is private and routed like one");
	assert.match(text, /conversation with a client, coworker, or friend without saying how it ended/);
	assert.match(text, /an outing and you do not know whether it happened or they got home/);
	assert.match(text, /not a task audit or an interrogation/);
	assert.match(text, /at most three .* or none\. Most evenings have none\./);
	assert.match(text, /never press, guess, or ask again tonight/);
	assert.match(text, /write what they told you in today's journal with the journal tool/);
	assert.match(text, /Never record an outcome they did not give you/);
	assert.match(text, /Your journal for today so far:\n\*\*\* 2026-11-02 Monday\n\*\*\*\* 14:10 Call with Dana/);
	assert.match(text, /from HEARTBEAT\.org, still apply:\n- Never nudge about work after 8\./);
	assert.match(text, /not chatting with you right now/);
	assert.match(text, /answer with exactly QUIET and nothing else/);
	assert.match(prompt({ day: "2026-11-02", chatting: true, journal: undefined, instructions: "" }), /chatting with you right now, so asking is simply your next line/);
});

test("at 20:30 June asks about a loose end, Alex's answer goes in the journal, and the night's reflection sees both", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const today = localStamp().date;
	const journal = join(tmp.dir, "JOURNAL.org");
	await writeFile(join(tmp.dir, "SOUL.org"), "* June\nBe observant.\n");
	await writeFile(journal, `#+TITLE: June's journal\n\n* ${today.slice(0, 4)}\n** ${today.slice(0, 7)} Month\n*** ${today} Day\n**** 14:10 Call with Dana\nAlex said he was about to call Dana about the contract.\n`);
	const [y, m, d] = today.split("-").map(Number) as [number, number, number];
	let evening = new Date(y, m - 1, d, 20, 29);
	// The reflection waits outside its window until the evening is over.
	let night = new Date(y, m - 1, d, 12, 0);
	const asked: string[] = [];
	let reflected: { system: string; input: any } | undefined;
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage("hello"),
		(ctx) => {
			asked.push(lastUser(ctx));
			return fauxAssistantMessage("How did the call with Dana go?");
		},
		fauxAssistantMessage([fauxToolCall("journal", { title: "Dana signed", text: "Alex said the call went well and Dana signed the contract." })], { stopReason: "toolUse" }),
		fauxAssistantMessage("That's great news."),
		(ctx) => {
			reflected = { system: JSON.stringify(ctx.messages[0]), input: JSON.parse(String(ctx.messages.at(-1)!.content)) };
			return fauxAssistantMessage(JSON.stringify({ day: `*** ${today} Day\n**** 14:10 Call with Dana\nAlex called Dana, and she signed the contract.`, memory: null }));
		},
	]);
	const daemon = await openTestDaemon({
		...tmp,
		faux,
		config: {
			soulFile: join(tmp.dir, "SOUL.org"),
			memoryFile: join(tmp.dir, "MEMORY.org"),
			journalFile: journal,
			looseEnds: { enabled: true, at: "20:30" },
			rhythm: { wake: "06:00", quiet: "22:00", sleep: "03:00" },
			reflection: { enabled: true, quietMinutes: 60, recentDays: 3, periods: [] },
		},
		looseEndsClock: { now: () => evening, tickMs: 50 },
		reflectionClock: { now: () => night, tickMs: 50 },
	});
	t.after(() => daemon.close());
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());
	assert.equal((await ask(tmp.paths.socket, "hi", "hi", "kitty")).text, "hello");

	await settle();
	assert.equal(faux.state.callCount, 1, "nothing before 20:30");
	evening = new Date(y, m - 1, d, 20, 30);
	await until(() => view.items().length === 3, 10_000);
	assert.match(asked[0]!, /^\[heartbeat\] Your evening look for loose ends/);
	assert.match(asked[0]!, /\*\*\*\* 14:10 Call with Dana\nAlex said he was about to call Dana/, "the day's journal is in the look");
	assert.equal(receipt(tmp.paths.state), today);
	assert.deepEqual(lines(view.items()), ["alex: hi", "june: hello", "june: How did the call with Dana go?"], "only the question shows, never the look");
	const question = view.items()[2]!;
	assert.equal(question.kind === "assistant" ? question.alert : undefined, "gui", "the question alerts where Alex last spoke");

	evening = new Date(y, m - 1, d, 21, 45);
	await settle();
	assert.equal(faux.state.callCount, 2, "once an evening");

	assert.equal((await ask(tmp.paths.socket, "It went well, she signed.", "answer", "kitty")).text, "That's great news.");
	assert.match(readFileSync(journal, "utf8"), /\*\*\*\* \d\d:\d\d Dana signed\nAlex said the call went well and Dana signed the contract\./, "the answer is in today's journal");

	night = new Date(y, m - 1, d + 1, 3, 30);
	await until(() => reflected !== undefined, 10_000);
	assert.match(reflected!.system, /a loose end they never answered stays open, never a guessed outcome/);
	assert.match(reflected!.input.day, /Dana signed the contract/, "the reflection reads the answer in the journal");
	assert.match(reflected!.input.conversation, /How did the call with Dana go\?/);
	assert.match(reflected!.input.conversation, /It went well, she signed\./, "and in the conversation");
	await until(() => readFileSync(journal, "utf8").includes("Alex called Dana, and she signed the contract."));
});

test("a quiet evening shows nothing, a day with nothing in it asks nobody, and after quiet hours the look waits", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const today = localStamp().date;
	await writeFile(join(tmp.dir, "SOUL.org"), "* June\nBe observant.\n");
	const [y, m, d] = today.split("-").map(Number) as [number, number, number];
	let clock = new Date(y, m - 1, d, 20, 29);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("hello"), fauxAssistantMessage("QUIET")]);
	const daemon = await openTestDaemon({
		...tmp,
		faux,
		config: { soulFile: join(tmp.dir, "SOUL.org"), memoryFile: join(tmp.dir, "MEMORY.org"), journalFile: join(tmp.dir, "JOURNAL.org"), looseEnds: { enabled: true, at: "20:30" } },
		looseEndsClock: { now: () => clock, tickMs: 50 },
	});
	t.after(() => daemon.close());
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());
	assert.equal((await ask(tmp.paths.socket, "hi", "hi", "kitty")).text, "hello");

	// Today Alex said something, so the look runs without any journal, and finds nothing worth asking.
	clock = new Date(y, m - 1, d, 20, 31);
	await until(() => faux.state.callCount === 2, 10_000);
	await until(() => existsSync(join(tmp.paths.state, "loose-ends.json")));
	await settle();
	assert.deepEqual(lines(view.items()), ["alex: hi", "june: hello"], "a quiet look shows nothing");

	// Tomorrow nothing was said or written, so no model is asked, and the day still counts as looked at.
	clock = new Date(y, m - 1, d + 1, 20, 30);
	await until(() => receipt(tmp.paths.state) > today);
	await settle();
	assert.equal(faux.state.callCount, 2);

	// The day after, June was down until after quiet hours: no look that evening.
	const later = localStamp(new Date(y, m - 1, d + 2)).date;
	clock = new Date(y, m - 1, d + 2, 22, 5);
	await settle();
	assert.ok(receipt(tmp.paths.state) < later, "after rhythm.quiet the look waits for tomorrow");
	assert.equal(faux.state.callCount, 2);
});
