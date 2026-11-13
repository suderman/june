import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import { ask, openTestDaemon, tempDir, until } from "./helpers.ts";

const night = { wake: "06:00", quiet: "22:00", sleep: "03:00" };
const reflection = { enabled: true, quietMinutes: 60, recentDays: 3, periods: [] };
const day = "*** 2026-10-27 Tuesday\n**** 18:04 Hockey win\nAlex said the boys' team won the final.";
const revised = `${day}\n\n**** Day's end\nThe boys won the final. I felt stoked all evening.`;
const journalText = `#+TITLE: June's journal\n\n* 2026\n** 2026-10 October\n${day}\n`;
const woke = "I wake up stoked: the boys won their final and Alex was proud.\n\n- Still side-eyeing the worker that broke the build.";

async function files(t: TestContext) {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const soul = join(tmp.dir, "SOUL.org");
	const journal = join(tmp.dir, "JOURNAL.org");
	const mood = join(tmp.dir, "MOOD.org");
	await writeFile(soul, "* June\nBe observant.\n");
	await writeFile(journal, journalText);
	const config = { soulFile: soul, memoryFile: join(tmp.dir, "MEMORY.org"), journalFile: journal, moodFile: mood, reflection, rhythm: night };
	return { tmp, journal, mood, config, kept: join(tmp.paths.state, "reflection") };
}

/** One nightly pass at 03:30 after 2026-10-27, answering with `answer` and recording what it was asked. */
async function nightly(t: TestContext, f: Awaited<ReturnType<typeof files>>, answer: object) {
	let asked: TranscriptContext | undefined;
	const faux = fauxProvider();
	faux.setResponses([(ctx) => {
		asked = ctx;
		return fauxAssistantMessage(JSON.stringify(answer));
	}]);
	const daemon = await openTestDaemon({ ...f.tmp, faux, config: f.config, reflectionClock: { now: () => new Date(2026, 9, 28, 3, 30), tickMs: 50 } });
	t.after(() => daemon.close());
	await until(() => faux.state.callCount === 1);
	await new Promise((r) => setTimeout(r, 200));
	return { system: JSON.stringify(asked!.messages[0]), input: JSON.parse(String(asked!.messages.at(-1)!.content)) };
}

test("the first night writes MOOD.org from nothing, told what moves June and to close the day with how she felt", async (t) => {
	const f = await files(t);
	const { system, input } = await nightly(t, f, { day: revised, memory: null, mood: `${woke}\n\n` });
	assert.equal(input.mood, null, "no mood yet starts fresh");
	assert.match(system, /\\"mood\\":\\"\.\.\.\\"/);
	assert.match(system, /one plain sentence on how you felt that day/);
	assert.match(system, /Moods shift, they do not reset/);
	assert.match(system, /never despair or self-pity/);
	assert.match(system, /dark flash of jealousy/);
	assert.match(system, /never an open task or a to-do list/, "threads are feelings, not tasks");
	assert.match(system, /Keep at most three/);
	assert.match(system, /never earns approval by flattery/);
	assert.match(system, /the journal day, MEMORY\.org, and MOOD\.org, never SOUL\.org/);
	assert.equal(readFileSync(f.mood, "utf8"), `${woke}\n`);
	assert.ok(!existsSync(join(f.kept, "2026-10-27.MOOD.org")), "nothing to keep from an empty start");
	assert.equal(JSON.parse(readFileSync(join(f.tmp.paths.state, "reflection.json"), "utf8")).day, "2026-10-27");
});

test("a later night reads last night's mood, keeps it, and replaces it whole", async (t) => {
	const f = await files(t);
	const before = "Composed and a little smug.\n\n- Looking forward to the hockey final.\n";
	await writeFile(f.mood, before);
	const { input } = await nightly(t, f, { day: revised, memory: null, mood: woke });
	assert.equal(input.mood, before.trim(), "last night's mood is an input, for inertia");
	assert.equal(readFileSync(join(f.kept, "2026-10-27.MOOD.org"), "utf8"), before);
	assert.equal(readFileSync(f.mood, "utf8"), `${woke}\n`);
});

test("a rerun of the same night keeps the mood it first replaced", async (t) => {
	const f = await files(t);
	const before = "Composed.\n";
	await writeFile(f.mood, before);
	await mkdir(f.kept, { recursive: true });
	await writeFile(join(f.kept, "2026-10-27.MOOD.org"), "The first copy.\n");
	await nightly(t, f, { day: revised, memory: null, mood: woke });
	assert.equal(readFileSync(join(f.kept, "2026-10-27.MOOD.org"), "utf8"), "The first copy.\n");
	assert.equal(readFileSync(f.mood, "utf8"), `${woke}\n`);
});

for (const [name, mood] of [["missing", undefined], ["null", null], ["blank", "  \n"], ["not text", 3]] as const)
	test(`an answer with a ${name} mood writes nothing and leaves the night undone`, async (t) => {
		const f = await files(t);
		await writeFile(f.mood, "Composed.\n");
		await nightly(t, f, { day: revised, memory: null, ...(mood === undefined ? {} : { mood }) });
		assert.equal(readFileSync(f.journal, "utf8"), journalText);
		assert.equal(readFileSync(f.mood, "utf8"), "Composed.\n");
		assert.ok(!existsSync(join(f.tmp.paths.state, "reflection.json")));
	});

test("a Syncthing conflict copy of MOOD.org stops the pass before it asks", async (t) => {
	const f = await files(t);
	await writeFile(join(f.tmp.dir, "MOOD.sync-conflict-20261027-000000-ABCDEFG.org"), "other");
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage(JSON.stringify({ day: revised, memory: null, mood: woke }))]);
	const daemon = await openTestDaemon({ ...f.tmp, faux, config: f.config, reflectionClock: { now: () => new Date(2026, 9, 28, 3, 30), tickMs: 50 } });
	t.after(() => daemon.close());
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(faux.state.callCount, 0);
	assert.ok(!existsSync(f.mood));
	assert.equal(readFileSync(f.journal, "utf8"), journalText);
});

/** The system prompt's sections, in order, for one ordinary turn. */
async function sections(t: TestContext, f: Awaited<ReturnType<typeof files>>): Promise<Record<string, string>> {
	let seen: Record<string, string> = {};
	const faux = fauxProvider();
	faux.setResponses([(ctx) => {
		seen = Object.assign({}, ...ctx.messages.filter((m) => m.role === "system").map((m) => (m as { sections?: object }).sections));
		return fauxAssistantMessage("ok");
	}]);
	const daemon = await openTestDaemon({ ...f.tmp, faux, config: { ...f.config, reflection: { ...reflection, enabled: false } } });
	t.after(() => daemon.close());
	await ask(f.tmp.paths.socket, "How are you feeling?");
	return seen;
}

test("the mood sits just before now, says today outweighs it, and how to answer how she feels", async (t) => {
	const f = await files(t);
	await writeFile(f.mood, `${woke}\n`);
	const seen = await sections(t, f);
	const order = Object.keys(seen);
	assert.equal(order.indexOf("mood"), order.indexOf("now") - 1, `order was ${order.join(", ")}`);
	assert.ok(order.indexOf("memory") < order.indexOf("mood"));
	const text = JSON.stringify(seen.mood);
	assert.match(text, /side-eyeing the worker/);
	assert.match(text, /What happens today outweighs it/);
	assert.match(text, /never facts, task status, or what you record/);
	assert.match(text, /answer honestly and briefly/);
	assert.match(text, /one line about yourself, then turn back to them/);
	assert.match(text, /never edit it/);
});

test("without MOOD.org the prompt has no mood, and a conflict copy is reported", async (t) => {
	const f = await files(t);
	await writeFile(join(f.tmp.dir, "MOOD.sync-conflict-20261027-000000-ABCDEFG.org"), "other");
	const seen = await sections(t, f);
	assert.ok(!("mood" in seen) || !seen.mood, "omitted when missing");
	assert.match(JSON.stringify(seen.memory), /MOOD\.sync-conflict-20261027-000000-ABCDEFG\.org/);
});
