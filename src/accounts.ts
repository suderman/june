// Provider accounts on this host (`june accounts`, `june quota`). Each numbered login, such as claude2 or codex3, gets a
// folder under ~/.local/state/june/accounts that keeps only that login's own files and links everything else, sessions
// included, to the harness's usual home, so a session started on one account resumes on another. A wrapper of the
// same name in ~/.local/state/june/bin, linked into ~/.local/bin, launches the harness with that folder. Which harnesses
// have how many accounts is `accounts` in config.json; who each number is, and the address each login must be, is the
// private ACCOUNTS.org table beside SOUL.org. Quota is read from each provider's usage endpoint with a login's own token,
// as CLIProxyAPI's sampler did; tokens are read, never refreshed or printed.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Run, runProcess } from "./tools/herdr.ts";

export type Provider = "openai" | "anthropic" | "google";
export type HarnessName = "claude" | "codex" | "pi" | "agy";

type Harness = {
	provider: Provider;
	/** The variable that points the harness at an account folder; none means one login per host, in the harness's own place. */
	env?: string;
	/** The harness's usual home, relative to $HOME, whose contents the account folders share. */
	base: string;
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
	// Pi's shared settings name the proxy as the default provider; an account folder uses its ChatGPT login instead.
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
		...(spec.env && slot.dir
			? [`export ${spec.env}="${rel(slot.dir)}"`, `[ -d "$${spec.env}" ] || { echo "${slot.name}: no account folder; run june accounts apply" >&2; exit 1; }`]
			: []),
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
			for (const entry of readdirSync(base)) {
				if (spec.own.includes(entry)) continue;
				const target = join(base, entry);
				const link = join(slot.dir, entry);
				if (isLinkTo(link, target)) continue;
				if (exists(link)) {
					result.problems.push(`${slot.name}: ${entry} is the folder's own copy, not shared; move it aside to share ${target}`);
					continue;
				}
				symlinkSync(target, link);
				result.links++;
			}
			if (spec.settings) {
				const shared = join(base, spec.settings.file);
				const values = existsSync(shared) ? (JSON.parse(readFileSync(shared, "utf8")) as Record<string, unknown>) : {};
				const content = JSON.stringify(spec.settings.adapt(values), null, 2) + "\n";
				const own = join(slot.dir, spec.settings.file);
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
const SIGN_IN: Record<HarnessName, readonly string[]> = { claude: ["auth", "login", "logout", "setup-token"], codex: ["login", "logout"], pi: ["auth"], agy: [] };

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
	if (accounts.length > 1) lines.push(`slot=$(june accounts pick ${harness}) || exit 1`, `exec "${rel(p.bin)}/$slot" "$@"`, "");
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

export type Window = { name: string; remaining: number; resetAt?: number; seconds?: number; group?: string };
export type Quota = {
	provider: Provider;
	number: number;
	label?: string;
	email?: string;
	/** The login whose token was used. */
	source?: string;
	windows: Window[];
	plan?: string;
	/** Epoch seconds of the last successful read. */
	fetched?: number;
	error?: string;
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

/** Anthropic's oauth/usage: utilization per named window. */
export function anthropicWindows(payload: any): { windows: Window[] } {
	const keys: [string, string, number][] = [
		["five_hour", "5 hour", 18000],
		["seven_day", "Weekly", 604800],
		["seven_day_opus", "Opus weekly", 604800],
		["seven_day_sonnet", "Sonnet weekly", 604800],
		["seven_day_oauth_apps", "OAuth apps weekly", 604800],
	];
	return { windows: keys.flatMap(([key, name, seconds]) => window(name, payload?.[key]?.utilization, payload?.[key]?.resets_at, seconds) ?? []) };
}

/** Antigravity's quota summary: buckets in groups such as Gemini models, each with a remaining fraction. */
export function googleWindows(payload: any): { windows: Window[] } {
	const windows: Window[] = [];
	for (const group of payload?.groups ?? []) {
		const title = group.displayName ?? group.display_name;
		if (!title) continue;
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
	return { windows };
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<any> }>;

async function getJson(fetcher: Fetch, url: string, headers: Record<string, string>, body?: unknown): Promise<any> {
	const response = await fetcher(url, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	if (response.status === 429) throw new Error("usage endpoint rate limited");
	if (response.status < 200 || response.status >= 300) throw new Error(`usage endpoint HTTP ${response.status}`);
	return response.json();
}

/** Read one login's quota windows from its provider. */
export async function readQuota(provider: Provider, l: Login, fetcher: Fetch = fetch as unknown as Fetch): Promise<{ windows: Window[]; plan?: string }> {
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
			const assist = await getJson(fetcher, "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", headers, {
				metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
			});
			const project = typeof assist?.cloudaicompanionProject === "string" ? assist.cloudaicompanionProject : assist?.cloudaicompanionProject?.id;
			if (!project) throw new Error("Antigravity reported no project for this login");
			let last: Error = new Error("usage response has no quota windows");
			// Some endpoints omit the Gemini buckets; prefer the first that has them.
			let found: Window[] = [];
			for (const host of ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"]) {
				try {
					const { windows } = googleWindows(await getJson(fetcher, `https://${host}/v1internal:retrieveUserQuotaSummary`, headers, { project }));
					if (windows.length && !found.length) found = windows;
					if (windows.some((w) => /gemini/i.test(w.group ?? ""))) return { windows };
				} catch (error) {
					last = error as Error;
				}
			}
			if (found.length) return { windows: found };
			throw last;
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
	// Pi and Codex logins refresh themselves when used; prefer the one most likely to hold a live token.
	const order: HarnessName[] = ["codex", "pi", "claude", "agy"];
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
	const now = options.now ?? Date.now();
	const fetcher = options.fetcher ?? (fetch as unknown as Fetch);
	const lock = join(slot.dir, ".june-refresh.lock");
	try {
		writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
	} catch {
		// Another june is refreshing it, or one died mid-way; a lock over a minute old is abandoned.
		if (now - (lstatSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? now) < 60_000) return "busy";
		rmSync(lock, { force: true });
		return refresh(slot, options);
	}
	try {
		const file = join(slot.dir, slot.harness === "claude" ? ".credentials.json" : "auth.json");
		const saved = readJson(file);
		const current =
			slot.harness === "claude" ? saved?.claudeAiOauth?.refreshToken : slot.harness === "codex" ? saved?.tokens?.refresh_token : saved?.["openai-codex"]?.refresh;
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

export type Ranked = { slot: string; usable: boolean; score: number; reason: string };

/**
 * Rank a harness's logged-in accounts by quota. An account is usable while its five-hour window keeps 10% and every
 * weekly window 5%, or the window resets within a quarter of its floor. Accounts with a five-hour window come first:
 * that allowance resets soonest, so it is spent before an account that has only a weekly one. Within a tier, the
 * higher score wins, as claude-auto weighed it: each window's remaining share against the time left until it resets.
 * Scores cap at even pace, so accounts with plenty tie; then the weekly allowance that resets soonest goes first.
 */
export function rank(accounts: readonly { slot: Slot; quota?: Quota }[], now = Date.now()): Ranked[] {
	const out = accounts.map(({ slot, quota }) => {
		if (!quota || quota.error || !quota.fetched || now / 1000 - quota.fetched > 600)
			return { slot: slot.name, usable: false, score: 0, tier: 2, resets: Infinity, reason: quota?.error ?? "no fresh quota" };
		const pace = (w: Window, floor: number) => {
			const left = w.resetAt ? Math.max(0, w.resetAt - now / 1000) : (w.seconds ?? floor);
			return Math.max(0.01, Math.min(100, (w.remaining * (w.seconds ?? floor)) / Math.max(left, floor)));
		};
		const short = (w: Window, minimum: number, grace: number) =>
			w.remaining < minimum && !(w.resetAt !== undefined && w.resetAt - now / 1000 <= grace && w.remaining >= 1);
		const five = quota.windows.find((w) => w.name === "5 hour");
		const weekly = quota.windows.filter((w) => w.seconds === 604800 || /weekly/i.test(w.name));
		if (five && short(five, 10, 900)) return { slot: slot.name, usable: false, score: 0, tier: 2, resets: Infinity, reason: `5 hour at ${five.remaining}%` };
		const low = weekly.find((w) => short(w, 5, 21600));
		if (low) return { slot: slot.name, usable: false, score: 0, tier: 2, resets: Infinity, reason: `${low.name} at ${low.remaining}%` };
		const resets = Math.min(...weekly.map((w) => w.resetAt ?? Infinity));
		const weeklyPace = weekly.length ? Math.min(...weekly.map((w) => pace(w, 86400))) : 100;
		const score = five ? 1 / (0.65 / pace(five, 1800) + 0.35 / weeklyPace) : weeklyPace;
		return { slot: slot.name, usable: true, score, tier: five ? 0 : 1, resets, reason: five ? "five-hour and weekly quota" : "weekly quota only, kept for last" };
	});
	return out
		.sort((a, b) => a.tier - b.tier || b.score - a.score || a.resets - b.resets || a.slot.localeCompare(b.slot, undefined, { numeric: true }))
		.map(({ tier: _, resets: __, ...r }) => r);
}
