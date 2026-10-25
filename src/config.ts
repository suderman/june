// Paths and runtime configuration. Everything here is ordinary files under XDG directories.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type HerdrHost = { readonly ssh?: string };

export type Config = {
	readonly model: { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string };
	/** Pi's models.json, read for the configured provider so codex-lb is defined in one place. */
	readonly providersFile: string;
	/** dotenv files read for provider keys at startup; values never reach the model. Empty under systemd. */
	readonly envFiles: readonly string[];
	readonly contextCap: number;
	readonly soulFile: string;
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
	return {
		config,
		state,
		runtime,
		socket: env.JUNE_SOCKET ?? join(runtime, "june.sock"),
		database: join(state, "june.sqlite"),
	};
}

const DEFAULTS = {
	model: { provider: "codex-lb", modelId: "gpt-6-luna", thinkingLevel: "medium" },
	providersFile: "~/.pi/agent/models.json",
	envFiles: [] as string[],
	contextCap: 200_000,
	soulFile: "SOUL.md",
	skillDirs: ["~/profile/skills", "~/.agents/skills"],
	org: { root: "~/org", agendaFiles: "~/.local/state/org-dispatch/agenda-files" },
	herdr: { session: "default", hosts: {}, allowPrompt: false },
};

/** `config.json` in the config directory, over the defaults. A missing file means defaults. */
export function loadConfig(p: Paths = paths()): Config {
	let raw: Record<string, any> = {};
	try {
		raw = JSON.parse(readFileSync(join(p.config, "config.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`config.json: ${(error as Error).message}`);
	}
	const herdr = { ...DEFAULTS.herdr, ...raw.herdr };
	const org = { ...DEFAULTS.org, ...raw.org };
	return {
		model: { ...DEFAULTS.model, ...raw.model },
		providersFile: expandHome(raw.providersFile ?? DEFAULTS.providersFile),
		envFiles: (raw.envFiles ?? DEFAULTS.envFiles).map(expandHome),
		contextCap: raw.contextCap ?? DEFAULTS.contextCap,
		soulFile: inDir(p.config, raw.soulFile ?? DEFAULTS.soulFile),
		skillDirs: (raw.skillDirs ?? DEFAULTS.skillDirs).map(expandHome),
		org: { root: expandHome(org.root), agendaFiles: expandHome(org.agendaFiles) },
		herdr: {
			session: herdr.session,
			host: herdr.host ?? process.env.HOSTNAME ?? readHostname(),
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

/** A relative path is relative to `dir`; `~` and absolute paths stand. */
function inDir(dir: string, path: string): string {
	return path.startsWith("~") || path.startsWith("/") ? expandHome(path) : join(dir, path);
}

function readHostname(): string {
	try {
		return readFileSync("/etc/hostname", "utf8").trim().split(".")[0] ?? "localhost";
	} catch {
		return "localhost";
	}
}

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
