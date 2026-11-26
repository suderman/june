// The clankers (clankers/ beside SOUL.org): named agents, one folder each. Its CARD.org is the user's: one heading whose
// properties fix the host it works on, the harness, model and effort, and whose text is its directives, added to the
// harness's instructions. Its MEMORY.org is the clanker's own: lessons it adds as it works, given back to it at each
// launch. A clanker works one task at a time: it is busy while a live herdr terminal carries its june.agent label.
// Accounts are not on the card; the harness's plain name picks one from quota on the clanker's host (src/accounts.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES as HARNESS_TABLE } from "../desktop/harnesses.mjs";
import { HARNESSES, type HarnessName, type Quota, rank, type SlotStatus } from "./accounts.ts";
import type { AgentSummary } from "./tools/herdr.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Card = {
	name: string;
	/** The name as commands and labels write it: lowercase letters, digits and hyphens. */
	slug: string;
	host?: string;
	harness?: HarnessName;
	model?: string;
	effort?: string;
	/** The card's directives. */
	instructions: string;
	/** Its folder, clankers/<slug>/, when read from one; MEMORY.org lives there. */
	dir?: string;
	/** What keeps the card from launching; empty for a usable card. */
	problems: string[];
};

export const slugOf = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/** Every first-level heading of TEXT as a card. Child headings belong to the card's directives. */
export function parseRoster(text: string): Card[] {
	const cards: Card[] = [];
	const sections = text.split(/^(?=\* )/m).filter((s) => s.startsWith("* "));
	for (const section of sections) {
		const [heading, ...rest] = section.split("\n");
		const name = heading!.slice(2).replace(/\s+:[\w@#%:]+:\s*$/, "").trim();
		let body = rest.join("\n");
		const props: Record<string, string> = {};
		const drawer = /^\s*:PROPERTIES:\s*\n([\s\S]*?)^\s*:END:\s*$\n?/m.exec(body);
		if (drawer && body.slice(0, drawer.index).trim() === "") {
			for (const line of drawer[1]!.split("\n")) {
				const m = /^\s*:([A-Za-z_-]+):\s*(.*?)\s*$/.exec(line);
				if (m) props[m[1]!.toUpperCase()] = m[2]!;
			}
			body = body.slice(drawer.index + drawer[0].length);
		}
		const problems: string[] = [];
		const slug = slugOf(name);
		if (!slug) problems.push("no name");
		const harness = props.HARNESS?.toLowerCase();
		if (!harness) problems.push("no :HARNESS:");
		else if (!(harness in HARNESSES)) problems.push(`:HARNESS: ${harness} is not one of ${Object.keys(HARNESSES).join(", ")}`);
		if (!props.HOST) problems.push("no :HOST:");
		const effort = props.EFFORT?.toLowerCase();
		if (effort && !(EFFORTS as readonly string[]).includes(effort)) problems.push(`:EFFORT: ${effort} is not one of ${EFFORTS.join(", ")}`);
		if (cards.some((c) => c.slug === slug)) problems.push(`another agent is also called ${slug}`);
		cards.push({
			name,
			slug,
			...(props.HOST ? { host: props.HOST } : {}),
			...(harness && harness in HARNESSES ? { harness: harness as HarnessName } : {}),
			...(props.MODEL ? { model: props.MODEL } : {}),
			...(effort ? { effort } : {}),
			instructions: body.trim(),
			problems,
		});
	}
	return cards;
}

/** The card named NAME, by its name or slug, ignoring case. */
export const findCard = (cards: readonly Card[], name: string) => cards.find((c) => c.slug === slugOf(name));

export const clankersDir = (dataDir: string) => join(dataDir, "clankers");

/**
 * Every clanker in DATADIR's clankers/, in folder order. The folder is the slug and its CARD.org's first heading the card.
 * Dot folders, such as .destroyed, are skipped.
 */
export function readClankers(dataDir: string): Card[] {
	const root = clankersDir(dataDir);
	let folders: string[];
	try {
		folders = readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith("."))
			.map((d) => d.name)
			.sort();
	} catch {
		return [];
	}
	return folders.map((folder): Card => {
		const dir = join(root, folder);
		let text = "";
		try {
			text = readFileSync(join(dir, "CARD.org"), "utf8");
		} catch {}
		const card = parseRoster(text)[0] ?? { name: folder, slug: folder, instructions: "", problems: ["CARD.org has no heading"] };
		const problems = [...card.problems];
		if (card.slug !== folder && !problems.length) problems.push(`its heading names ${card.name}, but its folder is ${folder}`);
		return { ...card, slug: folder, dir, problems };
	});
}

/** How much of MEMORY.org goes into a clanker's instructions: the newest end, where lessons are added. */
export const MEMORY_CHARS = 8000;

/** A clanker's instructions at launch: its directives, then its memory and how to add to it. A card without a folder has only its directives. */
export function launchInstructions(card: Card): string {
	if (!card.dir) return card.instructions;
	const file = join(card.dir, "MEMORY.org");
	let memory = "";
	try {
		memory = readFileSync(file, "utf8").trim();
	} catch {}
	if (memory.length > MEMORY_CHARS) memory = `[older lessons left out; the file has them]\n${memory.slice(-MEMORY_CHARS).replace(/^[^\n]*\n/, "")}`;
	return [
		card.instructions,
		memory ? `Your memory, ${file}, holds what you learned in earlier sessions:\n\n${memory}` : `Your memory is ${file}. It holds nothing yet.`,
		'Before you finish, add each lesson worth keeping for later sessions to the end of that file as a one-line Org list item ("- "). Keep a lesson general and short, and leave out what the task\'s Org record already holds.',
	]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * The arguments that start `card`'s harness as the card says, with PROMPT as its first message. Harnesses without an
 * instructions flag prepend the card's instructions to the prompt, and an interactive start without a prompt goes without them.
 */
export function launchArgs(card: Card, prompt?: string): string[] {
	if (!card.harness || !(card.harness in HARNESS_TABLE)) throw new Error(`${card.name} has no harness`);
	const { cli } = HARNESS_TABLE[card.harness];
	const { model, effort } = card;
	const text = launchInstructions(card);
	const args: string[] = [];
	if (model) args.push(cli.modelFlag, cli.modelPrefix && !model.includes("/") ? `${cli.modelPrefix}${model}` : model);
	if (effort && cli.effort) {
		if (cli.effort.kind === "flag") args.push(cli.effort.flag, effort);
		else args.push(cli.effort.flag, `${cli.effort.key}=${JSON.stringify(effort === "max" && cli.effort.maxAs ? cli.effort.maxAs : effort)}`);
	}
	if (text && cli.instructions) {
		if (cli.instructions.kind === "flag") args.push(cli.instructions.flag, text);
		else if (cli.instructions.kind === "config") args.push(cli.instructions.flag, `${cli.instructions.key}=${JSON.stringify(text)}`);
	}
	if (cli.nameFlag) args.push(cli.nameFlag, card.name);
	if (prompt) {
		const full = text && cli.instructions?.kind === "prepend-prompt" ? `${text}\n\n${prompt}` : prompt;
		if (cli.promptFlag) args.push(cli.promptFlag, full);
		else args.push(full);
	}
	return args;
}

/** Hours before a weekly reset within which unspent quota counts as about to be lost, and the least worth chasing. */
export const EXPIRING_HOURS = 6;
export const EXPIRING_PERCENT = 5;

export type Option = {
	name: string;
	/** Free to take a task now: a valid card, idle, its host reachable, and quota to spend if June can read it. */
	available: boolean;
	reason: string;
	/** Weekly quota left on the account it would use, hours until that resets, and the pace needed to spend it. */
	weekly?: number;
	hours?: number;
	rate?: number;
};

/** Whether an option's allowance would be lost at a reset within EXPIRING_HOURS. */
export const expiring = (o: Option) => o.available && o.hours !== undefined && o.hours <= EXPIRING_HOURS && (o.weekly ?? 0) >= EXPIRING_PERCENT;

/**
 * Pick among candidates given in the user's order. The first available one wins, unless it is not itself about to lose
 * quota and a later available one is: then the later one whose allowance runs out fastest goes, so tokens are not wasted.
 */
export function choose(options: readonly Option[]): { chosen?: string; why: string } {
	const first = options.find((o) => o.available);
	if (!first) return { why: options.map((o) => `${o.name}: ${o.reason}`).join("; ") || "no candidates" };
	if (expiring(first)) return { chosen: first.name, why: `${first.name} is first and would lose ${first.weekly}% at a reset in ${Math.round(first.hours!)}h` };
	const urgent = options.filter((o) => o !== first && expiring(o)).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];
	if (urgent) return { chosen: urgent.name, why: `${urgent.name} goes ahead of ${first.name}: ${urgent.weekly}% would be lost at its reset in ${Math.round(urgent.hours!)}h` };
	return { chosen: first.name, why: `${first.name} is the first available` };
}

/** For an Antigravity card, the model group its quota comes from (Gemini models for gemini-4-neon). */
export const familyOf = (card: Card) => (card.harness === "agy" && card.model ? new RegExp(/^(gemini|claude|gpt)/i.exec(card.model)?.[1] ?? "^$", "i") : undefined);

/** A clanker's energy from its best login's quota; STALE when that is the last good read, kept over a failed one, from FETCHED (epoch s). */
export type RosterBattery = { account: string; weekly: number; hours: number; rate: number; stale?: boolean; fetched?: number } | { reason: string };

export type RosterStats = {
	rank: number;
	runs: number;
	completed: number;
	handoffs: number;
	parked: number;
	avgDurationMs?: number;
	lastRunAt?: number;
};

export type RosterRecentRun = {
	taskId: string;
	taskTitle: string;
	outcome: string;
	startedAt: number;
	durationMs?: number;
};

export type RosterEntry = {
	card: Card;
	status: string;
	terminal?: string;
	battery?: RosterBattery;
	stats?: RosterStats;
	recentRuns?: RosterRecentRun[];
};

/** A clanker edit from a client: save (create or update) one card, or delete (destroy, archiving its folder) one by slug. */
export type RosterEdit =
	| { action: "save"; original?: string; name: string; host: string; harness: string; model?: string; effort?: string; instructions?: string }
	| { action: "delete"; slug: string };

/** Whether the dispatcher on this host has an active run of task ID, from its receipt in ~/.local/state/org-dispatch. */
export function dispatchActive(id: string): boolean {
	const state = process.env.XDG_STATE_HOME?.startsWith("/") ? process.env.XDG_STATE_HOME : `${process.env.HOME}/.local/state`;
	try {
		const status = JSON.parse(readFileSync(`${state}/org-dispatch/${id}.json`, "utf8")).status;
		return ["starting", "running", "stopping", "launch-uncertain"].includes(status);
	} catch {
		return false;
	}
}

/**
 * Fill in `rosterAgent` on live workers that belong to a roster card on their host, from their `june.agent` label,
 * else their linked task's assigned `:AGENT:`, else an active run record. Unnamed harness workers stay unnamed.
 */
export function assignRosterAgents(
	cards: readonly Card[],
	workers: readonly AgentSummary[],
	resolve: { taskAgent?: (w: AgentSummary) => string | undefined; runAgent?: (taskId: string) => string | undefined } = {},
): AgentSummary[] {
	const byHost = new Map<string, Set<string>>();
	for (const c of cards) {
		if (c.problems.length || !c.host) continue;
		let set = byHost.get(c.host);
		if (!set) {
			set = new Set();
			byHost.set(c.host, set);
		}
		set.add(c.slug);
	}
	return workers.map((w) => {
		if (w.rosterAgent) return w;
		const slugs = byHost.get(w.host);
		if (!slugs) return w;
		const candidate = resolve.taskAgent?.(w)?.trim().toLowerCase() || (w.task ? resolve.runAgent?.(w.task)?.trim().toLowerCase() : undefined);
		if (candidate && slugs.has(candidate)) return { ...w, rosterAgent: candidate };
		return w;
	});
}

/**
 * Each roster card with whether it is busy (a live terminal carries its roster slug) and its battery: the binding
 * weekly window left on the account its harness would pick now. The same accounts are signed in on every host and only
 * the daemon's host reads providers, so a clanker on another host takes its battery from these readings too.
 */
export function computeStanding(
	cards: readonly Card[],
	hosts: ReadonlyMap<string, readonly AgentSummary[] | undefined>,
	logins: readonly SlotStatus[],
	quotas: readonly Quota[],
	here: string,
	active: (id: string, host?: string, status?: string) => boolean = (id, host, status) => (host && host !== here ? status === "working" : dispatchActive(id)),
	now = Date.now(),
): RosterEntry[] {
	return cards.map((card): RosterEntry => {
		if (card.problems.length) return { card, status: "invalid" };
		const terminals = hosts.get(card.host!);
		if (!terminals) return { card, status: `${card.host} unreachable` };
		// A dispatched worker holds its agent only while its run is active; a finished one's terminal stays open for
		// review or resume without keeping the agent from its next task. A session started by hand holds it while open.
		const busy = terminals.find((t) => t.rosterAgent === card.slug && (!t.task || active(t.task, card.host, t.status)));
		if (busy) return { card, status: `busy (${busy.status})`, terminal: `${card.host}/${busy.terminal}` };
		return { card, status: "idle", battery: batteryOf(card.harness!, logins, quotas, now, card.model) };
	});
}

/**
 * HARNESS's battery from the daemon's readings: the binding weekly window left on the account it would pick now for
 * MODEL (any, without one), or why there is none. The same accounts are signed in on every host.
 */
export function batteryOf(harness: string, logins: readonly SlotStatus[], quotas: readonly Quota[], now = Date.now(), model?: string): RosterBattery {
	const mine = logins.filter((r) => r.harness === harness && r.loggedIn && !r.problems.length);
	if (!mine.length) return { reason: `no ${harness} login here` };
	const ranked = rank(mine.map((slot) => ({ slot, quota: quotas.find((q) => q.provider === slot.provider && q.number === slot.number) })), now, model);
	const best = ranked.find((r) => r.usable);
	if (!best?.budget) return { reason: ranked.map((r) => `${r.slot}: ${r.reason}`).join("; ") };
	const { weekly, hours, rate } = best.budget;
	const login = mine.find((s) => s.name === best.slot);
	const row = login && quotas.find((q) => q.provider === login.provider && q.number === login.number);
	const stale = row?.stale ? { stale: true, ...(row.fetched ? { fetched: row.fetched } : {}) } : {};
	return { account: best.slot, weekly: weekly!, hours: hours!, rate, ...stale };
}

/** Each harness with a login, in the shared table's order, and its battery: what a raw session on any host would spend. */
export function harnessBatteries(logins: readonly SlotStatus[], quotas: readonly Quota[], now = Date.now()): { harness: string; battery: RosterBattery }[] {
	const signed = new Set(logins.filter((r) => r.loggedIn).map((r) => r.harness as string));
	return Object.keys(HARNESS_TABLE).filter((h) => signed.has(h)).map((harness) => ({ harness, battery: batteryOf(harness, logins, quotas, now) }));
}

const oneLine = (value: unknown, field: string): string => {
	const s = typeof value === "string" ? value.trim() : "";
	if (/[\r\n]/.test(s)) throw new Error(`${field} must be a single line`);
	return s;
};

/** Format one card as an Org first-level heading with a PROPERTIES drawer and its directives. */
export function formatCard(fields: { name: string; host: string; harness: string; model?: string; effort?: string; instructions?: string }): string {
	const lines = [
		`* ${fields.name}`,
		":PROPERTIES:",
		`:HOST: ${fields.host}`,
		`:HARNESS: ${fields.harness}`,
		...(fields.model ? [`:MODEL: ${fields.model}`] : []),
		...(fields.effort ? [`:EFFORT: ${fields.effort}`] : []),
		":END:",
	];
	if (fields.instructions) lines.push(fields.instructions);
	return lines.join("\n");
}

const writeAtomic = (file: string, text: string) => {
	const tmp = `${file}.june-tmp`;
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, file);
};

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Apply one edit to DATADIR's clankers. A save writes clankers/<slug>/CARD.org, keeping any text above its heading,
 * renames the folder (and so its memory) when the name changes, and starts an empty MEMORY.org for a new clanker. A
 * delete moves the folder to clankers/.destroyed/<slug>-<day>/; nothing is removed. Returns a save's slug.
 */
export function editClanker(dataDir: string, edit: RosterEdit, now = new Date()): { slug?: string } {
	const root = clankersDir(dataDir);
	const slugs = readClankers(dataDir).map((c) => c.slug);
	if (edit.action === "delete") {
		const target = slugOf(typeof edit.slug === "string" ? edit.slug : "");
		if (!target) throw new Error("destroy needs a clanker's slug");
		if (!slugs.includes(target)) throw new Error(`no clanker called ${edit.slug}`);
		const archive = join(root, ".destroyed");
		mkdirSync(archive, { recursive: true });
		let to = join(archive, `${target}-${localDay(now)}`);
		for (let n = 2; existsSync(to); n++) to = join(archive, `${target}-${localDay(now)}-${n}`);
		renameSync(join(root, target), to);
		return {};
	}

	if (edit.action !== "save") throw new Error(`unknown clanker action ${String((edit as { action?: unknown }).action)}`);
	const name = oneLine(edit.name, "name").replace(/\s+:[\w@#%:]+:\s*$/, "").trim();
	const slug = slugOf(name);
	if (!slug) throw new Error("name is required");
	const host = oneLine(edit.host, "host");
	if (!host) throw new Error("host is required");
	const harness = oneLine(edit.harness, "harness").toLowerCase();
	if (!(harness in HARNESSES)) throw new Error(`harness must be one of ${Object.keys(HARNESSES).join(", ")}`);
	const model = oneLine(edit.model ?? "", "model");
	const effort = oneLine(edit.effort ?? "", "effort").toLowerCase();
	if (effort && !(EFFORTS as readonly string[]).includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);
	const instructions = typeof edit.instructions === "string" ? edit.instructions.replace(/\r\n/g, "\n").trim() : "";
	if (/^\* /m.test(instructions)) throw new Error("directives cannot contain top-level '* ' headings (use '** ' instead)");

	const original = typeof edit.original === "string" && edit.original.trim() !== "" ? slugOf(edit.original) : "";
	if (original && !slugs.includes(original)) throw new Error(`no clanker called ${edit.original}`);
	if (slug !== original && (slugs.includes(slug) || existsSync(join(root, slug)))) throw new Error(`another clanker is already called ${name}`);

	const dir = join(root, slug);
	if (original && original !== slug) renameSync(join(root, original), dir);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "CARD.org");
	const current = existsSync(file) ? readFileSync(file, "utf8") : "";
	const first = /^\* /m.exec(current);
	const preamble = (first ? current.slice(0, first.index) : current).trimEnd();
	const card = formatCard({ name, host, harness, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(instructions ? { instructions } : {}) });
	writeAtomic(file, `${preamble ? `${preamble}\n\n` : ""}${card}\n`);
	const memory = join(dir, "MEMORY.org");
	if (!existsSync(memory)) writeAtomic(memory, `#+TITLE: ${name}'s memory\n\nLessons ${name} learned, one list item each, newest last. ${name} adds to this file; edit or prune it freely.\n`);
	return { slug };
}
