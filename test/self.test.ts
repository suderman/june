import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import { ask, openTestDaemon, tempDir, until } from "./helpers.ts";

const night = { wake: "06:00", quiet: "22:00", sleep: "03:00" };
const reflection = { enabled: true, quietMinutes: 60, recentDays: 3, periods: ["week", "month"] as ("week" | "month")[] };
const journalText = `#+TITLE: June's journal

* 2026
** 2026-10 October
*** 2026-10-27 Tuesday
**** 18:04 Hockey win
Alex said the boys' team won the final.

**** Day's end
The boys won the final. I felt stoked all evening.
`;
const digest = "October was the hockey final and a lot of build work.";
const page = "* Between us\n- Alex calls the build agent \"the intern\" and so do I.\n\n* Proposals for SOUL\n- Add that I keep score of worker blunders, since it has held all month.";

async function files(t: TestContext) {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const soul = join(tmp.dir, "SOUL.org");
	const journal = join(tmp.dir, "JOURNAL.org");
	const self = join(tmp.dir, "SELF.org");
	await writeFile(soul, "* June\nBe observant.\n");
	await writeFile(journal, journalText);
	// The night of 2026-10-31 and its week are done, so the next pass is October's.
	await mkdir(tmp.paths.state, { recursive: true });
	await writeFile(join(tmp.paths.state, "reflection.json"), JSON.stringify({ day: "2026-10-31", week: "2026-10-25" }));
	const config = { soulFile: soul, memoryFile: join(tmp.dir, "MEMORY.org"), journalFile: journal, moodFile: join(tmp.dir, "MOOD.org"), selfFile: self, reflection, rhythm: night };
	return { tmp, journal, self, config, kept: join(tmp.paths.state, "reflection"), receipt: join(tmp.paths.state, "reflection.json") };
}

/** One month pass at 03:30 on 2026-11-01, answering with `answer` and recording what it was asked. */
async function monthly(t: TestContext, f: Awaited<ReturnType<typeof files>>, answer: object, at = new Date(2026, 10, 1, 3, 30)) {
	let asked: TranscriptContext | undefined;
	const faux = fauxProvider();
	faux.setResponses([(ctx) => {
		asked = ctx;
		return fauxAssistantMessage(JSON.stringify(answer));
	}]);
	const daemon = await openTestDaemon({ ...f.tmp, faux, config: f.config, reflectionClock: { now: () => at, tickMs: 50 } });
	t.after(() => daemon.close());
	await until(() => faux.state.callCount === 1);
	await new Promise((r) => setTimeout(r, 200));
	return { system: JSON.stringify(asked!.messages[0]), input: JSON.parse(String(asked!.messages.at(-1)!.content)) };
}

const receipts = (f: Awaited<ReturnType<typeof files>>) => JSON.parse(readFileSync(f.receipt, "utf8"));

test("the first month writes SELF.org from nothing, told what the page holds and that SOUL changes are proposals", async (t) => {
	const f = await files(t);
	const { system, input } = await monthly(t, f, { digest, self: `${page}\n\n` });
	assert.equal(input.period, "October 2026");
	assert.equal(input.self, null, "no page yet starts fresh");
	assert.match(input.material, /I felt stoked all evening/, "the month sees the mood sentences in each Day's end");
	assert.match(system, /\\"self\\":null/);
	assert.match(system, /It is about you, not Alex/);
	assert.match(system, /Facts and lessons about Alex stay in MEMORY\.org/);
	assert.match(system, /Revise the page, do not rewrite it/);
	assert.match(system, /When you have none yet, never answer null: write a first page/);
	assert.match(system, /never contradicts or revises it/);
	assert.match(system, /Never drift toward flattering Alex/);
	assert.match(system, /\* Proposals for SOUL/);
	assert.match(system, /Update only the digest and SELF\.org, never SOUL\.org/);
	assert.equal(readFileSync(f.self, "utf8"), `${page}\n`);
	assert.match(readFileSync(f.journal, "utf8"), /\*\*\* Month's end\nOctober was the hockey final/);
	assert.ok(!existsSync(join(f.kept, "2026-10-31.SELF.org")), "nothing to keep from an empty start");
	assert.equal(receipts(f).month, "2026-10-31");
});

test("a later month reads the page, keeps the old one, and replaces it whole", async (t) => {
	const f = await files(t);
	const before = "* Between us\n- Alex brought up chess twice.\n";
	await writeFile(f.self, before);
	const { input } = await monthly(t, f, { digest, self: page });
	assert.equal(input.self, before.trim());
	assert.equal(readFileSync(join(f.kept, "2026-10-31.SELF.org"), "utf8"), before);
	assert.equal(readFileSync(f.self, "utf8"), `${page}\n`);
});

test("a month that changed nothing leaves the page alone and keeps no copy", async (t) => {
	const f = await files(t);
	await writeFile(f.self, "* Between us\n- Steady.\n");
	await monthly(t, f, { digest, self: null });
	assert.equal(readFileSync(f.self, "utf8"), "* Between us\n- Steady.\n");
	assert.ok(!existsSync(join(f.kept, "2026-10-31.SELF.org")));
	assert.match(readFileSync(f.journal, "utf8"), /Month's end/);
	assert.equal(receipts(f).month, "2026-10-31");
});

test("a month with no digest can still revise the page", async (t) => {
	const f = await files(t);
	await monthly(t, f, { digest: null, self: page });
	assert.equal(readFileSync(f.self, "utf8"), `${page}\n`);
	assert.equal(readFileSync(f.journal, "utf8"), journalText);
	assert.equal(receipts(f).month, "2026-10-31");
});

test("a rerun of the same month keeps the page it first replaced", async (t) => {
	const f = await files(t);
	await writeFile(f.self, "* Between us\n- Rerun.\n");
	await mkdir(f.kept, { recursive: true });
	await writeFile(join(f.kept, "2026-10-31.SELF.org"), "The first copy.\n");
	await monthly(t, f, { digest, self: page });
	assert.equal(readFileSync(join(f.kept, "2026-10-31.SELF.org"), "utf8"), "The first copy.\n");
	assert.equal(readFileSync(f.self, "utf8"), `${page}\n`);
});

for (const [name, self] of [["missing", undefined], ["blank", "  \n"], ["not text", 3]] as const)
	test(`a month answer with a ${name} self writes nothing and leaves the month undone`, async (t) => {
		const f = await files(t);
		await writeFile(f.self, "* Between us\n- Steady.\n");
		await monthly(t, f, { digest, ...(self === undefined ? {} : { self }) });
		assert.equal(readFileSync(f.journal, "utf8"), journalText);
		assert.equal(readFileSync(f.self, "utf8"), "* Between us\n- Steady.\n");
		assert.equal(receipts(f).month, undefined);
	});

test("a week's pass is not asked about the page", async (t) => {
	const f = await files(t);
	await writeFile(f.receipt, JSON.stringify({ day: "2026-11-01", week: "2026-10-25", month: "2026-10-31" }));
	const { system, input } = await monthly(t, f, { digest: "A week." }, new Date(2026, 10, 2, 3, 30));
	assert.equal(input.period, "The week of 2026-10-26 to 2026-11-01");
	assert.ok(!("self" in input));
	assert.doesNotMatch(system, /SELF\.org/);
	assert.ok(!existsSync(f.self));
	assert.equal(receipts(f).week, "2026-11-01");
});

test("a Syncthing conflict copy of SELF.org stops the month before it asks", async (t) => {
	const f = await files(t);
	await writeFile(join(f.tmp.dir, "SELF.sync-conflict-20261031-000000-ABCDEFG.org"), "other");
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage(JSON.stringify({ digest, self: page }))]);
	const daemon = await openTestDaemon({ ...f.tmp, faux, config: f.config, reflectionClock: { now: () => new Date(2026, 10, 1, 3, 30), tickMs: 50 } });
	t.after(() => daemon.close());
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(faux.state.callCount, 0);
	assert.ok(!existsSync(f.self));
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
	await ask(f.tmp.paths.socket, "Who are you these days?");
	return seen;
}

test("the page sits directly after SOUL, below it in authority, with the rule on SOUL proposals", async (t) => {
	const f = await files(t);
	await writeFile(f.self, `${page}\n`);
	await writeFile(f.config.moodFile, "Composed.\n");
	const seen = await sections(t, f);
	const order = Object.keys(seen);
	assert.equal(order.indexOf("self"), order.indexOf("soul") + 1, `order was ${order.join(", ")}`);
	assert.ok(order.indexOf("self") < order.indexOf("mood"), "solid to fleeting: SOUL, SELF, then MOOD");
	const text = JSON.stringify(seen.self);
	assert.match(text, /the intern/);
	assert.match(text, /never overrides it/);
	assert.match(text, /never edit it/);
	assert.match(text, /mention a new one to them once/);
	assert.match(text, /never apply one yourself/);
});

test("without SELF.org the prompt has no page, and a conflict copy is reported", async (t) => {
	const f = await files(t);
	await writeFile(join(f.tmp.dir, "SELF.sync-conflict-20261031-000000-ABCDEFG.org"), "other");
	const seen = await sections(t, f);
	assert.ok(!("self" in seen) || !seen.self, "omitted when missing");
	assert.match(JSON.stringify(seen.memory), /SELF\.sync-conflict-20261031-000000-ABCDEFG\.org/);
});
