import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { accountsConfig, anthropicWindows, apply, googleWindows, openaiWindows, parseAccountsOrg, places, quotas, status } from "../src/accounts.ts";
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
	writeFileSync(join(home, ".pi/agent/settings.json"), JSON.stringify({ defaultProvider: "cliproxyapi", theme: "x" }));
	writeFileSync(join(home, ".pi/agent/auth.json"), "{}");
	const config = accountsConfig({ claude: 2, pi: 1, agy: 1 });
	const first = apply(config, p);
	assert.deepEqual(first.problems, []);
	assert.deepEqual(first.wrappers.sort(), ["agy1", "claude1", "claude2", "pi1"]);
	const claude2 = join(p.root, "claude2");
	assert.equal(readlinkSync(join(claude2, "projects")), join(home, ".claude/projects"));
	assert.equal(existsSync(join(claude2, ".credentials.json")), false, "a login is never shared");
	assert.equal(lstatSync(claude2).mode & 0o777, 0o700);
	assert.deepEqual(JSON.parse(readFileSync(join(p.root, "pi1/settings.json"), "utf8")), { defaultProvider: "openai-codex", theme: "x" });
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
