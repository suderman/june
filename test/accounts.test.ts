import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { accountsConfig, anthropicWindows, apply, autoWrapper, googleWindows, inUse, loginCommand, openaiWindows, parseAccountsOrg, places, quotas, rank, refresh, slots, status } from "../src/accounts.ts";
import { tempDir } from "./helpers.ts";

const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

test("accounts config takes harness counts and refuses unknown harnesses and a second keyring login", () => {
	assert.deepEqual(accountsConfig({ claude: 2, codex: 4 }), { harnesses: { claude: 2, codex: 4 }, commands: {} });
	assert.deepEqual(accountsConfig(undefined).harnesses, {});
	assert.throws(() => accountsConfig({ gemini: 1 }), /unknown harness/);
	assert.throws(() => accountsConfig({ codex: 0 }), /count from 1 to 9/);
	assert.throws(() => accountsConfig({ agy: 2 }), /system keyring/);
	assert.throws(() => accountsConfig({ commands: { codex: "codex --x" } }), /command name/);
});

test("ACCOUNTS.org maps numbers to labels and each provider's address", () => {
	const people = parseAccountsOrg(
		[
			"#+TITLE: Accounts",
			"",
			"| Number | Label    | OpenAI           | Anthropic | Google        |",
			"|--------+----------+------------------+-----------+---------------|",
			"|      1 | personal | A@example.com    | a@example.com | g@example.com |",
			"|      2 | work     | b@example.com    |           |               |",
		].join("\n"),
	);
	assert.equal(people.labels.get(2), "work");
	assert.equal(people.emails.get("openai")?.get(1), "a@example.com");
	assert.equal(people.emails.get("anthropic")?.get(2), undefined);
	assert.equal(people.emails.get("google")?.get(1), "g@example.com");
});

test("apply makes account folders that keep their own login and share the rest, with wrappers on PATH", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const home = tmp.dir;
	const p = places(home);
	mkdirSync(join(home, ".claude/projects"), { recursive: true });
	writeFileSync(join(home, ".claude/settings.json"), "{}");
	writeFileSync(join(home, ".claude/.credentials.json"), "{}");
	mkdirSync(join(home, ".pi/agent"), { recursive: true });
	writeFileSync(join(home, ".pi/agent/settings.json"), JSON.stringify({ defaultProvider: "cliproxyapi", theme: "x", enabledModels: ["cliproxyapi/gpt-6.2-sol:high"] }));
	writeFileSync(join(home, ".pi/agent/auth.json"), "{}");
	const config = accountsConfig({ claude: 2, pi: 1, agy: 1 });
	const first = apply(config, p);
	assert.deepEqual(first.problems, []);
	assert.deepEqual(first.wrappers.sort(), ["agy", "agy1", "claude", "claude1", "claude2", "pi", "pi1"]);
	assert.equal(readlinkSync(join(p.links, "claude")), join(p.bin, "claude"));
	const claude2 = join(p.root, "claude2");
	assert.equal(readlinkSync(join(claude2, "projects")), join(home, ".claude/projects"));
	assert.equal(existsSync(join(claude2, ".credentials.json")), false, "a login is never shared");
	assert.equal(lstatSync(claude2).mode & 0o777, 0o700);
	assert.deepEqual(JSON.parse(readFileSync(join(p.root, "pi1/settings.json"), "utf8")), { defaultProvider: "openai-codex", theme: "x", enabledModels: ["openai-codex/gpt-6.2-sol:high"] });
	assert.equal(existsSync(join(p.root, "pi1/auth.json")), false);
	assert.equal(existsSync(join(p.root, "agy1")), false, "agy keeps one login in the keyring");
	assert.equal(readlinkSync(join(p.links, "claude2")), join(p.bin, "claude2"));
	// Repeat applies change nothing; a real file where a link belongs is reported, not replaced.
	assert.deepEqual(apply(config, p), { folders: [], links: 0, wrappers: [], removed: [], problems: [] });
	writeFileSync(join(home, ".claude/history.jsonl"), "");
	writeFileSync(join(claude2, "history.jsonl"), "mine");
	const again = apply(config, p);
	assert.match(again.problems.join("\n"), /claude2: history\.jsonl is the folder's own copy/);
	assert.equal(readFileSync(join(claude2, "history.jsonl"), "utf8"), "mine");
	// Dropping an account removes its wrapper and link but keeps its folder and login.
	const fewer = apply(accountsConfig({ claude: 1, pi: 1, agy: 1 }), p);
	assert.deepEqual(fewer.removed, ["claude2"]);
	assert.equal(existsSync(join(p.links, "claude2")), false);
	assert.equal(existsSync(claude2), true);
});

test("a wrapper runs the real command with its account folder, skipping June's own wrappers", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const home = tmp.dir;
	const p = places(home);
	mkdirSync(join(home, ".codex"), { recursive: true });
	const realBin = join(home, "real");
	mkdirSync(realBin);
	writeFileSync(join(realBin, "codex"), '#!/bin/sh\necho "$CODEX_HOME $JUNE_ACCOUNT $*"\n');
	chmodSync(join(realBin, "codex"), 0o755);
	apply(accountsConfig({ codex: 2 }), p);
	// A June wrapper named like the real command earlier on PATH must not be run again.
	mkdirSync(join(home, "first"));
	execFileSync("ln", ["-s", join(p.bin, "codex2"), join(home, "first", "codex")]);
	const out = execFileSync(join(p.links, "codex2"), ["exec", "hi"], { env: { HOME: home, PATH: `${join(home, "first")}:${realBin}:/run/current-system/sw/bin:/usr/bin:/bin` } }).toString();
	assert.equal(out.trim(), `${join(p.root, "codex2")} codex2 exec hi`);
});

test("usage payloads become quota windows", () => {
	assert.deepEqual(
		openaiWindows({
			plan_type: "plus",
			rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1800000000 }, secondary_window: { used_percent: 90, limit_window_seconds: 604800 } },
		}),
		{ plan: "plus", windows: [{ name: "5 hour", remaining: 75, resetAt: 1800000000, seconds: 18000 }, { name: "Weekly", remaining: 10, seconds: 604800 }] },
	);
	assert.deepEqual(anthropicWindows({ five_hour: { utilization: 7, resets_at: "2026-11-23T04:30:00Z" }, seven_day: null }).windows, [
		{ name: "5 hour", remaining: 93, resetAt: Date.parse("2026-11-23T04:30:00Z") / 1000, seconds: 18000 },
	]);
	assert.deepEqual(googleWindows({ groups: [{ displayName: "Gemini models", buckets: [{ remainingFraction: 0.4, window: "weekly" }, { remainingFraction: "80%", displayName: "Flash" }] }] }).windows, [
		{ name: "Weekly", remaining: 40, seconds: 604800, group: "Gemini models" },
		{ name: "Flash", remaining: 80, group: "Gemini models" },
	]);
});

test("quota reads each provider account once, through a live login that is the right person", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const home = tmp.dir;
	const p = places(home);
	mkdirSync(join(home, ".codex"), { recursive: true });
	mkdirSync(join(home, ".pi/agent"), { recursive: true });
	mkdirSync(join(home, ".claude"), { recursive: true });
	const config = accountsConfig({ codex: 2, pi: 2, claude: 1 });
	apply(config, p);
	const now = Date.parse("2026-11-22T20:00:00Z");
	const later = Math.floor(now / 1000) + 3600;
	// codex1 is expired, pi1 is live: account 1 is read through pi1. codex2 is someone else: account 2 has no usable login.
	writeFileSync(join(p.root, "codex1/auth.json"), JSON.stringify({ tokens: { access_token: jwt({ exp: later - 7200 }), id_token: jwt({ email: "a@x" }) } }));
	writeFileSync(join(p.root, "pi1/auth.json"), JSON.stringify({ "openai-codex": { access: jwt({ "https://api.openai.com/profile": { email: "a@x" }, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }), expires: now + 3_600_000 } }));
	writeFileSync(join(p.root, "codex2/auth.json"), JSON.stringify({ tokens: { access_token: jwt({ exp: later }), id_token: jwt({ email: "stranger@x" }) } }));
	writeFileSync(join(p.root, "claude1/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: now + 3_600_000 } }));
	writeFileSync(join(p.root, "claude1/.claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "A@X" } }));
	const people = parseAccountsOrg("| Number | Label | OpenAI | Anthropic |\n| 1 | personal | a@x | a@x |\n| 2 | work | b@x | |\n");
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const fetcher = async (url: string, init: { headers: Record<string, string> }) => {
		calls.push({ url, headers: init.headers });
		const body = url.includes("chatgpt") ? { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800 } } } : { five_hour: { utilization: 50 } };
		return { status: 200, json: async () => body };
	};
	const rows = await quotas(config, people, { places: p, fetcher, now });
	assert.deepEqual(
		rows.map((r) => [r.provider, r.number, r.source, r.error, r.windows.map((w) => w.remaining)]),
		[
			["anthropic", 1, "claude1", undefined, [50]],
			["openai", 1, "pi1", undefined, [90]],
			["openai", 2, undefined, "every login's token here has expired or is someone else's; using the account refreshes it", []],
		],
	);
	assert.equal(calls.find((c) => c.url.includes("chatgpt"))?.headers["ChatGPT-Account-Id"], "acct-1");
	const st = await status(config, people, p);
	assert.deepEqual(st.find((s) => s.name === "codex2")?.problems, ["logged in as stranger@x, but ACCOUNTS.org says b@x"]);
	assert.deepEqual(st.find((s) => s.name === "pi2")?.loggedIn, false);
});

test("each harness signs in through its own wrapper, by device code where it can", () => {
	const [claude2, codex3, pi1, agy1] = slots(accountsConfig({ claude: 2, codex: 3, pi: 1, agy: 1 }), places("/h")).filter((s) => ["claude2", "codex3", "pi1", "agy1"].includes(s.name));
	assert.deepEqual(loginCommand(claude2!, "b@x"), ["claude2", "auth", "login", "--claudeai", "--email", "b@x"]);
	assert.deepEqual(loginCommand(codex3!), ["codex3", "login", "--device-auth"]);
	assert.deepEqual(loginCommand(pi1!), ["pi1", "auth", "login", "openai-codex", "--no-browser"]);
	assert.deepEqual(loginCommand(agy1!), ["agy1"]);
});

test("the plain name runs the picked account, or the only one, and refuses sign-in commands", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const home = tmp.dir;
	const p = places(home);
	mkdirSync(join(home, ".codex"), { recursive: true });
	mkdirSync(join(home, "real"));
	writeFileSync(join(home, "real", "codex"), '#!/bin/sh\necho "$JUNE_ACCOUNT $*"\n');
	writeFileSync(join(home, "real", "june"), "#!/bin/sh\necho codex2\n");
	for (const f of ["codex", "june"]) chmodSync(join(home, "real", f), 0o755);
	apply(accountsConfig({ codex: 2 }), p);
	const env = { HOME: home, PATH: `${p.links}:${join(home, "real")}:/run/current-system/sw/bin:/usr/bin:/bin` };
	assert.equal(execFileSync("codex", ["exec", "hi"], { env }).toString().trim(), "codex2 exec hi");
	assert.throws(() => execFileSync("codex", ["login"], { env, stdio: "pipe" }), /use codex1, codex2/);
	const one = slots(accountsConfig({ agy: 1 }), p);
	assert.match(autoWrapper("agy", one, p), /exec "\$HOME\/\.local\/state\/june\/bin\/agy1" "\$@"/);
});

test("ranking spends five-hour allowances first, skips short accounts, and keeps a weekly-only account for last", () => {
	const now = Date.parse("2026-11-22T20:00:00Z");
	const at = (h: number) => now / 1000 + h * 3600;
	const config = accountsConfig({ codex: 4 });
	const [c1, c2, c3, c4] = slots(config, places("/h"));
	const q = (windows: object[]) => ({ provider: "openai" as const, number: 0, windows: windows as any, fetched: now / 1000 });
	const ranked = rank(
		[
			{ slot: c1!, quota: q([{ name: "Weekly", remaining: 100, seconds: 604800, resetAt: at(140) }]) },
			{ slot: c2!, quota: q([{ name: "5 hour", remaining: 98, seconds: 18000, resetAt: at(4) }, { name: "Weekly", remaining: 74, seconds: 604800, resetAt: at(40) }]) },
			{ slot: c3!, quota: q([{ name: "5 hour", remaining: 5, seconds: 18000, resetAt: at(3) }, { name: "Weekly", remaining: 90, seconds: 604800, resetAt: at(100) }]) },
			{ slot: c4!, quota: q([{ name: "5 hour", remaining: 100, seconds: 18000, resetAt: at(5) }, { name: "Weekly", remaining: 89, seconds: 604800, resetAt: at(120) }]) },
		],
		now,
	);
	assert.deepEqual(ranked.map((r) => [r.slot, r.usable]), [["codex2", true], ["codex4", true], ["codex1", true], ["codex3", false]]);
	assert.equal(ranked.at(-1)!.reason, "5 hour at 5%");
	assert.equal(rank([{ slot: c1! }], now)[0]!.usable, false);
	// Both well ahead of pace: the weekly allowance that resets sooner is spent first.
	const plenty = (h: number) => q([{ name: "5 hour", remaining: 100, seconds: 18000, resetAt: at(5) }, { name: "Weekly", remaining: 90, seconds: 604800, resetAt: at(h) }]);
	assert.deepEqual(rank([{ slot: c2!, quota: plenty(100) }, { slot: c3!, quota: plenty(30) }], now).map((r) => r.slot), ["codex3", "codex2"]);
});

test("an idle login's lapsed token is renewed into the harness's own file; a busy one is left alone", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const home = tmp.dir;
	const p = places(home);
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(join(home, ".codex"), { recursive: true });
	const config = accountsConfig({ claude: 1, codex: 1 });
	apply(config, p);
	const now = Date.parse("2026-11-22T20:00:00Z");
	const credentials = join(p.root, "claude1/.credentials.json");
	writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "r1", expiresAt: now - 1000, scopes: ["user:inference"] } }));
	writeFileSync(join(p.root, "claude1/.claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@x" } }));
	const posted: any[] = [];
	const fetcher = async (url: string, init: { body?: string }) => {
		if (url.includes("oauth/token")) {
			posted.push({ url, ...JSON.parse(init.body!) });
			return { status: 200, json: async () => ({ access_token: "new", refresh_token: "r2", expires_in: 28800 }) };
		}
		return { status: 200, json: async () => ({ five_hour: { utilization: 20 } }) };
	};
	const [claude1, codex1] = slots(config, p);
	assert.equal(await refresh(claude1!, { fetcher, now, busy: () => true }), "busy");
	assert.equal(JSON.parse(readFileSync(credentials, "utf8")).claudeAiOauth.refreshToken, "r1");
	const people = parseAccountsOrg("| Number | Anthropic |\n| 1 | a@x |\n");
	const rows = await quotas(config, people, { places: p, fetcher, now, busy: () => false });
	assert.deepEqual(rows.find((r) => r.provider === "anthropic")?.windows.map((w) => w.remaining), [80]);
	assert.deepEqual(posted[0], { url: "https://platform.claude.com/v1/oauth/token", grant_type: "refresh_token", refresh_token: "r1", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" });
	const saved = JSON.parse(readFileSync(credentials, "utf8")).claudeAiOauth;
	assert.deepEqual([saved.accessToken, saved.refreshToken, saved.expiresAt, saved.scopes], ["new", "r2", now + 28800_000, ["user:inference"]]);
	assert.equal(lstatSync(credentials).mode & 0o777, 0o600);
	assert.equal(existsSync(join(p.root, "claude1/.june-refresh.lock")), false);
	// A Codex login keeps its id token and records the refresh as Codex does.
	writeFileSync(join(p.root, "codex1/auth.json"), JSON.stringify({ tokens: { access_token: "a", refresh_token: "c1", id_token: "keep", account_id: "x" }, last_refresh: "then" }));
	assert.equal(await refresh(codex1!, { fetcher, now, busy: () => false }), "refreshed");
	const codex = JSON.parse(readFileSync(join(p.root, "codex1/auth.json"), "utf8"));
	assert.deepEqual([codex.tokens.access_token, codex.tokens.refresh_token, codex.tokens.id_token, codex.last_refresh], ["new", "r2", "keep", new Date(now).toISOString()]);
	assert.equal(posted[1].client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
});

test("a login is in use while a process carries its account or folder", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const p = places("/h");
	const [claude2] = slots(accountsConfig({ claude: 2 }), p).slice(1);
	const proc = join(tmp.dir, "proc");
	mkdirSync(join(proc, "41"), { recursive: true });
	writeFileSync(join(proc, "41", "environ"), "HOME=/h\0PATH=/bin\0");
	assert.equal(inUse(claude2!, proc), false);
	mkdirSync(join(proc, "42"));
	writeFileSync(join(proc, "42", "environ"), `HOME=/h\0CLAUDE_CONFIG_DIR=${join(p.root, "claude2")}\0`);
	assert.equal(inUse(claude2!, proc), true);
});

test("a numbered wrapper runs the launcher the host hands over in libexec, and plain names leave ~/bin", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const home = tmp.dir;
	const p = places(home);
	mkdirSync(join(home, ".pi/agent"), { recursive: true });
	mkdirSync(p.libexec, { recursive: true });
	writeFileSync(join(p.libexec, "pi"), '#!/bin/sh\necho "handed $PI_CODING_AGENT_DIR $*"\n');
	chmodSync(join(p.libexec, "pi"), 0o755);
	// A plain-name link June left in ~/bin before is taken back; the user's own script there stays.
	mkdirSync(p.bin, { recursive: true });
	writeFileSync(join(p.bin, "pi"), "old");
	mkdirSync(join(home, "bin"));
	execFileSync("ln", ["-s", join(p.bin, "pi"), join(home, "bin", "pi")]);
	writeFileSync(join(home, "bin", "mine"), "#!/bin/sh\n");
	// Something else holding a name in ~/.local/bin is reported and left alone.
	mkdirSync(p.links, { recursive: true });
	writeFileSync(join(p.links, "agy"), "#!/bin/sh\n");
	const result = apply(accountsConfig({ pi: 1, agy: 1 }), p);
	assert.deepEqual(result.problems, [`${join(p.links, "agy")} exists and is not June's wrapper; left alone`]);
	assert.equal(existsSync(join(home, "bin", "pi")), false);
	assert.equal(existsSync(join(home, "bin", "mine")), true);
	const env = { HOME: home, PATH: "/run/current-system/sw/bin:/usr/bin:/bin" };
	assert.equal(execFileSync(join(p.links, "pi"), ["-p", "hi"], { env }).toString().trim(), `handed ${join(p.root, "pi1")} -p hi`);
	// A configured command skips the handover.
	const configured = apply(accountsConfig({ pi: 1, commands: { pi: "pi-other" } }), p);
	assert.ok(configured.wrappers.includes("pi1"));
	assert.doesNotMatch(readFileSync(join(p.bin, "pi1"), "utf8"), /libexec/);
});
