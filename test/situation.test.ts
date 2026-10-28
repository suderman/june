import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { calendarEvents, createSituation, day } from "../src/situation.ts";
import { tempDir } from "./helpers.ts";

const log = { info() {}, warn() {}, error() {} } as never;

test("the day line gives the weekday, workday or weekend, and a rough hour", () => {
	assert.match(day(new Date(2026, 9, 28, 11, 40)), /^Wednesday 2026-10-28, a workday, late morning \(about 11am\), /);
	assert.match(day(new Date(2026, 9, 31, 17, 5)), /^Saturday 2026-10-31, the weekend, early evening \(about 5pm\), /);
	assert.match(day(new Date(2026, 9, 28, 0, 30)), /the middle of the night \(about 12am\)/);
});

test("calendar entries fall on a day by their active timestamps, ranges included, never by done or inactive ones", () => {
	const org = [
		"#+TITLE: Family calendar",
		"* Alex in office meeting",
		":PROPERTIES:",
		":ICAL_UID: abc",
		":END:",
		"<2026-10-29 Thu 13:00-15:00>",
		"* Garbage day :bins:",
		"<2026-10-29 Thu>",
		"* Kim away",
		"<2026-10-27 Tue>--<2026-10-30 Fri>",
		"* DONE Old thing",
		"<2026-10-29 Thu 09:00>",
		"* Only noted",
		"[2026-10-29 Thu]",
		"* Repeated",
		"<2026-10-29 Thu 09:00>",
		"<2026-10-29 Thu 09:00>",
	].join("\n");
	assert.deepEqual(calendarEvents(org, "family", "2026-10-29"), [
		{ title: "Alex in office meeting", calendar: "family", time: "13:00–15:00" },
		{ title: "Garbage day", calendar: "family" },
		{ title: "Kim away", calendar: "family" },
		{ title: "Repeated", calendar: "family", time: "09:00" },
	]);
	assert.deepEqual(calendarEvents(org, "family", "2026-10-31"), []);
});

test("the now section joins the day, the sun, the calendars, and where people are, and leaves out what it cannot know", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const family = join(tmp.dir, "family.org");
	const work = join(tmp.dir, "work.org");
	await writeFile(family, "* Payday\n<2026-10-28 Wed>\n* Garbage day\n<2026-10-29 Thu>\n");
	await writeFile(work, "* Standup\n<2026-10-28 Wed 09:30>\n");
	const states: Record<string, object> = {
		"person.jon_suderman": { state: "Work", last_changed: new Date(2026, 9, 28, 9, 2).toISOString(), attributes: { friendly_name: "Alex" } },
		"person.ness": { state: "unknown", last_changed: new Date(2026, 9, 25).toISOString(), attributes: { friendly_name: "Kim" } },
		"sun.sun": {
			state: "above_horizon",
			last_changed: "",
			attributes: { next_setting: new Date(2026, 9, 28, 18, 22).toISOString(), next_rising: new Date(2026, 9, 29, 8, 18).toISOString() },
		},
		"weather.calgary_forecast": { state: "snowy", last_changed: "", attributes: { temperature: -1.7, temperature_unit: "°C" } },
		"get_forecasts?return_response": {
			service_response: {
				"weather.calgary_forecast": {
					forecast: [
						{ datetime: new Date(2026, 9, 28, 11).toISOString(), condition: "snowy", temperature: -1.2, templow: -6, precipitation_probability: 30 },
						{ datetime: new Date(2026, 9, 29, 11).toISOString(), condition: "partlycloudy", temperature: 3.6, templow: -4.4, precipitation_probability: 0 },
					],
				},
			},
		},
	};
	const asked: string[] = [];
	const fetch = (async (url: string, init: RequestInit) => {
		asked.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
		const entity = url.split("/").at(-1)!;
		return new Response(JSON.stringify(states[entity]), { status: states[entity] ? 200 : 404 });
	}) as typeof globalThis.fetch;
	const config = { calendars: [family, work, join(tmp.dir, "missing.org")], homeAssistant: { people: ["person.jon_suderman", "person.ness"], weather: "weather.calgary_forecast", pollSeconds: 300 } };
	const situation = createSituation({ config, env: { HASS_URL: "https://hass.test/", HASS_TOKEN: "t" }, log, fetch });
	const now = new Date(2026, 9, 28, 11, 40);
	assert.doesNotMatch(await situation.render(now), /sun|Alex is/, "nothing from Home Assistant before its first poll");
	const stop = situation.start();
	t.after(stop);
	await new Promise((r) => setTimeout(r, 50));
	assert.ok(asked.every((a) => a.startsWith("https://hass.test/api/") && a.endsWith(" Bearer t")));
	const text = await situation.render(now);
	assert.match(text, /^Where things stand right now/);
	assert.match(text, /\nWednesday 2026-10-28, a workday, late morning \(about 11am\), /);
	assert.match(text, /\nThe sun is up; it sets at 18:22\.\n/);
	assert.match(text, /\nWeather: snowy now; today: high -1°C, low -6°C, 30% chance of precipitation; tomorrow: partly cloudy, high 4°C, low -4°C\.\n/, "no live temperature, which would change every poll");
	assert.match(text, /\nToday: Payday \(family\); 09:30 Standup \(work\)\.\nTomorrow: Garbage day \(family\)\.\n/);
	assert.match(text, /\nAlex is at Work \(since 9:02\)\.$/);
	assert.doesNotMatch(text, /Kim/, "an unknown zone is left out, not guessed");
	const quiet = createSituation({ config: { calendars: [], homeAssistant: { people: [], pollSeconds: 300 } }, env: {}, log });
	quiet.start()();
	assert.equal((await quiet.render(now)).split("\n").length, 2, "without calendars or Home Assistant, only the day");
});
