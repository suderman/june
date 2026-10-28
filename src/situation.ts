// Where things stand for Jon right now, as atmosphere in June's prompt rather than a tool she must think to call: the
// day and rough hour, sunrise and sunset, the weather forecast, today's and tomorrow's entries from his curated
// calendars, and where the configured people are according to Home Assistant. It changes about once an hour, when a calendar file changes, or
// when someone's zone changes, so the prompt cache survives. Home Assistant is polled in the background and never
// delays a reply; when it is down or unconfigured, those lines are simply left out.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Logger } from "pi-durable-telegram";
import type { Config } from "./config.ts";
import { parseHeading } from "./tools/org.ts";

type Env = Readonly<Record<string, string | undefined>>;
type Person = { name: string; zone: string; since: Date };
type Forecast = { date: string; condition: string; high?: number; low?: number; precipitation?: number };
type Weather = { condition: string; unit: string; days: Forecast[] };
type Home = { people: Person[]; sun?: { up: boolean; rising: Date; setting: Date }; weather?: Weather };
type Event = { title: string; time?: string; calendar: string };

export type Situation = { render(now?: Date): Promise<string>; start(): () => void };

export function createSituation(options: {
	config: Config["situation"];
	env: Env;
	log: Logger;
	fetch?: typeof fetch;
}): Situation {
	const { config, env, log } = options;
	const get = options.fetch ?? fetch;
	const ha = config.homeAssistant;
	const url = env.HASS_URL?.replace(/\/+$/, "");
	const token = env.HASS_TOKEN;
	let home: Home = { people: [] };

	const state = async (entity: string) => {
		const response = await get(`${url}/api/states/${entity}`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error(`${entity}: HTTP ${response.status}`);
		return (await response.json()) as { state: string; last_changed: string; attributes: Record<string, unknown> };
	};

	// The live temperature is left out: it changes every poll and would rewrite the section each time. Conditions now,
	// and the daily highs and lows, change rarely and are enough to judge a cold day.
	const forecast = async (entity: string): Promise<Weather> => {
		const now = await state(entity);
		const response = await get(`${url}/api/services/weather/get_forecasts?return_response`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ entity_id: entity, type: "daily" }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error(`${entity} forecast: HTTP ${response.status}`);
		const body = (await response.json()) as { service_response?: Record<string, { forecast?: Record<string, unknown>[] }> };
		const days = (body.service_response?.[entity]?.forecast ?? []).map((f) => ({
			date: dateKey(new Date(String(f.datetime))),
			condition: String(f.condition ?? ""),
			...(typeof f.temperature === "number" ? { high: f.temperature } : {}),
			...(typeof f.templow === "number" ? { low: f.templow } : {}),
			...(typeof f.precipitation_probability === "number" ? { precipitation: f.precipitation_probability } : {}),
		}));
		return { condition: now.state, unit: String(now.attributes.temperature_unit ?? "°"), days };
	};

	const poll = async () => {
		const people: Person[] = [];
		for (const entity of ha.people) {
			const person = await state(entity);
			// unknown or unavailable means no tracker reported; say nothing rather than guess.
			if (person.state === "unknown" || person.state === "unavailable") continue;
			const zone = person.state === "home" ? "home" : person.state === "not_home" ? "away" : person.state;
			people.push({ name: String(person.attributes.friendly_name ?? entity), zone, since: new Date(person.last_changed) });
		}
		const sun = await state("sun.sun").catch(() => undefined);
		const weather = ha.weather ? await forecast(ha.weather).catch(() => undefined) : undefined;
		home = {
			people,
			...(weather ? { weather } : {}),
			...(sun
				? {
						sun: {
							up: sun.state === "above_horizon",
							rising: new Date(String(sun.attributes.next_rising)),
							setting: new Date(String(sun.attributes.next_setting)),
						},
					}
				: {}),
		};
	};

	return {
		render: async (now = new Date()) => {
			const lines = [
				"Where things stand right now, refreshed about hourly; for the exact time, use clock. Let it inform your judgment when it bears on the moment, such as how late it is, a commute, or something time-sensitive on the calendars, and flag what Jon may need to act on; do not narrate it otherwise. The calendars are Jon's curated ones, which his agenda also shows.",
				day(now),
				...(home.sun ? [sunLine(home.sun, now)] : []),
				...(home.weather ? [weatherLine(home.weather, now)] : []),
				...(await calendarLines(config.calendars, now, log)),
				...home.people.map((p) => `${p.name} is ${p.zone === "home" || p.zone === "away" ? p.zone : `at ${p.zone}`} (since ${when(p.since, now)}).`),
			];
			return lines.join("\n");
		},
		start: () => {
			// Sunrise and sunset alone are worth the poll; people are optional.
			if (!url || !token) return () => {};
			const run = () => void poll().catch((error) => log.warn("situation_poll_failed", { error: (error as Error).message }));
			run();
			const timer = setInterval(run, ha.pollSeconds * 1000);
			return () => clearInterval(timer);
		},
	};
}

const hm = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "Wednesday 2026-10-28, a workday, late morning (about 11am), America/Edmonton." */
export function day(now: Date): string {
	const weekday = now.toLocaleDateString("en-CA", { weekday: "long" });
	const weekend = now.getDay() === 0 || now.getDay() === 6;
	const hour = now.getHours();
	const part =
		hour < 5 ? "the middle of the night" : hour < 8 ? "early morning" : hour < 11 ? "morning" : hour < 12 ? "late morning"
		: hour < 14 ? "midday" : hour < 17 ? "afternoon" : hour < 19 ? "early evening" : hour < 22 ? "evening" : "late night";
	const clock = `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;
	return `${weekday} ${dateKey(now)}, ${weekend ? "the weekend" : "a workday"}, ${part} (about ${clock}), ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`;
}

function sunLine(sun: NonNullable<Home["sun"]>, now: Date): string {
	const at = (d: Date) => `${hm(d)}${sameDay(d, now) ? "" : " tomorrow"}`;
	return sun.up ? `The sun is up; it sets at ${at(sun.setting)}.` : `The sun is down; it rises at ${at(sun.rising)}.`;
}

const CONDITIONS: Record<string, string> = {
	partlycloudy: "partly cloudy",
	"clear-night": "clear",
	"lightning-rainy": "stormy with rain",
	"snowy-rainy": "sleet",
	"windy-variant": "windy",
	exceptional: "unusual weather",
};
const condition = (c: string) => CONDITIONS[c] ?? c.replaceAll("-", " ");

/** "Weather: snowy now; today: high -1°C, low -6°C, 30% chance of precipitation; tomorrow: snowy, high -2°C, low -6°C." */
function weatherLine(weather: Weather, now: Date): string {
	const tomorrow = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
	const deg = (n: number) => `${Math.round(n)}${weather.unit}`;
	const describe = (f: Forecast, label: string, withCondition: boolean) =>
		`${label}: ${[
			...(withCondition && f.condition ? [condition(f.condition)] : []),
			...(f.high !== undefined ? [`high ${deg(f.high)}`] : []),
			...(f.low !== undefined ? [`low ${deg(f.low)}`] : []),
			...(f.precipitation ? [`${f.precipitation}% chance of precipitation`] : []),
		].join(", ")}`;
	const today = weather.days.find((f) => f.date === dateKey(now));
	const next = weather.days.find((f) => f.date === tomorrow);
	return `Weather: ${condition(weather.condition)} now${today ? `; ${describe(today, "today", false)}` : ""}${next ? `; ${describe(next, "tomorrow", true)}` : ""}.`;
}

/** "since 9:02", or "since Mon 14:10" for an earlier day. */
function when(since: Date, now: Date): string {
	return sameDay(since, now) ? hm(since) : `${since.toLocaleDateString("en-CA", { weekday: "short" })} ${hm(since)}`;
}

async function calendarLines(files: readonly string[], now: Date, log: Logger): Promise<string[]> {
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
	const events = { today: [] as Event[], tomorrow: [] as Event[] };
	for (const file of files) {
		const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") log.warn("situation_calendar_failed", { file, error: error.message });
			return "";
		});
		for (const event of calendarEvents(text, basename(file, ".org"), dateKey(now))) events.today.push(event);
		for (const event of calendarEvents(text, basename(file, ".org"), dateKey(tomorrow))) events.tomorrow.push(event);
	}
	const list = (es: Event[]) =>
		es
			.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""))
			.map((e) => `${e.time ? `${e.time} ` : ""}${e.title} (${e.calendar})`)
			.join("; ");
	if (files.length === 0) return [];
	return [
		events.today.length > 0 ? `Today: ${list(events.today)}.` : "Nothing on the calendars today.",
		events.tomorrow.length > 0 ? `Tomorrow: ${list(events.tomorrow)}.` : "Nothing on the calendars tomorrow.",
	];
}

const STAMP = /<(\d{4}-\d{2}-\d{2})(?: [^\s>\d]+)?(?: (\d{1,2}:\d{2})(?:-(\d{1,2}:\d{2}))?)?[^>]*>(?:--<(\d{4}-\d{2}-\d{2})[^>]*>)?/g;

/** The entries of an Org calendar that fall on `date` (YYYY-MM-DD): active timestamps, including ranges over it. */
export function calendarEvents(text: string, calendar: string, date: string): Event[] {
	const found: Event[] = [];
	const seen = new Set<string>();
	let heading: { title: string; done: boolean } | undefined;
	for (const [i, line] of text.split("\n").entries()) {
		if (line.startsWith("*")) {
			const parsed = parseHeading(line, i + 1);
			heading = parsed && { title: parsed.title.replace(/<[^>]*>/g, "").trim(), done: parsed.state === "DONE" };
		}
		if (heading === undefined || heading.done) continue;
		for (const match of line.matchAll(STAMP)) {
			const [, start, from, to, end] = match;
			if (!(start === date || (end !== undefined && start! <= date && date <= end))) continue;
			const time = from === undefined || start !== date ? undefined : to ? `${from}–${to}` : from;
			const key = `${heading.title}|${time ?? ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			found.push({ title: heading.title, calendar, ...(time ? { time } : {}) });
		}
	}
	return found;
}
