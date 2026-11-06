import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Client, type Reply } from "../src/protocol.ts";
import { Hidden, parseRange, renderTimeline, terms, Timeline, TimelineFold, type TimelineItem } from "../src/timeline.ts";
import { ask, attachView, openTestDaemon, tempDir } from "./helpers.ts";

const at = (minute: number) => Date.UTC(2026, 9, 30, 22, minute);
const input = (id: number, minute: number, source: string, text: string, extra: Record<string, unknown> = {}, prompt = `[${source}] ${text}`) =>
	({ id, kind: "june.input", data: { source, text, ...extra }, model: [{ role: "user", content: prompt, timestamp: at(minute) }] });
const said = (id: number, minute: number, content: unknown[], stopReason = "stop") => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content, stopReason, timestamp: at(minute) }] });
const result = (id: number, minute: number, toolName: string, text: string) =>
	({ id, kind: "pi.tool-result", model: [{ role: "toolResult", toolName, content: [{ type: "text", text }], isError: false, timestamp: at(minute) }] });

const entries = [
	{ id: 1, kind: "pi.user", model: [{ role: "user", content: "an old telegram message", timestamp: at(0) }] },
	input(2, 1, "kitty", "Can you check the WORKER?", { imageCount: 2, files: [{ name: "notes.txt", size: 3, path: "/nonexistent/notes.txt" }] }),
	said(3, 1, [{ type: "thinking", thinking: "private reasoning" }, { type: "toolCall", id: "c1", name: "herdr_read_agent", arguments: { target: "w5A:p1" } }]),
	result(4, 1, "herdr_read_agent", "secret tool output"),
	said(5, 2, [{ type: "text", text: "He is running checks." }]),
	{ id: 6, kind: "june.patter", data: { text: "poor little bloke." } },
	input(7, 5, "heartbeat", "heartbeat", {}, "[heartbeat] A private look at the moment."),
	said(8, 5, [{ type: "toolCall", id: "c2", name: "org_read_task", arguments: { file: "x.org" } }]),
	result(9, 5, "org_read_task", "private task text"),
	said(10, 5, [{ type: "text", text: "QUIET" }]),
	input(11, 9, "follow", "follow", {}, "[follow] Time for the update."),
	said(12, 9, [{ type: "text", text: "The worker finished." }]),
	{ id: 13, kind: "june.work", data: { id: "w", state: "started", brief: "Check the mail" } },
	{ id: 14, kind: "june.expression", data: { expression: "smile" } },
	{ id: 15, kind: "pi.user", model: [{ role: "user", content: "[/stop]", timestamp: at(12) }] },
	{ id: 16, kind: "pi.compaction", model: [{ role: "user", content: "summary", timestamp: at(13) }] },
	input(17, 14, "gui", "thanks, that was the \"blue folder\" one"),
	said(18, 14, [{ type: "text", text: "Partial" }], "error"),
];

const folded = () => {
	const fold = new TimelineFold();
	return entries.flatMap((entry) => fold.push(entry));
};

test("the fold keeps what the user saw, word for word, and leaves out thinking, tool output, and private looks", () => {
	const items = folded();
	const line = (item: TimelineItem) => `${item.id} ${item.kind}${item.source ? `/${item.source}` : ""}: ${item.text}`;
	assert.deepEqual(items.map(line), [
		"1 user/telegram: an old telegram message",
		"2 user/tui: Can you check the WORKER? [2 images]",
		"3 action: herdr_read_agent target=w5A:p1",
		"5 june/tui: He is running checks.",
		"6 patter: poor little bloke.",
		"12 june/follow: The worker finished.",
		"13 action: background work started: Check the mail",
		"15 note: stopped",
		"16 note: earlier conversation compacted",
		'17 user/gui: thanks, that was the "blue folder" one',
		"18 june/gui: Partial",
		"18 note: June error",
	]);
	assert.equal(items.find((i) => i.id === 6)!.at, at(2), "patter takes the time of the entry before it");
	assert.deepEqual(items.find((i) => i.id === 2)!.files, [{ name: "notes.txt", path: "/nonexistent/notes.txt" }]);
	const text = renderTimeline(items, { user: "Robin" });
	assert.match(text, /^#2 \d{4}-\d\d-\d\d \d\d:\d\d Robin \(tui\): Can you check the WORKER\? \[2 images\] \[file notes\.txt, no longer kept\]$/m);
	assert.match(text, /^#12 .* June \(after follow\): The worker finished\.$/m);
	assert.match(text, /^#3 .* June did: herdr_read_agent target=w5A:p1$/m);
	assert.doesNotMatch(text, /private|secret|QUIET|smile/);
});

test("search matches every word in any case and quoted phrases, newest first, within times and kinds", async () => {
	assert.deepEqual(terms('Blue "blue folder"  x'), ["blue", "blue folder", "x"]);
	const items = folded();
	const timeline = new Timeline(async (query) => ({ items: entries.filter((e) => e.id >= Number((query as { minEntryId: number }).minEntryId)) as never, next: undefined }), new Hidden("/nonexistent/hidden.json"));
	const ids = async (query: Parameters<Timeline["search"]>[0]) => (await timeline.search(query, BG)).items.map((i) => i.id);
	assert.deepEqual(await ids({ query: "worker" }), [12, 2]);
	assert.deepEqual(await ids({ query: "check worker" }), [2]);
	assert.deepEqual(await ids({ query: '"blue folder"' }), [17]);
	assert.deepEqual(await ids({ query: '"folder blue"' }), []);
	assert.deepEqual(await ids({ query: "worker", kinds: ["june"] }), [12]);
	assert.deepEqual(await ids({ query: "worker", since: at(5) }), [12]);
	assert.deepEqual(await ids({ query: "worker", until: at(5) }), [2]);
	const limited = await timeline.search({ query: "", limit: 2 }, BG);
	assert.deepEqual([limited.items.map((i) => i.id), limited.more], [[18, 18], true]);
	assert.equal(items.length, 12);

	const near = await timeline.around(4, 1, 1, BG);
	assert.deepEqual(near.items.map((i) => i.id), [3, 5, 6], "an entry without an item reads around the next one");
	assert.match(renderTimeline(near.items, { mark: 4 }), /^#3 [\s\S]*\n>5 /);
	assert.deepEqual((await timeline.around(99, 1, 1, BG)).items, []);
});

test("the timeline catches up from where it stopped, once per entry, and hidden entries leave every query", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const hidden = new Hidden(join(tmp.dir, "state", "hidden.json"));
	const committed: unknown[] = entries.slice(0, 5);
	const asked: number[] = [];
	const timeline = new Timeline(async (query, limit) => {
		asked.push(Number((query as { minEntryId: number }).minEntryId));
		const from = committed.filter((e: any) => e.id >= (query as { minEntryId: number }).minEntryId);
		return { items: from.slice(0, limit) as never, next: undefined };
	}, hidden);
	assert.deepEqual((await timeline.search({ query: "worker" }, BG)).items.map((i) => i.id), [2]);
	committed.push(...entries.slice(5));
	assert.deepEqual((await timeline.search({ query: "worker" }, BG)).items.map((i) => i.id), [12, 2]);
	assert.deepEqual(asked, [0, 6]);

	assert.deepEqual(hidden.add(12), [[12, 12]]);
	assert.deepEqual(hidden.add(2, 3), [[2, 3], [12, 12]]);
	assert.deepEqual(hidden.add(4), [[2, 4], [12, 12]], "touching ranges merge");
	assert.deepEqual((await timeline.search({ query: "worker" }, BG)).items, []);
	assert.deepEqual(hidden.remove(3), [[2, 2], [4, 4], [12, 12]], "removing splits a range");
	assert.deepEqual(new Hidden(join(tmp.dir, "state", "hidden.json")).ranges(), [[2, 2], [4, 4], [12, 12]], "kept in a file");
	assert.equal(JSON.parse(await readFile(join(tmp.dir, "state", "hidden.json"), "utf8")).ranges.length, 3);
	assert.deepEqual((await timeline.around(3, 1, 1, BG)).items.map((i) => i.id), [1, 3, 5]);
	await writeFile(join(tmp.dir, "state", "hidden.json"), "{ broken");
	assert.deepEqual(hidden.ranges(), [[2, 2], [4, 4], [12, 12]], "a mangled file keeps the ranges last read");
	assert.deepEqual([parseRange("7"), parseRange("9-4"), parseRange("x")], [[7, 7], [4, 9], undefined]);
});

test("the daemon serves the timeline across /new and a restart, hides entries, and June can search it", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("The blue folder is on the shelf."), fauxAssistantMessage("Noted.")]);
	let daemon = await openTestDaemon({ ...tmp, faux });
	await ask(tmp.paths.socket, "where is the blue folder?");
	let client = await Client.open(tmp.paths.socket);
	const request = async (body: Record<string, unknown>) => (await client.request({ requestId: randomUUID(), ...body } as never)) as Reply;
	const search = async (query: string) => {
		const reply = await request({ op: "timeline", query });
		assert.equal(reply.type, "timeline", JSON.stringify(reply));
		return (reply as Extract<Reply, { type: "timeline" }>).items;
	};
	const first = await search("blue folder");
	assert.deepEqual(first.map((i) => [i.kind, i.source, i.text]), [["june", "cli", "The blue folder is on the shelf."], ["user", "cli", "where is the blue folder?"]]);
	await request({ op: "command", name: "new" });
	await ask(tmp.paths.socket, "and the red one?");
	assert.deepEqual((await search("folder")).length, 2, "a new context keeps the history");
	assert.equal((await search("red")).length, 1, "caught up with the newest message");
	client.close();
	await daemon.close();

	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("timeline", { query: "blue folder" })], { stopReason: "toolUse" }),
		(context: TranscriptContext) => {
			const output = JSON.stringify(context.messages.at(-1));
			assert.match(output, /June: The blue folder is on the shelf\./);
			assert.match(output, /Alex \(cli\): where is the blue folder\?/);
			return fauxAssistantMessage("It was on the shelf.");
		},
	]);
	daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	assert.equal((await search("blue folder")).length, 2, "rebuilt after a restart");
	assert.equal((await ask(tmp.paths.socket, "what did you say about the blue folder?")).text, "It was on the shelf.");
	const actions = await search("timeline");
	assert.ok(actions.some((i) => i.kind === "action" && i.text === "timeline query=blue folder"), "her own search is an action line");
	assert.ok(!actions.some((i) => i.kind !== "action" && /on the shelf\.\n/.test(i.text)), "tool output stays out");

	const answer = first[0]!.id;
	const hid = await request({ op: "hide", action: "add", from: answer });
	assert.deepEqual(hid.type === "hidden" && hid.ranges, [[answer, answer]]);
	assert.deepEqual((await search("shelf")).map((i) => i.text), ["It was on the shelf."]);
	const view = await attachView(tmp.paths.socket);
	assert.ok(!view.items().some((i) => i.kind === "assistant" && i.text.includes("The blue folder is on the shelf")), "attached views leave it out");
	assert.ok(view.items().some((i) => i.kind === "assistant" && i.text.includes("It was on the shelf")));
	view.close();
	const history = await request({ op: "history" });
	assert.ok(history.type === "history" && !history.entries.some((e) => Number(e.id) === answer), "history leaves it out too");
	const around = await request({ op: "timeline", around: answer, before: 1, after: 1 });
	assert.ok(around.type === "timeline" && !around.items.some((i) => i.id === answer));
	assert.deepEqual(around.type === "timeline" && around.items.map((i) => i.text).slice(0, 2), ["where is the blue folder?", "new context"], "around a hidden entry reads from the next one");
	const shown = await request({ op: "hide", action: "remove", from: answer });
	assert.deepEqual(shown.type === "hidden" && shown.ranges, []);
	assert.equal((await search("shelf")).length, 2);
	assert.equal((await request({ op: "hide", action: "add" })).type, "error");
});
