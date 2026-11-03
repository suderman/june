import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { dayStart, greeting } from "../src/greeting.ts";
import { ask, openTestDaemon, tempDir } from "./helpers.ts";

const at = (h: number, m = 0, d = 3) => new Date(2026, 10, d, h, m).getTime();
const jon = (text: string, timestamp: number): Message => ({ role: "user", content: text, timestamp });
const june = (text: string, timestamp: number, stopReason = "stop"): Message =>
	({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp }) as unknown as Message;
const now = new Date(2026, 10, 3, 9, 15);

test("the day starts at wake, so a chat after midnight belongs to the day before", () => {
	assert.equal(dayStart(new Date(2026, 10, 3, 9, 0), "05:00").getTime(), at(5));
	assert.equal(dayStart(new Date(2026, 10, 3, 0, 30), "05:00").getTime(), at(5, 0, 2));
	assert.equal(dayStart(new Date(2026, 10, 3, 5, 0), "05:00").getTime(), at(5));
});

test("June's first words of the day carry a greeting, whoever speaks first, until they have spoken", () => {
	const yesterday = [jon("night!", at(23, 0, 2)), june("night, sleep well.", at(23, 1, 2))];
	assert.match(greeting([...yesterday, jon("good morning", at(9, 10))], now, "05:00") ?? "", /not spoken yet today/, "Jon greets first");
	assert.match(greeting([...yesterday, jon("can you add milk to the list", at(9, 10))], now, "05:00") ?? "", /greeting/, "Jon asks first without one");
	assert.match(greeting([...yesterday, jon("[heartbeat] A private heartbeat", at(9, 10))], now, "05:00") ?? "", /greeting/, "June makes first contact");
	assert.equal(greeting([...yesterday, jon("morning", at(8, 0)), june("morning!", at(8, 0)), jon("one more thing", at(9, 10))], now, "05:00"), undefined, "already spoken");
	assert.equal(greeting([...yesterday, june("morning! the heater is on.", at(7, 0)), jon("thanks", at(9, 10))], now, "05:00"), undefined, "June already reached out");
	assert.equal(greeting([jon("still up?", at(0, 20)), june("yep", at(0, 21)), jon("ok one more", at(0, 40))], new Date(2026, 10, 3, 0, 45), "05:00"), undefined, "after midnight is still the same day");
});

test("June's own inputs, quiet heartbeats, and mid-turn words are not contact", () => {
	const messages = [
		jon("[heartbeat] A private heartbeat", at(6, 0)),
		june("QUIET", at(6, 0)),
		jon("[work] Report: census checked.", at(7, 0)),
		june("checking one thing", at(7, 0), "toolUse"),
		jon("[watch] An agent finished.", at(8, 0)),
		jon("hey", at(9, 10)),
	];
	assert.match(greeting(messages, now, "05:00") ?? "", /greeting/);
});

test("the section never asks June to break a quiet heartbeat just to greet", () => {
	assert.match(greeting([jon("[heartbeat] A private heartbeat", at(9, 10))], now, "05:00") ?? "", /never a reason to send a message/);
});

test("the main conversation's prompt has the greeting before the day's first exchange, and not after", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	// Each system message carries only the sections that changed, a removed one as null; merged, they are what is in effect.
	const sections = (ctx: TranscriptContext) => JSON.stringify(Object.assign({}, ...ctx.messages.filter((m) => m.role === "system").map((m) => m.sections)));
	const seen: boolean[] = [];
	const faux = fauxProvider();
	faux.setResponses([
		(ctx) => (seen.push(sections(ctx).includes("not spoken yet today")), fauxAssistantMessage("Morning, Alex!")),
		(ctx) => (seen.push(sections(ctx).includes("not spoken yet today")), fauxAssistantMessage("Done.")),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	await ask(tmp.paths.socket, "good morning");
	await ask(tmp.paths.socket, "add milk");
	assert.deepEqual(seen, [true, false]);
	assert.ok((await daemon.root.context(BG)).messages.length > 0);
});
