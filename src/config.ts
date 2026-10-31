// Paths and runtime configuration, in XDG directories. The config directory holds config.json and AGENTS.md, which
// `agents apply` copies there from ~/.agents; the data directory holds what June keeps herself: SOUL.org, MEMORY.org,
// and JOURNAL.org. Machine plumbing comes from the environment June's Home Manager module sets: JUNE_DAEMON_HOST, and
// TELEGRAM_ALLOWED_USERS beside the bot token.
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { DIGEST, type Period } from "./journal.ts";

export type HerdrHost = { readonly ssh?: string };

export type ModelChoice = { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string };

export type Config = {
	/** The person June serves; her prompts use the name. Without one she says "the user". */
	readonly user: { readonly name?: string };
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
	/** JOURNAL.org beside SOUL.org: June's dated record of the user and their days together. */
	readonly journalFile: string | undefined;
	/** HEARTBEAT.org beside SOUL.org: what June watches for between conversations, in the user's words. */
	readonly heartbeatFile: string | undefined;
	/** AGENTS.md from the config directory, when it exists. */
	readonly instructionsFile: string | undefined;
	/** The host that runs the daemon; elsewhere the client commands run there over SSH. */
	readonly daemonHost: string | undefined;
	readonly skillDirs: readonly string[];
	readonly org: { readonly root: string; readonly agendaFiles: string; /** The user's rolodex, one heading per person. */ readonly people: string };
	/**
	 * Hosts June may queue AUTO tasks for; empty turns the dispatch tools off. `host` and `agent` are the defaults the
	 * dispatcher writes into an AUTO task's drawer when it lacks them and no tag names one: `host` defaults to the first
	 * of `hosts`, `agent` to pi. `agents` are the ones June may choose for a task, `agent` alone without it. `settle` is
	 * how many seconds a heading the user typed must stay unchanged before the dispatcher launches it (120 without it).
	 */
	readonly dispatch: {
		readonly hosts: readonly string[];
		readonly host?: string;
		readonly agent?: string;
		readonly agents?: readonly string[];
		readonly settle?: number;
	};
	readonly herdr: {
		readonly session: string;
		/** This machine's name, as Org host tags and herdr: links use it. */
		readonly host: string;
		/** Other machines reached read-only over SSH. */
		readonly hosts: Readonly<Record<string, HerdrHost>>;
		readonly allowPrompt: boolean;
	};
	readonly telegram?: { readonly tokenEnv: string; readonly allowedUserIds: readonly number[] };
	/**
	 * The user's day, in local "HH:MM": heartbeats run from `wake` until `quiet`, when they no longer want to be bothered even
	 * if he is up, and the nightly reflection runs from `sleep`, when he is surely asleep, until `wake`.
	 */
	readonly rhythm: { readonly wake: string; readonly quiet: string; readonly sleep: string };
	/** The nightly pass over the day's journal and memory, in the rhythm's sleep hours. */
	readonly reflection: {
		readonly enabled: boolean;
		/** Minutes the user must have been quiet before it runs; until then it waits, up to `rhythm.wake`. */
		readonly quietMinutes: number;
		/** How many recent days' "Day's end" entries June sees in her prompt; 0 shows none. */
		readonly recentDays: number;
		/** The longer digests written after the nightly pass on each period's last day, such as ["week", "month"]. */
		readonly periods: readonly Period[];
	};
	/** June's periodic private look at the moment, which she may turn into a message to the user, or not. */
	readonly heartbeat: {
		readonly enabled: boolean;
		readonly everyMinutes: number;
		/** The user wrote this recently: they are chatting, so raising something is just her next line. */
		readonly chattingMinutes: number;
	};
	/** New mail for the heartbeat, from a notmuch query; accounts name each maildir folder, such as {"work": "work"}. */
	readonly mail: { readonly enabled: boolean; readonly query: string; readonly accounts: Readonly<Record<string, string>> };
	/** Dispatched tasks June did not queue, on `dispatch.hosts`: news reaches her in waking hours, at most every `gapMinutes`. */
	readonly watch: { readonly enabled: boolean; readonly gapMinutes: number };
	/** The "now" prompt section: calendars read for today and tomorrow, and Home Assistant people (with HASS_URL and HASS_TOKEN). */
	readonly situation: {
		readonly calendars: readonly string[];
		readonly homeAssistant: { readonly people: readonly string[]; readonly weather?: string; readonly pollSeconds: number };
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
	org: { root: "~/org", agendaFiles: "~/.local/state/org-dispatch/agenda-files", people: "~/org/people.org" },
	herdr: { session: "default", hosts: {}, allowPrompt: true },
	rhythm: { wake: "05:00", quiet: "22:00", sleep: "01:00" },
	reflection: { enabled: true, quietMinutes: 60, recentDays: 3, periods: ["week", "month", "quarter", "year"] },
	heartbeat: { enabled: false, everyMinutes: 60, chattingMinutes: 15 },
	mail: { enabled: false, query: "tag:inbox and tag:unread", accounts: {} as Record<string, string> },
	watch: { enabled: false, gapMinutes: 10 },
	patter: { openAfterSeconds: 8, gapsSeconds: [25, 25, 25, 40, 60, 90, 120, 180] },
	situation: { calendars: [] as string[], homeAssistant: { people: [] as string[], pollSeconds: 300 } },
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

/** The daemon's host, from the environment June's Home Manager module sets; undefined runs June here. */
export const daemonHost = (env: NodeJS.ProcessEnv = process.env) => env.JUNE_DAEMON_HOST?.trim() || undefined;

/** config.json over the defaults, with the machine's settings from the environment. */
export function loadConfig(p: Paths = paths(), env: NodeJS.ProcessEnv = process.env): Config {
	const raw = readConfigFile(p);
	const file = join(p.config, "config.json");
	if (!raw.model?.chat?.provider || !raw.model?.chat?.modelId) throw new Error(`No model.chat configured in ${file}`);
	for (const key of ["daemonHost", "telegram"]) if (key in raw) throw new Error(`${file}: ${key} now comes from the Home Manager module, not config.json`);
	const allowed = (env.TELEGRAM_ALLOWED_USERS ?? "").split(/[\s,]+/).filter(Boolean);
	if (allowed.some((id) => !/^\d+$/.test(id))) throw new Error("TELEGRAM_ALLOWED_USERS must be numeric user ids, separated by commas");
	const herdr = { ...DEFAULTS.herdr, ...raw.herdr };
	const org = { ...DEFAULTS.org, ...raw.org };
	return {
		user: raw.user?.name ? { name: String(raw.user.name) } : {},
		model: withModes(raw.model),
		providersFile: expandHome(raw.providersFile ?? DEFAULTS.providersFile),
		envFiles: (raw.envFiles ?? DEFAULTS.envFiles).map(expandHome),
		contextCap: raw.contextCap ?? DEFAULTS.contextCap,
		...promptFiles(p),
		daemonHost: daemonHost(env),
		skillDirs: (raw.skillDirs ?? DEFAULTS.skillDirs).map(expandHome),
		org: { root: expandHome(org.root), agendaFiles: expandHome(org.agendaFiles), people: expandHome(org.people) },
		dispatch: dispatch(raw.dispatch),
		herdr: {
			session: herdr.session,
			host: herdr.host ?? shortHostname(),
			hosts: herdr.hosts,
			allowPrompt: herdr.allowPrompt === true,
		},
		rhythm: rhythm({ ...DEFAULTS.rhythm, ...raw.rhythm }),
		reflection: reflection({ ...DEFAULTS.reflection, ...raw.reflection }),
		heartbeat: heartbeat({ ...DEFAULTS.heartbeat, ...raw.heartbeat }),
		mail: mail({ ...DEFAULTS.mail, ...raw.mail }),
		watch: watch({ ...DEFAULTS.watch, ...raw.watch }),
		patter: patterTiming({ ...DEFAULTS.patter, ...raw.patter }),
		situation: situation(raw.situation ?? {}),
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

function rhythm(given: Config["rhythm"]): Config["rhythm"] {
	for (const key of ["wake", "quiet", "sleep"] as const)
		if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(given[key])) throw new Error(`rhythm.${key} must be HH:MM, not ${given[key]}`);
	return given;
}

function reflection(given: Config["reflection"] & { start?: unknown; end?: unknown }): Config["reflection"] {
	if ("start" in given || "end" in given) throw new Error("reflection.start and end are gone: the reflection runs from rhythm.sleep to rhythm.wake");
	if (!Number.isInteger(given.recentDays) || given.recentDays < 0) throw new Error("reflection.recentDays must be a whole number, 0 or more");
	if (!Array.isArray(given.periods) || given.periods.some((p) => !Object.hasOwn(DIGEST, p))) throw new Error(`reflection.periods may hold only ${Object.keys(DIGEST).join(", ")}`);
	return given;
}

function heartbeat(given: Config["heartbeat"]): Config["heartbeat"] {
	if (!(typeof given.everyMinutes === "number" && given.everyMinutes >= 5)) throw new Error("heartbeat.everyMinutes must be 5 or more");
	if (!(typeof given.chattingMinutes === "number" && given.chattingMinutes >= 0)) throw new Error("heartbeat.chattingMinutes must be 0 or more");
	return given;
}

function dispatch(given: Partial<Config["dispatch"]> | undefined): Config["dispatch"] {
	const hosts = given?.hosts ?? [];
	for (const key of ["host", "agent"] as const)
		if (given?.[key] !== undefined && !(typeof given[key] === "string" && /^[a-z0-9-]+$/.test(given[key]!))) throw new Error(`dispatch.${key} must be a plain name`);
	if (given?.settle !== undefined && !(Number.isInteger(given.settle) && given.settle >= 0)) throw new Error("dispatch.settle must be whole seconds, 0 or more");
	const agents = given?.agents;
	if (agents !== undefined) {
		if (!(Array.isArray(agents) && agents.length > 0 && agents.every((agent) => typeof agent === "string" && /^[a-z0-9-]+$/.test(agent))))
			throw new Error("dispatch.agents must be a list of plain names");
		if (given?.agent !== undefined && !agents.includes(given.agent)) throw new Error("dispatch.agent must be one of dispatch.agents");
	}
	return {
		hosts,
		...(given?.host ? { host: given.host } : {}),
		...(given?.agent ? { agent: given.agent } : {}),
		...(agents ? { agents } : {}),
		...(given?.settle !== undefined ? { settle: given.settle } : {}),
	};
}

function watch(given: Config["watch"]): Config["watch"] {
	if (!(typeof given.gapMinutes === "number" && given.gapMinutes >= 0)) throw new Error("watch.gapMinutes must be 0 or more");
	return given;
}

function mail(given: Config["mail"]): Config["mail"] {
	if (typeof given.query !== "string" || given.query.trim() === "") throw new Error("mail.query must be a notmuch query");
	const accounts = given.accounts ?? {};
	if (typeof accounts !== "object" || Object.values(accounts).some((v) => typeof v !== "string")) throw new Error("mail.accounts maps maildir folders to names");
	return { enabled: given.enabled === true, query: given.query, accounts };
}

function situation(given: Record<string, any>): Config["situation"] {
	const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "");
	const calendars = given.calendars ?? DEFAULTS.situation.calendars;
	const homeAssistant = { ...DEFAULTS.situation.homeAssistant, ...given.homeAssistant };
	if (!strings(calendars)) throw new Error("situation.calendars must be a list of paths");
	if (!strings(homeAssistant.people) || !homeAssistant.people.every((p: string) => p.startsWith("person.")))
		throw new Error("situation.homeAssistant.people must be a list of person.* entity ids");
	if (homeAssistant.weather !== undefined && !(typeof homeAssistant.weather === "string" && homeAssistant.weather.startsWith("weather.")))
		throw new Error("situation.homeAssistant.weather must be a weather.* entity id");
	if (!(typeof homeAssistant.pollSeconds === "number" && homeAssistant.pollSeconds >= 30))
		throw new Error("situation.homeAssistant.pollSeconds must be 30 or more");
	return { calendars: calendars.map(expandHome), homeAssistant };
}

function patterTiming(given: Config["patter"]): Config["patter"] {
	const positive = (n: unknown) => typeof n === "number" && n > 0;
	if (!positive(given.openAfterSeconds)) throw new Error("patter.openAfterSeconds must be a positive number");
	if (!Array.isArray(given.gapsSeconds) || given.gapsSeconds.length === 0 || !given.gapsSeconds.every(positive))
		throw new Error("patter.gapsSeconds must be a list of positive numbers");
	return given;
}

export type PromptFiles = Pick<Config, "soulFile" | "memoryFile" | "journalFile" | "heartbeatFile" | "instructionsFile">;

/** The prompt files as they are now; /reload calls this again so files made since startup are found. */
export function promptFiles(p: Pick<Paths, "config" | "data">): PromptFiles {
	const soulFile = join(p.data, "SOUL.org");
	const instructionsFile = join(p.config, "AGENTS.md");
	const soul = existsSync(soulFile);
	return {
		soulFile: soul ? soulFile : undefined,
		memoryFile: soul ? join(p.data, "MEMORY.org") : undefined,
		journalFile: soul ? join(p.data, "JOURNAL.org") : undefined,
		heartbeatFile: soul ? join(p.data, "HEARTBEAT.org") : undefined,
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
