import assert from "node:assert/strict";
import { test } from "node:test";
import { day } from "../src/situation.ts";

const cases = [
	["2026-01-02T20:34:00Z", "2026-01-02", "13:34", 420],
	["2026-03-08T08:59:00Z", "2026-03-08", "01:59", 420],
	["2026-03-08T09:00:00Z", "2026-03-08", "03:00", 360],
	["2026-07-02T20:34:00Z", "2026-07-02", "14:34", 360],
	["2026-11-01T07:59:00Z", "2026-11-01", "01:59", 360],
	["2026-11-01T08:00:00Z", "2026-11-01", "02:00", 360],
	["2026-11-02T20:34:00Z", "2026-11-02", "14:34", 360],
	["2026-11-03T06:30:00Z", "2026-11-03", "00:30", 360],
	["2027-01-02T20:34:00Z", "2027-01-02", "14:34", 360],
] as const;

const format = (date: Date, timeZone?: string) => new Intl.DateTimeFormat("en-CA", {
	timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]);

function check(date: Date, expectedDate: string, expectedTime: string, timeZone?: string) {
	const parts = Object.fromEntries(format(date, timeZone));
	assert.equal(`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`, `${expectedDate} ${expectedTime}`, date.toISOString());
}

test("America/Edmonton keeps historical DST and stays at UTC-6 after Alberta's 2026 change", () => {
	for (const [iso, date, time] of cases) check(new Date(iso), date, time, "America/Edmonton");
});

test("June's default-zone formatters and local Date getters agree on Alberta's date and hour", (t) => {
	const previous = process.env.TZ;
	t.after(() => {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	});
	process.env.TZ = "America/Edmonton";
	assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "America/Edmonton");
	for (const [iso, date, time, offset] of cases) {
		const when = new Date(iso);
		check(when, date, time);
		assert.equal(when.getTimezoneOffset(), offset, iso);
		assert.equal(`${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`, time, iso);
	}
	const now = new Date("2026-11-02T20:34:00Z");
	assert.match(now.toLocaleString("en-CA", { dateStyle: "full", timeStyle: "long" }), /2:34:00/);
	assert.match(day(now), /^Monday 2026-11-02, a workday, afternoon \(about 2pm\), America\/Edmonton\.$/);
	assert.match(day(new Date("2026-11-03T06:30:00Z")), /^Tuesday 2026-11-03, .*about 12am/);
});
