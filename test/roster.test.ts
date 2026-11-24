import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { applyRosterEdit, choose, computeStanding, editRosterFile, familyOf, findCard, formatCard, launchArgs, parseRoster } from "../src/roster.ts";
import { leaderboard, listRuns, recordRunEnd, recordRunStart, statsByAgent } from "../src/runs.ts";
import { tempDir } from "./helpers.ts";

const ROSTER = `#+TITLE: Roster

* Bolt
:PROPERTIES:
:HOST: kit
:HARNESS: claude
:MODEL: claude-opus-5-5
:EFFORT: high
:AVATAR: roster/bolt.png
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

test("ROSTER.org cards take their properties, keep child headings as instructions, and report what is missing", () => {
	const [bolt, rivet, broken] = parseRoster(ROSTER);
	assert.deepEqual(bolt, {
		name: "Bolt",
		slug: "bolt",
		host: "kit",
		harness: "claude",
		model: "claude-opus-5-5",
		effort: "high",
		avatar: "roster/bolt.png",
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

test("roster edits add, update, rename and remove cards while preserving preamble and untouched headings", async (t) => {
	const added = applyRosterEdit(ROSTER, { action: "save", name: "Gyro", host: "cog", harness: "agy", model: "gemini-4", effort: "medium", instructions: "Fast worker.\n\n** Notes\nKeep it short." });
	assert.equal(added.slug, "gyro");
	assert.ok(added.text.startsWith("#+TITLE: Roster\n"), "preamble kept");
	assert.ok(added.text.includes("* Rivet Jr :fast:\n"), "untouched card preserved verbatim");
	const afterAdd = parseRoster(added.text);
	assert.equal(afterAdd.length, 4);
	assert.deepEqual([afterAdd[3]!.name, afterAdd[3]!.host, afterAdd[3]!.harness, afterAdd[3]!.model, afterAdd[3]!.effort], ["Gyro", "cog", "agy", "gemini-4", "medium"]);

	const updated = applyRosterEdit(added.text, { action: "save", original: "rivet-jr", name: "Rivet", host: "kit", harness: "pi", model: "gpt-5", effort: "high", instructions: "Updated." });
	assert.equal(updated.slug, "rivet");
	assert.equal(parseRoster(updated.text).map((c) => c.slug).join(","), "bolt,rivet,broken,gyro");
	assert.equal(findCard(parseRoster(updated.text), "rivet")!.harness, "pi");

	const deleted = applyRosterEdit(updated.text, { action: "delete", slug: "broken" });
	assert.equal(deleted.slug, undefined);
	assert.equal(parseRoster(deleted.text).map((c) => c.slug).join(","), "bolt,rivet,gyro");

	assert.throws(() => applyRosterEdit(ROSTER, { action: "save", name: "Bolt", host: "kit", harness: "claude" }), /already called/);
	assert.throws(() => applyRosterEdit(ROSTER, { action: "save", name: "Bad", host: "kit", harness: "bogus" }), /harness/);
	assert.throws(() => applyRosterEdit(ROSTER, { action: "save", name: "Bad", host: "kit", harness: "claude", instructions: "* Top heading" }), /top-level/);
	assert.throws(() => applyRosterEdit(ROSTER, { action: "delete", slug: "nope" }), /no agent/);
	assert.match(formatCard({ name: "Solo", host: "kit", harness: "claude", effort: "high", instructions: "" }), /^\* Solo\n:PROPERTIES:\n:HOST: kit\n:HARNESS: claude\n:EFFORT: high\n:END:$/);

	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const file = join(tmp.dir, "ROSTER.org");
	await writeFile(file, ROSTER);
	const res = await editRosterFile(file, { action: "save", name: "Spark", host: "kit", harness: "opencode" });
	assert.equal(res.slug, "spark");
	assert.equal(findCard(parseRoster(await readFile(file, "utf8")), "spark")!.host, "kit");
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
	const standing = computeStanding([bolt!, rivet!], hosts, logins, quotas, "kit", () => true, now);
	assert.deepEqual(standing.map((s) => [s.card.slug, s.status, s.terminal, s.battery && "account" in s.battery ? [s.battery.account, s.battery.weekly] : undefined]), [
		["bolt", "busy (working)", "kit/t3", undefined],
		["rivet-jr", "idle", undefined, ["codex1", 40]],
	]);
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
