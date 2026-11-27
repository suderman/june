import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { WebSocket } from "ws";
import { promptFiles } from "../src/config.ts";
import { renderTeam } from "../src/prompt.ts";
import { Client, type Reply } from "../src/protocol.ts";
import { editClanker, editClankerMemory, parseHosts, readClankerMemory, readClankers } from "../src/roster.ts";
import { leaderboard, levelOf, listRuns, rateRun, recordRunEnd, recordRunStart, runXp } from "../src/runs.ts";
import { Herdr } from "../src/tools/herdr.ts";
import { createTeamExtension } from "../src/tools/team.ts";
import { ask, openTestDaemon, tempDir, testConfig, until } from "./helpers.ts";

test("HOSTS.org parses one heading per machine and ignores duplicates", () => {
	const hosts = parseHosts(`#+TITLE: Hosts

* kit :desktop:
Always-on desktop with GPU and ComfyUI.

* cog
Portable laptop, often asleep.

* kit
Duplicate ignored.
`);
	assert.deepEqual(hosts, [
		{ name: "kit", slug: "kit", notes: "Always-on desktop with GPU and ComfyUI." },
		{ name: "cog", slug: "cog", notes: "Portable laptop, often asleep." },
	]);
});

test("clanker memory supports add, dedup, remove, replace, and refuses when a conflict copy exists", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	editClanker(tmp.dir, { action: "save", name: "pax", host: "kit", harness: "claude", model: "claude-opus-5-5", effort: "high", instructions: "Writes code." });

	const first = editClankerMemory(tmp.dir, { clanker: "pax", action: "add", lesson: "- Always run typecheck before commit." });
	assert.equal(first.added, true);
	assert.deepEqual(first.lessons, ["Always run typecheck before commit."]);

	const dup = editClankerMemory(tmp.dir, { clanker: "pax", action: "add", lesson: "Always run typecheck before commit." });
	assert.equal(dup.added, false);
	assert.equal(dup.count, 1);

	editClankerMemory(tmp.dir, { clanker: "pax", action: "add", lesson: "Check Syncthing conflicts before editing Org." });
	const dropped = editClankerMemory(tmp.dir, { clanker: "pax", action: "remove", match: "Syncthing" });
	assert.equal(dropped.removed, 1);
	assert.deepEqual(dropped.lessons, ["Always run typecheck before commit."]);

	const replaced = editClankerMemory(tmp.dir, { clanker: "pax", action: "replace", lessons: ["Lesson one.", "Lesson two.", "Lesson one."] });
	assert.deepEqual(replaced.lessons, ["Lesson one.", "Lesson two."]);

	const card = readClankers(tmp.dir)[0]!;
	await writeFile(join(card.dir!, "MEMORY.sync-conflict-20261127-010000-ABCDEFG.org"), "conflict");
	const mem = readClankerMemory(card);
	assert.equal(mem.conflict, "MEMORY.sync-conflict-20261127-010000-ABCDEFG.org");
	assert.throws(() => editClankerMemory(tmp.dir, { clanker: "pax", action: "add", lesson: "blocked" }), /Syncthing conflict/);
});

test("runs XP, levels, ratings, model breakdown, and legacy unmigrated SQLite tables work cleanly", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);

	assert.equal(runXp({ outcome: "done", rating: "good" }), 40);
	assert.equal(runXp({ outcome: "eval", rating: "poor" }), 0);
	assert.equal(runXp({ outcome: "parked" }), -15);
	assert.deepEqual(levelOf(0), { level: 1, title: "rookie", xp: 0, nextLevelXp: 50 });
	assert.deepEqual(levelOf(50), { level: 2, title: "hand", xp: 50, nextLevelXp: 125 });
	assert.deepEqual(levelOf(250), { level: 4, title: "veteran", xp: 250, nextLevelXp: 450 });
	assert.deepEqual(levelOf(1650), { level: 8, title: "legend", xp: 1650, nextLevelXp: 2150 });

	// Simulate an existing pre-migration database without rating columns.
	const db = join(tmp.dir, "june.sqlite");
	const raw = new DatabaseSync(db);
	raw.exec(`CREATE TABLE agent_runs (
		id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_title TEXT NOT NULL DEFAULT '',
		agent TEXT NOT NULL, harness TEXT NOT NULL DEFAULT '', host TEXT NOT NULL DEFAULT '',
		model TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, ended_at INTEGER,
		outcome TEXT NOT NULL DEFAULT 'running', switches INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT ''
	);`);
	raw.prepare("INSERT INTO agent_runs VALUES ('r0', 'id:0', 'Old run', 'pax', 'claude', 'kit', 'opus-4', 1000, 2000, 'done', 0, '')").run();
	raw.close();

	// Read-only queries succeed before migration runs.
	assert.equal(leaderboard(db)[0]!.xp, 25);
	assert.equal(listRuns(db)[0]!.id, "r0");

	// New writes migrate in place and support ratings + model breakdown.
	recordRunStart(db, { run: "r1", taskId: "id:1", taskTitle: "Build tools", agent: "pax", harness: "claude", host: "kit", model: "claude-opus-5-5", startedAt: 3000 });
	assert.throws(() => rateRun(db, { run: "r1", rating: "good" }), /still running/);
	recordRunEnd(db, { run: "r1", outcome: "done", endedAt: 5000 });
	const rated = rateRun(db, { run: "r1", rating: "good", note: "Clean tests and zero regressions", ratedAt: 6000 });
	assert.equal(rated.rating, "good");
	assert.equal(rated.ratingNote, "Clean tests and zero regressions");

	recordRunStart(db, { run: "r2", taskId: "id:2", taskTitle: "Stuck job", agent: "cid", harness: "claude", host: "cog", model: "claude-opus-5-5", startedAt: 7000 });
	recordRunEnd(db, { run: "r2", outcome: "parked", endedAt: 8000 });
	rateRun(db, { run: "r2", rating: "poor", note: "Missed conflict check" });

	const board = leaderboard(db, { agents: ["pax", "cid"] });
	assert.equal(board[0]!.agent, "pax");
	assert.equal(board[0]!.xp, 65);
	assert.equal(board[0]!.level, 2);
	assert.equal(board[0]!.title, "hand");
	assert.equal(board[0]!.good, 1);
	assert.deepEqual(board[0]!.models.map((m) => [m.model, m.runs, m.xp]), [
		["claude-opus-5-5", 1, 40],
		["opus-4", 1, 25],
	]);
	assert.equal(board[1]!.agent, "cid");
	assert.equal(board[1]!.xp, 0, "XP floors at zero");
	assert.equal(board[1]!.failed, 1);
	assert.equal(board[1]!.poor, 1);
});

test("the team prompt section sits before mood, updates live when cards or HOSTS.org change, and stays absent without them", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	await writeFile(join(tmp.dir, "SOUL.org"), "You are June.\n");
	await writeFile(join(tmp.dir, "MOOD.org"), "Steady.\n");
	const seen: Record<string, string>[] = [];
	const faux = fauxProvider();
	faux.setResponses([
		(ctx) => {
			seen.push(Object.assign({}, ...ctx.messages.filter((m) => m.role === "system").map((m) => (m as { sections?: object }).sections)));
			return fauxAssistantMessage("one");
		},
		(ctx) => {
			seen.push(Object.assign({}, ...ctx.messages.filter((m) => m.role === "system").map((m) => (m as { sections?: object }).sections)));
			return fauxAssistantMessage("two");
		},
		(ctx) => {
			seen.push(Object.assign({}, ...ctx.messages.filter((m) => m.role === "system").map((m) => (m as { sections?: object }).sections)));
			return fauxAssistantMessage("three");
		},
	]);
	const daemon = await openTestDaemon({
		...tmp,
		faux,
		config: {
			...promptFiles(tmp.paths),
			dispatch: { hosts: ["kit", "cog"] },
			herdr: { host: "kit", hosts: { cog: {}, lux: {} }, allowPrompt: false },
		},
	});
	t.after(() => daemon.close());

	// Turn 1: no clankers or HOSTS.org yet -> team section omitted.
	await ask(tmp.paths.socket, "Hello");
	assert.ok(!seen[0]!.team, "team section is omitted when neither clankers nor HOSTS.org exist");

	// Turn 2: Jon creates HOSTS.org and a clanker without restarting June -> appears next turn automatically.
	await writeFile(join(tmp.dir, "HOSTS.org"), "* kit\nGPU and ComfyUI.\n\n* cog\nLaptop.\n");
	editClanker(tmp.dir, { action: "save", name: "craft", host: "kit", harness: "codex", model: "gpt-6.2-sol", effort: "high", instructions: "Runs ComfyUI art." });
	await ask(tmp.paths.socket, "Who can make art?");
	assert.match(seen[1]!.team!, /craft \[kit, codex, gpt-6\.2-sol, effort high\]: Runs ComfyUI art\./);
	assert.match(seen[1]!.team!, /kit \[dispatcher\]: GPU and ComfyUI\./);
	assert.match(seen[1]!.team!, /clankers_status/);

	// Turn 3: Jon swaps craft's model and adds pax -> refreshed automatically on next turn.
	editClanker(tmp.dir, { action: "save", original: "craft", name: "craft", host: "kit", harness: "codex", model: "gpt-6.3-nova", effort: "xhigh", instructions: "Runs ComfyUI art." });
	editClanker(tmp.dir, { action: "save", name: "pax", host: "kit", harness: "claude", model: "claude-opus-5-5", effort: "high", instructions: "Writes code." });
	await ask(tmp.paths.socket, "Any updates?");
	assert.match(seen[2]!.team!, /craft \[kit, codex, gpt-6\.3-nova, effort xhigh\]/);
	assert.match(seen[2]!.team!, /pax \[kit, claude, claude-opus-5-5, effort high\]: Writes code\./);

	// Fresh conversation verifies exact section ordering: skills < team < mood < now.
	await daemon.close();
	const tmp2 = await tempDir();
	t.after(tmp2.cleanup);
	await writeFile(join(tmp2.dir, "SOUL.org"), "You are June.\n");
	await writeFile(join(tmp2.dir, "MOOD.org"), "Steady.\n");
	await writeFile(join(tmp2.dir, "HOSTS.org"), "* kit\nDesktop.\n");
	let ordered: Record<string, string> = {};
	const faux2 = fauxProvider();
	faux2.setResponses([(ctx) => {
		ordered = Object.assign({}, ...ctx.messages.filter((m) => m.role === "system").map((m) => (m as { sections?: object }).sections));
		return fauxAssistantMessage("ordered");
	}]);
	const daemon2 = await openTestDaemon({ ...tmp2, faux: faux2, config: { ...promptFiles(tmp2.paths), dispatch: { hosts: ["kit"] } } });
	t.after(() => daemon2.close());
	await ask(tmp2.paths.socket, "Order?");
	const order = Object.keys(ordered);
	assert.ok(order.indexOf("skills") < order.indexOf("team"), `order was ${order.join(", ")}`);
	assert.ok(order.indexOf("team") < order.indexOf("mood"), `order was ${order.join(", ")}`);
	assert.equal(order.indexOf("mood"), order.indexOf("now") - 1, `mood stays right before now: ${order.join(", ")}`);
});

test("remote WebSocket messages carry @device for proximity while local socket messages stay unqualified", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const heard: string[] = [];
	const faux = fauxProvider();
	faux.setResponses([
		(ctx) => {
			const last = ctx.messages.findLast((m) => m.role === "user");
			heard.push(typeof last?.content === "string" ? last.content : "");
			return fauxAssistantMessage("local ok");
		},
		(ctx) => {
			const last = ctx.messages.findLast((m) => m.role === "user");
			heard.push(typeof last?.content === "string" ? last.content : "");
			return fauxAssistantMessage("remote ok");
		},
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config: { remote: { port: 0 } } });
	t.after(() => daemon.close());
	const port = (await daemon.status()).remote!.port;

	await ask(tmp.paths.socket, "from kit", "local1", "gui");

	const ctl = await Client.open(tmp.paths.socket);
	const added = await ctl.request({ op: "device", requestId: "dev1", action: "add", name: "cog" });
	ctl.close();
	const token = (added as Extract<Reply, { type: "devices" }>).token!;

	const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
	const replies: Reply[] = [];
	ws.on("message", (data) => replies.push(JSON.parse(data.toString("utf8"))));
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	t.after(() => ws.close());
	ws.send(JSON.stringify({ op: "hello", requestId: "h1", token, protocol: 1 }));
	await until(() => replies.some((r) => r.type === "hello"));
	ws.send(JSON.stringify({ op: "submit", requestId: "m1", source: "gui", text: "from laptop", wait: true }));
	await until(() => replies.some((r) => r.type === "settled" && r.requestId === "m1"));

	assert.deepEqual(heard, ["[gui] from kit", "[gui@cog] from laptop"]);
});

test("team tools inspect live standing, deploy clankers, coach memory, and rate runs", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	await writeFile(join(tmp.dir, "HOSTS.org"), "* kit\nDesktop with GPU.\n\n* cog\nLaptop.\n");
	editClanker(tmp.dir, { action: "save", name: "pax", host: "kit", harness: "claude", model: "claude-opus-5-5", effort: "high", instructions: "Writes code cleanly." });
	editClanker(tmp.dir, { action: "save", name: "cid", host: "cog", harness: "claude", model: "claude-opus-5-5", effort: "high", instructions: "Laptop engineer." });
	editClankerMemory(tmp.dir, { clanker: "pax", action: "add", lesson: "Run unit tests after editing." });

	const now = Date.UTC(2026, 10, 27, 12, 0);
	recordRunStart(tmp.paths.database, { run: "run-old", taskId: "id:old", taskTitle: "Old task", agent: "pax", harness: "claude", host: "kit", model: "claude-opus-4-5", startedAt: now - 3_600_000 });
	recordRunEnd(tmp.paths.database, { run: "run-old", outcome: "done", endedAt: now - 3_500_000 });
	recordRunStart(tmp.paths.database, { run: "run-now", taskId: "id:live", taskTitle: "Active job", agent: "cid", harness: "claude", host: "cog", model: "claude-opus-5-5", startedAt: now - 60_000 });

	const live: Record<string, any[]> = {
		kit: [],
		cog: [{
			address: "cog/t2",
			state: "live",
			agent: "claude",
			cwd: "/home/jon/src/suderman/june",
			status: { state: "working" },
			labels: { "june.agent": "cid", "org.task": "id:live", "org.session": "11111111-1111-1111-1111-111111111111" },
		}],
	};
	const herdr = new Herdr({ host: "kit", hosts: { cog: {} }, allowPrompt: false }, async (argv) => {
		if (argv[0] === "herdr-app") throw new Error("no herdr-app");
		if (argv[1] === "machine") return JSON.stringify({ machines: [{ name: "cog", state: "connected" }] });
		if (argv[1] === "ls") {
			const all = Object.values(live).flat();
			const label = argv.indexOf("--label") >= 0 ? argv[argv.indexOf("--label") + 1]!.split("=") : undefined;
			return JSON.stringify({ terminals: label ? all.filter((r) => r.labels?.[label[0]!] === label[1]) : all });
		}
		if (argv[1] === "run") {
			const on = argv.indexOf("--on");
			const host = on >= 0 ? argv[on + 1]! : "kit";
			const addr = `${host === "kit" ? "" : `${host}/`}t7`;
			const labels: Record<string, string> = {};
			argv.forEach((a, i) => { if (a === "--label") { const [k, v] = argv[i + 1]!.split("="); labels[k!] = v!; } });
			(live[host] ??= []).push({ address: addr, state: "live", agent: "claude", cwd: "/home/jon/src/suderman/june", status: { state: "idle" }, labels });
			return JSON.stringify({ address: addr });
		}
		if (argv[1] === "get") return JSON.stringify(Object.values(live).flat().find((r) => r.address === argv[2]) ?? {});
		if (argv[0] === "sh" || argv[0] === "ssh") return "cpu  10 0 10 80 0 0 0 0\nMemTotal:       32768000 kB\nMemAvailable:   16384000 kB\n";
		return "";
	});

	let deployedCalls = 0;
	const config = testConfig(tmp.dir, { dispatch: { hosts: ["kit", "cog"] }, herdr: { host: "kit", hosts: { cog: {} }, allowPrompt: false } });
	const teamExt = createTeamExtension({
		config,
		herdr,
		dataDir: tmp.dir,
		stateDir: tmp.paths.state,
		configFile: join(tmp.dir, "config.json"),
		database: tmp.paths.database,
		onDeployed: () => { deployedCalls++; },
		now: () => now,
		readAccounts: async () => ({
			logins: [{ name: "claude1", harness: "claude", provider: "anthropic", number: 1, label: "home", loggedIn: true, problems: [] }],
			quotas: [{ provider: "anthropic", number: 1, fetched: Math.floor(now / 1000), windows: [{ name: "weekly", remaining: 35, resetAt: Math.floor((now + 3 * 3600_000) / 1000) }] }],
		}),
	});

	const outputs: Record<string, any> = {};
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([
			fauxToolCall("clankers_status", {}),
			fauxToolCall("clankers_status", { clanker: "pax" }),
			fauxToolCall("clanker_rate_run", { run: "run-old", rating: "good", note: "Fast and solid" }),
			fauxToolCall("clanker_memory", { clanker: "pax", action: "add", lesson: "Check git status before staging." }),
			fauxToolCall("clanker_deploy", { clanker: "pax", dir: "~/src/suderman/june" }),
		], { stopReason: "toolUse" }),
		(ctx) => {
			for (const msg of ctx.messages) {
				if (msg.role === "toolResult") {
					const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
					outputs[`${msg.toolName}:${msg.toolCallId}`] = msg.isError ? { _error: text } : JSON.parse(text);
				}
			}
			return fauxAssistantMessage("all checked");
		},
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, extensions: [teamExt] });
	t.after(() => daemon.close());

	await ask(tmp.paths.socket, "Check team");
	const byTool = (name: string) => Object.entries(outputs).filter(([k]) => k.startsWith(`${name}:`)).map(([, v]) => v);

	const [overview, paxDetail] = byTool("clankers_status");
	assert.equal(overview.hosts.find((h: any) => h.host === "kit").notes, "Desktop with GPU.");
	const cidRow = overview.clankers.find((c: any) => c.slug === "cid");
	assert.equal(cidRow.status, "busy (working)");
	assert.equal(cidRow.workingOn.taskTitle, "Active job");
	const paxRow = overview.clankers.find((c: any) => c.slug === "pax");
	assert.equal(paxRow.status, "idle");
	assert.equal(paxRow.battery.expiring, true, "35% resetting in 3h is marked expiring");
	assert.equal(paxRow.modelChanged, true, "old run used claude-opus-4-5, card now uses claude-opus-5-5");
	assert.equal(paxRow.memory.count, 1);
	assert.equal(paxRow.memory.lessons, undefined, "overview omits full lessons unless asked");
	assert.deepEqual(paxDetail.clankers[0].memory.lessons, ["Run unit tests after editing."]);

	const [rated] = byTool("clanker_rate_run");
	assert.equal(rated._error, undefined, `clanker_rate_run error: ${rated._error}`);
	assert.equal(rated.run.rating, "good");
	assert.equal(rated.xp, 40);

	const [mem] = byTool("clanker_memory");
	assert.deepEqual(mem.lessons, ["Run unit tests after editing.", "Check git status before staging."]);

	const [deployed] = byTool("clanker_deploy");
	assert.equal(deployed.clanker, "pax");
	assert.equal(deployed.host, "kit");
	assert.equal(deployed.terminal, "t7");
	assert.equal(deployedCalls, 1);
});

test("the team section names what each specialist owns and tells June to hand it the deeper dives", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	editClanker(tmp.dir, { action: "save", name: "Ledger", host: "kit", harness: "claude", owns: "~/org/finance/", instructions: "Keeps the books." });
	const team = renderTeam(tmp.dir, testConfig(tmp.dir))!;
	assert.match(team, /^- ledger \(Ledger\) \[kit, claude, owns ~\/org\/finance\/\]: Keeps the books\.$/m);
	assert.match(team, /You stay the generalist there/);
});
