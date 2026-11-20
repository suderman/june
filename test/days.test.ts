import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { attachView as serveView } from "../src/daemon.ts";
import { dayName, dayRange } from "../src/greeting.ts";
import { Client, type Reply } from "../src/protocol.ts";
import { snippet } from "../src/timeline.ts";
import { ask, openTestDaemon, tempDir } from "./helpers.ts";

const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

test("a day runs from June's wake to the next, named by the date it starts on", () => {
	assert.equal(dayName(local(20, 9), "05:00"), "2026-11-20");
	assert.equal(dayName(local(21, 1), "05:00"), "2026-11-20", "past midnight is still the day before");
	assert.equal(dayName(local(21, 5), "05:00"), "2026-11-21");
	assert.deepEqual(dayRange("2026-11-20", "05:00"), { start: local(20, 5), end: local(21, 5) });
	assert.deepEqual(dayRange("2026-11-30", "05:30"), { start: local(30, 5, 30), end: new Date(2026, 11, 1, 5, 30).getTime() }, "across a month");
});

test("a search snippet is one line around the first match, cut with ellipses", () => {
	assert.equal(snippet("short\nand plain", ["plain"]), "short and plain");
	const long = `${"before ".repeat(40)}the boat is moored ${"after ".repeat(40)}`;
	const cut = snippet(long, ["boat"], 60);
	assert.ok(cut.startsWith("…") && cut.endsWith("…") && cut.includes("the boat is moored"), cut);
	assert.ok(snippet(long, ["missing"], 60).startsWith("before"), "the start when nothing matches");
});

test("the live view shows only today, says earlier days exist, and starts over on the new day", async () => {
	const wake = `${String(new Date().getHours()).padStart(2, "0")}:00`;
	const start = new Date();
	start.setMinutes(0, 0, 0);
	const entry = (id: number, text: string, at: number) => ({ id, kind: "june.input", data: { source: "gui", text }, model: [{ role: "user", content: text, timestamp: at }] });
	const value = { conversation: {}, docs: {}, entries: [entry(1, "yesterday's words", start.getTime() - 3_600_000), { id: 2, kind: "june.patter", data: { text: "hmm" } }, entry(3, "today's words", start.getTime() + 1)] };
	const root = { watch: async () => ({ value, start: () => {}, stop: async () => ({ kind: "stopped" }) }), entries: async () => ({ items: [] }) };
	const sent: Reply[] = [];
	const view = await serveView(root as never, BG, (r) => sent.push(r), "a", { wake });
	const first = sent[0] as Extract<Reply, { type: "view"; reset: true }>;
	assert.deepEqual(first.items.map((i) => i.id), ["3"], "the patter takes yesterday's time and stays with it");
	assert.equal(first.earlier, true);
	await view.stop();
	sent.length = 0;
	const all = await serveView(root as never, BG, (r) => sent.push(r), "b");
	assert.deepEqual((sent[0] as Extract<Reply, { type: "view"; reset: true }>).items.map((i) => i.id), ["1", "2", "3"], "without a wake, every entry the window holds");
	await all.stop();
});

test("the daemon lists days, folds one by date or entry, and searches what was said", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("The boat is moored at the east dock."), fauxAssistantMessage("Glad to help.")]);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	await ask(tmp.paths.socket, "where did we leave the boat?");
	await ask(tmp.paths.socket, "thanks");
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const request = async (body: Record<string, unknown>) => (await client.request({ requestId: randomUUID(), ...body } as never)) as Reply;

	const days = await request({ op: "days" });
	assert.ok(days.type === "days", JSON.stringify(days));
	assert.deepEqual(days.days, [{ date: days.today, count: 4 }], "two messages each way, today");

	const found = await request({ op: "search", query: "boat" });
	assert.ok(found.type === "search", JSON.stringify(found));
	assert.deepEqual(found.hits.map((h) => [h.kind, h.text, h.date]), [["june", "The boat is moored at the east dock.", days.today], ["user", "where did we leave the boat?", days.today]]);
	const blank = await request({ op: "search", query: "  " });
	assert.deepEqual(blank.type === "search" && [blank.hits, blank.more], [[], false], "no words, no hits");

	const byDate = await request({ op: "day", date: days.today });
	assert.ok(byDate.type === "day", JSON.stringify(byDate));
	assert.equal(byDate.today, true);
	assert.deepEqual(byDate.items.filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.text), ["where did we leave the boat?", "thanks"]);
	assert.equal(byDate.at, undefined);

	const moment = await request({ op: "day", at: found.hits[0]!.id });
	assert.ok(moment.type === "day", JSON.stringify(moment));
	assert.equal(moment.date, days.today);
	const marked = moment.items.find((i) => i.id === moment.at);
	assert.ok(marked?.kind === "assistant" && marked.text.includes("east dock"), "the reply names the item to scroll to");

	const empty = await request({ op: "day", date: "2001-01-01" });
	assert.deepEqual(empty.type === "day" && [empty.items, empty.today], [[], false]);
	assert.equal((await request({ op: "day" })).type, "error");
});
