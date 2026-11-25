// The roster (ROSTER.org beside SOUL.org): named agents, one heading each, whose properties fix the host they work on,
// the harness, model and effort, and an avatar, and whose text is the instructions added to the harness's own. An agent
// works one task at a time: it is busy while a live herdr terminal carries its june.agent label. Accounts are not on the
// card; the harness's plain name picks one from quota on the agent's host (src/accounts.ts).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
	avatar?: string;
	instructions: string;
	/** What keeps the card from launching; empty for a usable card. */
	problems: string[];
};

export const slugOf = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/** Every first-level heading of ROSTER.org as a card. Child headings belong to the card's instructions. */
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
			...(props.AVATAR ? { avatar: props.AVATAR } : {}),
			instructions: body.trim(),
			problems,
		});
	}
	return cards;
}

/** The card named NAME, by its name or slug, ignoring case. */
export const findCard = (cards: readonly Card[], name: string) => cards.find((c) => c.slug === slugOf(name));

/**
 * The arguments that start `card`'s harness as the card says, with PROMPT as its first message. Harnesses without an
 * instructions flag prepend the card's instructions to the prompt, and an interactive start without a prompt goes without them.
 */
export function launchArgs(card: Card, prompt?: string): string[] {
	if (!card.harness || !(card.harness in HARNESS_TABLE)) throw new Error(`${card.name} has no harness`);
	const { cli } = HARNESS_TABLE[card.harness];
	const { model, effort, instructions: text } = card;
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

/** An edit of ROSTER.org from a client: save (add or update) one card, or delete one by slug. */
export type RosterEdit =
	| { action: "save"; original?: string; name: string; host: string; harness: string; model?: string; effort?: string; avatar?: string; instructions?: string }
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
 * Each roster card with whether it is busy (a live terminal carries its june.agent label) and, on this host, its
 * battery: the binding weekly window left on the account its harness would pick now.
 */
export function computeStanding(
	cards: readonly Card[],
	hosts: ReadonlyMap<string, readonly AgentSummary[] | undefined>,
	logins: readonly SlotStatus[],
	quotas: readonly Quota[],
	here: string,
	active: (id: string) => boolean = dispatchActive,
	now = Date.now(),
): RosterEntry[] {
	return cards.map((card): RosterEntry => {
		if (card.problems.length) return { card, status: "invalid" };
		const terminals = hosts.get(card.host!);
		if (!terminals) return { card, status: `${card.host} unreachable` };
		// A dispatched worker holds its agent only while its run is active; a finished one's terminal stays open for
		// review or resume without keeping the agent from its next task. A session started by hand holds it while open.
		const busy = terminals.find((t) => t.rosterAgent === card.slug && (!t.task || card.host !== here || active(t.task)));
		if (busy) return { card, status: `busy (${busy.status})`, terminal: `${card.host}/${busy.terminal}` };
		if (card.host !== here) return { card, status: "idle", battery: { reason: `quota is read on ${card.host}` } };
		const mine = logins.filter((r) => r.harness === card.harness && r.loggedIn && !r.problems.length);
		if (!mine.length) return { card, status: "idle", battery: { reason: `no ${card.harness} login here` } };
		const ranked = rank(mine.map((slot) => ({ slot, quota: quotas.find((q) => q.provider === slot.provider && q.number === slot.number) })), now, card.model);
		const best = ranked.find((r) => r.usable);
		if (!best?.budget) return { card, status: "idle", battery: { reason: ranked.map((r) => `${r.slot}: ${r.reason}`).join("; ") } };
		const { weekly, hours, rate } = best.budget;
		const login = mine.find((s) => s.name === best.slot);
		const row = login && quotas.find((q) => q.provider === login.provider && q.number === login.number);
		const stale = row?.stale ? { stale: true, ...(row.fetched ? { fetched: row.fetched } : {}) } : {};
		return { card, status: "idle", battery: { account: best.slot, weekly: weekly!, hours: hours!, rate, ...stale } };
	});
}

const oneLine = (value: unknown, field: string): string => {
	const s = typeof value === "string" ? value.trim() : "";
	if (/[\r\n]/.test(s)) throw new Error(`${field} must be a single line`);
	return s;
};

/** Format one roster card as an Org first-level heading with a PROPERTIES drawer and instructions body. */
export function formatCard(fields: { name: string; host: string; harness: string; model?: string; effort?: string; avatar?: string; instructions?: string }): string {
	const lines = [
		`* ${fields.name}`,
		":PROPERTIES:",
		`:HOST: ${fields.host}`,
		`:HARNESS: ${fields.harness}`,
		...(fields.model ? [`:MODEL: ${fields.model}`] : []),
		...(fields.effort ? [`:EFFORT: ${fields.effort}`] : []),
		...(fields.avatar ? [`:AVATAR: ${fields.avatar}`] : []),
		":END:",
	];
	if (fields.instructions) lines.push(fields.instructions);
	return lines.join("\n");
}

/**
 * Apply one edit to ROSTER.org text, preserving the file's preamble and every untouched card verbatim. Returns the new
 * Org text and, for a save, the saved card's slug.
 */
export function applyRosterEdit(text: string, edit: RosterEdit): { text: string; slug?: string } {
	const first = /^\* /m.exec(text);
	const preamble = (first ? text.slice(0, first.index) : text).trimEnd() || "#+TITLE: Roster";
	const rawSections = first ? text.slice(first.index).split(/^(?=\* )/m).filter((s) => s.startsWith("* ")).map((s) => s.trimEnd()) : [];
	const parsed = rawSections.map((raw) => ({ raw, card: parseRoster(raw)[0]! }));

	if (edit.action === "delete") {
		const target = slugOf(typeof edit.slug === "string" ? edit.slug : "");
		if (!target) throw new Error("delete needs an agent slug");
		const idx = parsed.findIndex((p) => p.card.slug === target);
		if (idx < 0) throw new Error(`no agent called ${edit.slug}`);
		const kept = parsed.filter((_, i) => i !== idx).map((p) => p.raw);
		return { text: [preamble, ...kept].join("\n\n") + "\n" };
	}

	if (edit.action !== "save") throw new Error(`unknown roster action ${String((edit as { action?: unknown }).action)}`);
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
	const avatar = oneLine(edit.avatar ?? "", "avatar");
	const instructions = typeof edit.instructions === "string" ? edit.instructions.replace(/\r\n/g, "\n").trim() : "";
	if (/^\* /m.test(instructions)) throw new Error("instructions cannot contain top-level '* ' headings (use '** ' instead)");

	const original = typeof edit.original === "string" && edit.original.trim() !== "" ? slugOf(edit.original) : "";
	const idx = original ? parsed.findIndex((p) => p.card.slug === original) : -1;
	if (original && idx < 0) throw new Error(`no agent called ${edit.original}`);
	if (parsed.some((p, i) => i !== idx && p.card.slug === slug)) throw new Error(`another agent is already called ${name}`);

	const formatted = formatCard({ name, host, harness, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(avatar ? { avatar } : {}), ...(instructions ? { instructions } : {}) });
	const next = parsed.map((p) => p.raw);
	if (idx >= 0) next[idx] = formatted;
	else next.push(formatted);
	return { text: [preamble, ...next].join("\n\n") + "\n", slug };
}

/** Read, edit and atomically rewrite ROSTER.org. */
export function editRosterFile(file: string, edit: RosterEdit): { slug?: string } {
	const current = existsSync(file) ? readFileSync(file, "utf8") : "";
	const { text, slug } = applyRosterEdit(current, edit);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.june-tmp`;
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, file);
	return { ...(slug ? { slug } : {}) };
}
