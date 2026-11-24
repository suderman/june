// Provider accounts on this host (`june accounts`, `june quota`). Each numbered login, such as claude2 or codex3, gets a
// folder under ~/.local/state/june/accounts that keeps only that login's own files and links everything else, sessions
// included, to the harness's usual home, so a session started on one account resumes on another. A wrapper of the
// same name in ~/.local/state/june/bin, linked into ~/.local/bin, launches the harness with that folder. Which harnesses
// have how many accounts is `accounts` in config.json; who each number is, and the address each login must be, is the
// private ACCOUNTS.org table beside SOUL.org. Quota is read from each provider's usage endpoint with a login's own token,
// as CLIProxyAPI's sampler did; tokens are read, never refreshed or printed.
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type Run, runProcess } from "./tools/herdr.ts";

export type Provider = "openai" | "anthropic" | "google";
export type HarnessName = "claude" | "codex" | "pi" | "opencode" | "agy";

type Harness = {
	provider: Provider;
	/** The variable that points the harness at an account folder; none means one login per host, in the harness's own place. */
	env?: string;
	/** The harness's usual home, relative to $HOME, whose contents the account folders share. */
	base: string;
	/** Subdirectory inside the account folder where the harness reads its files (e.g. XDG_DATA_HOME/opencode). */
	subdir?: string;
	/** Extra export lines emitted by the wrapper after env. */
	extraEnv?: () => string[];
	/** Files each account folder keeps for itself. */
	own: readonly string[];
	/** What the wrapper runs: the first of this name on PATH that is not one of June's wrappers. */
	command: string;
	/** A settings file an account folder keeps as an adapted copy of the shared one. */
	settings?: { file: string; adapt: (shared: Record<string, unknown>) => Record<string, unknown> };
};

export const HARNESSES: Record<HarnessName, Harness> = {
	// claude-direct clears proxy settings and keeps the permission default; it honours CLAUDE_CONFIG_DIR.
	claude: { provider: "anthropic", env: "CLAUDE_CONFIG_DIR", base: ".claude", own: [".credentials.json", ".claude.json"], command: "claude-direct" },
	codex: { provider: "openai", env: "CODEX_HOME", base: ".codex", own: ["auth.json", "auth.json.lock", "auth.lock", "models_cache.json"], command: "codex" },
	// Each Pi account folder uses its own ChatGPT login under openai-codex.
	pi: {
		provider: "openai",
		env: "PI_CODING_AGENT_DIR",
		base: ".pi/agent",
		own: ["auth.json", "settings.json"],
		command: "pi",
		settings: {
			file: "settings.json",
			adapt: (shared) => ({
				...shared,
				defaultProvider: "openai-codex",
				...(Array.isArray(shared.enabledModels)
					? { enabledModels: shared.enabledModels.map((m) => (typeof m === "string" ? m.replace(/^[^/:]+\//, "openai-codex/") : m)) }
					: {}),
			}),
		},
	},
	// OpenCode reads auth.json from $XDG_DATA_HOME/opencode and its SQLite store from OPENCODE_DB; pointing OPENCODE_DB
	// directly at the shared database keeps -wal and -shm beside it instead of split across account folders.
	opencode: {
		provider: "openai",
		env: "XDG_DATA_HOME",
		base: ".local/share/opencode",
		subdir: "opencode",
		own: ["auth.json", "opencode.db", "opencode.db-shm", "opencode.db-wal"],
		extraEnv: () => ['export OPENCODE_DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"'],
		command: "opencode",
	},
	// Antigravity keeps its login in the system keyring, one per host, so it has no account folder.
	agy: { provider: "google", base: ".gemini", own: [], command: "agy" },
};

export const PROVIDERS: Record<Provider, string> = { openai: "ChatGPT", anthropic: "Claude", google: "Antigravity" };

export type AccountsConfig = { harnesses: Partial<Record<HarnessName, number>>; commands: Partial<Record<HarnessName, string>> };

/** config.json's `accounts`: {"claude": 2, "codex": 4, ...}, with optional "commands": {"codex": "codex"}. */
export function accountsConfig(raw: unknown): AccountsConfig {
	if (raw === undefined) return { harnesses: {}, commands: {} };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("accounts must be an object of harness counts");
	const { commands = {}, ...counts } = raw as Record<string, unknown>;
	const harnesses: AccountsConfig["harnesses"] = {};
	for (const [name, count] of Object.entries(counts)) {
		if (!(name in HARNESSES)) throw new Error(`accounts.${name}: unknown harness; known are ${Object.keys(HARNESSES).join(", ")}`);
		if (!(Number.isInteger(count) && (count as number) >= 1 && (count as number) <= 9)) throw new Error(`accounts.${name} must be a count from 1 to 9`);
		if (!HARNESSES[name as HarnessName].env && (count as number) > 1)
			throw new Error(`accounts.${name}: one account per host, since its login lives in the system keyring`);
		harnesses[name as HarnessName] = count as number;
	}
	if (typeof commands !== "object" || commands === null || Array.isArray(commands)) throw new Error("accounts.commands must be an object");
	for (const [name, command] of Object.entries(commands)) {
		if (!(name in HARNESSES)) throw new Error(`accounts.commands.${name}: unknown harness`);
		if (!(typeof command === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(command))) throw new Error(`accounts.commands.${name} must be a command name`);
	}
	return { harnesses, commands: commands as AccountsConfig["commands"] };
}

export type People = { labels: Map<number, string>; emails: Map<Provider, Map<number, string>> };

/** ACCOUNTS.org's table: a Number column, an optional Label, and one column per provider (OpenAI, Anthropic, Google). */
export function parseAccountsOrg(text: string): People {
	const people: People = { labels: new Map(), emails: new Map() };
	const rows = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|") && !/^\|[-+]+\|?$/.test(l));
	const cells = (row: string) => row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
	const header = rows.shift();
	if (!header) return people;
	const columns = cells(header).map((c) => c.toLowerCase());
	const number = columns.findIndex((c) => c === "number" || c === "#");
	if (number < 0) return people;
	const label = columns.indexOf("label");
	const providers = (Object.keys(PROVIDERS) as Provider[]).map((p) => [p, columns.indexOf(p)] as const).filter(([, i]) => i >= 0);
	for (const row of rows) {
		const c = cells(row);
		const n = Number(c[number]);
		if (!Number.isInteger(n) || n < 1) continue;
		if (label >= 0 && c[label]) people.labels.set(n, c[label]!);
		for (const [p, i] of providers) {
			if (!c[i]) continue;
			if (!people.emails.has(p)) people.emails.set(p, new Map());
			people.emails.get(p)!.set(n, c[i]!.toLowerCase());
		}
	}
	return people;
}

/** Account folders (root), June's wrappers (bin), where all of them are linked onto PATH (links, ~/.local/bin), and where
 * each harness's own launcher is handed to June (libexec): the host's configuration links ~/.local/libexec/june/pi to
 * its pi wrapper, and so on, off PATH, so June's plain names can hold ~/.local/bin. */
export type Places = { home: string; root: string; bin: string; links: string; libexec: string };

export function places(home = homedir()): Places {
	return {
		home,
		root: join(home, ".local/state/june/accounts"),
		bin: join(home, ".local/state/june/bin"),
		links: join(home, ".local/bin"),
		libexec: join(home, ".local/libexec/june"),
	};
}

export type Slot = { name: string; harness: HarnessName; number: number; provider: Provider; dir?: string };

export function slots(config: AccountsConfig, p: Places = places()): Slot[] {
	return (Object.entries(config.harnesses) as [HarnessName, number][]).flatMap(([harness, count]) =>
		Array.from({ length: count }, (_, i) => {
			const name = `${harness}${i + 1}`;
			const spec = HARNESSES[harness];
			return { name, harness, number: i + 1, provider: spec.provider, ...(spec.env ? { dir: join(p.root, name) } : {}) };
		}),
	);
}

/** The wrapper script for `slot`: the harness launcher handed over in libexec, else `command` from PATH. A configured
 * `command` skips the handover. */
export function wrapper(slot: Slot, command: string, p: Places = places(), handover = true): string {
	const spec = HARNESSES[slot.harness];
	const rel = (path: string) => `$HOME/${path.slice(p.home.length + 1)}`;
	return [
		"#!/bin/sh",
		`# ${slot.name}: ${slot.harness} on ${PROVIDERS[slot.provider]} account ${slot.number}. Written by \`june accounts apply\`; changes are overwritten.`,
		`export JUNE_ACCOUNT=${slot.name}`,
		"# Trust the folder this starts in, as the harness would after asking; the plain name has done it already.",
		`[ -n "\${JUNE_TRUSTED-}" ] || june accounts trust ${slot.name} >/dev/null 2>&1 || true`,
		"unset JUNE_TRUSTED",
		...(spec.env && slot.dir
			? [`export ${spec.env}="${rel(slot.dir)}"`, `[ -d "$${spec.env}" ] || { echo "${slot.name}: no account folder; run june accounts apply" >&2; exit 1; }`]
			: []),
		...(spec.extraEnv ? spec.extraEnv() : []),
		...(handover ? [`[ -x "${rel(join(p.libexec, slot.harness))}" ] && exec "${rel(join(p.libexec, slot.harness))}" "$@"`] : []),
		"# Otherwise the first command of this name on PATH that is not one of June's wrappers.",
		`june_bin="${rel(p.bin)}"`,
		"IFS=:",
		"for dir in $PATH; do",
		`  cmd="$dir/${command}"`,
		'  [ -x "$cmd" ] || continue',
		'  case "$(readlink -f "$cmd")" in "$june_bin"/*) continue ;; esac',
		'  exec "$cmd" "$@"',
		"done",
		`echo "${slot.name}: ${command} not found on PATH" >&2`,
		"exit 127",
		"",
	].join("\n");
}

export type Applied = { folders: string[]; links: number; wrappers: string[]; removed: string[]; problems: string[] };

const isLinkTo = (path: string, target: string) => {
	try {
		return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
	} catch {
		return false;
	}
};
const exists = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

/** Make each account folder, link its shared entries, write its wrapper and link it into ~/.local/bin. Never replaces a real file. */
export function apply(config: AccountsConfig, p: Places = places()): Applied {
	const result: Applied = { folders: [], links: 0, wrappers: [], removed: [], problems: [] };
	mkdirSync(p.bin, { recursive: true, mode: 0o700 });
	mkdirSync(p.links, { recursive: true });
	const wanted = slots(config, p);
	for (const slot of wanted) {
		const spec = HARNESSES[slot.harness];
		if (slot.dir) {
			const base = join(p.home, spec.base);
			if (!existsSync(base)) {
				result.problems.push(`${slot.name}: ${base} does not exist; start ${slot.harness} once first`);
				continue;
			}
			if (!existsSync(slot.dir)) {
				mkdirSync(slot.dir, { recursive: true, mode: 0o700 });
				result.folders.push(slot.dir);
			}
			chmodSync(slot.dir, 0o700);
			const linkEntries = (srcDir: string, dstDir: string, skip: readonly string[]) => {
				for (const entry of readdirSync(srcDir)) {
					if (skip.includes(entry)) continue;
					const target = join(srcDir, entry);
					const link = join(dstDir, entry);
					if (isLinkTo(link, target)) continue;
					if (exists(link)) {
						result.problems.push(`${slot.name}: ${entry} is the folder's own copy, not shared; move it aside to share ${target}`);
						continue;
					}
					symlinkSync(target, link);
					result.links++;
				}
			};
			let targetDir = slot.dir;
			if (spec.subdir) {
				// Share sibling entries of the XDG parent (e.g. ~/.local/share/*) so child tools see their own data.
				linkEntries(dirname(base), slot.dir, [spec.subdir]);
				targetDir = join(slot.dir, spec.subdir);
				if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true, mode: 0o700 });
				chmodSync(targetDir, 0o700);
			}
			linkEntries(base, targetDir, spec.own);
			if (spec.settings) {
				const shared = join(base, spec.settings.file);
				const values = existsSync(shared) ? (JSON.parse(readFileSync(shared, "utf8")) as Record<string, unknown>) : {};
				const content = JSON.stringify(spec.settings.adapt(values), null, 2) + "\n";
				const own = join(targetDir, spec.settings.file);
				if (lstatSync(own, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(own);
				if (!existsSync(own) || readFileSync(own, "utf8") !== content) writeFileSync(own, content, { mode: 0o600 });
			}
		}
		const configured = config.commands[slot.harness];
		install(slot.name, wrapper(slot, configured ?? spec.command, p, !configured), p.links, p, result);
	}
	const harnesses = Object.keys(config.harnesses) as HarnessName[];
	for (const harness of harnesses) {
		// Plain names once lived in ~/bin, which holds the user's own scripts; take June's links back out.
		const old = join(p.home, "bin", harness);
		if (isLinkTo(old, join(p.bin, harness))) rmSync(old);
		install(harness, autoWrapper(harness, wanted.filter((s) => s.harness === harness), p), p.links, p, result);
	}
	// Wrappers for accounts no longer configured go, with their links; account folders stay, since they hold logins.
	const names = new Set([...wanted.map((s) => s.name), ...harnesses]);
	for (const entry of readdirSync(p.bin)) {
		if (names.has(entry) || entry.endsWith(".tmp")) continue;
		const script = join(p.bin, entry);
		if (isLinkTo(join(p.links, entry), script)) rmSync(join(p.links, entry));
		rmSync(script);
		result.removed.push(entry);
	}
	return result;
}

/** Write wrapper NAME when it changed, and link it into DIR unless something else holds that name there. */
function install(name: string, content: string, dir: string, p: Places, result: Applied): void {
	const script = join(p.bin, name);
	if (!existsSync(script) || readFileSync(script, "utf8") !== content) {
		writeFileSync(`${script}.tmp`, content, { mode: 0o755 });
		renameSync(`${script}.tmp`, script);
		result.wrappers.push(name);
	}
	const link = join(dir, name);
	if (isLinkTo(link, script)) return;
	if (exists(link)) result.problems.push(`${link} exists and is not June's wrapper; left alone`);
	else symlinkSync(script, link);
}

/** Subcommands that act on one login, which the plain name must not pick for. */
const SIGN_IN: Record<HarnessName, readonly string[]> = { claude: ["auth", "login", "logout", "setup-token"], codex: ["login", "logout"], pi: ["auth"], opencode: ["auth", "providers"], agy: [] };

/** The plain-name wrapper (claude, codex, pi, agy): the account June picks from quota, or the only one. */
export function autoWrapper(harness: HarnessName, accounts: readonly Slot[], p: Places = places()): string {
	const rel = (path: string) => `$HOME/${path.slice(p.home.length + 1)}`;
	const names = accounts.map((s) => s.name).join(", ");
	const lines = [
		"#!/bin/sh",
		`# ${harness}: ${accounts.length > 1 ? `the account June picks from quota and resets (${names})` : `its one account, ${names}`}. Written by \`june accounts apply\`; changes are overwritten.`,
	];
	if (SIGN_IN[harness].length)
		lines.push(
			`case "\${1-}" in ${SIGN_IN[harness].join("|")}) echo "${harness} $1 acts on one login; use ${names}" >&2; exit 2 ;; esac`,
		);
	if (accounts.length > 1) lines.push(`slot=$(june accounts pick ${harness} --trust) || exit 1`, `JUNE_TRUSTED=1 exec "${rel(p.bin)}/$slot" "$@"`, "");
	else lines.push(`exec "${rel(p.bin)}/${accounts[0]!.name}" "$@"`, "");
	return lines.join("\n");
}

/** The command that signs `slot` in through its own wrapper, by device code where the harness offers one (a browser
 * callback on port 1455 collides with codex-lb). Antigravity signs in when it first starts. */
export function loginCommand(slot: Slot, expected?: string): string[] {
	switch (slot.harness) {
		case "claude":
			return [slot.name, "auth", "login", "--claudeai", ...(expected ? ["--email", expected] : [])];
		case "codex":
			return [slot.name, "login", "--device-auth"];
		case "pi":
			return [slot.name, "auth", "login", "openai-codex", "--no-browser"];
		case "opencode":
			return [slot.name, "auth", "login", "-p", "openai", "-m", "ChatGPT Pro/Plus (headless)"];
		case "agy":
			return [slot.name];
	}
}

/** The claims of a JWT, unverified; undefined when it is not one. */
export function claims(token: unknown): Record<string, any> | undefined {
	if (typeof token !== "string") return undefined;
	const part = token.split(".")[1];
	if (!part) return undefined;
	try {
		return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
	} catch {
		return undefined;
	}
}

const emailOf = (c: Record<string, any> | undefined): string | undefined =>
	(c?.email ?? c?.["https://api.openai.com/profile"]?.email)?.toLowerCase?.();

const readJson = (file: string): any => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

/** A login's bearer token, expiry (epoch ms), account address and provider-specific extras. Never logged. */
export type Login = { email?: string; token?: string; expires?: number; accountId?: string; source: string };

/** The login in `slot` on this host, if any. */
export async function login(slot: Slot, run: Run = runProcess): Promise<Login | undefined> {
	const dir = slot.dir;
	switch (slot.harness) {
		case "claude": {
			const state = readJson(join(dir!, ".claude.json"));
			const oauth = readJson(join(dir!, ".credentials.json"))?.claudeAiOauth;
			if (!oauth?.accessToken) return undefined;
			return { email: state?.oauthAccount?.emailAddress?.toLowerCase(), token: oauth.accessToken, expires: oauth.expiresAt, source: slot.name };
		}
		case "codex": {
			const tokens = readJson(join(dir!, "auth.json"))?.tokens;
			if (!tokens?.access_token) return undefined;
			const id = claims(tokens.id_token);
			const exp = claims(tokens.access_token)?.exp;
			return {
				email: emailOf(id),
				token: tokens.access_token,
				...(typeof exp === "number" ? { expires: exp * 1000 } : {}),
				accountId: tokens.account_id ?? id?.["https://api.openai.com/auth"]?.chatgpt_account_id,
				source: slot.name,
			};
		}
		case "pi": {
			const entry = readJson(join(dir!, "auth.json"))?.["openai-codex"];
			if (!entry?.access) return undefined;
			const c = claims(entry.access);
			return {
				email: emailOf(c),
				token: entry.access,
				expires: entry.expires,
				accountId: entry.accountId ?? c?.["https://api.openai.com/auth"]?.chatgpt_account_id,
				source: slot.name,
			};
		}
		case "opencode": {
			const entry = readJson(join(dir!, "opencode/auth.json"))?.openai;
			if (entry?.type !== "oauth" || !entry?.access) return undefined;
			const c = claims(entry.access);
			return {
				email: emailOf(c),
				token: entry.access,
				expires: entry.expires,
				accountId: entry.accountId ?? c?.["https://api.openai.com/auth"]?.chatgpt_account_id,
				source: slot.name,
			};
		}
		case "agy": {
			let secret: any;
			try {
				secret = JSON.parse(await run(["secret-tool", "lookup", "service", "gemini", "username", "antigravity"], 10_000));
			} catch {
				return undefined;
			}
			const token = secret?.token;
			if (!token?.access_token) return undefined;
			const expires = Date.parse(token.expiry ?? "");
			return { email: secret.id_token_email?.toLowerCase(), token: token.access_token, ...(Number.isFinite(expires) ? { expires } : {}), source: slot.name };
		}
	}
}

export type SlotStatus = Slot & { label?: string; expected?: string; email?: string; loggedIn: boolean; problems: string[] };

/** Each configured login on this host: present, as whom, and whether that is who its number says. */
export async function status(config: AccountsConfig, people: People, p: Places = places(), run: Run = runProcess): Promise<SlotStatus[]> {
	const out: SlotStatus[] = [];
	for (const slot of slots(config, p)) {
		const expected = people.emails.get(slot.provider)?.get(slot.number);
		const label = people.labels.get(slot.number);
		const problems: string[] = [];
		if (slot.dir && !existsSync(slot.dir)) problems.push("no account folder; run june accounts apply");
		if (!existsSync(join(p.links, slot.name))) problems.push("no wrapper on PATH; run june accounts apply");
		const found = slot.dir && !existsSync(slot.dir) ? undefined : await login(slot, run);
		if (found?.email && expected && found.email !== expected) problems.push(`logged in as ${found.email}, but ACCOUNTS.org says ${expected}`);
		if (!expected) problems.push(`ACCOUNTS.org names no ${PROVIDERS[slot.provider]} account ${slot.number}`);
		out.push({ ...slot, ...(label ? { label } : {}), ...(expected ? { expected } : {}), ...(found?.email ? { email: found.email } : {}), loggedIn: !!found, problems });
	}
	return out;
}

export type QuotaGroup = { name: string; models: string[] };
export type Window = { name: string; remaining: number; resetAt?: number; seconds?: number; group?: string };
export type Quota = {
	provider: Provider;
	number: number;
	label?: string;
	email?: string;
	/** The login whose token was used. */
	source?: string;
	windows: Window[];
	/** Provider-reported model names or families belonging to each quota group, when the provider names them. */
	groups?: QuotaGroup[];
	plan?: string;
	/** Epoch seconds of the last successful read. */
	fetched?: number;
	error?: string;
	/** The windows are the last good read's, kept because the newest read failed (`error` says why). */
	stale?: boolean;
	/** Epoch seconds before which this account is not read again, after its provider rate limited it. */
	retryAt?: number;
};

const num = (v: unknown): number | undefined => {
	const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const epoch = (v: unknown): number | undefined => {
	const n = num(v);
	if (n !== undefined) return n > 1e12 ? n / 1000 : n;
	const t = typeof v === "string" ? Date.parse(v) : NaN;
	return Number.isFinite(t) ? t / 1000 : undefined;
};
const window = (name: string, used: unknown, reset: unknown, seconds?: number): Window | undefined => {
	const u = num(used);
	if (u === undefined) return undefined;
	const resetAt = epoch(reset);
	return { name, remaining: Math.round(Math.max(0, Math.min(100, 100 - u)) * 10) / 10, ...(resetAt ? { resetAt } : {}), ...(seconds ? { seconds } : {}) };
};

/** ChatGPT's wham/usage: primary and secondary windows, named by length. */
export function openaiWindows(payload: any): { windows: Window[]; plan?: string } {
	const limits = payload?.rate_limit ?? {};
	const windows = ["primary_window", "secondary_window"].flatMap((key) => {
		const raw = limits[key] ?? {};
		const seconds = num(raw.limit_window_seconds);
		const name = seconds === 18000 ? "5 hour" : seconds === 604800 ? "Weekly" : "Quota";
		return window(name, raw.used_percent, raw.reset_at, seconds) ?? [];
	});
	return { windows, ...(payload?.plan_type ? { plan: String(payload.plan_type) } : {}) };
}

const titleCase = (slug: string) =>
	slug
		.split(/[_-]+/)
		.filter(Boolean)
		.map((part) => (part.toLowerCase() === "oauth" ? "OAuth" : part[0]!.toUpperCase() + part.slice(1).toLowerCase()))
		.join(" ");

/** Anthropic's oauth/usage: account-wide five_hour/seven_day plus any active scoped or promotional buckets. */
export function anthropicWindows(payload: any): { windows: Window[] } {
	const windows: Window[] = [];
	const push = (w: Window | undefined, group?: string) => {
		if (w) windows.push(group ? { ...w, group } : w);
	};
	push(window("5 hour", payload?.five_hour?.utilization, payload?.five_hour?.resets_at, 18000));
	push(window("Weekly", payload?.seven_day?.utilization, payload?.seven_day?.resets_at, 604800));
	const skip = new Set(["five_hour", "seven_day", "extra_usage"]);
	if (payload && typeof payload === "object") {
		for (const [key, value] of Object.entries(payload)) {
			if (skip.has(key) || !value || typeof value !== "object" || Array.isArray(value)) continue;
			const raw = value as Record<string, unknown>;
			if (num(raw.utilization) === undefined) continue;
			if (key.startsWith("seven_day_")) {
				const scope = titleCase(key.slice("seven_day_".length));
				push(window(`${scope} weekly`, raw.utilization, raw.resets_at, 604800), scope);
			} else if (key.startsWith("five_hour_")) {
				const scope = titleCase(key.slice("five_hour_".length));
				push(window(`${scope} 5 hour`, raw.utilization, raw.resets_at, 18000), scope);
			} else {
				const scope = titleCase(key);
				push(window(scope, raw.utilization, raw.resets_at), scope);
			}
		}
	}
	// Fallback to the newer limits[] array if top-level legacy keys are absent.
	if (!windows.length && Array.isArray(payload?.limits)) {
		for (const entry of payload.limits) {
			if (!entry || typeof entry !== "object") continue;
			const kind = String(entry.kind ?? "").toLowerCase();
			const group = typeof entry.scope === "string" && entry.scope ? titleCase(entry.scope) : undefined;
			const [name, seconds] =
				kind === "session" ? ["5 hour", 18000] : kind === "weekly_all" ? ["Weekly", 604800] : [group ? `${group} ${entry.group ?? kind}`.trim() : titleCase(kind || "Quota"), entry.group === "weekly" ? 604800 : entry.group === "session" ? 18000 : undefined];
			push(window(name, entry.percent ?? entry.utilization, entry.resets_at, seconds), group);
		}
	}
	return { windows };
}

function parseGroupModels(group: any): string[] {
	const direct = group?.models ?? group?.modelIds ?? group?.model_ids;
	if (Array.isArray(direct)) {
		return direct
			.map((m) => (typeof m === "string" ? m : typeof m?.displayName === "string" ? m.displayName : typeof m?.id === "string" ? m.id : ""))
			.map((s) => s.trim())
			.filter(Boolean);
	}
	const desc = typeof group?.description === "string" ? group.description : "";
	const colon = desc.indexOf(":");
	if (colon < 0) return [];
	return desc
		.slice(colon + 1)
		.split(",")
		.map((s: string) => s.trim().replace(/\.$/, ""))
		.filter(Boolean);
}

/** Antigravity's quota summary: buckets in groups such as Gemini models, each with a remaining fraction. */
export function googleWindows(payload: any): { windows: Window[]; groups?: QuotaGroup[] } {
	const windows: Window[] = [];
	const groups: QuotaGroup[] = [];
	for (const group of payload?.groups ?? []) {
		const title = group.displayName ?? group.display_name;
		if (!title) continue;
		const models = parseGroupModels(group);
		if (models.length) groups.push({ name: title, models });
		for (const bucket of group.buckets ?? []) {
			const raw = bucket.remainingFraction ?? bucket.remaining_fraction;
			const percent = typeof raw === "string" && raw.trim().endsWith("%");
			const remaining = num(percent ? raw.trim().slice(0, -1) : raw);
			if (remaining === undefined) continue;
			const period = String(bucket.window ?? "").trim().toLowerCase();
			const [name, seconds] = ["5h", "five-hour", "five_hour"].includes(period)
				? ["5 hour", 18000]
				: ["week", "weekly"].includes(period)
					? ["Weekly", 604800]
					: [bucket.displayName ?? bucket.display_name ?? (period || "Quota"), undefined];
			const w = window(name, 100 - remaining * (percent ? 1 : 100), bucket.resetTime ?? bucket.reset_time, seconds);
			if (w) windows.push({ ...w, group: title });
		}
	}
	return { windows, ...(groups.length ? { groups } : {}) };
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<any> }>;

async function getJson(fetcher: Fetch, url: string, headers: Record<string, string>, body?: unknown): Promise<any> {
	const response = await fetcher(url, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	if (response.status === 429) throw new Error("usage endpoint rate limited");
	if (response.status < 200 || response.status >= 300) throw new Error(`usage endpoint HTTP ${response.status}`);
	return response.json();
}

/** Read one login's quota windows from its provider. */
export async function readQuota(provider: Provider, l: Login, fetcher: Fetch = fetch as unknown as Fetch): Promise<{ windows: Window[]; groups?: QuotaGroup[]; plan?: string }> {
	const auth = { Authorization: `Bearer ${l.token}`, "Content-Type": "application/json" };
	switch (provider) {
		case "openai":
			return openaiWindows(
				await getJson(fetcher, "https://chatgpt.com/backend-api/wham/usage", {
					...auth,
					"User-Agent": "codex-tui/0.171.0",
					...(l.accountId ? { "ChatGPT-Account-Id": l.accountId } : {}),
				}),
			);
		case "anthropic":
			return anthropicWindows(
				await getJson(fetcher, "https://api.anthropic.com/api/oauth/usage", { ...auth, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-cli/2.1.330 (external, cli)" }),
			);
		case "google": {
			const headers = { ...auth, "User-Agent": "antigravity/hub/2.23.0 linux/amd64" };
			const assist = await getJson(fetcher, "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", headers, {
				metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
			});
			const project = typeof assist?.cloudaicompanionProject === "string" ? assist.cloudaicompanionProject : assist?.cloudaicompanionProject?.id;
			if (!project) throw new Error("Antigravity reported no project for this login");
			// daily-cloudcode-pa carries Antigravity's live usage; cloudcode-pa returns placeholder 100% buckets,
			// so only fall back if daily succeeds with no windows (never on an error, which would mask depletion).
			const primary = googleWindows(await getJson(fetcher, "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", headers, { project }));
			if (primary.windows.length) return primary;
			const fallback = googleWindows(await getJson(fetcher, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", headers, { project }));
			if (fallback.windows.length) return fallback;
			throw new Error("usage response has no quota windows");
		}
	}
}

/** Every provider account the config names, with its quota read through the first login here that has a live token. */
export async function quotas(
	config: AccountsConfig,
	people: People,
	options: {
		places?: Places;
		run?: Run;
		fetcher?: Fetch;
		now?: number;
		only?: (q: { provider: Provider; number: number }) => boolean;
		/** Whether a login is in use, which stops June renewing its token; /proc by default. */
		busy?: (slot: Slot) => boolean;
	} = {},
): Promise<Quota[]> {
	const now = options.now ?? Date.now();
	const all = slots(config, options.places);
	const accounts = new Map<string, Slot[]>();
	// Pi, Codex and OpenCode logins refresh themselves when used; prefer the one most likely to hold a live token.
	const order: HarnessName[] = ["codex", "pi", "opencode", "claude", "agy"];
	for (const s of [...all].sort((a, b) => order.indexOf(a.harness) - order.indexOf(b.harness))) {
		const key = `${s.provider}${s.number}`;
		if (!accounts.has(key)) accounts.set(key, []);
		accounts.get(key)!.push(s);
	}
	const out: Quota[] = [];
	for (const candidates of accounts.values()) {
		const { provider, number } = candidates[0]!;
		if (options.only && !options.only({ provider, number })) continue;
		const label = people.labels.get(number);
		const email = people.emails.get(provider)?.get(number);
		const row: Quota = { provider, number, ...(label ? { label } : {}), ...(email ? { email } : {}), windows: [] };
		const found: Login[] = [];
		for (const s of candidates) {
			if (s.dir && !existsSync(s.dir)) continue;
			let l = await login(s, options.run);
			// An idle login's token lapses (Claude's after eight hours); renew it as the harness would.
			if (l?.token && l.expires !== undefined && l.expires <= now + 300_000) {
				const renewed = await refresh(s, { ...(options.fetcher ? { fetcher: options.fetcher } : {}), now, ...(options.busy ? { busy: options.busy } : {}) });
				if (renewed === "refreshed") l = await login(s, options.run);
			}
			if (l?.token) found.push(l);
		}
		const live = found.filter((l) => l.expires === undefined || l.expires > now + 60_000).filter((l) => !email || !l.email || l.email === email);
		if (!found.length) row.error = "no login on this host";
		else if (!live.length) row.error = "every login's token here has expired or is someone else's; using the account refreshes it";
		for (const l of live) {
			try {
				Object.assign(row, await readQuota(provider, l, options.fetcher), { source: l.source, fetched: Math.floor(now / 1000) });
				delete row.error;
				break;
			} catch (error) {
				row.error = `${l.source}: ${(error as Error).message}`;
			}
		}
		out.push(row);
	}
	return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.number - b.number);
}

/**
 * Fill any locally failed or empty quota rows (for instance, a worker host whose idle token lapsed) from a daemon
 * host's fresher read of the same provider account, checking email equality when both carry one.
 */
export function mergeQuotas(local: readonly Quota[], remote: readonly Quota[], host: string): Quota[] {
	return local.map((row) => {
		if (!row.error && row.fetched && row.windows.length) return row;
		const peer = remote.find(
			(r) =>
				r.provider === row.provider &&
				r.number === row.number &&
				!r.error &&
				r.fetched &&
				r.windows.length &&
				(!row.email || !r.email || row.email === r.email),
		);
		if (!peer) return row;
		return { ...peer, ...(row.label ? { label: row.label } : {}), source: `${host}/${peer.source ?? host}` };
	});
}

/** How long an account waits after its provider rate limits a read, and the least time between reads of it. */
export const BACKOFF_S = 600;
export const MIN_READ_S = 60;

/**
 * NEXT's rows over PREVIOUS's: a failed read keeps the account's last good windows, marked stale with why the read
 * failed, since a quota that could not be read is not an empty one; a rate limited read also waits BACKOFF_S before
 * the account is read again. A row the read skipped (still waiting) stays as it was.
 */
export function keepGood(previous: readonly Quota[], next: readonly Quota[], now = Date.now()): Quota[] {
	const at = Math.floor(now / 1000);
	const before = (q: Quota) => previous.find((p) => p.provider === q.provider && p.number === q.number);
	const out = next.map((row) => {
		const old = before(row);
		const limited = /rate limited/.test(row.error ?? "");
		if (!row.error) return { ...row, stale: undefined, retryAt: undefined };
		const wait = limited ? { retryAt: at + BACKOFF_S } : {};
		if (old && old.windows.length && old.fetched)
			return { ...old, error: row.error, stale: true, ...wait, ...(row.label ? { label: row.label } : {}), ...(row.email ? { email: row.email } : {}) };
		return { ...row, ...wait };
	});
	for (const old of previous) if (!out.some((q) => q.provider === old.provider && q.number === old.number)) out.push(old);
	return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.number - b.number);
}

/** Whether an account may be read now: past any rate limit wait, and not read in the last MIN_READ_S. */
export function due(row: Quota | undefined, now = Date.now()): boolean {
	const at = now / 1000;
	if (!row) return true;
	if (row.retryAt && row.retryAt > at) return false;
	return !(row.fetched && !row.stale && !row.error && at - row.fetched < MIN_READ_S);
}

/** The saved quota file's rows and when they were saved, whatever their age; undefined when there is none. */
export function savedQuotas(file: string): { at: number; quotas: Quota[] } | undefined {
	const saved = readJson(file);
	return saved && Array.isArray(saved.quotas) && typeof saved.at === "number" ? { at: saved.at, quotas: saved.quotas } : undefined;
}

/**
 * The quota as the daemon host keeps it in FILE: its saved rows while they are under MAXAGE seconds old, else a new
 * read of the accounts that are due (see `due`), kept over the last good one (`keepGood`) and saved. One reader at a
 * time: while another holds the read's lock, the saved rows stand. FORCE reads every due account whatever the age.
 * Only the daemon's host reads providers; other hosts ask its listener (`june quota`, GET /quota).
 */
export async function sharedQuotas(
	config: AccountsConfig,
	people: People,
	file: string,
	options: { maxAge: number; force?: boolean; now?: number; read?: typeof quotas } = { maxAge: 300 },
): Promise<Quota[]> {
	const now = options.now ?? Date.now();
	const saved = savedQuotas(file);
	if (saved && !options.force && now / 1000 - saved.at < options.maxAge) return saved.quotas;
	const lock = `${file}.lock`;
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	try {
		// A lock older than two minutes, by the real clock, is a reader that died.
		if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 120_000) rmSync(lock, { force: true });
		writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
	} catch {
		return saved?.quotas ?? [];
	}
	try {
		const previous = saved?.quotas ?? [];
		const fresh = await (options.read ?? quotas)(config, people, { now, only: (q) => due(previous.find((p) => p.provider === q.provider && p.number === q.number), now) });
		const rows = keepGood(previous, fresh, now);
		save(file, rows, now);
		return rows;
	} finally {
		rmSync(lock, { force: true });
	}
}

/** The daemon host's quota from its own files: config.json's accounts, DATA/ACCOUNTS.org, and STATE/quota.json. */
export async function hostQuotas(configFile: string, dataDir: string, stateDir: string, options: { maxAge: number; force?: boolean }): Promise<Quota[]> {
	const raw = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
	const config = accountsConfig(raw?.accounts);
	if (!Object.keys(config.harnesses).length) return [];
	const org = join(dataDir, "ACCOUNTS.org");
	const people = parseAccountsOrg(existsSync(org) ? readFileSync(org, "utf8") : "");
	return sharedQuotas(config, people, join(stateDir, "quota.json"), options);
}

/** The last quota read, kept in ~/.local/state/june/quota.json so repeated calls do not poll the providers. */
export function cached(file: string, maxAgeSeconds: number, now = Date.now()): Quota[] | undefined {
	const saved = readJson(file);
	if (!saved || !Array.isArray(saved.quotas) || typeof saved.at !== "number" || now / 1000 - saved.at > maxAgeSeconds) return undefined;
	return saved.quotas;
}

export function save(file: string, rows: Quota[], now = Date.now()): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(`${file}.tmp`, JSON.stringify({ at: Math.floor(now / 1000), quotas: rows }) + "\n", { mode: 0o600 });
	renameSync(`${file}.tmp`, file);
}

/** Whether a running process uses `slot`: its wrapper's JUNE_ACCOUNT, or the folder in the harness's variable. */
export function inUse(slot: Slot, proc = "/proc"): boolean {
	const env = HARNESSES[slot.harness].env;
	const marks = [`JUNE_ACCOUNT=${slot.name}`, ...(env && slot.dir ? [`${env}=${slot.dir}`] : [])];
	for (const pid of readdirSync(proc)) {
		if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
		let environ: string;
		try {
			environ = readFileSync(join(proc, pid, "environ"), "utf8");
		} catch {
			continue;
		}
		if (environ.split("\0").some((v) => marks.includes(v))) return true;
	}
	return false;
}

// The harnesses' own public OAuth clients. Antigravity's needs a client secret, so June does not refresh it; its quota
// reads again once agy runs.
const OAUTH: Partial<Record<Provider, { url: string; clientId: string; scope?: string }>> = {
	anthropic: { url: "https://platform.claude.com/v1/oauth/token", clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" },
	openai: { url: "https://auth.openai.com/oauth/token", clientId: "app_EMoamEEZ73f0CkXaXp7hrann", scope: "openid profile email" },
};

const writePrivate = (file: string, value: unknown) => {
	writeFileSync(`${file}.june-tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
	renameSync(`${file}.june-tmp`, file);
};

/**
 * Renew `slot`'s access token with its refresh token, as the harness would, and save both back in the harness's own
 * file. Only while no process uses the login, so June never races the harness for a refresh token that changes on use.
 */
export async function refresh(
	slot: Slot,
	options: { fetcher?: Fetch; now?: number; busy?: (slot: Slot) => boolean } = {},
): Promise<"refreshed" | "busy" | "unsupported" | "failed"> {
	const client = OAUTH[slot.provider];
	if (!client || !slot.dir) return "unsupported";
	if ((options.busy ?? inUse)(slot)) return "busy";
	if (slot.harness === "pi") return withAuthLock(join(slot.dir, "auth.json"), () => refreshInside(slot, client, options));
	return refreshInside(slot, client, options);
}

async function refreshInside(
	slot: Slot,
	client: { url: string; clientId: string; scope?: string },
	options: { fetcher?: Fetch; now?: number; busy?: (slot: Slot) => boolean },
): Promise<"refreshed" | "busy" | "unsupported" | "failed"> {
	const now = options.now ?? Date.now();
	const fetcher = options.fetcher ?? (fetch as unknown as Fetch);
	if (slot.harness === "pi") {
		// Inside Pi's lock: another process may have refreshed it while this one waited.
		const entry = readJson(join(slot.dir!, "auth.json"))?.["openai-codex"];
		if (typeof entry?.expires === "number" && entry.expires > now + 300_000) return "refreshed";
	}
	const lock = join(slot.dir!, ".june-refresh.lock");
	try {
		writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
	} catch {
		// Another june is refreshing it, or one died mid-way; a lock over a minute old is abandoned.
		if (now - (lstatSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? now) < 60_000) return "busy";
		rmSync(lock, { force: true });
		return refresh(slot, options);
	}
	try {
		const file = join(slot.dir!, slot.harness === "claude" ? ".credentials.json" : slot.harness === "opencode" ? "opencode/auth.json" : "auth.json");
		const saved = readJson(file);
		const current =
			slot.harness === "claude"
				? saved?.claudeAiOauth?.refreshToken
				: slot.harness === "codex"
					? saved?.tokens?.refresh_token
					: slot.harness === "opencode"
						? saved?.openai?.refresh
						: saved?.["openai-codex"]?.refresh;
		if (typeof current !== "string") return "failed";
		const response = await fetcher(client.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ grant_type: "refresh_token", refresh_token: current, client_id: client.clientId, ...(client.scope ? { scope: client.scope } : {}) }),
		});
		if (response.status < 200 || response.status >= 300) return "failed";
		const t = await response.json();
		if (typeof t?.access_token !== "string") return "failed";
		const expires = typeof t.expires_in === "number" ? now + t.expires_in * 1000 : (claims(t.access_token)?.exp ?? 0) * 1000;
		if (slot.harness === "claude") {
			Object.assign(saved.claudeAiOauth, { accessToken: t.access_token, refreshToken: t.refresh_token ?? current, expiresAt: expires });
		} else if (slot.harness === "codex") {
			Object.assign(saved.tokens, { access_token: t.access_token, refresh_token: t.refresh_token ?? current, ...(t.id_token ? { id_token: t.id_token } : {}) });
			saved.last_refresh = new Date(now).toISOString();
		} else if (slot.harness === "opencode") {
			Object.assign(saved.openai, { access: t.access_token, refresh: t.refresh_token ?? current, expires });
		} else {
			Object.assign(saved["openai-codex"], { access: t.access_token, refresh: t.refresh_token ?? current, expires });
		}
		writePrivate(file, saved);
		return "refreshed";
	} catch {
		return "failed";
	} finally {
		rmSync(lock, { force: true });
	}
}

/** What an account has to spend: the binding weekly window (the one with least left), the hours until it resets, and
 * the rate, weekly % per hour, at which the account would have to be spent to use it all before then. */
export type Budget = { weekly?: number; hours?: number; rate: number; five?: number; fiveHours?: number; group?: string; missingGroup?: boolean };
export type BudgetTarget = string | RegExp;

const EFFORT_SUFFIX = new Set(["low", "medium", "high", "xhigh", "max"]);
const GROUP_STOP = new Set(["and", "for", "the", "model", "models", "weekly", "hour", "limit", "quota", "pro", "preview", "tiered", "orchestrator"]);

function modelTokens(raw: string): string[] {
	const bare = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
	const tokens = bare
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	while (tokens.length > 1 && EFFORT_SUFFIX.has(tokens.at(-1)!)) tokens.pop();
	return tokens;
}

/**
 * Resolve which provider quota group a model (or RegExp) draws on. Prefers provider-reported group model lists
 * (`quota.groups`) over group display names so consolidations and codenames do not depend on hardcoded prefix maps.
 */
export function resolveGroup(quota: Quota, target: BudgetTarget): string | undefined {
	const groupNames = [...new Set(quota.windows.flatMap((w) => (w.group ? [w.group] : [])))];
	if (!groupNames.length) return undefined;
	if (target instanceof RegExp) return groupNames.find((g) => target.test(g));
	const qTokens = modelTokens(target);
	if (!qTokens.length) return undefined;
	const qNorm = qTokens.join(" ");
	const qSet = new Set(qTokens);
	const qDistinct = qTokens.filter((t) => /[a-z]/.test(t) && t.length >= 2 && !GROUP_STOP.has(t));

	const pickBest = (scored: [string, number][]): string | undefined => {
		const positive = scored.filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
		if (!positive.length) return undefined;
		if (positive.length > 1 && positive[0]![1] === positive[1]![1]) return undefined;
		return positive[0]![0];
	};

	if (quota.groups?.length) {
		const allowed = new Set(groupNames);
		const byListed: [string, number][] = [];
		for (const g of quota.groups) {
			if (!allowed.has(g.name)) continue;
			let best = 0;
			for (const listed of g.models) {
				const mTokens = modelTokens(listed);
				if (!mTokens.length) continue;
				const mNorm = mTokens.join(" ");
				const mSet = new Set(mTokens);
				const mDistinct = mTokens.filter((t) => /[a-z]/.test(t) && t.length >= 2 && !GROUP_STOP.has(t));
				let score = 0;
				if (qNorm === mNorm) score = 1000;
				else if (mTokens.every((t) => qSet.has(t))) score = 500 + mTokens.length * 10;
				else if (qTokens.every((t) => mSet.has(t))) score = 400 + qTokens.length * 10;
				else if (qDistinct.length && qDistinct.every((t) => mSet.has(t))) score = 300 + qDistinct.length * 10;
				else {
					const overlap = qDistinct.filter((t) => mDistinct.includes(t)).length;
					if (overlap > 0) score = 100 + overlap * 10;
				}
				if (score > best) best = score;
			}
			byListed.push([g.name, best]);
		}
		const matched = pickBest(byListed);
		if (matched) return matched;
	}

	const byName: [string, number][] = groupNames.map((name) => {
		const words = modelTokens(name).filter((t) => t.length >= 3 && !GROUP_STOP.has(t));
		const hits = words.filter((w) => qSet.has(w)).length;
		return [name, hits];
	});
	return pickBest(byName);
}

const budgetUsable = (b: Budget) =>
	b.weekly !== undefined && !(b.five !== undefined && b.five < 10 && (b.fiveHours ?? 1) > 0.25) && !(b.weekly < 1 && (b.hours ?? 1) > 0.25);

/**
 * An account's budget from its quota windows. When TARGET names a model (or RegExp), selects that model's quota group
 * plus any account-wide ungrouped windows. Never falls back to an unrelated group when a disjoint-group provider lacks
 * a match; without TARGET on a multi-group provider, picks the best independent group without mixing windows across groups.
 */
export function budget(quota: Quota, now = Date.now(), target?: BudgetTarget): Budget {
	const hoursTo = (w: Window) => (w.resetAt ? Math.max(0, (w.resetAt - now / 1000) / 3600) : (w.seconds ?? 604800) / 3600);
	const least = (ws: Window[]) => (ws.length ? ws.reduce((x, y) => (y.remaining < x.remaining ? y : x)) : undefined);
	const compute = (windows: Window[], group?: string): Budget => {
		const five = least(windows.filter((w) => w.name === "5 hour" || w.seconds === 18000));
		const weekly = least(windows.filter((w) => w.seconds === 604800 || /weekly/i.test(w.name))) ?? five;
		if (!weekly) return { rate: 0, ...(group ? { group } : {}) };
		return {
			weekly: weekly.remaining,
			hours: hoursTo(weekly),
			// A quarter hour floor keeps a reset minutes away from swamping everything else.
			rate: weekly.remaining / Math.max(hoursTo(weekly), 0.25),
			...(five ? { five: five.remaining, fiveHours: hoursTo(five) } : {}),
			...(group ? { group } : {}),
		};
	};

	const ungrouped = quota.windows.filter((w) => !w.group);
	const groupNames = [...new Set(quota.windows.flatMap((w) => (w.group ? [w.group] : [])))];
	if (!groupNames.length) return compute(ungrouped);

	if (target !== undefined) {
		const matched = resolveGroup(quota, target);
		if (matched) return compute([...ungrouped, ...quota.windows.filter((w) => w.group === matched)], matched);
		// Account-wide pools still cover models without their own sub-bucket (e.g. Anthropic seven_day without seven_day_opus).
		if (ungrouped.length) return compute(ungrouped);
		// Disjoint-group provider (e.g. Antigravity) with no matching group: fail closed instead of inventing capacity.
		return { rate: 0, missingGroup: true };
	}

	// No model specified: prefer account-wide windows when present; otherwise evaluate each group independently so
	// windows from unrelated pools are never mixed and one depleted pool does not hide a healthy sibling pool.
	if (ungrouped.length) return compute(ungrouped);
	const perGroup = groupNames.map((g) => compute(quota.windows.filter((w) => w.group === g), g));
	const usable = perGroup.filter(budgetUsable).sort((a, b) => b.rate - a.rate || (b.weekly ?? 0) - (a.weekly ?? 0));
	if (usable.length) return usable[0]!;
	return perGroup.sort((a, b) => (b.weekly ?? -1) - (a.weekly ?? -1))[0] ?? { rate: 0 };
}

export type Ranked = { slot: string; usable: boolean; score: number; reason: string; budget?: Budget };

/**
 * Rank a harness's logged-in accounts so no allowance goes to waste. The score is the budget's rate: weekly quota left
 * over hours until it resets, the pace needed to spend it all. A little left with the reset hours away outranks a lot
 * left with days to go, which is rationed. The five-hour window gates rather than scores: under 10% the account waits
 * for it, unless it resets within a quarter hour. An account with nothing left waits for its reset.
 */
export function rank(accounts: readonly { slot: Slot; quota?: Quota }[], now = Date.now(), target?: BudgetTarget): Ranked[] {
	const out = accounts.map(({ slot, quota }): Ranked & { number: number } => {
		const base = { slot: slot.name, number: slot.number, usable: false, score: 0 };
		if (!quota || quota.error || !quota.fetched || now / 1000 - quota.fetched > 600) return { ...base, reason: quota?.error ?? "no fresh quota" };
		const b = budget(quota, now, target);
		if (b.missingGroup) return { ...base, reason: typeof target === "string" ? `no quota group for ${target}` : "no matching quota group", budget: b };
		if (b.weekly === undefined) return { ...base, reason: "no quota windows", budget: b };
		if (b.five !== undefined && b.five < 10 && (b.fiveHours ?? 1) > 0.25) return { ...base, reason: `5 hour at ${b.five}%`, budget: b };
		if (b.weekly < 1 && (b.hours ?? 1) > 0.25) return { ...base, reason: `weekly at ${b.weekly}%`, budget: b };
		const reason = `${b.weekly}% weekly left, resets in ${b.hours! < 48 ? `${Math.round(b.hours!)}h` : `${Math.round(b.hours! / 24)}d`}`;
		return { ...base, usable: true, score: b.rate, reason, budget: b };
	});
	return out
		.sort((x, y) => Number(y.usable) - Number(x.usable) || y.score - x.score || x.number - y.number)
		.map(({ number: _, ...r }) => r);
}

/**
 * The folders a harness keys project trust on for DIR: its Git checkout's root, and for a worktree its main checkout's
 * too, since Claude and Codex trust a worktree through the main one; DIR itself outside Git. Codex, Claude and Antigravity
 * ask again inside a repository even when a parent folder is trusted, so each launch trusts its own root.
 */
export async function projectRoots(dir: string, run: Run = runProcess): Promise<string[]> {
	try {
		const [top, common] = (await run(["git", "-C", dir, "rev-parse", "--show-toplevel", "--git-common-dir"], 5_000)).trim().split("\n");
		if (!top) return [dir];
		const commonDir = common?.startsWith("/") ? common : join(dir, common ?? ".git");
		const main = commonDir.endsWith("/.git") ? dirname(commonDir) : top;
		// Git names the checkout by its resolved path; a harness started through a symlink (~/src/x linking to
		// ~/.config/x) keys trust on the path as typed, so record the root that way too.
		const inside = relative(top, realpathSync(dir));
		const typed = inside === "" ? dir : dir.endsWith(`/${inside}`) ? dir.slice(0, -inside.length - 1) : undefined;
		return [...new Set([main, top, ...(typed && !inside.startsWith("..") ? [typed] : [])])];
	} catch {
		return [dir];
	}
}

/** Record `roots` as trusted in `slot`'s harness, the way it records a "yes, trust this folder" itself. Returns roots added. */
export function trust(slot: Slot, roots: readonly string[], p: Places = places()): string[] {
	const added: string[] = [];
	const target = (file: string) => (existsSync(file) ? realpathSync(file) : file);
	switch (slot.harness) {
		case "claude": {
			// Each Claude login keeps its own .claude.json, holding trust beside the sign-in.
			const file = join(slot.dir!, ".claude.json");
			const state = readJson(file) ?? {};
			state.projects ??= {};
			for (const root of roots) {
				if (state.projects[root]?.hasTrustDialogAccepted === true) continue;
				state.projects[root] = { ...state.projects[root], hasTrustDialogAccepted: true };
				added.push(root);
			}
			if (added.length) writePrivate(file, state);
			return added;
		}
		case "codex": {
			const file = target(join(slot.dir!, "config.toml"));
			const text = existsSync(file) ? readFileSync(file, "utf8") : "";
			const tables = roots.filter((root) => !text.includes(`[projects.${JSON.stringify(root)}]`));
			if (tables.length) appendFileSync(file, tables.map((root) => `\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`).join(""));
			return tables;
		}
		case "pi": {
			const file = target(join(slot.dir!, "trust.json"));
			const state = readJson(file) ?? {};
			for (const root of roots) if (state[root] !== true) (state[root] = true), added.push(root);
			if (added.length) writePrivate(file, state);
			return added;
		}
		case "opencode":
			return [];
		case "agy": {
			const file = target(join(p.home, HARNESSES.agy.base, "antigravity-cli/settings.json"));
			const state = readJson(file) ?? {};
			const list: string[] = Array.isArray(state.trustedWorkspaces) ? state.trustedWorkspaces : [];
			for (const root of roots) if (!list.includes(root)) list.push(root), added.push(root);
			if (added.length) writePrivate(file, { ...state, trustedWorkspaces: list });
			return added;
		}
	}
}

/**
 * Run FN holding the lock Pi takes on an auth.json (proper-lockfile's convention: a `.lock` directory beside the
 * resolved file, stale after ten seconds), so June and Pi never refresh one login's token at once.
 */
export async function withAuthLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
	const lock = `${existsSync(file) ? realpathSync(file) : file}.lock`;
	for (let attempt = 0; ; attempt++) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const age = Date.now() - (lstatSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
			if (age > 10_000) rmSync(lock, { recursive: true, force: true });
			else if (attempt > 100) throw new Error(`${file} stays locked`);
			else await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	try {
		return await fn();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

type Credential = Record<string, unknown> & { type: string };

/**
 * A pi-ai credential store for June's own ChatGPT requests, served from the auth.json of one Pi account login. It
 * starts on the login with the most quota to spare (`rank`), stays on it so the provider's prompt cache keeps working,
 * and moves to the next when `choose` finds it unusable, which June checks at most every ten minutes. Writes, such as
 * pi-ai's token refresh, go through Pi's own lock.
 */
export class AccountCredentials {
	#slot?: Slot;
	#checked = 0;
	readonly #choose: () => Promise<Slot | undefined>;
	readonly #now: () => number;
	constructor(choose: () => Promise<Slot | undefined>, now: () => number = Date.now) {
		this.#choose = choose;
		this.#now = now;
	}
	/** The login June's requests use now, chosen afresh when ten minutes have passed. */
	async slot(): Promise<Slot> {
		if (!this.#slot || this.#now() - this.#checked > 600_000) {
			this.#checked = this.#now();
			const chosen = await this.#choose();
			if (chosen) this.#slot = chosen;
		}
		if (!this.#slot?.dir) throw new Error("No Pi account login with a ChatGPT sign-in is ready; run june accounts login");
		return this.#slot;
	}
	async #file(): Promise<string> {
		return join((await this.slot()).dir!, "auth.json");
	}
	async read(providerId: string): Promise<any> {
		return readJson(await this.#file())?.[providerId];
	}
	async list(): Promise<{ providerId: string; type: any }[]> {
		const saved = readJson(await this.#file()) ?? {};
		return Object.entries(saved).map(([providerId, c]) => ({ providerId, type: (c as Credential).type }));
	}
	async modify(providerId: string, fn: (current: any) => Promise<any>): Promise<any> {
		const file = await this.#file();
		return withAuthLock(file, async () => {
			const saved = readJson(file) ?? {};
			const next = await fn(saved[providerId]);
			if (next === undefined) return saved[providerId];
			writePrivate(file, { ...saved, [providerId]: next });
			return next;
		});
	}
	async delete(): Promise<void> {
		throw new Error("June does not sign out of Pi's account logins");
	}
}
