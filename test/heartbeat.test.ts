import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { within } from "../src/heartbeat.ts";
import { Client, type Reply } from "../src/protocol.ts";
import { createCodingExtension } from "../src/tools/coding.ts";
import { Transcript } from "../src/transcript.ts";
import { fakeTelegram, openTestDaemon, tempDir, until } from "./helpers.ts";

test("the heartbeat window may cross midnight", () => {
	const day = { start: "05:00", end: "22:00" };
	assert.equal(within(new Date(2026, 9, 28, 4, 59), day), false);
	assert.equal(within(new Date(2026, 9, 28, 5, 0), day), true);
	assert.equal(within(new Date(2026, 9, 28, 21, 59), day), true);
	assert.equal(within(new Date(2026, 9, 28, 22, 0), day), false, "quiet means quiet, even if Alex is up");
	const night = { start: "01:00", end: "05:00" };
	assert.equal(within(new Date(2026, 9, 28, 3, 0), night), true);
	assert.equal(within(new Date(2026, 9, 28, 12, 0), night), false);
	const wrapped = { start: "22:00", end: "02:00" };
	assert.equal(within(new Date(2026, 9, 28, 23, 0), wrapped), true);
	assert.equal(within(new Date(2026, 9, 28, 1, 0), wrapped), true);
});

test("a heartbeat looks privately, stays quiet or messages Alex where they are, and never shows itself", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	await writeFile(join(tmp.dir, "SOUL.org"), "* June\nBe observant.\n");
	await writeFile(join(tmp.dir, "HEARTBEAT.org"), "* Worth a nudge\n- The clinic heater, an hour ahead when it is cold.\n");
	const calendar = join(tmp.dir, "fresha.org");
	await writeFile(calendar, "");
	// Tomorrow at 10:00, so Alex's real message from a moment ago is not "chatting".
	const base = new Date();
	let clock = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 10, 0);
	const day = `${clock.getFullYear()}-${String(clock.getMonth() + 1).padStart(2, "0")}-${String(clock.getDate()).padStart(2, "0")}`;
	const asked: string[] = [];
	const heard = (ctx: TranscriptContext) => {
		// The now section may have changed too, which appends a system update after the input.
		const last = ctx.messages.findLast((m) => m.role === "user")!;
		asked.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
	};
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage("hello"),
		(ctx) => {
			heard(ctx);
			return fauxAssistantMessage([fauxToolCall("bash", { command: "echo checking" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("QUIET"),
		(ctx) => {
			heard(ctx);
			return fauxAssistantMessage("Clinic at 13:00 and it's cold: **heater** on soon?");
		},
	]);
	const tg = fakeTelegram();
	const daemon = await openTestDaemon({
		...tmp,
		faux,
		telegramPort: tg.port,
		extensions: [createCodingExtension()],
		config: {
			soulFile: join(tmp.dir, "SOUL.org"),
			memoryFile: join(tmp.dir, "MEMORY.org"),
			heartbeatFile: join(tmp.dir, "HEARTBEAT.org"),
			telegram: { tokenEnv: "TG", allowedUserIds: [42] },
			heartbeat: { enabled: true, everyMinutes: 60, chattingMinutes: 15 },
			situation: { calendars: [calendar], homeAssistant: { people: [], pollSeconds: 300 } },
		},
		secrets: { TG: `123456:${"a".repeat(35)}` },
		heartbeatClock: { now: () => clock, tickMs: 50 },
	});
	t.after(() => daemon.close());
	await daemon.telegram!.handleUpdate({
		update_id: 1,
		message: {
			message_id: 7,
			date: Math.floor(Date.now() / 1000),
			chat: { id: 42, type: "private" as const, first_name: "Alex" },
			from: { id: 42, is_bot: false, first_name: "Alex" },
			text: "hi",
		},
	});
	await until(() => tg.sent.some((m) => m.text.includes("hello")));

	// The first look, quiet, even after a tool call.
	await until(() => faux.state.callCount >= 3, 10_000);
	await until(() => existsSync(join(tmp.paths.state, "heartbeat.json")));
	assert.match(asked[0]!, /^\[heartbeat\] A private heartbeat/);
	assert.match(asked[0]!, /not chatting with you right now/);
	assert.match(asked[0]!, /first look today/);
	assert.match(asked[0]!, /The clinic heater, an hour ahead/, "her standing instructions come from HEARTBEAT.org");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(faux.state.callCount, 3, "one look per hour");
	assert.equal(tg.sent.length, 1, "a quiet look sends nothing");

	// Later, inside the hour: nothing. An hour on, with a clinic on the calendar: a message to Telegram, where Alex is.
	clock = new Date(clock.getTime() + 30 * 60_000);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(faux.state.callCount, 3);
	await writeFile(calendar, `* Clinic on ${day}\n<${day} Thu 13:00-17:00>\n`);
	clock = new Date(clock.getTime() + 31 * 60_000);
	await until(() => tg.sent.length === 2, 10_000);
	assert.match(asked[1]!, /Since your last look:\n- Today: 13:00–17:00 Clinic/, "what changed since the last look");
	assert.equal(tg.sent[1]!.text, "Clinic at 13:00 and it's cold: <b>heater</b> on soon?");

	// Quiet hours: no look at all.
	clock = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate(), 22, 30);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(faux.state.callCount, 4, "no heartbeat after quiet");

	// The terminal shows Alex's chat and June's one real message; never the heartbeats, her tools, or QUIET.
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const snapshot = (await client.request({ op: "attach", requestId: "a" })) as Extract<Reply, { type: "snapshot" }>;
	const transcript = new Transcript();
	transcript.load(snapshot.snapshot);
	const shown = transcript.items.map((i) => (i.kind === "assistant" ? `june: ${i.blocks.map((b) => b.text ?? "").join("")}` : i.kind === "user" ? `alex: ${i.text}` : i.kind));
	assert.deepEqual(shown, ["alex: hi", "june: hello", "june: Clinic at 13:00 and it's cold: **heater** on soon?"]);
});
