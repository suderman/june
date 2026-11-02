import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import { bitcoinDay } from "../src/reflect.ts";
import { openTestDaemon, tempDir, until } from "./helpers.ts";

const night = { wake: "06:00", quiet: "22:00", sleep: "03:00" };
const reflection = { enabled: true, quietMinutes: 60, recentDays: 3, periods: [], bitcoin: true };
const day = "*** 2026-10-27 Tuesday\n**** 18:04 Hockey win\nAlex said the boys' team won the final.";
const revised = `${day}\n\n**** Day's end\nThe boys won the final. I felt stoked all evening.`;
const woke = "I wake up stoked.\n\n- Looking forward to the weekend.";
const market = { market_data: { current_price: { usd: 76644.4 }, price_change_percentage_24h: 6.214, price_change_percentage_7d: -1.55 } };
const line = "Bitcoin is at US$76,644, up 6.2% over the last day and down 1.6% over the last week.";
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Replace fetch for one test, recording the URLs asked for. */
function stubFetch(t: TestContext, answer: (url: string, init?: RequestInit) => Promise<Response>): string[] {
	const asked: string[] = [];
	const real = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		asked.push(String(input));
		return answer(String(input), init);
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = real;
	});
	return asked;
}

/** One nightly pass at 03:30 after 2026-10-27, with MOOD.org unless `mood` is false. */
async function nightly(t: TestContext, options: { bitcoin?: boolean; mood?: boolean } = {}) {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const soul = join(tmp.dir, "SOUL.org");
	const journal = join(tmp.dir, "JOURNAL.org");
	const mood = join(tmp.dir, "MOOD.org");
	await writeFile(soul, "* June\nBe observant.\n");
	await writeFile(journal, `#+TITLE: June's journal\n\n* 2026\n** 2026-10 October\n${day}\n`);
	const withMood = options.mood !== false;
	const config = {
		soulFile: soul,
		memoryFile: join(tmp.dir, "MEMORY.org"),
		journalFile: journal,
		moodFile: withMood ? mood : undefined,
		reflection: { ...reflection, bitcoin: options.bitcoin ?? true },
		rhythm: night,
	};
	let asked: TranscriptContext | undefined;
	const faux = fauxProvider();
	faux.setResponses([(ctx) => {
		asked = ctx;
		return fauxAssistantMessage(JSON.stringify({ day: revised, memory: null, ...(withMood ? { mood: woke } : {}) }));
	}]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, reflectionClock: { now: () => new Date(2026, 9, 28, 3, 30), tickMs: 50 } });
	t.after(() => daemon.close());
	await until(() => faux.state.callCount === 1);
	await until(() => existsSync(join(tmp.paths.state, "reflection.json")));
	return { system: JSON.stringify(asked!.messages[0]), input: JSON.parse(String(asked!.messages.at(-1)!.content)), mood, journal };
}

test("with bitcoin on, the mood pass gets one line on bitcoin's day and is told what it means", async (t) => {
	const urls = stubFetch(t, async () => Response.json(market));
	const { system, input, mood, journal } = await nightly(t);
	assert.equal(urls.length, 1);
	assert.match(urls[0]!, /^https:\/\/api\.coingecko\.com\/api\/v3\/coins\/bitcoin\?/);
	assert.equal(input.bitcoin, line);
	assert.match(system, /follows bitcoin and cares about it, so a big move is news in their life/);
	assert.match(system, /a pump makes you happy for them and a slump weighs on you a little/);
	assert.match(system, /never write a price or a percentage in the day, MEMORY\.org, or MOOD\.org/);
	assert.equal(readFileSync(mood, "utf8"), `${woke}\n`);
	assert.doesNotMatch(readFileSync(journal, "utf8"), /76,644|US\$/);
});

for (const [name, answer] of [
	["a network error", async () => Promise.reject(new TypeError("fetch failed"))],
	["an HTTP error", async () => new Response("rate limited", { status: 429 })],
	["an unexpected answer", async () => Response.json({ market_data: { current_price: {} } })],
	["a body that is not JSON", async () => new Response("<html>")],
] as const)
	test(`${name} leaves bitcoin out and the night still completes`, async (t) => {
		stubFetch(t, answer);
		const { system, input, mood } = await nightly(t);
		assert.ok(!("bitcoin" in input));
		assert.doesNotMatch(system, /follows bitcoin/);
		assert.equal(readFileSync(mood, "utf8"), `${woke}\n`);
	});

test("a slow answer times out and is left out", async (t) => {
	stubFetch(t, (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))));
	const warned: unknown[] = [];
	const started = Date.now();
	// AbortSignal.timeout does not hold the event loop open by itself.
	const alive = setTimeout(() => {}, 5_000);
	t.after(() => clearTimeout(alive));
	assert.equal(await bitcoinDay({ ...quiet, warn: (event, fields) => warned.push({ event, ...fields }) }, 50), undefined);
	assert.ok(Date.now() - started < 2_000);
	assert.equal((warned[0] as { event: string }).event, "bitcoin_unavailable");
});

test("a missing week change gives the day alone, and a fall reads as down", async (t) => {
	stubFetch(t, async () => Response.json({ market_data: { current_price: { usd: 70_000 }, price_change_percentage_24h: -4.04 } }));
	assert.equal(await bitcoinDay(quiet), "Bitcoin is at US$70,000, down 4.0% over the last day.");
});

test("with bitcoin off, or without MOOD.org, nothing is fetched", async (t) => {
	const urls = stubFetch(t, async () => Response.json(market));
	const off = await nightly(t, { bitcoin: false });
	assert.ok(!("bitcoin" in off.input));
	assert.doesNotMatch(off.system, /follows bitcoin/);
	const moodless = await nightly(t, { mood: false });
	assert.ok(!("bitcoin" in moodless.input));
	assert.equal(urls.length, 0);
});
