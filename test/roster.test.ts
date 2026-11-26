import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { HARNESSES as HARNESS_TABLE, HARNESS_NAMES, LAUNCHABLE_HARNESSES } from "../desktop/harnesses.mjs";
import { HARNESSES as ACCOUNT_HARNESSES } from "../src/accounts.ts";
import { assignRosterAgents, batteryOf, choose, computeStanding, editClanker, familyOf, findCard, formatCard, harnessBatteries, launchArgs, launchInstructions, MEMORY_CHARS, parseRoster, readClankers } from "../src/roster.ts";
import { LAUNCHABLE } from "../src/tools/dispatch.ts";
import { activeRunsByTask, leaderboard, listRuns, recordRunEnd, recordRunStart, statsByAgent } from "../src/runs.ts";
import { tempDir } from "./helpers.ts";

const ROSTER = `#+TITLE: Roster

* Bolt
:PROPERTIES:
:HOST: kit
:HARNESS: claude
:MODEL: claude-opus-5-5
:EFFORT: high
:END:
Careful and thorough.

** Habits
Reads before editing.

* Rivet Jr :fast:
:PROPERTIES:
:HOST: kit
:HARNESS: codex
:EFFORT: max
:END:
Quick fixes.

* Broken
:PROPERTIES:
:HARNESS: gemini
:EFFORT: huge
:END:
`;

test("cards take their properties, keep child headings as instructions, and report what is missing", () => {
	const [bolt, rivet, broken] = parseRoster(ROSTER);
	assert.deepEqual(bolt, {
		name: "Bolt",
		slug: "bolt",
		host: "kit",
		harness: "claude",
		model: "claude-opus-5-5",
		effort: "high",
		instructions: "Careful and thorough.\n\n** Habits\nReads before editing.",
		problems: [],
	});
	assert.deepEqual([rivet!.name, rivet!.slug, rivet!.harness, rivet!.model, rivet!.problems], ["Rivet Jr", "rivet-jr", "codex", undefined, []]);
	assert.deepEqual(broken!.problems, [":HARNESS: gemini is not one of claude, codex, pi, opencode, agy", "no :HOST:", ":EFFORT: huge is not one of low, medium, high, xhigh, max"]);
	assert.equal(findCard(parseRoster(ROSTER), "RIVET JR")?.slug, "rivet-jr");
});

test("each harness starts with the card's model, effort and instructions in its own flags", () => {
	const card = (harness: string, extra = {}) => ({ name: "Bolt", slug: "bolt", host: "kit", harness: harness as any, model: "m-1", effort: "max", instructions: "Be careful.", problems: [], ...extra });
	assert.deepEqual(launchArgs(card("claude"), "go"), ["--model", "m-1", "--effort", "max", "--append-system-prompt", "Be careful.", "--name", "Bolt", "go"]);
	assert.deepEqual(launchArgs(card("codex")), ["--model", "m-1", "-c", 'model_reasoning_effort="xhigh"', "-c", 'developer_instructions="Be careful."']);
	assert.deepEqual(launchArgs(card("pi", { model: "gpt-6.2-sol" })), ["--model", "openai-codex/gpt-6.2-sol", "--thinking", "max", "--append-system-prompt", "Be careful.", "--name", "Bolt"]);
	assert.deepEqual(launchArgs(card("pi", { model: "cliproxyapi/gpt-6.2-sol", effort: undefined, instructions: "" })), ["--model", "cliproxyapi/gpt-6.2-sol", "--name", "Bolt"]);
	assert.deepEqual(launchArgs(card("opencode", { model: "gpt-6.2-sol" }), "go"), ["--model", "openai/gpt-6.2-sol", "--prompt", "Be careful.\n\ngo"]);
	assert.deepEqual(launchArgs(card("agy"), "go"), ["--model", "m-1", "--effort", "max", "--prompt-interactive", "Be careful.\n\ngo"]);
	assert.deepEqual(launchArgs(card("agy")), ["--model", "m-1", "--effort", "max"]);
});

test("the first available candidate wins unless a later one would otherwise lose quota at a reset within hours", () => {
	const bolt = { name: "bolt", available: true, reason: "idle", weekly: 60, hours: 90, rate: 0.67 };
	const gyro = { name: "gyro", available: true, reason: "idle", weekly: 40, hours: 3, rate: 13.3 };
	const rivet = { name: "rivet", available: true, reason: "idle", weekly: 20, hours: 5, rate: 4 };
	assert.deepEqual(choose([bolt, rivet]), { chosen: "rivet", why: "rivet goes ahead of bolt: 20% would be lost at its reset in 5h" });
	assert.equal(choose([bolt, rivet, gyro]).chosen, "gyro", "the fastest-expiring later candidate goes");
	assert.equal(choose([{ ...bolt, hours: 2 }, gyro]).chosen, "bolt", "the first keeps its turn when it is expiring too");
	assert.equal(choose([bolt, { ...gyro, weekly: 3 }]).chosen, "bolt", "a few percent is not worth jumping the order");
	assert.equal(choose([bolt, { ...gyro, hours: 8 }]).chosen, "bolt", "eight hours away is not yet expiring");
	assert.equal(choose([{ ...bolt, available: false, reason: "busy (working)" }, { name: "sprocket", available: true, reason: "idle" }]).chosen, "sprocket");
	assert.deepEqual(choose([{ name: "x", available: false, reason: "busy (working)" }]), { why: "x: busy (working)" });
	const card = { name: "Gyro", slug: "gyro", harness: "agy" as const, model: "gemini-4-neon", instructions: "", problems: [] };
	assert.match("Gemini Models", familyOf(card)!);
	assert.equal(familyOf({ ...card, harness: "claude" }), undefined);
});

test("clankers are folders: the folder is the slug, CARD.org the card, and a bad folder says what is wrong", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const card = (slug: string, text: string) => mkdir(join(tmp.dir, "clankers", slug), { recursive: true }).then(() => writeFile(join(tmp.dir, "clankers", slug, "CARD.org"), text));
	assert.deepEqual(readClankers(tmp.dir), [], "no clankers folder, no clankers");
	await card("pax", "#+TITLE: Pax\n\n* Pax\n:PROPERTIES:\n:HOST: kit\n:HARNESS: claude\n:EFFORT: high\n:END:\nWrites code.\n");
	await card("odd", "* Someone Else\n:PROPERTIES:\n:HOST: kit\n:HARNESS: pi\n:END:\n");
	await mkdir(join(tmp.dir, "clankers", "empty"));
	await mkdir(join(tmp.dir, "clankers", ".destroyed", "old-2026-01-01"), { recursive: true });
	const [empty, odd, pax] = readClankers(tmp.dir);
	assert.deepEqual([pax!.name, pax!.slug, pax!.host, pax!.harness, pax!.effort, pax!.instructions, pax!.dir, pax!.problems], ["Pax", "pax", "kit", "claude", "high", "Writes code.", join(tmp.dir, "clankers", "pax"), []]);
	assert.deepEqual([odd!.slug, odd!.problems], ["odd", ["its heading names Someone Else, but its folder is odd"]]);
	assert.deepEqual([empty!.slug, empty!.problems], ["empty", ["CARD.org has no heading"]]);
	assert.equal(readClankers(tmp.dir).length, 3, "dot folders are not clankers");
});

test("a clanker's memory follows its directives at launch, newest lessons kept when it grows long", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const dir = join(tmp.dir, "clankers", "pax");
	await mkdir(dir, { recursive: true });
	const card = { name: "Pax", slug: "pax", host: "kit", harness: "claude" as const, instructions: "Writes code.", dir, problems: [] };
	assert.equal(launchInstructions({ ...card, dir: undefined }), "Writes code.", "a card without a folder has only its directives");
	assert.match(launchInstructions(card), /^Writes code\.\n\nYour memory is .*clankers\/pax\/MEMORY\.org\. It holds nothing yet\.\n\nBefore you finish, add each lesson/);
	await writeFile(join(dir, "MEMORY.org"), "#+TITLE: Pax's memory\n\n- Run the typecheck before tests.\n");
	const text = launchInstructions(card);
	assert.match(text, /holds what you learned in earlier sessions:\n\n#\+TITLE: Pax's memory\n\n- Run the typecheck before tests\.\n\nBefore you finish/);
	assert.equal(launchArgs(card, "go")[launchArgs(card, "go").indexOf("--append-system-prompt") + 1], text, "the harness gets directives and memory");
	await writeFile(join(dir, "MEMORY.org"), `- first lesson\n${"- filler lesson\n".repeat(MEMORY_CHARS / 10)}- newest lesson\n`);
	const long = launchInstructions(card);
	assert.ok(long.includes("- newest lesson") && !long.includes("- first lesson") && long.includes("[older lessons left out"), "the oldest end is left out");
});

test("clanker edits create, update, rename and destroy folders, keeping memory and archiving instead of deleting", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "clankers");
	assert.deepEqual(editClanker(tmp.dir, { action: "save", name: "cid", host: "cog", harness: "claude", model: "claude-opus-5-5", effort: "high", instructions: "Writes code.\n\n** Notes\nKeep it short." }), { slug: "cid" });
	assert.equal(await readFile(join(root, "cid", "CARD.org"), "utf8"), "* cid\n:PROPERTIES:\n:HOST: cog\n:HARNESS: claude\n:MODEL: claude-opus-5-5\n:EFFORT: high\n:END:\nWrites code.\n\n** Notes\nKeep it short.\n");
	assert.match(await readFile(join(root, "cid", "MEMORY.org"), "utf8"), /^#\+TITLE: cid's memory\n/);
	await writeFile(join(root, "cid", "MEMORY.org"), "- a lesson\n");
	await writeFile(join(root, "cid", "CARD.org"), "#+TITLE: Cid\n\n" + (await readFile(join(root, "cid", "CARD.org"), "utf8")));

	assert.deepEqual(editClanker(tmp.dir, { action: "save", original: "cid", name: "sid", host: "kit", harness: "pi", instructions: "Updated." }), { slug: "sid" });
	assert.equal(await readFile(join(root, "sid", "CARD.org"), "utf8"), "#+TITLE: Cid\n\n* sid\n:PROPERTIES:\n:HOST: kit\n:HARNESS: pi\n:END:\nUpdated.\n", "text above the heading is kept");
	assert.equal(await readFile(join(root, "sid", "MEMORY.org"), "utf8"), "- a lesson\n", "a rename keeps the clanker's memory");
	assert.deepEqual(readClankers(tmp.dir).map((c) => c.slug), ["sid"]);

	editClanker(tmp.dir, { action: "save", name: "pax", host: "kit", harness: "claude" });
	assert.throws(() => editClanker(tmp.dir, { action: "save", name: "Pax", host: "kit", harness: "claude" }), /already called/);
	assert.throws(() => editClanker(tmp.dir, { action: "save", original: "pax", name: "sid", host: "kit", harness: "claude" }), /already called/);
	assert.throws(() => editClanker(tmp.dir, { action: "save", name: "Bad", host: "kit", harness: "bogus" }), /harness/);
	assert.throws(() => editClanker(tmp.dir, { action: "save", name: "Bad", host: "kit", harness: "claude", instructions: "* Top heading" }), /top-level/);
	assert.throws(() => editClanker(tmp.dir, { action: "save", name: "", host: "kit", harness: "claude" }), /name is required/);

	const day = new Date(2026, 10, 26);
	assert.deepEqual(editClanker(tmp.dir, { action: "delete", slug: "sid" }, day), {});
	editClanker(tmp.dir, { action: "save", name: "sid", host: "kit", harness: "pi" });
	editClanker(tmp.dir, { action: "delete", slug: "sid" }, day);
	assert.deepEqual((await readdir(join(root, ".destroyed"))).sort(), ["sid-2026-11-26", "sid-2026-11-26-2"]);
	assert.equal(await readFile(join(root, ".destroyed", "sid-2026-11-26", "MEMORY.org"), "utf8"), "- a lesson\n", "a destroyed clanker's folder is archived whole");
	assert.deepEqual(readClankers(tmp.dir).map((c) => c.slug), ["pax"]);
	assert.throws(() => editClanker(tmp.dir, { action: "delete", slug: "nope" }), /no clanker/);
	assert.match(formatCard({ name: "Solo", host: "kit", harness: "claude", effort: "high", instructions: "" }), /^\* Solo\n:PROPERTIES:\n:HOST: kit\n:HARNESS: claude\n:EFFORT: high\n:END:$/);
});

test("computeStanding combines roster cards, live workers, and account battery", () => {
	const [bolt, rivet] = parseRoster(ROSTER);
	const now = Date.UTC(2026, 10, 23, 12);
	const hosts = new Map([
		["kit", [{ host: "kit", terminal: "t3", agent: "claude", status: "working", cwd: "/w", task: "t1", rosterAgent: "bolt" }]],
	]);
	const logins = [
		{ name: "claude1", harness: "claude" as const, provider: "anthropic" as const, number: 1, label: "home", loggedIn: true, problems: [] },
		{ name: "codex1", harness: "codex" as const, provider: "openai" as const, number: 1, label: "home", loggedIn: true, problems: [] },
	];
	const quotas = [
		{ provider: "anthropic" as const, number: 1, fetched: Math.floor(now / 1000), windows: [{ name: "weekly", remaining: 75, resetAt: Math.floor((now + 7_200_000) / 1000) }] },
		{ provider: "openai" as const, number: 1, fetched: Math.floor(now / 1000), windows: [{ name: "weekly", remaining: 40, resetAt: Math.floor((now + 36_000_000) / 1000) }] },
	];
	const cid = { ...bolt!, name: "cid", slug: "cid", host: "cog" };
	hosts.set("cog", []);
	const standing = computeStanding([bolt!, rivet!, cid], hosts, logins, quotas, "kit", () => true, now);
	assert.deepEqual(standing.map((s) => [s.card.slug, s.status, s.terminal, s.battery && "account" in s.battery ? [s.battery.account, s.battery.weekly] : undefined]), [
		["bolt", "busy (working)", "kit/t3", undefined],
		["rivet-jr", "idle", undefined, ["codex1", 40]],
		["cid", "idle", undefined, ["claude1", 75]],
	], "a clanker on another host shows the daemon's reading of the same accounts");
});

test("computeStanding shares Antigravity pools across same-group specialists and isolates Antigravity Claude from native Claude", () => {
	const now = Date.UTC(2026, 10, 23, 12);
	const cards = parseRoster(`
* NativeClaude
:PROPERTIES:
:HOST: kit
:HARNESS: claude
:MODEL: claude-opus-5-5
:END:

* Neon
:PROPERTIES:
:HOST: kit
:HARNESS: agy
:MODEL: gemini-4-neon
:END:

* Argon
:PROPERTIES:
:HOST: kit
:HARNESS: agy
:MODEL: argon
:END:

* AgyClaude
:PROPERTIES:
:HOST: kit
:HARNESS: agy
:MODEL: claude-opus-5-5
:END:

* VanishedPool
:PROPERTIES:
:HOST: kit
:HARNESS: agy
:MODEL: mystery-promo
:END:
`);
	const hosts = new Map([["kit", []]]);
	const logins = [
		{ name: "claude1", harness: "claude" as const, provider: "anthropic" as const, number: 1, loggedIn: true, problems: [] },
		{ name: "agy1", harness: "agy" as const, provider: "google" as const, number: 1, loggedIn: true, problems: [] },
	];
	const quotas = [
		{
			provider: "anthropic" as const,
			number: 1,
			fetched: Math.floor(now / 1000),
			windows: [{ name: "Weekly", remaining: 0, seconds: 604800, resetAt: Math.floor((now + 48 * 3600_000) / 1000) }],
		},
		{
			provider: "google" as const,
			number: 1,
			fetched: Math.floor(now / 1000),
			groups: [
				{ name: "Gemini Models", models: ["Gemini 4 Neon", "Gemini 4 Argon"] },
				{ name: "Claude and GPT models", models: ["Claude Opus 5.5", "GPT-OSS 120B"] },
			],
			windows: [
				{ name: "Weekly", remaining: 0, seconds: 604800, resetAt: Math.floor((now + 48 * 3600_000) / 1000), group: "Gemini Models" },
				{ name: "Weekly", remaining: 58, seconds: 604800, resetAt: Math.floor((now + 48 * 3600_000) / 1000), group: "Claude and GPT models" },
			],
		},
	];
	const standing = computeStanding(cards, hosts, logins, quotas, "kit", () => false, now);
	const bySlug = new Map(standing.map((s) => [s.card.slug, s.battery]));
	// Native Claude spent does not affect Antigravity Claude.
	assert.deepEqual(bySlug.get("nativeclaude"), { reason: "claude1: weekly at 0%" });
	assert.equal((bySlug.get("agyclaude") as { account: string; weekly: number }).weekly, 58);
	// Neon and Argon share the exhausted Gemini Models pool.
	assert.deepEqual(bySlug.get("neon"), { reason: "agy1: weekly at 0%" });
	assert.deepEqual(bySlug.get("argon"), { reason: "agy1: weekly at 0%" });
	// Unknown model fails closed rather than borrowing Antigravity Claude's 58%.
	assert.deepEqual(bySlug.get("vanishedpool"), { reason: "agy1: no quota group for mystery-promo" });
});

test("run history records starts and endings in june.sqlite and ranks agents on the leaderboard", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const db = join(tmp.dir, "june.sqlite");
	assert.deepEqual(leaderboard(db), [], "missing db returns empty leaderboard");
	assert.deepEqual(listRuns(db), []);

	const t0 = Date.UTC(2026, 10, 23, 10, 0);
	recordRunStart(db, { run: "r1", taskId: "id:1", taskTitle: "Fix login", agent: "bolt", harness: "claude", host: "kit", model: "opus", startedAt: t0 });
	recordRunEnd(db, { run: "r1", outcome: "done", endedAt: t0 + 120_000, note: "All green" });
	recordRunStart(db, { run: "r2", taskId: "id:2", taskTitle: "Write docs", agent: "bolt", harness: "claude", host: "kit", startedAt: t0 + 200_000 });
	recordRunEnd(db, { run: "r2", outcome: "handoff", endedAt: t0 + 260_000, switches: 1, note: "out of quota" });
	recordRunStart(db, { run: "r3", taskId: "id:2", taskTitle: "Write docs", agent: "rivet", harness: "codex", host: "kit", startedAt: t0 + 270_000 });
	recordRunEnd(db, { run: "r3", outcome: "eval", endedAt: t0 + 390_000 });
	// An end without a prior start still records when taskId and agent are given.
	recordRunEnd(db, { run: "r4", taskId: "id:3", taskTitle: "Legacy finish", agent: "rivet", outcome: "done", startedAt: t0 + 400_000, endedAt: t0 + 460_000 });

	const board = leaderboard(db);
	assert.deepEqual(board.map((b) => [b.rank, b.agent, b.runs, b.completed, b.handoffs, b.avgDurationMs]), [
		[1, "rivet", 2, 2, 0, 90_000],
		[2, "bolt", 2, 1, 1, 90_000],
	]);
	assert.deepEqual(listRuns(db, { agent: "bolt" }).map((r) => [r.id, r.outcome, r.switches]), [["r2", "handoff", 1], ["r1", "done", 0]]);
	const { stats, recent } = statsByAgent(db, 2);
	assert.equal(stats.get("rivet")!.rank, 1);
	assert.equal(recent.get("rivet")!.length, 2);
});

test("desktop/harnesses.mjs is valid strict JSON for Emacs and drives accounts and dispatch", async () => {
	const text = await readFile(new URL("../desktop/harnesses.mjs", import.meta.url), "utf8");
	const m = /^export const HARNESSES = (\{[\s\S]*?\n\});/m.exec(text);
	assert.ok(m, "HARNESSES export must remain a strict JSON object literal for org-dispatch.el");
	assert.deepEqual(JSON.parse(m[1]!), HARNESS_TABLE);
	assert.deepEqual(Object.keys(ACCOUNT_HARNESSES), HARNESS_NAMES);
	assert.deepEqual(LAUNCHABLE, LAUNCHABLE_HARNESSES);
});

test("assignRosterAgents and activeRunsByTask link unlabelled dispatched workers without claiming plain harness runs", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const db = join(tmp.dir, "june.sqlite");
	recordRunStart(db, { run: "r1", taskId: "task-bolt", taskTitle: "Fix auth", agent: "bolt", harness: "claude", host: "kit", startedAt: 1000 });
	recordRunStart(db, { run: "r2", taskId: "task-done", taskTitle: "Old task", agent: "rivet-jr", harness: "codex", host: "kit", startedAt: 2000 });
	recordRunEnd(db, { run: "r2", outcome: "done", endedAt: 3000 });
	const running = activeRunsByTask(db);
	assert.equal(running.get("task-bolt")?.agent, "bolt");
	assert.equal(running.get("task-done"), undefined);

	const cards = parseRoster(`${ROSTER}\n* CogBot\n:PROPERTIES:\n:HOST: cog\n:HARNESS: pi\n:END:\n`);
	const workers = [
		{ host: "kit", terminal: "t1", agent: "claude", status: "working", cwd: "/w", task: "task-bolt" },
		{ host: "kit", terminal: "t2", agent: "codex", status: "working", cwd: "/w", task: "task-rivet" },
		{ host: "kit", terminal: "t3", agent: "pi", status: "working", cwd: "/w", task: "task-plain" },
		{ host: "cog", terminal: "t4", agent: "claude", status: "working", cwd: "/w", task: "task-bolt" },
		{ host: "cog", terminal: "t5", agent: "pi", status: "done", cwd: "/w", task: "task-cog", rosterAgent: "cogbot" },
	];
	const enriched = assignRosterAgents(cards, workers, {
		taskAgent: (w) => (w.task === "task-rivet" ? "rivet-jr" : w.task === "task-plain" ? "pi" : undefined),
		runAgent: (id) => running.get(id)?.agent,
	});
	assert.deepEqual(enriched.map((w) => [w.terminal, w.rosterAgent]), [
		["t1", "bolt"],
		["t2", "rivet-jr"],
		["t3", undefined],
		["t4", undefined],
		["t5", "cogbot"],
	]);
	// On a remote host (cog), a finished terminal (status "done") does not keep CogBot WORKING.
	const byHost = new Map([["kit", enriched.filter((w) => w.host === "kit")], ["cog", enriched.filter((w) => w.host === "cog")]]);
	const standing = computeStanding(cards, byHost, [], [], "kit", (id, host, status) => (host === "kit" ? id === "task-bolt" || id === "task-rivet" : status === "working"));
	const bySlug = new Map(standing.map((s) => [s.card.slug, [s.status, s.terminal]]));
	assert.deepEqual(bySlug.get("bolt"), ["busy (working)", "kit/t1"]);
	assert.deepEqual(bySlug.get("rivet-jr"), ["busy (working)", "kit/t2"]);
	assert.deepEqual(bySlug.get("cogbot"), ["idle", undefined]);
});

test("each harness with a login gets the battery a raw session would spend, in the shared table's order", () => {
	const now = Date.UTC(2026, 10, 23, 12);
	const logins = [
		{ name: "codex1", harness: "codex" as const, provider: "openai" as const, number: 1, label: "home", loggedIn: true, problems: [] },
		{ name: "claude1", harness: "claude" as const, provider: "anthropic" as const, number: 1, label: "home", loggedIn: true, problems: [] },
		{ name: "pi1", harness: "pi" as const, provider: "openai" as const, number: 2, label: "home", loggedIn: false, problems: [] },
	];
	const quotas = [{ provider: "anthropic" as const, number: 1, fetched: Math.floor(now / 1000), windows: [{ name: "weekly", remaining: 75, resetAt: Math.floor((now + 7_200_000) / 1000) }] }];
	const rows = harnessBatteries(logins, quotas, now);
	assert.deepEqual(rows.map((r) => r.harness), ["claude", "codex"], "signed-in harnesses only, claude first as the table lists it");
	assert.deepEqual("account" in rows[0]!.battery ? [rows[0]!.battery.account, rows[0]!.battery.weekly] : rows[0]!.battery, ["claude1", 75]);
	assert.ok("reason" in rows[1]!.battery, "a harness whose quota is unread says why");
	assert.deepEqual(batteryOf("agy", logins, quotas, now), { reason: "no agy login here" });
});
