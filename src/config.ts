// Paths and runtime configuration. Configuration is read in place from layered directories, least specific first,
// such as harness defaults in Git, personal files, and this machine's overrides. Each may hold config.json (merged),
// AGENTS.md, and SOUL.md (most specific wins).
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export type HerdrHost = { readonly ssh?: string };

export type Config = {
	readonly model: { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string };
	/** Pi's models.json, read for the configured provider so codex-lb is defined in one place. */
	readonly providersFile: string;
	/** dotenv files read for provider keys at startup; values never reach the model. Empty under systemd. */
	readonly envFiles: readonly string[];
	readonly contextCap: number;
	/** SOUL.md and AGENTS.md from the most specific layer that has them. */
	readonly soulFile: string | undefined;
	readonly instructionsFile: string | undefined;
	/** The host that runs the daemon; elsewhere the client commands run there over SSH. */
	readonly daemonHost: string | undefined;
	readonly skillDirs: readonly string[];
	readonly org: { readonly root: string; readonly agendaFiles: string };
	readonly herdr: {
		readonly session: string;
		/** This machine's name, as Org host tags and herdr: links use it. */
		readonly host: string;
		/** Other machines reached read-only over SSH. */
		readonly hosts: Readonly<Record<string, HerdrHost>>;
		readonly allowPrompt: boolean;
	};
	readonly telegram?: { readonly tokenEnv: string; readonly allowedUserIds: readonly number[] };
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

/** The layers' config.json files merged over the defaults. Missing files are skipped. */
export function loadConfig(p: Paths = paths()): Config {
	let raw: Record<string, any> = {};
	for (const dir of p.layers) {
		const file = join(dir, "config.json");
		try {
			raw = merge(raw, JSON.parse(readFileSync(file, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${file}: ${(error as Error).message}`);
		}
	}
	if (!raw.model?.provider || !raw.model?.modelId) throw new Error(`No model configured in ${p.layers.join(", ")}`);
	const layerFile = (name: string) => [...p.layers].reverse().map((dir) => join(dir, name)).find((f) => existsSync(f));
	const herdr = { ...DEFAULTS.herdr, ...raw.herdr };
	const org = { ...DEFAULTS.org, ...raw.org };
	return {
		model: { thinkingLevel: "medium", ...raw.model },
		providersFile: expandHome(raw.providersFile ?? DEFAULTS.providersFile),
		envFiles: (raw.envFiles ?? DEFAULTS.envFiles).map(expandHome),
		contextCap: raw.contextCap ?? DEFAULTS.contextCap,
		soulFile: layerFile("SOUL.md"),
		instructionsFile: layerFile("AGENTS.md"),
		daemonHost: raw.daemonHost,
		skillDirs: (raw.skillDirs ?? DEFAULTS.skillDirs).map(expandHome),
		org: { root: expandHome(org.root), agendaFiles: expandHome(org.agendaFiles) },
		herdr: {
			session: herdr.session,
			host: herdr.host ?? shortHostname(),
			hosts: herdr.hosts,
			allowPrompt: herdr.allowPrompt === true,
		},
		...(raw.telegram
			? {
					telegram: {
						tokenEnv: raw.telegram.tokenEnv ?? "JUNE_TELEGRAM_BOT_TOKEN",
						allowedUserIds: (raw.telegram.allowedUserIds ?? []).map(Number),
					},
				}
			: {}),
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
