import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createRegistry, Harness, UserEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { runCommand } from "../src/commands.ts";
import { createMemoryExtension, MemoryReview } from "../src/memory.ts";
import { createPromptExtension } from "../src/prompt.ts";
import { dayFor } from "../src/reflect.ts";
import { ask, fakeTelegram, openTestDaemon, tempDir, testConfig, until, type Faux } from "./helpers.ts";

const lesson = "#+TITLE: Memory\n\n* 2026-10-26 Trust and judgment\nJon said: judge when to act directly, rather than force delegation by missing tools.\n\nI had mistaken delegation for a universal rule. Use available tools for bounded checks, delegate sustained work, and keep approval rules. Source: conversation 1.\n";
const response = (memory: string | null = lesson, summary = "Old conversation summarized.") => fauxAssistantMessage(JSON.stringify({ summary, memory }));
const effectivePrompt = (ctx: TranscriptContext) => JSON.stringify(Object.assign({}, ...ctx.messages.filter((m) => m.role === "system").map((m) => m.sections)));

async function fixture(t: TestContext) {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	await mkdir(tmp.paths.state);
	const soul = join(tmp.dir, "SOUL.org");
	const memory = join(tmp.dir, "MEMORY.org");
	await writeFile(soul, "#+TITLE: June\nBe observant, not flattering.\n");
	const journal = join(tmp.dir, "JOURNAL.org");
	const config = testConfig(tmp.dir, { soulFile: soul, memoryFile: memory, journalFile: journal });
	let harness: Harness;
	let pause: (() => Promise<void>) | undefined;
	const open = async (faux: Faux, automatic = false, policy: { reserveTokens?: number; backgroundTokens?: number } = {}) => {
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		const prompt = createPromptExtension(config, { config: tmp.dir, data: tmp.dir });
		registry.install(prompt.extension);
		const commit: Harness["commit"] = async (fn, context) => {
			if (pause !== undefined && existsSync(memory)) await pause();
			return harness.commit(fn, context);
		};
		registry.install(createMemoryExtension(prompt.files, () => new Proxy(harness, {
			get: (target, key) => key === "commit" ? commit : Reflect.get(target, key),
		})));
		harness = await Harness.open(await openNodeSqliteStorage(tmp.paths.database), {
			models, registry, settings: { compaction: { enabled: automatic, keepRecentTokens: 50, reserveTokens: 120_000, backgroundTokens: 0, ...policy } },
		}, BG);
		const root = await harness.root(BG, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const append = async (text: string) => {
			const submission = await root.submit({ type: "write", entry: { kind: UserEntry.kind,
				model: [{ role: "user", content: text, timestamp: Date.parse("2026-10-26T12:00:00Z") }] } }, BG);
			await submission.wait(BG);
		};
		const compact = () => runCommand({ harness, root, models, reload: async () => 0,
			status: async () => { throw new Error("not used"); } }, "compact", "preserve exact paths", "compact", BG);
		return { harness, root, append, compact, reload: prompt.reload };
	};
	t.after(() => harness?.close(BG));
	return { ...tmp, memory, soul, journal, config, open, pause: (fn: (() => Promise<void>) | undefined) => { pause = fn; } };
}

async function seed(f: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["open"]>>) {
	await f.append("I want you trusted to use judgment, not forced to delegate by missing tools.");
	await f.append("Unrelated recent context. ".repeat(100));
}

test("compaction saves a formative lesson, and fresh context sees it without the old summary", async (t) => {
	const env = await fixture(t);
	const faux = fauxProvider();
	faux.setResponses([(ctx) => {
		const source = JSON.parse(String(ctx.messages.at(-1)!.content));
		assert.equal(source.memory, null);
		assert.match(source.conversation, /trusted to use judgment/);
		assert.match(source.conversation, /2026-10-26/);
		assert.equal(source.focus, "preserve exact paths");
		assert.match(source.source, /conversation 1, entries/);
		return response(lesson, "Intentionally omits the lesson to test independent memory.");
	}]);
	let f = await env.open(faux);
	await seed(f);
	assert.equal(await f.compact(), "Compacted. Memory reviewed and updated.");
	assert.equal(await readFile(env.memory, "utf8"), lesson);
	assert.equal((await f.harness.usage(BG)).models["faux/faux-1"]!.output > 0, true);
	const soul = await readFile(env.soul, "utf8");
	await f.root.reset(undefined, BG);
	await f.harness.close(BG);

	const next = fauxProvider();
	next.setResponses([(ctx) => {
		assert.match(effectivePrompt(ctx), /mistaken delegation for a universal rule/);
		assert.doesNotMatch(JSON.stringify(ctx.messages), /Intentionally omits/);
		return fauxAssistantMessage("A bounded check is mine to do directly; approval rules still apply.");
	}]);
	f = await env.open(next);
	assert.equal((await (await f.root.submit({ type: "input", content: "How will you handle a bounded host check?" }, BG)).wait(BG)).status, "done");
	assert.equal(await readFile(env.soul, "utf8"), soul, "compaction never rewrites identity");
});

test("an existing lesson is reconciled, repeated review is a no-op, and no finding needs no file", async (t) => {
	const env = await fixture(t);
	const base = "#+TITLE: Memory\n\n* Old belief\nAlways delegate.\n\n* Unrelated\nKeep dates explicit.\n";
	await writeFile(env.memory, base);
	const revised = lesson + "\n* Unrelated\nKeep dates explicit.\n";
	const faux = fauxProvider();
	faux.setResponses([(ctx) => {
		assert.equal(JSON.parse(String(ctx.messages.at(-1)!.content)).memory, base);
		return response(revised);
	}, (ctx) => {
		assert.equal(JSON.parse(String(ctx.messages.at(-1)!.content)).memory, revised);
		return response(null);
	}]);
	const f = await env.open(faux);
	await seed(f);
	assert.match(await f.compact(), /updated/);
	await f.append("Another recent message. ".repeat(100));
	assert.match(await f.compact(), /no changes needed/);
	assert.equal(await readFile(env.memory, "utf8"), revised);
	assert.equal(revised.match(/Trust and judgment/g)?.length, 1);
	await rm(env.memory);
	faux.appendResponses([response(null)]);
	await f.append("Nothing learned today. ".repeat(100));
	assert.match(await f.compact(), /no changes needed/);
	assert.equal(existsSync(env.memory), false);
});

test("concurrent memory edits and Syncthing conflicts decline without losing old context, then recover", async (t) => {
	const env = await fixture(t);
	const concurrent = "#+TITLE: Memory\n\n* Human edit\nKeep this.\n";
	const faux = fauxProvider();
	faux.setResponses([async () => {
		await writeFile(env.memory, concurrent);
		return response();
	}]);
	const f = await env.open(faux);
	await seed(f);
	const before = await f.root.context(BG);
	assert.match(await f.compact(), /Compaction skipped: MEMORY.org changed during review/);
	assert.equal(await readFile(env.memory, "utf8"), concurrent);
	assert.deepEqual((await f.root.context(BG)).entries, before.entries);
	assert.equal((await f.harness.snapshot(MemoryReview, f.root.id, BG))?.failure !== undefined, true);
	const conflict = join(env.dir, "MEMORY.sync-conflict-test.org");
	await writeFile(conflict, "other copy");
	assert.match(await f.compact(), /Syncthing conflict copy/);
	assert.equal(faux.state.callCount, 1, "known conflict starts no model call");
	await rm(conflict);
	faux.appendResponses([response(null)]);
	assert.match(await f.compact(), /no changes needed/);
	assert.equal((await f.harness.snapshot(MemoryReview, f.root.id, BG))?.failure, undefined);
	assert.equal(await readFile(env.memory, "utf8"), concurrent);
	assert.deepEqual((await readdir(env.dir)).filter((n) => n.includes(".compaction-")), []);
});

test("invalid and truncated reviews do not fall through to Durable's default compaction", async (t) => {
	const env = await fixture(t);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("not json"), fauxAssistantMessage('{"summary":"partial', { stopReason: "length" })]);
	const f = await env.open(faux);
	await seed(f);
	const entries = (await f.root.context(BG)).entries;
	assert.match(await f.compact(), /Compaction skipped: Memory review returned invalid JSON/);
	assert.match(await f.compact(), /Compaction skipped: Memory review did not finish/);
	assert.equal(faux.state.callCount, 2, "no default summary and no automatic retry loop");
	assert.equal(existsSync(env.memory), false);
	assert.deepEqual((await f.root.context(BG)).entries, entries);
});

test("a failed file write keeps old context and the original memory", async (t) => {
	const env = await fixture(t);
	await writeFile(env.memory, "* Existing lesson\nKeep me.\n");
	const faux = fauxProvider();
	faux.setResponses([async () => { await chmod(env.dir, 0o500); return response(); }]);
	const f = await env.open(faux);
	await seed(f);
	const entries = (await f.root.context(BG)).entries;
	try { assert.match(await f.compact(), /Compaction skipped:.*EACCES/); }
	finally { await chmod(env.dir, 0o700); }
	assert.equal(await readFile(env.memory, "utf8"), "* Existing lesson\nKeep me.\n");
	assert.deepEqual((await f.root.context(BG)).entries, entries);
	assert.equal(faux.state.callCount, 1);
});

test("cancelling a review aborts its model call without saving or replacing context", async (t) => {
	const env = await fixture(t);
	const faux = fauxProvider();
	let started = false;
	let aborted = false;
	faux.setResponses([async (_ctx, options) => {
		started = true;
		await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
		return response();
	}]);
	const f = await env.open(faux);
	await seed(f);
	const entries = (await f.root.context(BG)).entries;
	const task = await f.root.compact(undefined, BG);
	await until(() => started);
	await f.root.abort(BG);
	assert.equal((await f.harness.waitForTask(task, BG)).state.outcome.status, "aborted");
	await until(() => aborted);
	assert.equal(existsSync(env.memory), false);
	assert.deepEqual((await f.root.context(BG)).entries, entries);
});

test("reload during review cannot write once the memory file has moved", async (t) => {
	const env = await fixture(t);
	const faux = fauxProvider();
	let f: Awaited<ReturnType<typeof env.open>>;
	faux.setResponses([async () => {
		// SOUL.org gone: June has no personal files, so memory has nowhere to go.
		await rm(env.soul);
		await f.reload();
		return response();
	}, response()]);
	f = await env.open(faux);
	await seed(f);
	assert.match(await f.compact(), /Memory destination changed during review/);
	assert.equal(existsSync(env.memory), false);
	await writeFile(env.soul, "#+TITLE: June\nBack again.\n");
	await f.reload();
	assert.match(await f.compact(), /updated/);
	assert.equal(await readFile(env.memory, "utf8"), lesson);
});

test("a restart after the file save reuses the durable proposal without repeating the write or model request", async (t) => {
	const env = await fixture(t);
	const faux = fauxProvider();
	faux.setResponses([response()]);
	let f = await env.open(faux);
	await seed(f);
	let release!: () => void;
	const paused = new Promise<void>((resolve) => { release = resolve; });
	let held = false;
	env.pause(async () => { held = true; await paused; });
	const compact = f.root.compact(undefined, BG);
	const task = await compact;
	await until(() => held);
	assert.equal(readFileSync(env.memory, "utf8"), lesson);
	const closing = f.harness.close(BG);
	release();
	await closing;
	env.pause(undefined);
	const next = fauxProvider();
	f = await env.open(next);
	f.harness.resume();
	const { outcome } = (await f.harness.waitForTask(task, BG)).state;
	assert.equal(outcome.status, "completed");
	assert.equal(next.state.callCount, 0, "the saved summary and proposal were reused");
	assert.equal(await readFile(env.memory, "utf8"), lesson);
	assert.equal((await f.harness.usage(BG)).models["faux/faux-1"]!.output > 0, true);
	assert.equal((await readdir(env.dir)).some((n) => n.includes(".compaction-")), false);
});

test("a resumed review cannot apply an old summary to a newly selected context range", async (t) => {
	const env = await fixture(t);
	const faux = fauxProvider();
	faux.setResponses([response()]);
	let f = await env.open(faux);
	await seed(f);
	let release!: () => void;
	const paused = new Promise<void>((resolve) => { release = resolve; });
	let held = false;
	env.pause(async () => { held = true; await paused; });
	const task = await f.root.compact(undefined, BG);
	await until(() => held);
	await f.append("New work that the old summary never saw. ".repeat(100));
	const entries = (await f.root.context(BG)).entries;
	const closing = f.harness.close(BG);
	release();
	await closing;
	env.pause(undefined);
	const next = fauxProvider();
	f = await env.open(next);
	f.harness.resume();
	await f.harness.waitForTask(task, BG);
	assert.match((await f.harness.snapshot(MemoryReview, f.root.id, BG))?.failure?.message ?? "", /Context changed during memory review/);
	assert.deepEqual((await f.root.context(BG)).entries, entries);
	assert.equal(next.state.callCount, 0);
	assert.equal(await readFile(env.memory, "utf8"), lesson, "a previously saved lesson is not rolled back");
});

test("threshold compaction saves memory before the blocked request; failed preservation does not loop", async (t) => {
	const env = await fixture(t);
	const faux = fauxProvider();
	faux.setResponses([response(), (ctx) => {
		assert.equal(readFileSync(env.memory, "utf8"), lesson);
		assert.match(effectivePrompt(ctx), /mistaken delegation/);
		return fauxAssistantMessage("Checked directly.");
	}]);
	const f = await env.open(faux, true);
	await f.append("I want you trusted to use judgment. " + "old context ".repeat(5000));
	await f.append("Recent context. ".repeat(100));
	const submission = await f.root.submit({ type: "input", content: "Check the host." }, BG);
	assert.equal((await submission.wait(BG)).status, "done");
	assert.equal((await f.root.context(BG)).entries.some((e) => e.kind === "pi.compaction"), true);
	assert.equal(faux.state.callCount, 2);

	faux.appendResponses([fauxAssistantMessage("invalid"), (ctx) => {
		assert.match(effectivePrompt(ctx), /Memory preservation failed/);
		return fauxAssistantMessage("Memory save failed; old context is kept.");
	}]);
	await f.append("more old context ".repeat(5000));
	await f.append("Another recent message. ".repeat(100));
	const failed = await f.root.submit({ type: "input", content: "Continue." }, BG);
	assert.equal((await failed.wait(BG)).status, "done");
	assert.equal(faux.state.callCount, 4, "decline permits one request, not another compaction in the same generation");
	assert.equal((await f.harness.snapshot(MemoryReview, f.root.id, BG))?.failure !== undefined, true);
});

test("background compaction reviews memory while a normal request can finish", async (t) => {
	const env = await fixture(t);
	const faux = fauxProvider();
	let release!: () => void;
	const paused = new Promise<void>((resolve) => { release = resolve; });
	let reviewing = false;
	const answer = async (ctx: TranscriptContext) => {
		if (JSON.stringify(ctx.messages).includes("Prepare a conversation summary and review personal memory")) {
			reviewing = true;
			await paused;
			return response();
		}
		return fauxAssistantMessage("Normal request completed.");
	};
	faux.setResponses([answer, answer]);
	const f = await env.open(faux, true, { reserveTokens: 0, backgroundTokens: 120_000 });
	await f.append("Old interaction. ".repeat(5000));
	await f.append("Recent context. ".repeat(100));
	try {
		assert.equal((await (await f.root.submit({ type: "input", content: "Continue." }, BG)).wait(BG)).status, "done");
		await until(() => reviewing);
		assert.equal(existsSync(env.memory), false, "review has not saved yet");
	} finally { release(); }
	await until(async () => (await f.root.context(BG)).entries.some((e) => e.kind === "pi.compaction"));
	assert.equal(await readFile(env.memory, "utf8"), lesson);
	assert.equal(faux.state.callCount, 2);
});

test("Telegram's manual compact uses the same memory hook without a separate review path", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const soul = join(tmp.dir, "SOUL.org");
	const memory = join(tmp.dir, "MEMORY.org");
	await writeFile(soul, "* June\nBe observant.\n");
	const faux = fauxProvider();
	faux.setResponses([response(), fauxAssistantMessage("invalid")]);
	const tg = fakeTelegram();
	const daemon = await openTestDaemon({ ...tmp, faux, telegramPort: tg.port,
		config: { soulFile: soul, memoryFile: memory, contextCap: 1000, telegram: { tokenEnv: "TG", allowedUserIds: [42] } },
		secrets: { TG: `123456:${"a".repeat(35)}` },
	});
	t.after(() => daemon.close());
	const append = async (content: string) => (await daemon.root.submit({ type: "write", entry: {
		kind: UserEntry.kind, model: [{ role: "user", content, timestamp: Date.now() }],
	} }, BG)).wait(BG);
	const compact = async (id: number) => daemon.telegram!.handleUpdate({ update_id: id, message: {
		message_id: id, date: Math.floor(Date.now() / 1000),
		chat: { id: 42, type: "private", first_name: "Jon" }, from: { id: 42, is_bot: false, first_name: "Jon" }, text: "/compact",
	} });
	await append("Old formative interaction. ".repeat(300));
	await append("Recent working context. ".repeat(300));
	await compact(1);
	await until(() => tg.sent.some((m) => m.text === "Compacted."));
	assert.equal(await readFile(memory, "utf8"), lesson);
	await append("More recent working context. ".repeat(300));
	const entries = (await daemon.root.context(BG)).entries;
	await compact(2);
	// The library has only a generic decline reply; June gets the actual cause in her next model prompt.
	await until(() => tg.sent.some((m) => m.text === "Nothing to compact."));
	assert.match((await daemon.harness.snapshot(MemoryReview, daemon.root.id, BG))?.failure?.message ?? "", /invalid JSON/);
	assert.deepEqual((await daemon.root.context(BG)).entries, entries);
	assert.equal(await readFile(memory, "utf8"), lesson);
	assert.equal(faux.state.callCount, 2);
});

test("overflow recovery also preserves memory before retrying the request", async (t) => {
	const env = await fixture(t);
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "Your input exceeds the context window of this model" }),
		response(),
		(ctx) => {
			assert.equal(readFileSync(env.memory, "utf8"), lesson);
			assert.match(effectivePrompt(ctx), /mistaken delegation/);
			return fauxAssistantMessage("Recovered after compaction.");
		},
	]);
	const f = await env.open(faux, true, { reserveTokens: 0 });
	await seed(f);
	assert.equal((await (await f.root.submit({ type: "input", content: "Continue." }, BG)).wait(BG)).status, "done");
	assert.equal(faux.state.callCount, 3);
	assert.equal((await f.root.context(BG)).entries.some((e) => e.kind === "pi.compaction"), true);
});

test("compaction keeps topic threads and journals what the journal lacks, once", async (t) => {
	const env = await fixture(t);
	const entry = { date: "2026-10-26", title: "Rough morning", text: "Jon had a rough morning with the kids and wanted to vent, not fix it." };
	const faux = fauxProvider();
	faux.setResponses([
		(ctx) => {
			const source = JSON.parse(String(ctx.messages.at(-1)!.content));
			assert.equal(source.journal, "", "a first review sees an empty journal");
			assert.ok(source.timeZone, "and the local time zone, to date entries");
			assert.match(String(ctx.messages[0]!.content), /by topic thread/);
			return fauxAssistantMessage(JSON.stringify({ summary: "Threads.", memory: null, journal: [entry] }));
		},
		(ctx) => {
			assert.match(JSON.parse(String(ctx.messages.at(-1)!.content)).journal, /Rough morning/, "a later review sees what is written");
			return fauxAssistantMessage(JSON.stringify({ summary: "Threads again.", memory: null, journal: [entry] }));
		},
	]);
	const f = await env.open(faux);
	await seed(f);
	await f.compact();
	const written = await readFile(env.journal, "utf8");
	assert.match(written, /^\* 2026\n\*\* 2026-10 October\n\*\*\* 2026-10-26 Monday\n\*\*\*\* Rough morning\nJon had a rough morning/m);
	await seed(f);
	await f.compact();
	assert.equal(faux.state.callCount, 2, "both compactions reviewed");
	assert.equal(await readFile(env.journal, "utf8"), written, "an entry already there is not written twice");
});

test("June's prompt carries the last few days' endings and says where to look further back", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const soul = join(tmp.dir, "SOUL.org");
	const journal = join(tmp.dir, "JOURNAL.org");
	await writeFile(soul, "* June\nBe observant.\n");
	const day = (date: string, end?: string) => `*** ${date}\n**** 09:00 Morning\nCoffee on ${date}.\n${end ? `\n**** Day's end\n${end}\n` : ""}`;
	await writeFile(journal, `#+TITLE: June's journal\n\n* 2026\n** 2026-10 October\n${day("2026-10-24 Saturday", "Lucy's birthday.")}\n${day("2026-10-25 Sunday", "Church and a nap.")}\n${day("2026-10-26 Monday")}\n${day("2026-10-27 Tuesday", "Meeting the boys.\n\nThe site check is still open.")}`);
	let prompt = "";
	const faux = fauxProvider();
	faux.setResponses([(ctx) => {
		prompt = (JSON.parse(effectivePrompt(ctx)) as { memory: string }).memory;
		return fauxAssistantMessage("hi");
	}]);
	const config = { soulFile: soul, memoryFile: join(tmp.dir, "MEMORY.org"), journalFile: journal, reflection: { enabled: false, quietMinutes: 60, recentDays: 2 } };
	const daemon = await openTestDaemon({ ...tmp, faux, config });
	t.after(() => daemon.close());
	await (await daemon.root.submit({ type: "input", content: "hello", requestId: "r1" }, BG)).wait(BG);
	assert.match(prompt, /Your recent days, from each night's reflection:\n- 2026-10-25 Sunday: Church and a nap\.\n- 2026-10-27 Tuesday: Meeting the boys\. The site check is still open\./);
	assert.doesNotMatch(prompt, /Lucy's birthday/, "only the last two endings");
	assert.doesNotMatch(prompt, /Coffee on/, "and never the entries themselves");
	assert.ok(prompt.includes(`rg -n -A1 "^\\*\\*\\* YYYY-MM|^\\*\\*\\*\\* Day's end"`), "with a way to skim a month");
});

test("June writes her journal with a tool, under today's date", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const soul = join(tmp.dir, "SOUL.org");
	const journal = join(tmp.dir, "JOURNAL.org");
	await writeFile(soul, "* June\nBe observant.\n");
	const faux = fauxProvider();
	faux.setResponses([
		(ctx) => {
			assert.match(effectivePrompt(ctx), /Your journal, .*JOURNAL\.org/);
			return fauxAssistantMessage([fauxToolCall("journal", { title: "Kids", text: "Jon vented about the school run.\nI listened." })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("that sounds rough"),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config: { soulFile: soul, memoryFile: join(tmp.dir, "MEMORY.org"), journalFile: journal } });
	t.after(() => daemon.close());
	await (await daemon.root.submit({ type: "input", content: "ugh, the school run", requestId: "r1" }, BG)).wait(BG);
	const today = new Date();
	const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
	assert.match(await readFile(journal, "utf8"), new RegExp(`\\*\\*\\* ${date} \\w+\\n\\*\\*\\*\\* \\d\\d:\\d\\d Kids\\nJon vented about the school run\\. I listened\\.\\n?$`));
});

test("the reflection window looks back on the day before it opened", () => {
	const night = { start: "03:00", end: "06:00" };
	assert.equal(dayFor(new Date(2026, 9, 28, 3, 30), night), "2026-10-27");
	assert.equal(dayFor(new Date(2026, 9, 28, 6, 0), night), undefined, "the end is exclusive");
	assert.equal(dayFor(new Date(2026, 9, 27, 22, 0), night), undefined);
	const late = { start: "23:30", end: "02:00" };
	assert.equal(dayFor(new Date(2026, 9, 27, 23, 45), late), "2026-10-27", "a window before midnight reflects on today");
	assert.equal(dayFor(new Date(2026, 9, 28, 1, 0), late), "2026-10-27", "and still on that day after midnight");
});

test("the nightly reflection rewrites the day, carries a lasting fact into memory, keeps what it replaced, and runs once", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const soul = join(tmp.dir, "SOUL.org");
	const memory = join(tmp.dir, "MEMORY.org");
	const journal = join(tmp.dir, "JOURNAL.org");
	await writeFile(soul, "* June\nBe observant.\n");
	await writeFile(memory, "#+TITLE: June's memory\n\n* Household\n- Lucy: the family's dog.\n");
	const day = "*** 2026-10-27 Tuesday\n**** 18:04 Meeting Lucy\nJon shared a photo of Lucy.\n\n**** 20:42 Lucy's birthday breakfast\nLucy had a sausage for her fifth birthday.";
	const after = "*** 2026-10-28 Wednesday\n**** 09:00 Morning\nCoffee.";
	await writeFile(journal, `#+TITLE: June's journal\n\n* 2026\n** 2026-10 October\n${day}\n\n${after}\n`);
	const revised = "*** 2026-10-27 Tuesday\n**** 18:04 Lucy turns five\nJon shared a photo of Lucy, who turned five on Saturday, and she had a greasy sausage for breakfast.\n\n**** Day's end\nA warm family evening.";
	const remembered = "#+TITLE: June's memory\n\n* Household\n- Lucy: the family's golden dog. Turned five on 2026-10-24.\n";
	let asked: TranscriptContext | undefined;
	const faux = fauxProvider();
	faux.setResponses([(ctx) => {
		asked = ctx;
		return fauxAssistantMessage(JSON.stringify({ day: revised, memory: remembered }));
	}]);
	const daemon = await openTestDaemon({
		...tmp,
		faux,
		config: { soulFile: soul, memoryFile: memory, journalFile: journal, reflection: { enabled: true, quietMinutes: 60, recentDays: 3 }, rhythm: { wake: "06:00", quiet: "22:00", sleep: "03:00" } },
		reflectionClock: { now: () => new Date(2026, 9, 28, 3, 30), tickMs: 50 },
	});
	t.after(() => daemon.close());
	await until(() => existsSync(join(tmp.paths.state, "reflection.json")));
	assert.match(JSON.stringify(asked!.messages.at(-1)), /Meeting Lucy/, "it reads the day being reflected on");
	assert.doesNotMatch(JSON.stringify(asked!.messages.at(-1)), /Coffee/, "and not the next day");
	assert.equal(readFileSync(journal, "utf8"), `#+TITLE: June's journal\n\n* 2026\n** 2026-10 October\n${revised}\n\n${after}\n`);
	assert.equal(readFileSync(memory, "utf8"), remembered);
	assert.equal(readFileSync(join(tmp.paths.state, "reflection", "2026-10-27.org"), "utf8"), `${day}\n`, "the day as it was is kept");
	assert.match(readFileSync(join(tmp.paths.state, "reflection", "2026-10-27.MEMORY.org"), "utf8"), /the family's dog\./, "and so is the memory it replaced");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(faux.state.callCount, 1, "one pass a night");
});

test("the nightly reflection waits while Jon is still talking, and refuses a day that lost its heading", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const soul = join(tmp.dir, "SOUL.org");
	const journal = join(tmp.dir, "JOURNAL.org");
	await writeFile(soul, "* June\nBe observant.\n");
	// A window open now, whatever the hour the test runs, and the day it looks back on.
	let clock = Date.now();
	const at = () => new Date(clock);
	const hhmm = (ms: number) => `${String(new Date(ms).getHours()).padStart(2, "0")}:${String(new Date(ms).getMinutes()).padStart(2, "0")}`;
	const reflection = { enabled: true, quietMinutes: 60, recentDays: 3 };
	const rhythm = { wake: hhmm(clock + 3 * 3_600_000), quiet: "22:00", sleep: hhmm(clock - 60_000) };
	const date = dayFor(at(), { start: rhythm.sleep, end: rhythm.wake })!;
	const text = `#+TITLE: June's journal\n\n* ${date.slice(0, 4)}\n** ${date.slice(0, 7)}\n*** ${date}\n**** 18:04 Meeting Lucy\nJon shared a photo of Lucy.\n`;
	await writeFile(journal, text);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("hi"), fauxAssistantMessage(JSON.stringify({ day: "**** Lucy\nNo heading.", memory: null }))]);
	const daemon = await openTestDaemon({
		...tmp,
		faux,
		config: { soulFile: soul, memoryFile: join(tmp.dir, "MEMORY.org"), journalFile: journal, reflection, rhythm },
		reflectionClock: { now: at, tickMs: 50 },
	});
	t.after(() => daemon.close());
	await ask(tmp.paths.socket, "still up");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(faux.state.callCount, 1, "no reflection while Jon has spoken in the last hour");
	clock += 61 * 60_000;
	await until(() => faux.state.callCount === 2);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(readFileSync(journal, "utf8"), text, "a revised day without its heading is refused");
	assert.ok(!existsSync(join(tmp.paths.state, "reflection.json")), "and the night is not marked done");
});

