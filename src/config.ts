// Paths and runtime configuration. Configuration is read in place from layered directories, least specific first,
// such as harness defaults in Git, personal files, and this machine's overrides. Each may hold config.json (merged),
// AGENTS.md, and SOUL.org (most specific wins). MEMORY.org sits beside the SOUL.org in use.
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

export type HerdrHost = { readonly ssh?: string };

export type ModelChoice = { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string };

export type Config = {
	/** June's three modes. Focus and patter take the provider they leave out from chat. */
	readonly model: {
		/** Everyday conversation, and where every conversation starts. */
		readonly chat: ModelChoice;
		/** Careful heads-down work; effort defaults to chat's. */
		readonly focus?: ModelChoice;
		/** The cheap model that keeps the user company during long waits; thinking defaults to medium, which keeps its planning out of the line. */
		readonly patter?: ModelChoice;
	};
	/** Pi's models.json, read for the configured provider so codex-lb is defined in one place. */
	readonly providersFile: string;
	/** dotenv files read for provider keys at startup; values never reach the model. Empty under systemd. */
	readonly envFiles: readonly string[];
	readonly contextCap: number;
	/** SOUL.org and AGENTS.md from the most specific layer that has them; MEMORY.org beside SOUL.org, maybe not yet made. */
	readonly soulFile: string | undefined;
	readonly memoryFile: string | undefined;
	/** JOURNAL.org beside SOUL.org: June's dated record of Jon and their days together. */
	readonly journalFile: string | undefined;
	readonly instructionsFile: string | undefined;
	/** The host that runs the daemon; elsewhere the client commands run there over SSH. */
	readonly daemonHost: string | undefined;
	readonly skillDirs: readonly string[];
	readonly org: { readonly root: string; readonly agendaFiles: string };
	/** Hosts June may queue AUTO tasks for; empty turns the dispatch tools off. The first is the default. */
	readonly dispatch: { readonly hosts: readonly string[] };
	readonly herdr: {
		readonly session: string;
		/** This machine's name, as Org host tags and herdr: links use it. */
		readonly host: string;
		/** Other machines reached read-only over SSH. */
		readonly hosts: Readonly<Record<string, HerdrHost>>;
		readonly allowPrompt: boolean;
	};
	readonly telegram?: { readonly tokenEnv: string; readonly allowedUserIds: readonly number[] };
	/** The nightly pass over the day's journal and memory, between `start` and `end` local time ("HH:MM"). */
	readonly reflection: {
		readonly enabled: boolean;
		readonly start: string;
		readonly end: string;
		/** Minutes Jon must have been quiet before it runs; until then it waits, up to `end`. */
		readonly quietMinutes: number;
	};
	/** When patter speaks during a wait. */
	readonly patter: {
		/** A run busy this long is a wait; a brief or focus starts one at once. */
		readonly openAfterSeconds: number;
		/** Pauses between lines; the last repeats. */
		readonly gapsSeconds: readonly number[];
	};
};

export type Paths = {
	/** Configuration directories, least specific first. */
	readonly layers: readonly string[];
	readonly config: string;
	readonly state: string;
	readonly runtime: string;
	readonly socket: string;
	readonly database: string;
};

const home = () => process.env.HOME || homedir();

export function expandHome(path: string): string {
	if (path === "~") return home();
	return path.startsWith("~/") ? join(home(), path.slice(2)) : resolve(path);
}

function xdg(name: string, fallback: string): string {
	const value = process.env[name];
	return value && value.startsWith("/") ? value : join(home(), fallback);
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
	const config = env.JUNE_CONFIG_DIR ?? join(xdg("XDG_CONFIG_HOME", ".config"), "june");
	const state = env.JUNE_STATE_DIR ?? join(xdg("XDG_STATE_HOME", ".local/state"), "june");
	const runtime = env.JUNE_RUNTIME_DIR ?? join(env.XDG_RUNTIME_DIR ?? join(state, "run"), "june");
	// JUNE_CONFIG_PATH lists the layers, least specific first, like PATH; without it, only the XDG directory.
	const layers = env.JUNE_CONFIG_PATH ? env.JUNE_CONFIG_PATH.split(":").filter(Boolean).map(expandHome) : [config];
	return {
		layers,
		config,
		state,
		runtime,
		socket: env.JUNE_SOCKET ?? join(runtime, "june.sock"),
		database: join(state, "june.sqlite"),
	};
}

const DEFAULTS = {
	providersFile: "~/.pi/agent/models.json",
	envFiles: [] as string[],
	contextCap: 200_000,
	skillDirs: [] as string[],
	org: { root: "~/org", agendaFiles: "~/.local/state/org-dispatch/agenda-files" },
	herdr: { session: "default", hosts: {}, allowPrompt: false },
	reflection: { enabled: true, start: "03:00", end: "06:00", quietMinutes: 60 },
	patter: { openAfterSeconds: 8, gapsSeconds: [25, 25, 25, 40, 60, 90, 120, 180] },
};

/** Objects merge key by key; anything else, arrays included, replaces. */
export function merge(base: Record<string, any>, over: Record<string, any>): Record<string, any> {
	const out = { ...base };
	for (const [key, value] of Object.entries(over)) {
		const old = out[key];
		const plain = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
		out[key] = plain(old) && plain(value) ? merge(old, value) : value;
	}
	return out;
}

/** The layers' config.json files merged, without defaults or checks. Missing files are skipped. */
export function readLayers(p: Paths): Record<string, any> {
	let raw: Record<string, any> = {};
	for (const dir of p.layers) {
		const file = join(dir, "config.json");
		try {
			raw = merge(raw, JSON.parse(readFileSync(file, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${file}: ${(error as Error).message}`);
		}
	}
	return raw;
}

/** The merged layers over the defaults. */
export function loadConfig(p: Paths = paths()): Config {
	const raw = readLayers(p);
	if (!raw.model?.chat?.provider || !raw.model?.chat?.modelId) throw new Error(`No model.chat configured in ${p.layers.join(", ")}`);
	const herdr = { ...DEFAULTS.herdr, ...raw.herdr };
	const org = { ...DEFAULTS.org, ...raw.org };
	return {
		model: withModes(raw.model),
		providersFile: expandHome(raw.providersFile ?? DEFAULTS.providersFile),
		envFiles: (raw.envFiles ?? DEFAULTS.envFiles).map(expandHome),
		contextCap: raw.contextCap ?? DEFAULTS.contextCap,
		...promptFiles(p.layers),
		daemonHost: raw.daemonHost,
		skillDirs: (raw.skillDirs ?? DEFAULTS.skillDirs).map(expandHome),
		org: { root: expandHome(org.root), agendaFiles: expandHome(org.agendaFiles) },
		dispatch: { hosts: raw.dispatch?.hosts ?? [] },
		herdr: {
			session: herdr.session,
			host: herdr.host ?? shortHostname(),
			hosts: herdr.hosts,
			allowPrompt: herdr.allowPrompt === true,
		},
		reflection: reflection({ ...DEFAULTS.reflection, ...raw.reflection }),
		patter: patterTiming({ ...DEFAULTS.patter, ...raw.patter }),
		...(raw.telegram
			? {
					telegram: {
						tokenEnv: raw.telegram.tokenEnv ?? "TELEGRAM_BOT_TOKEN",
						allowedUserIds: (raw.telegram.allowedUserIds ?? []).map(Number),
					},
				}
			: {}),
	};
}

function withModes({ chat: given, focus, patter }: Record<string, any>): Config["model"] {
	for (const [name, mode] of Object.entries({ focus, patter })) if (mode !== undefined && !mode.modelId) throw new Error(`model.${name} needs a modelId`);
	const chat = { thinkingLevel: "medium", ...given };
	return {
		chat,
		...(focus ? { focus: { provider: chat.provider, thinkingLevel: chat.thinkingLevel, ...focus } } : {}),
		...(patter ? { patter: { provider: chat.provider, thinkingLevel: "medium", ...patter } } : {}),
	} as Config["model"];
}

function reflection(given: Config["reflection"]): Config["reflection"] {
	for (const key of ["start", "end"] as const)
		if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(given[key])) throw new Error(`reflection.${key} must be HH:MM, not ${given[key]}`);
	return given;
}

function patterTiming(given: Config["patter"]): Config["patter"] {
	const positive = (n: unknown) => typeof n === "number" && n > 0;
	if (!positive(given.openAfterSeconds)) throw new Error("patter.openAfterSeconds must be a positive number");
	if (!Array.isArray(given.gapsSeconds) || given.gapsSeconds.length === 0 || !given.gapsSeconds.every(positive))
		throw new Error("patter.gapsSeconds must be a list of positive numbers");
	return given;
}

export type PromptFiles = Pick<Config, "soulFile" | "memoryFile" | "journalFile" | "instructionsFile">;

/** The prompt files the layers select now; /reload calls this again so moved or new files are picked up. */
export function promptFiles(layers: readonly string[]): PromptFiles {
	const layerFile = (name: string) => [...layers].reverse().map((dir) => join(dir, name)).find((f) => existsSync(f));
	const soulFile = layerFile("SOUL.org");
	return {
		soulFile,
		memoryFile: soulFile === undefined ? undefined : join(dirname(soulFile), "MEMORY.org"),
		journalFile: soulFile === undefined ? undefined : join(dirname(soulFile), "JOURNAL.org"),
		instructionsFile: layerFile("AGENTS.md"),
	};
}

export const shortHostname = () => hostname().split(".")[0]!;

/** KEY=value lines; quotes stripped, comments and blanks skipped. */
export function readEnvFiles(files: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
			if (match === null) continue;
			out[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
		}
	}
	return out;
}
