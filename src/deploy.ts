// Deploying from the boards: a raw harness session on a host, or a clanker on its own host, in a folder the user
// picks, each in a new herdr-core terminal the way the dispatcher starts its workers. A clanker already at work is
// visited instead: its terminal comes back, and nothing new starts. A raw session is the harness as the user would type
// it, so its wrapper picks the account; a clanker runs `june start NAME`, which gives it its card and memory. Each joins
// the Herdr app's space on its host named after its folder (june for ~/src/suderman/june), else the host's main space,
// so the app shows it; a terminal hc starts with no space stays hidden there.
import { homedir } from "node:os";
import { HARNESSES as HARNESS_TABLE } from "../desktop/harnesses.mjs";
import { findCard, readClankers } from "./roster.ts";
import type { Herdr } from "./tools/herdr.ts";

/** What a client asks to deploy: a CLANKER, or a HARNESS on HOST; DIR is "~" or empty for home. */
export type DeployRequest = { host?: string; harness?: string; clanker?: string; dir?: string };

/** Where the session runs: its host and terminal (t7), whether it was already running, and whether hc lists it yet. */
export type Deployed = { host: string; terminal: string; existing?: boolean; listed: boolean };

/** DIR as a folder on the target host: undefined for its home ("", "~"), "~/x" under the home, or an absolute path. */
export function deployDir(dir: string | undefined, home = homedir()): string | undefined {
	const d = (dir ?? "").trim();
	if (/[\u0000-\u001f]/.test(d) || d.length > 512) throw new Error("The folder must be one line");
	if (d === "" || d === "~") return undefined;
	if (d.startsWith("~/")) return `${home}/${d.slice(2)}`;
	if (d.startsWith("/")) return d;
	throw new Error(`The folder must start with / or ~/, not ${d}`);
}

const stamp = (d: Date) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");

/** Start (or, for a clanker at work, find) the session REQUEST asks for. */
export async function deploy(herdr: Herdr, dataDir: string, request: DeployRequest, options: { now?: Date; home?: string; waitMs?: number } = {}): Promise<Deployed> {
	const now = options.now ?? new Date();
	const dir = deployDir(request.dir, options.home);
	if (request.clanker) {
		const card = findCard(readClankers(dataDir), request.clanker);
		if (!card) throw new Error(`No clanker called ${request.clanker}`);
		if (card.problems.length) throw new Error(`${card.name}'s card has problems: ${card.problems.join("; ")}`);
		const host = card.host!;
		const busy = (await herdr.labelled(host, "june.agent", card.slug))[0];
		if (busy) return { host, terminal: String(busy.address).replace(`${host}/`, ""), existing: true, listed: true };
		const terminal = await herdr.start(host, ["june", "start", card.slug], { name: `${card.slug}-${stamp(now)}`, ...(dir ? { dir } : {}), labels: { "june.agent": card.slug, "june.deploy": card.slug, ...(await spaceFor(herdr, host, dir)) } });
		return { host, terminal, listed: await listed(herdr, host, terminal, options.waitMs) };
	}
	const harness = String(request.harness ?? "");
	if (!(harness in HARNESS_TABLE)) throw new Error(`Harness must be one of ${Object.keys(HARNESS_TABLE).join(", ")}`);
	const host = String(request.host ?? "");
	if (!herdr.hosts().includes(host)) throw new Error(`Host must be one of ${herdr.hosts().join(", ")}`);
	const terminal = await herdr.start(host, [harness], { name: `${harness}-${stamp(now)}`, ...(dir ? { dir } : {}), labels: { "june.deploy": harness, ...(await spaceFor(herdr, host, dir)) } });
	return { host, terminal, listed: await listed(herdr, host, terminal, options.waitMs) };
}

/** The herdr.space label for a session in DIR on HOST: the space named after the folder, else "main"; none without either. */
async function spaceFor(herdr: Herdr, host: string, dir: string | undefined): Promise<Record<string, string>> {
	const folder = dir?.split("/").filter(Boolean).pop();
	const space = (folder ? await herdr.space(host, folder).catch(() => undefined) : undefined) ?? (await herdr.space(host, "main").catch(() => undefined));
	return space ? { "herdr.space": space } : {};
}

/**
 * Whether hc lists TERMINAL among HOST's agents within WAITMS, so a client can attach to it at once; a session that
 * ended first (a folder that is not there, a harness that is not installed) is an error with its last words.
 */
async function listed(herdr: Herdr, host: string, terminal: string, waitMs = 8_000): Promise<boolean> {
	const until = Date.now() + waitMs;
	for (;;) {
		if ((await herdr.agents(host).catch(() => [])).some((a) => a.terminal === terminal)) return true;
		const record = await herdr.terminal(host, terminal).catch(() => undefined);
		if (record && record.state !== "live") {
			const last = (await herdr.read(host, terminal, 6).catch(() => "")).trim().split("\n").slice(-3).join(" ").slice(0, 300);
			throw new Error(`The session on ${host} ended at once${last ? `: ${last}` : ""}`);
		}
		if (Date.now() >= until) return false;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}
