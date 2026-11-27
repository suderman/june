// June's team tools: live clanker standing (availability, host load, quota, XP/levels, model-swap stats, and memory),
// interactive deployment in Herdr terminals, clanker MEMORY.org coaching, and post-review run ratings.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { arr, bool, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { accountsConfig, parseAccountsOrg, sharedQuotas, status as accountStatus, type Quota, type SlotStatus } from "../accounts.ts";
import { parseLoad, type Load } from "../board.ts";
import type { Config } from "../config.ts";
import { deploy } from "../deploy.ts";
import {
	assignRosterAgents,
	computeStanding,
	editClankerMemory,
	EXPIRING_HOURS,
	EXPIRING_PERCENT,
	findCard,
	harnessBatteries,
	readClankerMemory,
	readClankers,
	readHosts,
	type Card,
	type RosterBattery,
} from "../roster.ts";
import { activeRunsByTask, levelOf, rateRunAsync, RUN_RATINGS, statsByAgent, type AgentRun, type AgentStats, type ModelStats } from "../runs.ts";
import type { AgentSummary, Herdr } from "./herdr.ts";
import { user } from "../user.ts";

export type TeamOptions = {
	config: Config;
	herdr: Herdr;
	dataDir: string;
	stateDir: string;
	configFile: string;
	database: string;
	/** Called after a live terminal is deployed, e.g. to refresh the agents board. */
	onDeployed?: () => void;
	/** Tests may inject logins and quotas instead of reading host accounts. */
	readAccounts?: () => Promise<{ logins: SlotStatus[]; quotas: Quota[] }>;
	now?: () => number;
};

type HostStanding = {
	host: string;
	ok: boolean;
	error?: string;
	load?: Load;
	dispatcher: boolean;
	notes?: string;
};

const isBatteryExpiring = (b: RosterBattery | undefined): boolean =>
	Boolean(b && "account" in b && b.hours <= EXPIRING_HOURS && b.weekly >= EXPIRING_PERCENT);

function summarizeDirectives(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
}

function modelBreakdown(stats: AgentStats | undefined, card: Card): { currentModelStats?: ModelStats; modelChanged: boolean } {
	if (!stats || stats.models.length === 0) return { modelChanged: false };
	const wanted = (card.model ?? "").trim();
	const current = wanted ? stats.models.find((m) => m.model === wanted) : stats.models[0];
	const otherModels = stats.models.filter((m) => m.model !== (wanted || "(default)") && m.runs > 0);
	return {
		...(current ? { currentModelStats: current } : {}),
		modelChanged: Boolean(wanted && otherModels.length > 0),
	};
}

function formatRun(r: AgentRun) {
	return {
		id: r.id,
		taskId: r.taskId,
		taskTitle: r.taskTitle,
		model: r.model,
		outcome: r.outcome,
		...(r.rating ? { rating: r.rating } : {}),
		...(r.ratingNote ? { ratingNote: r.ratingNote } : {}),
		...(r.switches ? { switches: r.switches } : {}),
		startedAt: r.startedAt,
		...(r.endedAt !== undefined && r.endedAt >= r.startedAt ? { durationMs: r.endedAt - r.startedAt } : {}),
		...(r.note ? { note: r.note } : {}),
	};
}

async function defaultReadAccounts(configFile: string, dataDir: string, stateDir: string): Promise<{ logins: SlotStatus[]; quotas: Quota[] }> {
	try {
		const raw = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
		const accounts = accountsConfig(raw?.accounts);
		if (!Object.keys(accounts.harnesses).length) return { logins: [], quotas: [] };
		const orgPath = join(dataDir, "ACCOUNTS.org");
		const people = parseAccountsOrg(existsSync(orgPath) ? readFileSync(orgPath, "utf8") : "");
		const logins = await accountStatus(accounts, people);
		const quotas = logins.length ? await sharedQuotas(accounts, people, join(stateDir, "quota.json"), { maxAge: 300 }).catch(() => []) : [];
		return { logins, quotas };
	} catch {
		return { logins: [], quotas: [] };
	}
}

export function createTeamExtension(options: TeamOptions): Extension {
	const { config, herdr, dataDir, stateDir, configFile, database } = options;
	const now = options.now ?? Date.now;
	const readAccounts = options.readAccounts ?? (() => defaultReadAccounts(configFile, dataDir, stateDir));

	const statusTool = defineTool({
		name: "clankers_status",
		description: `Inspect live status of your team of clankers and hosts: who is idle or busy (with current task and terminal link), host reachability and CPU/memory load, provider quota and expiring resets, XP/level, current-model vs all-time stats, recent runs (with run IDs for clanker_rate_run), and each clanker's MEMORY.org. Call this before choosing a clanker or answering ${user()} about team status.`,
		parameters: obj({
			clanker: opt(str({ description: "Optional clanker slug or name for full directives, full MEMORY.org lessons, and up to 10 recent runs" })),
			includeMemory: opt(bool({ description: "Include every clanker's full MEMORY.org lessons in the team overview (default false; always true when clanker is specified)" })),
		}),
		replay: "safe",
		execute: async (args) => {
			const cards = readClankers(dataDir);
			let selected: Card[] = cards;
			const single = Boolean(args.clanker?.trim());
			if (single) {
				const found = findCard(cards, args.clanker!);
				if (!found) throw new Error(`No clanker called ${args.clanker}; current clankers: ${cards.map((c) => c.slug).join(", ") || "none"}`);
				selected = [found];
			}

			const hostDocs = new Map(readHosts(dataDir).map((h) => [h.slug, h]));
			const dispatchHosts = new Set(config.dispatch.hosts);
			const targetHosts = [...new Set([...herdr.hosts(), ...selected.flatMap((c) => (c.host ? [c.host] : []))])];

			const runningByTask = activeRunsByTask(database);
			const [hostResults, accountState] = await Promise.all([
				Promise.all(targetHosts.map(async (host) => {
					const notes = hostDocs.get(host.toLowerCase())?.notes;
					try {
						const [workers, loadText] = await Promise.all([
							herdr.agents(host),
							herdr.load(host).catch(() => undefined),
						]);
						const load = loadText ? parseLoad(loadText).load : undefined;
						return {
							info: { host, ok: true, ...(load ? { load } : {}), dispatcher: dispatchHosts.has(host), ...(notes ? { notes } : {}) } satisfies HostStanding,
							workers: assignRosterAgents(cards, workers, { runAgent: (taskId) => runningByTask.get(taskId)?.agent }),
						};
					} catch (error) {
						return {
							info: { host, ok: false, error: (error as Error).message.slice(0, 200), dispatcher: dispatchHosts.has(host), ...(notes ? { notes } : {}) } satisfies HostStanding,
							workers: undefined as AgentSummary[] | undefined,
						};
					}
				})),
				readAccounts(),
			]);

			const byHost = new Map<string, AgentSummary[] | undefined>();
			const workerByTerminal = new Map<string, AgentSummary>();
			for (const r of hostResults) {
				byHost.set(r.info.host, r.workers);
				for (const w of r.workers ?? []) workerByTerminal.set(`${w.host}/${w.terminal}`, w);
			}

			const ts = now();
			const standing = computeStanding(selected, byHost, accountState.logins, accountState.quotas, config.herdr.host, undefined, ts);
			const rosterSlugs = cards.map((c) => c.slug);
			const { stats, recent } = statsByAgent(database, single ? 10 : 5, rosterSlugs.length ? { agents: rosterSlugs } : {});

			const clankers = standing.map((entry) => {
				const { card, status, terminal, battery } = entry;
				const s = stats.get(card.slug);
				const runs = recent.get(card.slug) ?? [];
				const mem = readClankerMemory(card);
				const liveWorker = terminal ? workerByTerminal.get(terminal) : undefined;
				const activeRun = liveWorker?.task ? runningByTask.get(liveWorker.task) : undefined;
				const lv = levelOf(s?.xp ?? 0);
				const { currentModelStats, modelChanged } = modelBreakdown(s, card);
				const showLessons = single || args.includeMemory === true;
				return {
					name: card.name,
					slug: card.slug,
					...(card.host ? { host: card.host } : {}),
					...(card.harness ? { harness: card.harness } : {}),
					...(card.model ? { model: card.model } : {}),
					...(card.effort ? { effort: card.effort } : {}),
					...(card.problems.length ? { problems: card.problems } : {}),
					directives: single ? card.instructions : summarizeDirectives(card.instructions),
					status,
					...(terminal ? { terminal } : {}),
					...(liveWorker ? {
						workingOn: {
							status: liveWorker.status,
							...(liveWorker.cwd ? { cwd: liveWorker.cwd } : {}),
							...(liveWorker.task ? { taskId: liveWorker.task } : {}),
							...(activeRun?.taskTitle ? { taskTitle: activeRun.taskTitle } : {}),
							...(liveWorker.herdrLink ? { herdrLink: liveWorker.herdrLink } : {}),
						},
					} : {}),
					...(battery ? { battery: "account" in battery ? { ...battery, expiring: isBatteryExpiring(battery) } : battery } : {}),
					level: { level: lv.level, title: lv.title, xp: lv.xp, nextLevelXp: lv.nextLevelXp },
					...(s ? {
						stats: {
							rank: s.rank,
							runs: s.runs,
							completed: s.completed,
							failed: s.failed,
							done: s.done,
							eval: s.eval,
							ask: s.ask,
							hold: s.hold,
							retry: s.retry,
							handoffs: s.handoffs,
							parked: s.parked,
							good: s.good,
							mixed: s.mixed,
							poor: s.poor,
							...(s.avgDurationMs !== undefined ? { avgDurationMs: s.avgDurationMs } : {}),
							...(s.lastRunAt !== undefined ? { lastRunAt: s.lastRunAt } : {}),
						},
					} : {}),
					...(currentModelStats ? { currentModelStats } : {}),
					...(modelChanged ? { modelChanged: true } : {}),
					memory: {
						file: mem.file,
						count: mem.lessons.length,
						...(mem.conflict ? { conflict: mem.conflict } : {}),
						...(showLessons ? { lessons: mem.lessons } : {}),
					},
					...(runs.length ? { recentRuns: runs.map(formatRun) } : {}),
				};
			});

			const harnesses = harnessBatteries(accountState.logins, accountState.quotas, ts).map(({ harness, battery }) => ({
				harness,
				battery: "account" in battery ? { ...battery, expiring: isBatteryExpiring(battery) } : battery,
			}));

			return {
				output: [{
					type: "text",
					text: JSON.stringify({
						hosts: hostResults.map((r) => r.info),
						clankers,
						...(single ? {} : { harnesses }),
					}, null, 1),
				}],
			};
		},
	});

	const deployTool = defineTool({
		name: "clanker_deploy",
		description: `Start an interactive Herdr terminal session for a clanker on its own host (or return its existing live terminal if it is already working) so ${user()} can work directly alongside it. For unattended delegated tasks, prefer org_queue_task with agents instead.`,
		parameters: obj({
			clanker: str({ description: "Clanker slug or name from your team" }),
			dir: opt(str({ description: "Working directory on the clanker's host (~, ~/..., or absolute path; omit for home)" })),
		}),
		execute: async (args) => {
			const card = findCard(readClankers(dataDir), args.clanker);
			if (!card) throw new Error(`No clanker called ${args.clanker}`);
			const done = await deploy(herdr, dataDir, { clanker: card.slug, ...(args.dir ? { dir: args.dir } : {}) });
			options.onDeployed?.();
			const agent = (await herdr.agents(done.host).catch(() => [])).find((a) => a.terminal === done.terminal);
			return {
				output: [{
					type: "text",
					text: JSON.stringify({
						clanker: card.slug,
						...done,
						...(agent?.herdrLink ? { herdrLink: agent.herdrLink } : {}),
					}, null, 1),
				}],
			};
		},
	});

	const memoryTool = defineTool({
		name: "clanker_memory",
		description: "Read, add, remove, or prune lessons in a clanker's MEMORY.org (injected into that clanker at every launch). Keep lessons concise, general, and one line each; leave task-specific logs in Org. Refuses if a Syncthing conflict copy sits beside MEMORY.org.",
		parameters: obj({
			clanker: str({ description: "Clanker slug or name" }),
			action: union([lit("read"), lit("add"), lit("remove"), lit("replace")], { description: "read lists current lessons; add appends one general lesson; remove drops one matching lesson; replace writes a pruned list" }),
			lesson: opt(str({ description: "For add: one concise single-line lesson" })),
			match: opt(str({ description: "For remove: exact lesson or unique substring to drop" })),
			lessons: opt(arr(str(), { description: "For replace: full list of lessons to keep, oldest first" })),
		}),
		replay: "safe",
		execute: async (args) => {
			const card = findCard(readClankers(dataDir), args.clanker);
			if (!card) throw new Error(`No clanker called ${args.clanker}`);
			if (args.action === "read") {
				const mem = readClankerMemory(card);
				return { output: [{ type: "text", text: JSON.stringify({ clanker: card.slug, file: mem.file, count: mem.lessons.length, ...(mem.conflict ? { conflict: mem.conflict } : {}), lessons: mem.lessons }, null, 1) }] };
			}
			if (args.action === "add") {
				if (!args.lesson) throw new Error("add requires lesson");
				const result = editClankerMemory(dataDir, { clanker: card.slug, action: "add", lesson: args.lesson });
				return { output: [{ type: "text", text: JSON.stringify({ clanker: card.slug, ...result }, null, 1) }] };
			}
			if (args.action === "remove") {
				if (!args.match) throw new Error("remove requires match");
				const result = editClankerMemory(dataDir, { clanker: card.slug, action: "remove", match: args.match });
				return { output: [{ type: "text", text: JSON.stringify({ clanker: card.slug, ...result }, null, 1) }] };
			}
			if (!args.lessons) throw new Error("replace requires lessons");
			const result = editClankerMemory(dataDir, { clanker: card.slug, action: "replace", lessons: args.lessons });
			return { output: [{ type: "text", text: JSON.stringify({ clanker: card.slug, ...result }, null, 1) }] };
		},
	});

	const rateTool = defineTool({
		name: "clanker_rate_run",
		description: `Record your review rating (${RUN_RATINGS.join("/")}) and an optional short coaching note on a finished clanker run (by run id from clankers_status or org_agents_leaderboard). Updates the clanker's XP and level.`,
		parameters: obj({
			run: str({ description: "Run id from clankers_status or org_agents_leaderboard" }),
			rating: union([lit("good"), lit("mixed"), lit("poor")], { description: "good (+15 XP): clean, thorough work; mixed (0 XP): usable with gaps; poor (-20 XP): missed requirements or needed rework" }),
			note: opt(str({ description: "Optional short one-line note on why this run earned that rating" })),
		}),
		replay: "safe",
		execute: async (args) => {
			const updated = await rateRunAsync(database, { run: args.run, rating: args.rating, ...(args.note ? { note: args.note } : {}) });
			const { stats } = statsByAgent(database, 1, { agents: [updated.agent] });
			const s = stats.get(updated.agent);
			return {
				output: [{
					type: "text",
					text: JSON.stringify({
						run: formatRun(updated),
						...(s ? { agent: updated.agent, xp: s.xp, level: s.level, title: s.title, nextLevelXp: s.nextLevelXp, completed: s.completed, failed: s.failed } : {}),
					}, null, 1),
				}],
			};
		},
	});

	return defineExtension({
		name: "team",
		tools: [statusTool, deployTool, memoryTool, rateTool],
	});
}
