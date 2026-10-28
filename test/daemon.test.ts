import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { promptFiles } from "../src/config.ts";
import { Client, parseCommand, type Reply } from "../src/protocol.ts";
import { createCodingExtension } from "../src/tools/coding.ts";
import { Transcript } from "../src/transcript.ts";
import { ask, fakeTelegram, openTestDaemon, routed, tempDir, until } from "./helpers.ts";

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

test("ask answers over the socket, and a repeated request id is the same submission", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("Hiya Alex.")]);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());

	const first = await ask(tmp.paths.socket, "Hello", "req-1");
	assert.equal(first.status, "done");
	assert.equal(first.text, "Hiya Alex.");
	const again = await ask(tmp.paths.socket, "Hello", "req-1");
	assert.equal(again.submissionId, first.submissionId);
	assert.equal(again.text, "Hiya Alex.");
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
			chat: { id: 42, type: "private" as const, first_name: "Alex" },
			from: { id: 42, is_bot: false, first_name: "Alex" },
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

test("a brief asked for from Telegram reports back to the chat; one asked for in the terminal stays there", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses(routed(
		[
			call("work", { brief: "Count the phone wombats." }),
			fauxAssistantMessage("on it"),
			(ctx) => {
				assert.match(JSON.stringify(ctx.messages.at(-1)), /\[work\] Report: seven wombats\./);
				return fauxAssistantMessage("seven wombats, from the phone brief");
			},
			call("work", { brief: "Count the desk wombats." }),
			fauxAssistantMessage("on it at the desk"),
			fauxAssistantMessage("three wombats, from the desk brief"),
		],
		[fauxAssistantMessage("Report: seven wombats."), fauxAssistantMessage("Report: three wombats.")],
	));
	const tg = fakeTelegram();
	const daemon = await openTestDaemon({
		...tmp,
		faux,
		telegramPort: tg.port,
		extensions: [createCodingExtension()],
		config: { telegram: { tokenEnv: "TG", allowedUserIds: [42] } },
		secrets: { TG: `123456:${"a".repeat(35)}` },
	});
	t.after(() => daemon.close());
	await daemon.telegram!.handleUpdate({
		update_id: 1,
		message: {
			message_id: 7,
			date: Math.floor(Date.now() / 1000),
			chat: { id: 42, type: "private" as const, first_name: "Alex" },
			from: { id: 42, is_bot: false, first_name: "Alex" },
			text: "count the wombats",
		},
	});
	await until(() => tg.sent.some((m) => m.text.includes("seven wombats, from the phone brief")), 10_000);
	assert.ok(tg.sent.some((m) => m.text.includes("on it")), "the hand-off reached the chat too");
	const transcript = new Transcript();
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	transcript.load(((await client.request({ op: "attach", requestId: "a" })) as Extract<Reply, { type: "snapshot" }>).snapshot);
	assert.ok(
		transcript.items.some((i) => i.kind === "user" && i.source === "work" && i.text === "Report: seven wombats."),
		"the terminal shows the delivered report as one short work line",
	);

	const before = tg.sent.length;
	assert.equal((await ask(tmp.paths.socket, "now count the desk ones")).text, "on it at the desk");
	await until(async () => JSON.stringify((await daemon.root.context(BG)).messages).includes("three wombats, from the desk brief"), 10_000);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(tg.sent.length, before, "a terminal brief's report stays in the terminal");
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
	assert.equal((await command(tmp.paths.socket, "reload")).type, "reply");
	assert.equal((await daemon.status()).busy, true, "reload leaves the current run alone");
	assert.equal((await daemon.status()).queued, 1, "reload leaves queued inputs alone");
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

test("/reload refreshes prompt files and skill discovery without a model call or chat reset", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const skills = join(tmp.dir, "skills");
	const oldSkill = join(skills, "old");
	const newSkill = join(skills, "new");
	const personal = join(tmp.dir, "personal");
	const dirs = { ...tmp.paths, data: personal };
	const instructions = join(tmp.dir, "AGENTS.md");
	await mkdir(oldSkill, { recursive: true });
	await mkdir(personal);
	await writeFile(join(oldSkill, "SKILL.md"), "---\nname: old\ndescription: Old skill\n---\nOld body.");
	await writeFile(join(personal, "SOUL.org"), "Soul before.");
	await writeFile(instructions, "Rules before.");
	const stamp = await stat(instructions);
	const faux = fauxProvider();
	// Durable keeps system updates in the transcript; later sections replace earlier ones by name.
	const prompt = (ctx: TranscriptContext) => JSON.stringify(Object.assign({}, ...ctx.messages.filter((m) => m.role === "system").map((m) => m.sections)));
	faux.setResponses([
		(ctx) => {
			assert.match(prompt(ctx), /Soul before\./);
			assert.match(prompt(ctx), /Rules before\./);
			assert.match(prompt(ctx), /old: Old skill/);
			assert.match(prompt(ctx), /MEMORY.org is empty or does not exist yet/, "a missing memory file is not an error");
			return fauxAssistantMessage("Before reload.");
		},
	]);
	const daemon = await openTestDaemon({
		...tmp,
		paths: dirs,
		faux,
		config: { ...promptFiles(dirs), skillDirs: [skills] },
	});
	t.after(() => daemon.close());
	await ask(tmp.paths.socket, "before");

	await rm(oldSkill, { recursive: true });
	await mkdir(newSkill);
	await writeFile(join(newSkill, "SKILL.md"), "---\nname: new\ndescription: New skill\n---\nNew body.");
	// The identity changes after startup, and memory starts beside it.
	await writeFile(join(personal, "SOUL.org"), "Soul after!.");
	await writeFile(join(personal, "MEMORY.org"), "* Alex prefers Org");
	await writeFile(join(personal, "MEMORY.sync-conflict-20261026-120000-ABCDEFG.org"), "* other copy");
	await writeFile(instructions, "Rules after!."); // Same size and mtime: /reload must bypass the file cache.
	await utimes(instructions, stamp.atime, stamp.mtime);
	const before = (await daemon.root.context(BG)).entries;
	const conversation = (await daemon.status()).conversation;
	const reloaded = await command(tmp.paths.socket, "reload");
	assert.match(reloaded.type === "reply" ? reloaded.text : "", /^Reloaded prompt files and skills \(1\)\. Chat kept\./);
	assert.equal(faux.state.callCount, 1, "reload never calls the model");
	assert.deepEqual((await daemon.root.context(BG)).entries, before, "reload adds no entries and drops no history");
	assert.equal((await daemon.status()).conversation, conversation);

	faux.setResponses([
		(ctx) => {
			assert.match(prompt(ctx), /Soul after!\./);
			assert.doesNotMatch(prompt(ctx), /Soul before/, "the identity as it is now");
			assert.match(prompt(ctx), /Rules after!\./);
			assert.match(prompt(ctx), /\* Alex prefers Org/);
			assert.ok(prompt(ctx).includes(join(personal, "MEMORY.org")), "June is told where her memory lives");
			assert.match(prompt(ctx), /conflict copies in .*MEMORY\.sync-conflict-20261026-120000-ABCDEFG\.org/);
			assert.match(prompt(ctx), /new: New skill/);
			assert.doesNotMatch(prompt(ctx), /old: Old skill/);
			return fauxAssistantMessage([fauxToolCall("skill_read", { name: "new" })], { stopReason: "toolUse" });
		},
		(ctx) => {
			assert.match(JSON.stringify(ctx.messages.at(-1)), /New body\./);
			return fauxAssistantMessage([fauxToolCall("skill_read", { name: "old" })], { stopReason: "toolUse" });
		},
		(ctx) => {
			assert.match(JSON.stringify(ctx.messages.at(-1)), /No skill named old/);
			return fauxAssistantMessage("After reload.");
		},
	]);
	assert.equal((await ask(tmp.paths.socket, "after")).text, "After reload.");

	await writeFile(join(newSkill, "SKILL.md"), "---\nname: new\ndescription: Changed description\n---\nChanged body.");
	await command(tmp.paths.socket, "reload");
	faux.setResponses([
		(ctx) => {
			assert.match(prompt(ctx), /new: Changed description/);
			assert.doesNotMatch(prompt(ctx), /new: New skill/);
			return fauxAssistantMessage([fauxToolCall("skill_read", { name: "new" })], { stopReason: "toolUse" });
		},
		(ctx) => {
			assert.match(JSON.stringify(ctx.messages.at(-1)), /Changed body\./);
			return fauxAssistantMessage("Changed.");
		},
	]);
	assert.equal((await ask(tmp.paths.socket, "changed")).text, "Changed.");
	const help = await command(tmp.paths.socket, "help");
	assert.match(help.type === "reply" ? help.text : "", /\/reload - Reload prompt files and skills/);
});

test("command parsing accepts Telegram's forms and leaves other text alone", () => {
	assert.deepEqual(parseCommand("/compact keep test names"), { name: "compact", args: "keep test names" });
	assert.deepEqual(parseCommand("/new@june_bot"), { name: "new", args: "" });
	assert.deepEqual(parseCommand("/reload"), { name: "reload", args: "" });
	assert.equal(parseCommand("/usr/bin is a path"), undefined);
	assert.equal(parseCommand("please /stop"), undefined);
});
