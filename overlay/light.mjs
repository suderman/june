// The hour's light and each panel's backdrop. A panel is lit by the hour its words were written, so a strip read at night
// still shows the morning's exchange in morning light; the hours follow the sun at home when the daemon sends a sky. The
// grade falls on the ground and, more gently, on June, and never on the words. Behind her stands her room (Scenery.qml,
// or a tint without room art), a calm ground for a serious or gentle reply, a procedural abstract background for a rare
// face, or, while she works, a cutaway of the work itself drawn from her tool calls. QML imports it and
// test/overlay.test.mjs runs it under Node, so it is plain JavaScript as QML's engine knows it: no Array.prototype.at,
// Object.hasOwn, or object spread. See "Light and backgrounds" in docs/interfaces.org.
import { hash, picked } from "./compose.mjs";
import { DELEGATING } from "./live.mjs";
import { narrate } from "./strip.mjs";

/**
 * The palettes of the day. `grade` multiplies the ground at `gradeAmount`; June gets the same colour at `figureGrade`,
 * with her own brightness and saturation, and `key` lights her from the open side at `keyStrength`. `lampOn` brings up
 * the warm lamp behind her. The sky through a window runs from `skyTop` to `skyBottom`, with the sun or moon (`sun`)
 * at `sunX`, `sunY` in the window and `stars` at night. Morning is the reference look: no grade at all.
 */
export const TIMES = {
	dawn: { grade: "#f2d2de", gradeAmount: 0.55, key: "#ffc4d6", keyStrength: 0.7, figureGrade: 0.2, figureBrightness: 0.97, figureSaturation: 0.95, lampOn: 0, skyTop: "#f4b8cf", skyBottom: "#fde3c4", sun: "#ffd6a0", sunX: 0.7, sunY: 0.7, sunOpacity: 0.9, stars: 0.2 },
	morning: { grade: "#ffffff", gradeAmount: 0, key: "#ffffff", keyStrength: 0.45, figureGrade: 0, figureBrightness: 1.02, figureSaturation: 1, lampOn: 0, skyTop: "#9fd4ff", skyBottom: "#e8f6ff", sun: "#fff3c4", sunX: 0.26, sunY: 0.3, sunOpacity: 1, stars: 0 },
	afternoon: { grade: "#fff6e6", gradeAmount: 0.35, key: "#fff4d6", keyStrength: 0.5, figureGrade: 0.1, figureBrightness: 1, figureSaturation: 1.02, lampOn: 0, skyTop: "#7fbcf4", skyBottom: "#d4ecff", sun: "#fff8d8", sunX: 0.5, sunY: 0.14, sunOpacity: 1, stars: 0 },
	golden: { grade: "#ffcf9a", gradeAmount: 0.6, key: "#ffb35c", keyStrength: 0.85, figureGrade: 0.25, figureBrightness: 1, figureSaturation: 1.05, lampOn: 0, skyTop: "#ff9a5a", skyBottom: "#ffe0a0", sun: "#ffe38a", sunX: 0.78, sunY: 0.62, sunOpacity: 1, stars: 0 },
	evening: { grade: "#b9a3a0", gradeAmount: 0.75, key: "#ffbf7a", keyStrength: 0.7, figureGrade: 0.25, figureBrightness: 0.95, figureSaturation: 0.95, lampOn: 1, skyTop: "#4d4a86", skyBottom: "#e9937a", sun: "#ffb07a", sunX: 0.84, sunY: 0.8, sunOpacity: 0.7, stars: 0.4 },
	night: { grade: "#6d7bb5", gradeAmount: 0.85, key: "#ffc27a", keyStrength: 0.75, figureGrade: 0.3, figureBrightness: 0.92, figureSaturation: 0.9, lampOn: 1, skyTop: "#141b3a", skyBottom: "#33406e", sun: "#f2f0d8", sunX: 0.74, sunY: 0.22, sunOpacity: 0.9, stars: 1 },
};

// When each palette is at its fullest, in hours of the local clock, when the sun's times are unknown; between two, the
// look blends. Night holds from half past eleven until half past four.
const KEYS = [
	{ hour: 4.5, name: "night" },
	{ hour: 6, name: "dawn" },
	{ hour: 9, name: "morning" },
	{ hour: 14, name: "afternoon" },
	{ hour: 18.5, name: "golden" },
	{ hour: 20.5, name: "evening" },
	{ hour: 23.5, name: "night" },
];
const NUMBERS = ["gradeAmount", "keyStrength", "figureGrade", "figureBrightness", "figureSaturation", "lampOn", "sunX", "sunY", "sunOpacity", "stars"];
const COLOURS = ["grade", "key", "skyTop", "skyBottom", "sun"];

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
const n = (v) => Math.round(v * 10) / 10;
const circle = (x, y, r) => `M ${n(x - r)} ${n(y)} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;

const rad = Math.PI / 180;

/**
 * Sunrise, solar noon, and sunset on the local calendar day of `date`, in hours of the local clock, at `latitude` and
 * `longitude` in degrees (NOAA's approximation, within a few minutes). Null when the sun neither rises nor sets that day.
 */
export function sunTimes(date, latitude, longitude) {
	const start = new Date(date.getFullYear(), 0, 1);
	const day = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86400000) + 1;
	const g = ((2 * Math.PI) / 365) * (day - 1);
	const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
	const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
	const lat = latitude * rad;
	const cosHa = Math.cos(90.833 * rad) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl);
	if (cosHa < -1 || cosHa > 1) return null;
	const ha = Math.acos(cosHa) / rad;
	// UTC minutes to the local clock's hours, with the offset in force at local noon that day.
	const offset = -new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTimezoneOffset();
	const local = (minutes) => (minutes + offset) / 60;
	return { rise: local(720 - 4 * (longitude + ha) - eqtime), noon: local(720 - 4 * longitude - eqtime), set: local(720 - 4 * (longitude - ha) - eqtime) };
}

/**
 * The day's keys from the sun: night until a little before sunrise, dawn as it rises, morning a couple of hours on,
 * afternoon after noon, golden hour just before it sets, evening as it goes down, and night once the dusk has gone. Each
 * key is kept at least a quarter hour after the one before, for short winter days.
 */
export function sunKeys(sun) {
	const keys = [
		{ hour: sun.rise - 1.25, name: "night" },
		{ hour: sun.rise + 0.25, name: "dawn" },
		{ hour: sun.rise + 2.5, name: "morning" },
		{ hour: sun.noon + 1.5, name: "afternoon" },
		{ hour: sun.set - 0.5, name: "golden" },
		{ hour: sun.set + 0.75, name: "evening" },
		{ hour: sun.set + 2.25, name: "night" },
	];
	for (let i = 1; i < keys.length; i++) if (keys[i].hour < keys[i - 1].hour + 0.25) keys[i].hour = keys[i - 1].hour + 0.25;
	return keys;
}

/**
 * The look at `hour` (0 to 24, fractional): the nearest palette's `name` and every value blended between the two keys
 * either side, so the light moves through the day instead of jumping. `sun`, from sunTimes(), sets the keys by the real
 * sunrise and sunset; without it they keep the fixed clock hours.
 */
export function look(hour, sun = null) {
	const keys = sun ? sunKeys(sun) : KEYS;
	let h = ((hour % 24) + 24) % 24;
	while (h < keys[0].hour) h += 24;
	while (h >= keys[0].hour + 24) h -= 24;
	let i = keys.length - 1;
	for (let k = 0; k < keys.length - 1; k++)
		if (h >= keys[k].hour && h < keys[k + 1].hour) {
			i = k;
			break;
		}
	const from = keys[i];
	const to = i < keys.length - 1 ? keys[i + 1] : { hour: keys[0].hour + 24, name: keys[0].name };
	const t = (h - from.hour) / (to.hour - from.hour);
	const a = TIMES[from.name];
	const b = TIMES[to.name];
	const out = { name: t < 0.5 ? from.name : to.name };
	for (const n of NUMBERS) out[n] = a[n] + (b[n] - a[n]) * t;
	for (const n of COLOURS) out[n] = mix(a[n], b[n], t);
	return out;
}

/** The hour of a moment in epoch milliseconds, on the local clock. */
export function hourOf(ms) {
	const d = new Date(ms);
	return d.getHours() + d.getMinutes() / 60;
}

/** The sun's times for the day a moment falls on, from the daemon's sky; null without one. */
export function sunFor(ms, sky) {
	if (!sky || typeof sky.latitude !== "number" || typeof sky.longitude !== "number") return null;
	return sunTimes(new Date(ms), sky.latitude, sky.longitude);
}

// How much each of Home Assistant's conditions hides the sky, and what falls from it.
const OVERCAST = { partlycloudy: 0.25, cloudy: 0.55, fog: 0.75, rainy: 0.6, pouring: 0.7, "lightning-rainy": 0.7, lightning: 0.6, snowy: 0.5, "snowy-rainy": 0.6, hail: 0.6, windy: 0.1, "windy-variant": 0.3, exceptional: 0.4 };
const FALLING = { rainy: "rain", pouring: "rain", "lightning-rainy": "rain", "snowy-rainy": "rain", hail: "rain", snowy: "snow" };
/** How long the weather now is taken to hold for a panel: older panels show a clear sky rather than a guess. */
export const WEATHER_MS = 3 * 60 * 60 * 1000;

/**
 * The sky through a window: the hour's gradient, sun or moon, and stars, greyed by cloud for `condition` (Home
 * Assistant's name), with rain or snow falling when it says so.
 */
export function skyLook(light, condition) {
	const cover = OVERCAST[condition] ?? 0;
	const grey = (c) => {
		const [r, g, b] = rgb(c);
		const y = 0.3 * r + 0.59 * g + 0.11 * b;
		return hex([y * 0.97, y, y * 1.04]);
	};
	return {
		top: mix(light.skyTop, grey(light.skyTop), cover),
		bottom: mix(light.skyBottom, grey(light.skyBottom), cover),
		sun: light.sun,
		sunX: light.sunX,
		sunY: light.sunY,
		sunOpacity: light.sunOpacity * (1 - cover),
		stars: light.stars * (1 - cover),
		falling: FALLING[condition] ?? null,
	};
}

/** Rain as short slanted strokes, or snow as small flakes, scattered over a `w` by `h` window by `seed`. */
export function fallingPath(kind, w, h, seed = 0) {
	if (kind !== "rain" && kind !== "snow") return "";
	const count = Math.max(10, Math.round((w * h) / (kind === "rain" ? 900 : 1400)));
	const parts = [];
	for (let i = 0; i < count; i++) {
		const x = (seed * 7 + i * 113) % Math.max(1, Math.round(w));
		const y = (seed * 3 + i * 67) % Math.max(1, Math.round(h));
		if (kind === "rain") parts.push(`M ${x} ${y} l -5 14`);
		else parts.push(circle(x, y, 2 + ((i + seed) % 3)));
	}
	return parts.join(" ");
}

/** A ground colour under the hour's grade: multiplied by it at `gradeAmount`, as a print under coloured light. */
export function graded(colour, light) {
	const g = rgb(light.grade);
	return hex(rgb(colour).map((v, i) => v * (1 - light.gradeAmount + (light.gradeAmount * g[i]) / 255)));
}

/** When a panel's words were written: its latest message's time, or null for a panel with none (a live one). */
export function moment(panel) {
	let at = null;
	for (const e of panel.elements) {
		const t = e.kind === "user" ? e.item.at : e.kind === "june" ? e.at : undefined;
		if (typeof t === "number" && (at === null || t > at)) at = t;
	}
	return at;
}

// The procedural backgrounds by picked face: only occasional and rare ones, so they stay special. Common faces keep the
// room; serious and gentle replies get the calm ground, never an effect.
const ABSTRACT = { surprised: "focus", delighted: "sparkle", cheering: "sparkle", bashful: "bubbles", pout: "gloom", exasperated: "gloom", indignant: "burst" };
const CALM = ["serious", "gentle"];
/** A panel whose words cover more than this share of it keeps a flat tint: an effect would only fight the reading. */
export const LONG_SHARE = 0.5;

export const PATTERNS = {
	focus: { ground: "#ffffff", fill: "transparent", stroke: "#1b1a1f", width: 1.4, opacity: 0.45 },
	sparkle: { ground: "#fff2c4", fill: "#f2b81c", stroke: "#1b1a1f", width: 1, opacity: 0.8 },
	bubbles: { ground: "#ffe1ea", fill: "#ffb3c7", stroke: "transparent", width: 0, opacity: 0.6 },
	gloom: { ground: "#dfe3ec", fill: "transparent", stroke: "#5b6683", width: 2.2, opacity: 0.7 },
	burst: { ground: "#ffd6cf", fill: "#ff8f80", stroke: "#1b1a1f", width: 2.5, opacity: 0.85 },
};
export const CALM_GROUND = "#dfe7ee";

// The tools of the run in progress: those after June's last words in the panel.
function working(panel) {
	const kinds = panel.elements.map((e) => e.kind);
	const since = panel.elements.slice(kinds.lastIndexOf("june") + 1);
	const tools = [];
	for (const e of since) if (e.kind === "tools") for (const t of e.items) tools.push(t);
	return tools;
}

/**
 * What stands behind June in a panel. `live` says the panel is the one she is working in now, `share` how much of it
 * the words cover. One of:
 * - `{ kind: "cutaway", scene: "delegating" | "digging", tools }` while tool calls run, from those calls alone;
 * - `{ kind: "flat" }` for a long panel;
 * - `{ kind: "calm" }` or `{ kind: "abstract", pattern }` for a reply whose picked face asks for one;
 * - `{ kind: "room" }` otherwise.
 */
export function backdrop(panel, { live = false, share = 0 } = {}) {
	if (live) {
		const tools = working(panel);
		if (tools.length > 0) return { kind: "cutaway", scene: tools.some((t) => DELEGATING.includes(t.name)) ? "delegating" : "digging", tools };
		return { kind: "room" };
	}
	if (share > LONG_SHARE) return { kind: "flat" };
	const face = picked(panel);
	if (face && CALM.includes(face.expression)) return { kind: "calm" };
	if (face && ABSTRACT[face.expression]) return { kind: "abstract", pattern: ABSTRACT[face.expression] };
	return { kind: "room" };
}


/**
 * An abstract background's path over a `w` by `h` panel. Focus lines and the burst centre on `centre` (her face), so the
 * panel draws the eye to her; the rest scatter by `seed`, stable between redraws.
 */
export function patternPath(kind, w, h, centre, seed = 0) {
	const cx = centre ? centre.x : w / 2;
	const cy = centre ? centre.y : h / 2;
	const reach = Math.hypot(w, h);
	const parts = [];
	if (kind === "focus") {
		const count = 64;
		for (let i = 0; i < count; i++) {
			const a = (i / count) * Math.PI * 2 + (seed % 7) * 0.01;
			// Lines start a little out from her face, at uneven radii, as a hand would rule them.
			const start = 70 + ((seed + i * 37) % 5) * 14;
			parts.push(`M ${n(cx + Math.cos(a) * start)} ${n(cy + Math.sin(a) * start)} L ${n(cx + Math.cos(a) * reach)} ${n(cy + Math.sin(a) * reach)}`);
		}
	} else if (kind === "sparkle") {
		const count = Math.max(8, Math.round((w * h) / 7000));
		for (let i = 0; i < count; i++) {
			const x = 14 + ((seed + i * 131) % Math.max(1, Math.round(w - 28)));
			const y = 14 + ((seed + i * 71) % Math.max(1, Math.round(h - 28)));
			const r = 6 + ((i + seed) % 3) * 3;
			const q = r / 3;
			parts.push(`M ${n(x)} ${n(y - r)} L ${n(x + q)} ${n(y - q)} L ${n(x + r)} ${n(y)} L ${n(x + q)} ${n(y + q)} L ${n(x)} ${n(y + r)} L ${n(x - q)} ${n(y + q)} L ${n(x - r)} ${n(y)} L ${n(x - q)} ${n(y - q)} Z`);
		}
	} else if (kind === "bubbles") {
		const count = Math.max(12, Math.round((w * h) / 4500));
		for (let i = 0; i < count; i++) parts.push(circle((seed + i * 97) % Math.round(w), (seed + i * 53) % Math.round(h), 4 + ((i + seed) % 4) * 3));
	} else if (kind === "gloom") {
		const step = 18;
		for (let x = 10, i = 0; x < w; x += step, i++) parts.push(`M ${n(x)} 0 L ${n(x)} ${n(h * (0.45 + ((i + seed) % 3) * 0.15))}`);
	} else if (kind === "burst") {
		const spikes = 16;
		for (let i = 0; i < spikes; i++) {
			const a = (i / spikes) * Math.PI * 2;
			const r = i % 2 === 0 ? reach * 0.6 : reach * (0.22 + ((seed + i) % 3) * 0.04);
			parts.push(`${i === 0 ? "M" : "L"} ${n(cx + Math.cos(a) * r)} ${n(cy + Math.sin(a) * r)}`);
		}
		parts.push("Z");
	}
	return parts.join(" ");
}

const STATUS = { running: "#ffd36b", done: "#86e08f", error: "#ff8f80" };
const DRAWERS = ["#fbf0c9", "#dfead6", "#d7e4f2", "#f6dccb"];
const clipLabel = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Where a tool call looks, named as a place: mail, Org, the calendar, the shell, the web, or the file it touched. */
export function place(tool) {
	const name = tool.name ?? "";
	const said = narrate(tool.summary ?? "");
	const file = /(\S+\.\w+)/.exec(said);
	if (/mail|notmuch/.test(name)) return "mail";
	if (/calendar/.test(name)) return "calendar";
	if (/^org/.test(name)) return file ? file[1] : "org";
	if (/^(web|fetch|search|browse)/.test(name)) return "web";
	if (name === "bash") return "shell";
	if (file) return file[1];
	return name;
}

/**
 * A cutaway's pieces over a `w` by `h` panel, from the run's tool calls and nothing else. Delegating shows a pane per
 * brief, named by its narration, and the run's calls as a chain coloured by status; digging shows the places her calls
 * looked, as labelled drawers on a dotted ground.
 */
export function cutaway(spec, w, h, seed = 0) {
	const tools = spec.tools;
	if (spec.scene === "delegating") {
		const briefs = tools.filter((t) => DELEGATING.includes(t.name));
		const shown = briefs.slice(Math.max(0, briefs.length - 3));
		const paneW = Math.min(230, w * 0.42);
		const panes = shown.map((t, i) => ({
			name: clipLabel(narrate(t.summary ?? "") || t.name, 30),
			dot: STATUS[t.status] ?? STATUS.running,
			x: n(w * (0.05 + 0.29 * i)),
			y: n(h * (0.08 + 0.14 * (i % 2))),
			w: n(paneW),
			r: (((seed + i * 5) % 7) - 3) * 0.8,
			lines: [0, 1, 2].map((k) => 48 + ((seed + i * 17 + k * 29) % 42)),
		}));
		const chain = tools.slice(Math.max(0, tools.length - 5));
		const y = h * 0.72;
		const nodes = chain.map((t, i) => ({ x: n(w * (0.18 + (0.64 * (i + 0.5)) / chain.length)), y: n(y + (i % 2 === 0 ? 0 : -h * 0.08)), fill: STATUS[t.status] ?? STATUS.running }));
		let path = "";
		for (let i = 1; i < nodes.length; i++) {
			const a = nodes[i - 1];
			const b = nodes[i];
			const mid = n((a.x + b.x) / 2);
			path += `${i === 1 ? `M ${a.x} ${a.y} ` : ""}C ${mid} ${a.y} ${mid} ${b.y} ${b.x} ${b.y} `;
		}
		return { ground: "#1f2433", panes, nodes, path: path.trim() };
	}
	const places = [];
	for (let i = tools.length - 1; i >= 0 && places.length < 4; i--) {
		const p = clipLabel(place(tools[i]), 14);
		if (!places.includes(p)) places.push(p);
	}
	places.reverse();
	const drawerW = Math.min(150, w * 0.3);
	const drawers = places.map((label, i) => ({
		label,
		fill: DRAWERS[(hash(label) + seed) % DRAWERS.length],
		x: n(w * (0.05 + 0.24 * i)),
		y: n(h * (0.12 + 0.16 * (i % 2))),
		w: n(drawerW),
		r: (((seed + i * 3) % 9) - 4) * 0.9,
	}));
	return { ground: "#e8dfcf", drawers };
}
