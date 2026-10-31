import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { parseSince, renderHistory } from "../src/history.ts";
import { Client } from "../src/protocol.ts";
import { ask, openTestDaemon, tempDir } from "./helpers.ts";

const at = (minute: number) => Date.UTC(2026, 9, 30, 22, minute);
const input = (id: number, minute: number, source: string, text: string, prompt = `[${source}] ${text}`) =>
	({ id, kind: "june.input", data: { source, text }, model: [{ role: "user", content: prompt, timestamp: at(minute) }] });
const said = (id: number, minute: number, content: unknown[]) => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content, stopReason: "stop", timestamp: at(minute) }] });
const result = (id: number, minute: number, toolName: string, text: string, isError = false) =>
	({ id, kind: "pi.tool-result", model: [{ role: "toolResult", toolName, content: [{ type: "text", text }], isError, timestamp: at(minute) }] });

const entries = [
	input(1, 0, "kitty", "can you check the worker?"),
	said(2, 0, [{ type: "thinking", thinking: "Finding the worker\nthen reading it" }, { type: "toolCall", id: "c1", name: "herdr_read_agent", arguments: { target: "w5A:p1" } }]),
	result(3, 0, "herdr_read_agent", "running checks"),
	said(4, 1, [{ type: "text", text: "he is running checks." }]),
	{ id: 5, kind: "june.patter", data: { text: "poor little bloke." } },
	input(6, 5, "heartbeat", "heartbeat", "[heartbeat] A private heartbeat: look at the moment."),
	said(7, 5, [{ type: "toolCall", id: "c2", name: "org_read_task", arguments: { file: "x.org" } }]),
	result(8, 5, "org_read_task", "secret task text"),
	said(9, 5, [{ type: "text", text: "QUIET" }]),
	input(10, 9, "follow", "follow", "[follow] Time for the regular update."),
	said(11, 9, [{ type: "text", text: "still checking." }]),
	result(12, 10, "org_search", "no such file", true),
];

test("the plain view shows what the terminal shows, and detail adds thinking, tool output, and private looks", () => {
	const plain = renderHistory(entries, { user: "Robin", omitted: 4 });
	assert.match(plain, /^\(4 earlier entries not shown\)\n== 2026-10-30\n/);
	assert.match(plain, /\d\d:\d\d Robin \(kitty\): can you check the worker\?/);
	assert.match(plain, /June thinking: Finding the worker then reading it\n/, "thinking is one line");
	assert.match(plain, / {2}-> herdr_read_agent: target=w5A:p1/);
	assert.doesNotMatch(plain, /<- herdr_read_agent/, "output of a tool that worked stays out");
	assert.match(plain, /June \(patter\): poor little bloke\./);
	assert.doesNotMatch(plain, /heartbeat|org_read_task|secret|QUIET|regular update/, "private looks show only her message");
	assert.match(plain, /June: still checking\./);
	assert.doesNotMatch(plain, /org_search/, "a tool in a look stays out, failed or not");

	const detail = renderHistory(entries, { detail: true, user: "Robin" });
	assert.match(detail, /June thinking: Finding the worker\n {6}then reading it/);
	assert.match(detail, /-> herdr_read_agent: \{"target":"w5A:p1"\}/);
	assert.match(detail, /<- herdr_read_agent: running checks/);
	assert.match(detail, /\[heartbeat\] \(private\): \[heartbeat\] A private heartbeat/);
	assert.match(detail, /<- org_read_task \(private\): secret task text/);
	assert.match(detail, /June \(private\): QUIET/);
	assert.match(detail, /June: still checking\./, "her message from a look reached the user, so it is not private");
	assert.match(detail, /<- org_search failed \(private\): no such file/);
});

test("--since reads ages, clock times, and dates", () => {
	const now = new Date(2026, 9, 30, 16, 30);
	assert.equal(parseSince("30m", now), now.getTime() - 30 * 60_000);
	assert.equal(parseSince("2h", now), now.getTime() - 2 * 3_600_000);
	assert.equal(parseSince("16:20", now), new Date(2026, 9, 30, 16, 20).getTime());
	assert.equal(parseSince("17:00", now), new Date(2026, 9, 29, 17, 0).getTime(), "a later clock time means yesterday");
	assert.equal(parseSince("2026-10-29T08:00:00Z", now), Date.UTC(2026, 9, 29, 8));
	assert.equal(parseSince("soon", now), undefined);
});

test("the daemon serves history without a stream: the newest entries, or those since a time", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxThinking("Looking it up"), fauxToolCall("no_such_tool", { query: "x" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Could not look it up.")]),
		fauxAssistantMessage("Second answer."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	await ask(tmp.paths.socket, "first message");
	await ask(tmp.paths.socket, "second message");

	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const history = async (options: { since?: number; limit?: number }) => {
		const reply = await client.request({ op: "history", requestId: randomUUID(), ...options });
		assert.equal(reply.type, "history");
		return reply as Extract<typeof reply, { type: "history" }>;
	};
	const all = await history({});
	const text = renderHistory(all.entries);
	assert.match(text, /user \(cli\): first message\n.*June thinking: Looking it up\n.*-> no_such_tool: query=x\n.*<- no_such_tool failed: .+\n.*June: Could not look it up\.\n.*user \(cli\): second message\n.*June: Second answer\.$/s);
	const last = await history({ limit: 2 });
	assert.equal(last.entries.length, 2);
	assert.equal(last.omitted, all.entries.length + all.omitted - 2);
	assert.match(renderHistory(last.entries), /second message[\s\S]*Second answer/);
	const future = await history({ since: Date.now() + 60_000 });
	assert.deepEqual([future.entries.length, future.omitted], [0, all.entries.length + all.omitted]);
});
