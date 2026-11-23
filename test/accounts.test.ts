import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AccountCredentials, accountsConfig, anthropicWindows, apply, withAuthLock, autoWrapper, budget, googleWindows, inUse, loginCommand, openaiWindows, parseAccountsOrg, places, projectRoots, quotas, rank, refresh, slots, status, trust } from "../src/accounts.ts";
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
	const [claude2, codex3, pi1, opencode2, agy1] = slots(accountsConfig({ claude: 2, codex: 3, pi: 1, opencode: 2, agy: 1 }), places("/h")).filter((s) =>
		["claude2", "codex3", "pi1", "opencode2", "agy1"].includes(s.name),
	);
	assert.deepEqual(loginCommand(claude2!, "b@x"), ["claude2", "auth", "login", "--claudeai", "--email", "b@x"]);
	assert.deepEqual(loginCommand(codex3!), ["codex3", "login", "--device-auth"]);
	assert.deepEqual(loginCommand(pi1!), ["pi1", "auth", "login", "openai-codex", "--no-browser"]);
	assert.deepEqual(loginCommand(opencode2!), ["opencode2", "auth", "login", "-p", "openai", "-m", "ChatGPT Pro/Plus (headless)"]);
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

test("ranking spends first what would otherwise be lost: weekly quota left over hours to its reset", () => {
	const now = Date.parse("2026-11-22T20:00:00Z");
	const at = (h: number) => now / 1000 + h * 3600;
	const config = accountsConfig({ codex: 4 });
	const [c1, c2, c3, c4] = slots(config, places("/h"));
	const q = (windows: object[]) => ({ provider: "openai" as const, number: 0, windows: windows as any, fetched: now / 1000 });
	const week = (remaining: number, h: number) => ({ name: "Weekly", remaining, seconds: 604800, resetAt: at(h) });
	const five = (remaining: number, h = 4) => ({ name: "5 hour", remaining, seconds: 18000, resetAt: at(h) });
	const ranked = rank(
		[
			// 80% over five days: about 0.67% an hour; no five-hour window, so nothing gates it.
			{ slot: c1!, quota: q([week(80, 120)]) },
			// 10% but resetting in two hours: 5% an hour, the most at risk of being wasted.
			{ slot: c2!, quota: q([five(90), week(10, 2)]) },
			// 10% with three days left: rationed.
			{ slot: c3!, quota: q([five(100), week(10, 72)]) },
			// Plenty of weekly, but the five-hour window is spent: it waits.
			{ slot: c4!, quota: q([five(5, 3), week(90, 30)]) },
		],
		now,
	);
	assert.deepEqual(ranked.map((r) => [r.slot, r.usable, Math.round(r.score * 100) / 100]), [["codex2", true, 5], ["codex1", true, 0.67], ["codex3", true, 0.14], ["codex4", false, 0]]);
	assert.equal(ranked[0]!.reason, "10% weekly left, resets in 2h");
	assert.equal(ranked.at(-1)!.reason, "5 hour at 5%");
	// A spent five-hour window about to reset, and an empty weekly about to reset, are usable again.
	assert.equal(rank([{ slot: c4!, quota: q([five(5, 0.1), week(90, 30)]) }], now)[0]!.usable, true);
	assert.equal(rank([{ slot: c4!, quota: q([five(50), week(0.5, 40)]) }], now)[0]!.reason, "weekly at 0.5%");
	assert.equal(rank([{ slot: c1! }], now)[0]!.usable, false);
});

test("an Antigravity budget reads the model group the agent draws on", () => {
	const now = Date.parse("2026-11-22T20:00:00Z");
	const quota = {
		provider: "google" as const,
		number: 1,
		fetched: now / 1000,
		windows: [
			{ name: "Weekly", remaining: 66, seconds: 604800, resetAt: now / 1000 + 100 * 3600, group: "Gemini Models" },
			{ name: "Weekly", remaining: 20, seconds: 604800, resetAt: now / 1000 + 10 * 3600, group: "Claude and GPT models" },
		],
	};
	assert.equal(budget(quota, now, /gemini/i).weekly, 66);
	assert.equal(budget(quota, now).weekly, 20);
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

test("a project's trust root is its checkout, and a worktree's main checkout too; elsewhere the folder itself", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const repo = join(tmp.dir, "repo");
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", repo, ...args], { stdio: "pipe" });
	mkdirSync(join(repo, "sub"), { recursive: true });
	git("init", "-q", "-b", "main");
	git("commit", "-q", "--allow-empty", "-m", "x");
	git("worktree", "add", "-q", "-b", "other", join(tmp.dir, "wt"));
	assert.deepEqual(await projectRoots(join(repo, "sub")), [repo]);
	assert.deepEqual(await projectRoots(join(tmp.dir, "wt")), [repo, join(tmp.dir, "wt")]);
	mkdirSync(join(tmp.dir, "plain"));
	assert.deepEqual(await projectRoots(join(tmp.dir, "plain")), [join(tmp.dir, "plain")]);
	// Reached through a symlink, the root is also recorded under the path as typed, at the root or inside it.
	execFileSync("ln", ["-s", repo, join(tmp.dir, "link")]);
	assert.deepEqual((await projectRoots(join(tmp.dir, "link"))).sort(), [join(tmp.dir, "link"), repo].sort());
	assert.deepEqual((await projectRoots(join(tmp.dir, "link", "sub"))).sort(), [join(tmp.dir, "link"), repo].sort());
});

test("trust records a root the way each harness records its own yes, once", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const home = tmp.dir;
	const p = places(home);
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(join(home, ".codex"), { recursive: true });
	writeFileSync(join(home, ".codex/config.toml"), 'model_reasoning_effort = "high"\n');
	mkdirSync(join(home, ".pi/agent"), { recursive: true });
	writeFileSync(join(home, ".pi/agent/trust.json"), JSON.stringify({ "/a": true }));
	mkdirSync(join(home, ".gemini/antigravity-cli"), { recursive: true });
	writeFileSync(join(home, ".gemini/antigravity-cli/settings.json"), JSON.stringify({ toolPermission: "always-proceed", trustedWorkspaces: ["/a"] }));
	const config = accountsConfig({ claude: 1, codex: 1, pi: 1, agy: 1 });
	apply(config, p);
	writeFileSync(join(p.root, "claude1/.claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@x" }, projects: { "/r": { allowedTools: [] } } }));
	const [claude1, codex1, pi1, agy1] = slots(config, p);
	for (const slot of [claude1!, codex1!, pi1!, agy1!]) assert.deepEqual(trust(slot, ["/r"], p), ["/r"], slot.name);
	for (const slot of [claude1!, codex1!, pi1!, agy1!]) assert.deepEqual(trust(slot, ["/r"], p), [], `${slot.name} again`);
	const claude = JSON.parse(readFileSync(join(p.root, "claude1/.claude.json"), "utf8"));
	assert.deepEqual([claude.oauthAccount.emailAddress, claude.projects["/r"]], ["a@x", { allowedTools: [], hasTrustDialogAccepted: true }]);
	assert.equal(readFileSync(join(home, ".codex/config.toml"), "utf8"), 'model_reasoning_effort = "high"\n\n[projects."/r"]\ntrust_level = "trusted"\n');
	assert.ok(lstatSync(join(p.root, "codex1/config.toml")).isSymbolicLink(), "the shared config stays shared");
	assert.deepEqual(JSON.parse(readFileSync(join(home, ".pi/agent/trust.json"), "utf8")), { "/a": true, "/r": true });
	assert.deepEqual(JSON.parse(readFileSync(join(home, ".gemini/antigravity-cli/settings.json"), "utf8")), { toolPermission: "always-proceed", trustedWorkspaces: ["/a", "/r"] });
});

test("wrappers trust the folder they start in: the plain name through pick, a numbered one itself", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const home = tmp.dir;
	const p = places(home);
	mkdirSync(join(home, ".codex"), { recursive: true });
	mkdirSync(join(home, "real"));
	const calls = join(home, "calls");
	writeFileSync(join(home, "real", "codex"), "#!/bin/sh\necho ran\n");
	writeFileSync(join(home, "real", "june"), `#!/bin/sh\necho "$*" >> ${calls}\necho codex2\n`);
	for (const f of ["codex", "june"]) chmodSync(join(home, "real", f), 0o755);
	apply(accountsConfig({ codex: 2 }), p);
	const env = { HOME: home, PATH: `${p.links}:${join(home, "real")}:/run/current-system/sw/bin:/usr/bin:/bin` };
	execFileSync("codex", [], { env });
	execFileSync("codex1", [], { env });
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["accounts pick codex --trust", "accounts trust codex1"]);
});

test("June's ChatGPT credentials come from a Pi login, written under Pi's lock, and move when that login is spent", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const p = places(tmp.dir);
	mkdirSync(join(tmp.dir, ".pi/agent"), { recursive: true });
	const config = accountsConfig({ pi: 2 });
	apply(config, p);
	const [pi1, pi2] = slots(config, p);
	for (const [slot, token] of [[pi1!, "a1"], [pi2!, "a2"]] as const)
		writeFileSync(join(slot.dir!, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: token, refresh: "r", expires: 1 } }));
	let now = 0;
	let choice = pi1!;
	const store = new AccountCredentials(async () => choice, () => now);
	assert.equal((await store.read("openai-codex")).access, "a1");
	// A refresh writes back to the same login, and the lock is gone afterwards.
	await store.modify("openai-codex", async (current) => ({ ...current, access: "a1-new" }));
	assert.equal(JSON.parse(readFileSync(join(pi1!.dir!, "auth.json"), "utf8"))["openai-codex"].access, "a1-new");
	assert.equal(existsSync(join(pi1!.dir!, "auth.json.lock")), false);
	// It stays on its login until ten minutes pass, then takes the new choice.
	choice = pi2!;
	assert.equal((await store.read("openai-codex")).access, "a1-new");
	now = 600_001;
	assert.equal((await store.read("openai-codex")).access, "a2");
	// A stale lock left by a dead process is cleared; a fresh one is waited for.
	mkdirSync(join(pi2!.dir!, "auth.json.lock"));
	const old = new Date(Date.now() - 60_000);
	(await import("node:fs")).utimesSync(join(pi2!.dir!, "auth.json.lock"), old, old);
	assert.equal(await withAuthLock(join(pi2!.dir!, "auth.json"), async () => "ran"), "ran");
});

test("OpenCode account folders isolate auth.json under XDG_DATA_HOME while sharing the database and sibling XDG dirs", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const home = tmp.dir;
	const p = places(home);
	mkdirSync(join(home, ".local/share/opencode/storage"), { recursive: true });
	mkdirSync(join(home, ".local/share/other-app"), { recursive: true });
	writeFileSync(join(home, ".local/share/opencode/auth.json"), "{}");
	writeFileSync(join(home, ".local/share/opencode/opencode.db"), "db");
	writeFileSync(join(home, ".local/share/opencode/mcp-auth.json"), "{}");
	const config = accountsConfig({ opencode: 2 });
	const applied = apply(config, p);
	assert.deepEqual(applied.problems, []);
	assert.deepEqual(applied.wrappers.sort(), ["opencode", "opencode1", "opencode2"]);
	const oc1 = join(p.root, "opencode1");
	assert.equal(readlinkSync(join(oc1, "other-app")), join(home, ".local/share/other-app"));
	assert.equal(readlinkSync(join(oc1, "opencode/storage")), join(home, ".local/share/opencode/storage"));
	assert.equal(readlinkSync(join(oc1, "opencode/mcp-auth.json")), join(home, ".local/share/opencode/mcp-auth.json"));
	assert.equal(existsSync(join(oc1, "opencode/auth.json")), false, "auth.json is per account");
	assert.equal(existsSync(join(oc1, "opencode/opencode.db")), false, "database is opened directly via OPENCODE_DB");
	assert.deepEqual(apply(config, p), { folders: [], links: 0, wrappers: [], removed: [], problems: [] });

	// Wrapper sets XDG_DATA_HOME and OPENCODE_DB, and plain opencode refuses auth/providers subcommands.
	mkdirSync(join(home, "real"));
	writeFileSync(join(home, "real", "opencode"), '#!/bin/sh\necho "$XDG_DATA_HOME|$OPENCODE_DB|$JUNE_ACCOUNT|$*"\n');
	writeFileSync(join(home, "real", "june"), "#!/bin/sh\necho opencode1\n");
	for (const f of ["opencode", "june"]) chmodSync(join(home, "real", f), 0o755);
	const env = { HOME: home, PATH: `${p.links}:${join(home, "real")}:/run/current-system/sw/bin:/usr/bin:/bin` };
	assert.equal(
		execFileSync("opencode", ["run", "hi"], { env }).toString().trim(),
		`${oc1}|${join(home, ".local/share/opencode/opencode.db")}|opencode1|run hi`,
	);
	assert.throws(() => execFileSync("opencode", ["auth", "login"], { env, stdio: "pipe" }), /use opencode1, opencode2/);
	assert.throws(() => execFileSync("opencode", ["providers", "login"], { env, stdio: "pipe" }), /use opencode1, opencode2/);

	// OAuth login reads identity and refreshes; an API-key entry does not count as a ChatGPT OAuth login.
	const now = Date.parse("2026-11-23T12:00:00Z");
	const [slot1, slot2] = slots(config, p);
	writeFileSync(
		join(oc1, "opencode/auth.json"),
		JSON.stringify({
			openai: {
				type: "oauth",
				access: jwt({ "https://api.openai.com/profile": { email: "a@x" }, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
				refresh: "r1",
				expires: now - 1000,
			},
		}),
	);
	writeFileSync(join(p.root, "opencode2/opencode/auth.json"), JSON.stringify({ openai: { type: "api", key: "sk-x" } }));
	const people = parseAccountsOrg("| Number | OpenAI |\n| 1 | a@x |\n| 2 | b@x |\n");
	const st = await status(config, people, p);
	assert.equal(st[0]!.loggedIn, true);
	assert.equal(st[0]!.email, "a@x");
	assert.equal(st[1]!.loggedIn, false);
	assert.deepEqual(trust(slot1!, ["/r"], p), []);

	const fetcher = async (url: string) =>
		url.includes("oauth/token")
			? { status: 200, json: async () => ({ access_token: "new-oc", refresh_token: "r2", expires_in: 3600 }) }
			: { status: 200, json: async () => ({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800 } } }) };
	assert.equal(await refresh(slot1!, { fetcher, now, busy: () => false }), "refreshed");
	const saved = JSON.parse(readFileSync(join(oc1, "opencode/auth.json"), "utf8")).openai;
	assert.deepEqual([saved.access, saved.refresh, saved.expires], ["new-oc", "r2", now + 3_600_000]);
	assert.equal(await refresh(slot2!, { fetcher, now, busy: () => false }), "failed");
});
