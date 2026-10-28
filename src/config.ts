// Paths and runtime configuration, in XDG directories. The config directory holds config.json and AGENTS.md, which
// `agents apply` copies there from ~/.agents; the data directory holds what June keeps herself: SOUL.org, MEMORY.org,
// and JOURNAL.org. Machine plumbing comes from the environment the NixOS module sets: JUNE_DAEMON_HOST, and
// TELEGRAM_ALLOWED_USERS beside the bot token.
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

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
	/** SOUL.org from the data directory when it exists, MEMORY.org and JOURNAL.org beside it (maybe not yet made). */
	readonly soulFile: string | undefined;
	readonly memoryFile: string | undefined;
	/** JOURNAL.org beside SOUL.org: June's dated record of Jon and their days together. */
	readonly journalFile: string | undefined;
	/** AGENTS.md from the config directory, when it exists. */
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
		/** How many recent days' "Day's end" entries June sees in her prompt; 0 shows none. */
		readonly recentDays: number;
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
	/** config.json and AGENTS.md. */
	readonly config: string;
	/** SOUL.org, MEMORY.org, and JOURNAL.org. */
	readonly data: string;
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
	const data = env.JUNE_DATA_DIR ?? join(xdg("XDG_DATA_HOME", ".local/share"), "june");
	const state = env.JUNE_STATE_DIR ?? join(xdg("XDG_STATE_HOME", ".local/state"), "june");
	const runtime = env.JUNE_RUNTIME_DIR ?? join(env.XDG_RUNTIME_DIR ?? join(state, "run"), "june");
	return {
		config,
		data,
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
	reflection: { enabled: true, start: "03:00", end: "06:00", quietMinutes: 60, recentDays: 3 },
	patter: { openAfterSeconds: 8, gapsSeconds: [25, 25, 25, 40, 60, 90, 120, 180] },
};

/** config.json, without defaults or checks; {} when it does not exist. */
export function readConfigFile(p: Paths): Record<string, any> {
	const file = join(p.config, "config.json");
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`${file}: ${(error as Error).message}`);
	}
}

/** The daemon's host, from the environment the NixOS module sets; undefined runs June here. */
export const daemonHost = (env: NodeJS.ProcessEnv = process.env) => env.JUNE_DAEMON_HOST?.trim() || undefined;

/** config.json over the defaults, with the machine's settings from the environment. */
export function loadConfig(p: Paths = paths(), env: NodeJS.ProcessEnv = process.env): Config {
	const raw = readConfigFile(p);
	const file = join(p.config, "config.json");
	if (!raw.model?.chat?.provider || !raw.model?.chat?.modelId) throw new Error(`No model.chat configured in ${file}`);
	for (const key of ["daemonHost", "telegram"]) if (key in raw) throw new Error(`${file}: ${key} now comes from the NixOS module, not config.json`);
	const allowed = (env.TELEGRAM_ALLOWED_USERS ?? "").split(/[\s,]+/).filter(Boolean);
	if (allowed.some((id) => !/^\d+$/.test(id))) throw new Error("TELEGRAM_ALLOWED_USERS must be numeric user ids, separated by commas");
	const herdr = { ...DEFAULTS.herdr, ...raw.herdr };
	const org = { ...DEFAULTS.org, ...raw.org };
	return {
		model: withModes(raw.model),
		providersFile: expandHome(raw.providersFile ?? DEFAULTS.providersFile),
		envFiles: (raw.envFiles ?? DEFAULTS.envFiles).map(expandHome),
		contextCap: raw.contextCap ?? DEFAULTS.contextCap,
		...promptFiles(p),
		daemonHost: daemonHost(env),
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
		// Telegram is on where the module names who may use it; the token sits beside the ids in June's secret.
		...(allowed.length > 0 ? { telegram: { tokenEnv: "TELEGRAM_BOT_TOKEN", allowedUserIds: allowed.map(Number) } } : {}),
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
	if (!Number.isInteger(given.recentDays) || given.recentDays < 0) throw new Error("reflection.recentDays must be a whole number, 0 or more");
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

/** The prompt files as they are now; /reload calls this again so files made since startup are found. */
export function promptFiles(p: Pick<Paths, "config" | "data">): PromptFiles {
	const soulFile = join(p.data, "SOUL.org");
	const instructionsFile = join(p.config, "AGENTS.md");
	const soul = existsSync(soulFile);
	return {
		soulFile: soul ? soulFile : undefined,
		memoryFile: soul ? join(p.data, "MEMORY.org") : undefined,
		journalFile: soul ? join(p.data, "JOURNAL.org") : undefined,
		instructionsFile: existsSync(instructionsFile) ? instructionsFile : undefined,
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
