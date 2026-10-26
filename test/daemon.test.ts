import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Client, parseCommand, type Reply } from "../src/protocol.ts";
import { ask, fakeTelegram, openTestDaemon, tempDir, until } from "./helpers.ts";

test("ask answers over the socket, and a repeated request id is the same submission", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("Hiya Jon.")]);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());

	const first = await ask(tmp.paths.socket, "Hello", "req-1");
	assert.equal(first.status, "done");
	assert.equal(first.text, "Hiya Jon.");
	const again = await ask(tmp.paths.socket, "Hello", "req-1");
	assert.equal(again.submissionId, first.submissionId);
	assert.equal(again.text, "Hiya Jon.");
	assert.equal(faux.state.callCount, 1, "the duplicate never reached the model");

	const status = await daemon.status();
	assert.equal(status.busy, false);
	assert.equal(status.model, "faux/faux-1");
});

test("a restart keeps the conversation and finishes a run the last process left", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const slow = fauxProvider({ tokensPerSecond: 20 });
	slow.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage(`${"word ".repeat(200)}end`)]);
	let daemon = await openTestDaemon({ ...tmp, faux: slow });
	await ask(tmp.paths.socket, "one", "r1");

	const client = await Client.open(tmp.paths.socket);
	await client.request({ op: "submit", requestId: "r2", text: "two", source: "kitty" });
	await until(async () => (await daemon.status()).busy);
	await daemon.close();
	client.close();

	const fast = fauxProvider();
	fast.setResponses([fauxAssistantMessage("resumed answer")]);
	daemon = await openTestDaemon({ ...tmp, faux: fast });
	t.after(() => daemon.close());
	const resumed = await ask(tmp.paths.socket, "two", "r2", "kitty");
	assert.equal(resumed.status, "done", resumed.reason);
	assert.equal(fast.state.callCount, 1, "the resubmitted request did not start a second run");
	assert.equal(resumed.text, "resumed answer");
	const kinds = (await daemon.root.context(BG)).entries.map((e) => e.kind);
	assert.equal(kinds.filter((k) => k === "june.input").length, 2, "both inputs survive, neither duplicated");
});

test("an attached client sees a snapshot, then other clients' messages as events", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("earlier"), fauxAssistantMessage("live")]);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	await ask(tmp.paths.socket, "before attach");

	const watcher = await Client.open(tmp.paths.socket);
	t.after(() => watcher.close());
	const events: Reply[] = [];
	watcher.on((r) => events.push(r));
	const snapshot = await watcher.request({ op: "attach", requestId: randomUUID() });
	assert.equal(snapshot.type, "snapshot");
	if (snapshot.type === "snapshot") assert.ok(snapshot.snapshot.entries.some((e) => e.kind === "pi.assistant"));

	await ask(tmp.paths.socket, "after attach");
	await until(() =>
		events.some((r) => r.type === "events" && r.events.some((e) => e.type === "message_end")),
	);
	const appended = events.flatMap((r) => (r.type === "events" ? r.events : []));
	assert.ok(appended.some((e) => e.type === "message_end" && e.entry.kind === "june.input"));
});

test("Telegram messages land in the primary conversation and are answered to the chat", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("from kitty"), fauxAssistantMessage("from telegram")]);
	const tg = fakeTelegram();
	const daemon = await openTestDaemon({
		...tmp,
		faux,
		telegramPort: tg.port,
		config: { telegram: { tokenEnv: "TG", allowedUserIds: [42] } },
		secrets: { TG: `123456:${"a".repeat(35)}` },
	});
	t.after(() => daemon.close());
	assert.equal((await daemon.status()).telegram, "polling");

	await ask(tmp.paths.socket, "hello from the terminal");
	assert.equal(tg.sent.length, 0, "terminal answers stay in the terminal");

	const update = {
		update_id: 1,
		message: {
			message_id: 7,
			date: Math.floor(Date.now() / 1000),
			chat: { id: 42, type: "private" as const, first_name: "Jon" },
			from: { id: 42, is_bot: false, first_name: "Jon" },
			text: "hello from my phone",
		},
	};
	await daemon.telegram!.handleUpdate(update);
	await daemon.telegram!.handleUpdate(update); // redelivered by Telegram
	await until(() => tg.sent.some((m) => m.text.includes("from telegram")));

	const entries = (await daemon.root.context(BG)).entries;
	assert.equal(entries.filter((e) => e.kind === "pi.user").length, 1, "one shared conversation, no duplicate");
	assert.equal(entries.filter((e) => e.kind === "june.input").length, 1);
	assert.equal(faux.state.callCount, 2);

	// A stranger is refused before reaching the model.
	await daemon.telegram!.handleUpdate({
		update_id: 2,
		message: { ...update.message, message_id: 8, chat: { id: 9, type: "private" as const, first_name: "X" }, from: { id: 9, is_bot: false, first_name: "X" } },
	});
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(faux.state.callCount, 2);
});

test("a second daemon refuses to open the same state", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const daemon = await openTestDaemon({ ...tmp, faux: fauxProvider() });
	t.after(() => daemon.close());
	await assert.rejects(openTestDaemon({ ...tmp, faux: fauxProvider() }), /used by pid/);
});

test("an empty or malformed request gets an error, not a crash", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const daemon = await openTestDaemon({ ...tmp, faux: fauxProvider() });
	t.after(() => daemon.close());
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const reply = await client.request({ op: "submit", requestId: "x", text: "  ", source: "cli" });
	assert.equal(reply.type, "error");
	assert.equal((await daemon.status()).ok, true);
});

async function command(socket: string, name: string, args = "") {
	const client = await Client.open(socket);
	try {
		return await client.request({ op: "command", requestId: randomUUID(), name, args });
	} finally {
		client.close();
	}
}

test("slash commands match Telegram: /stop keeps the queue, /new resets, /compact and /status report", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider({ tokensPerSecond: 20 });
	faux.setResponses([fauxAssistantMessage(`${"slow ".repeat(200)}end`), fauxAssistantMessage("queued answer"), fauxAssistantMessage("another long one ".repeat(100))]);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());

	const idle = await command(tmp.paths.socket, "stop");
	assert.equal(idle.type === "reply" && idle.text, "Nothing is running.");

	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	await client.request({ op: "submit", requestId: "a", text: "first", source: "kitty" });
	await until(async () => (await daemon.status()).busy);
	const queued = ask(tmp.paths.socket, "second", "b", "kitty");
	await until(async () => (await daemon.status()).queued === 1);
	const stopped = await command(tmp.paths.socket, "stop");
	assert.equal(stopped.type === "reply" && stopped.text, "Stopped. 1 queued message(s) will continue.");
	assert.equal((await queued).text, "queued answer");

	await client.request({ op: "submit", requestId: "c", text: "third", source: "kitty" });
	await until(async () => (await daemon.status()).busy);
	const fresh = await command(tmp.paths.socket, "new");
	assert.equal(fresh.type === "reply" && fresh.text, "New context. Old history is kept.\nThe request in progress was stopped.");
	const kinds = (await daemon.root.context(BG)).entries.map((e) => e.kind);
	assert.equal(kinds[0], "pi.reset", "the model sees nothing before the reset");

	const compact = await command(tmp.paths.socket, "compact");
	assert.equal(compact.type === "reply" && compact.text, "Nothing to compact.");
	const status = await command(tmp.paths.socket, "status");
	assert.match(status.type === "reply" ? status.text : "", /^June .*\nModel: faux\/faux-1, thinking off\nState: idle, queued: 0\nContext: /);
	const help = await command(tmp.paths.socket, "help");
	assert.match(help.type === "reply" ? help.text : "", /^\/new - Start a fresh context/);
	assert.equal((await command(tmp.paths.socket, "nope")).type, "error");
});

test("command parsing accepts Telegram's forms and leaves other text alone", () => {
	assert.deepEqual(parseCommand("/compact keep test names"), { name: "compact", args: "keep test names" });
	assert.deepEqual(parseCommand("/new@june_bot"), { name: "new", args: "" });
	assert.equal(parseCommand("/usr/bin is a path"), undefined);
	assert.equal(parseCommand("please /stop"), undefined);
});
