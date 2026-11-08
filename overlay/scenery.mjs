// June's room behind her: a room drawn with its window cut out, the season's view through that window under the hour's
// sky, and props brought out by the weather, the season, or a holiday. An avatar set's manifest describes the art under
// `backgrounds`; this module reads it leniently, chooses, and places, and Scenery.qml paints. QML imports it and
// test/overlay.test.mjs runs it under Node, so it is plain JavaScript as QML's engine knows it: no Array.prototype.at,
// Object.hasOwn, or object spread. See "Rooms, windows, and props" in docs/interfaces.org.
import { SETTINGS, hash } from "./compose.mjs";
import { WEATHER_MS, backdrop as chooseBackdrop, hourOf, look, moment, skyLook, sunFor } from "./light.mjs";

export { SETTINGS };
export const SEASONS = ["spring", "summer", "autumn", "winter"];
/** Where a prop can stand in a room. A copy of SPOTS in src/avatar.ts. */
export const SPOTS = ["floor", "desk", "wall", "sill"];
/** At most this many props at once, so the room stays hers rather than a shop window. */
export const MAX_PROPS = 2;

const fraction = (n) => typeof n === "number" && n >= 0 && n <= 1;
const size = (s) => Array.isArray(s) && s.length === 2 && s[0] > 0 && s[1] > 0;
const point = (p) => Array.isArray(p) && p.length === 2 && fraction(p[0]) && fraction(p[1]);
const monthDay = (s) => typeof s === "string" && /^\d\d-\d\d$/.test(s);

/**
 * One set's rooms, window views, and props, with image URLs under `base`. An entry the overlay cannot use is skipped, so
 * one bad entry never blanks a panel.
 */
export function readScenery(manifest, base) {
	const b = manifest && typeof manifest.backgrounds === "object" && manifest.backgrounds !== null ? manifest.backgrounds : {};
	const rooms = [];
	for (const [id, r] of Object.entries(b.rooms ?? {})) {
		if (typeof r?.file !== "string" || !size(r.size)) continue;
		const settings = Array.isArray(r.settings) ? r.settings.filter((s) => SETTINGS.includes(s)) : [];
		const w = r.window;
		const spots = {};
		for (const spot of SPOTS) spots[spot] = Array.isArray(r.spots?.[spot]) ? r.spots[spot].filter(point) : [];
		rooms.push({
			id,
			url: base + r.file,
			width: r.size[0],
			height: r.size[1],
			settings: settings.length > 0 ? settings : ["desk"],
			window: Array.isArray(w) && w.length === 4 && w.every(fraction) && w[2] > 0 && w[3] > 0 ? { x: w[0], y: w[1], w: w[2], h: w[3] } : null,
			spots,
		});
	}
	const plates = [];
	for (const [id, p] of Object.entries(b.plates ?? {})) {
		if (typeof p?.file !== "string" || !size(p.size) || !SEASONS.includes(p.season)) continue;
		plates.push({ id, url: base + p.file, width: p.size[0], height: p.size[1], season: p.season });
	}
	const props = [];
	for (const [id, p] of Object.entries(b.props ?? {})) {
		if (typeof p?.file !== "string" || !size(p.size)) continue;
		const spots = (Array.isArray(p.spots) ? p.spots : [p.spot]).filter((s) => SPOTS.includes(s));
		if (spots.length === 0) continue;
		const when = typeof p.when === "object" && p.when !== null ? p.when : {};
		const temperature = Array.isArray(when.temperature) && when.temperature.length === 2 && when.temperature.every((t) => typeof t === "number") ? when.temperature : null;
		const weather = Array.isArray(when.weather) ? when.weather.filter((c) => typeof c === "string") : [];
		const dates = Array.isArray(when.dates) ? when.dates.filter((d) => Array.isArray(d) && d.length === 2 && d.every(monthDay)) : [];
		const seasons = Array.isArray(when.seasons) ? when.seasons.filter((s) => SEASONS.includes(s)) : [];
		// A prop with no conditions would stand there always; that is room art, not a prop.
		if (!temperature && weather.length === 0 && dates.length === 0 && seasons.length === 0) continue;
		props.push({ id, url: base + p.file, width: p.size[0], height: p.size[1], spots, temperature, weather, dates, seasons, rooms: Array.isArray(p.rooms) ? p.rooms.filter((r) => typeof r === "string") : [] });
	}
	return { rooms, plates, props };
}

/** Several sets' scenery in order, the first set winning a shared id. */
export function mergeScenery(sets) {
	const out = { rooms: [], plates: [], props: [] };
	const seen = { rooms: {}, plates: {}, props: {} };
	for (const set of sets)
		for (const kind of ["rooms", "plates", "props"])
			for (const item of set?.[kind] ?? [])
				if (!seen[kind][item.id]) {
					seen[kind][item.id] = true;
					out[kind].push(item);
				}
	return out;
}

/** How far out of focus the room is behind a framing: well blurred behind her face, softened behind her head, sharp wider. */
export function focusBlur(framing) {
	return framing === "close-up" ? 0.7 : framing === "head" ? 0.35 : 0;
}

/** The season of a date, by month, in the northern hemisphere: winter is December to February. */
export function season(date) {
	const m = date.getMonth();
	return m === 11 || m <= 1 ? "winter" : m <= 4 ? "spring" : m <= 7 ? "summer" : "autumn";
}

/** The room for a pose's setting, by `seed` among those that serve it; any room when none does. Null without rooms. */
export function chooseRoom(rooms, setting, seed = 0) {
	if (rooms.length === 0) return null;
	const fit = rooms.filter((r) => r.settings.includes(setting ?? "desk"));
	const from = fit.length > 0 ? fit : rooms;
	return from[seed % from.length];
}

/** The view through the window for the season, by `seed` among several; null when the set has none for it. */
export function choosePlate(plates, which, seed = 0) {
	const fit = plates.filter((p) => p.season === which);
	return fit.length > 0 ? fit[seed % fit.length] : null;
}

const inDates = (date, [from, to]) => {
	const md = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	return from <= to ? md >= from && md <= to : md >= from || md <= to;
};
const celsius = (t, unit) => (typeof unit === "string" && /F/.test(unit) ? ((t - 32) * 5) / 9 : t);

/**
 * The props a panel brings out, holiday ones first, then weather, then temperature, then season: every condition a prop
 * names must hold. `weather` is `{ condition, temperature, unit }` when the weather now applies to the panel, else null,
 * and then a prop that needs the weather stays away. At most MAX_PROPS, by `seed` among equals.
 */
export function chooseProps(props, { date, weather = null, room = null, seed = 0 }) {
	const fits = [];
	for (const p of props) {
		if (p.rooms.length > 0 && (!room || !p.rooms.includes(room.id))) continue;
		if (p.dates.length > 0 && !p.dates.some((d) => inDates(date, d))) continue;
		if (p.seasons.length > 0 && !p.seasons.includes(season(date))) continue;
		if (p.weather.length > 0 && !(weather && p.weather.includes(weather.condition))) continue;
		if (p.temperature) {
			if (!weather || typeof weather.temperature !== "number") continue;
			const t = celsius(weather.temperature, weather.unit);
			if (t < p.temperature[0] || t > p.temperature[1]) continue;
		}
		const rank = p.dates.length > 0 ? 0 : p.weather.length > 0 ? 1 : p.temperature ? 2 : 3;
		fits.push({ prop: p, rank, order: (hash(p.id) + seed) % 997 });
	}
	fits.sort((a, b) => a.rank - b.rank || a.order - b.order);
	return fits.map((f) => f.prop);
}

/**
 * A room covering a `w` by `h` panel, with its window on the open side, away from June's `side`: the room is mirrored
 * when its window is on her side, and shifted so the window sits toward the open side and in the upper third, leaving room below for the desk and the sill.
 * Returns where the image goes, its scale, and the window in panel coordinates.
 */
export function placeRoom(room, w, h, side) {
	const scale = Math.max(w / room.width, h / room.height);
	const dw = room.width * scale;
	const dh = room.height * scale;
	const win = room.window;
	const winCentre = win ? win.x + win.w / 2 : 0.5;
	const mirror = side === "right" ? winCentre > 0.5 : winCentre < 0.5;
	const fx = (f) => (mirror ? 1 - f : f);
	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
	const targetX = side === "right" ? 0.3 * w : 0.7 * w;
	const x = clamp(targetX - fx(winCentre) * dw, w - dw, 0);
	const y = clamp(0.3 * h - (win ? win.y + win.h / 2 : 0.5) * dh, h - dh, 0);
	const place = { x, y, w: dw, h: dh, scale, mirror, window: null };
	if (win) {
		const left = x + (mirror ? 1 - win.x - win.w : win.x) * dw;
		place.window = { x: left, y: y + win.y * dh, w: win.w * dw, h: win.h * dh };
	}
	return place;
}

/** A point given in fractions of the room's image, in panel coordinates, as `place` puts the room. */
export function roomPoint(place, fx, fy) {
	return { x: place.x + (place.mirror ? 1 - fx : fx) * place.w, y: place.y + fy * place.h };
}

const overlaps = (a, b, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/**
 * Where the chosen props stand: each at the first of its room's spots where it fits whole inside the panel, clear of
 * her face, the words, and the other props, standing on the spot (its bottom centre there). Props that fit nowhere stay
 * away. A prop scales with the room, so it keeps its size against the furniture.
 */
export function placeProps(props, room, place, w, h, obstacles = []) {
	const out = [];
	for (const prop of props) {
		if (out.length >= MAX_PROPS) break;
		let placed = null;
		for (const spot of prop.spots) {
			for (const [fx, fy] of room.spots[spot] ?? []) {
				const at = roomPoint(place, fx, fy);
				const pw = prop.width * place.scale;
				const ph = prop.height * place.scale;
				const box = { x: at.x - pw / 2, y: at.y - ph, w: pw, h: ph };
				if (box.x < 0 || box.y < 0 || box.x + box.w > w || box.y + box.h > h) continue;
				if (obstacles.some((o) => overlaps(box, o, 6))) continue;
				if (out.some((o) => overlaps(box, o, 4))) continue;
				placed = { id: prop.id, url: prop.url, x: box.x, y: box.y, w: box.w, h: box.h, mirror: place.mirror };
				break;
			}
			if (placed) break;
		}
		if (placed) out.push(placed);
	}
	return out;
}

/**
 * Everything behind June in a laid-out panel, as every client decides it: the hour its words were written (or the
 * clock, or `hourOverride` when previewing the light), the light then at home under the daemon's `sky`, what stands
 * behind her (light.mjs `backdrop`, the words' share of the panel keeping a long one plain), and when that is her
 * room, which room for her pose, where it sits, the season's view, the window's sky with the weather now (for a panel
 * from the last few hours only), the props the day brings out placed clear of her face and the words, and how far out
 * of focus it is. `sizes` are the elements' measured sizes; `scenery` is mergeScenery's.
 */
export function panelScene({ panel, layout, pose, sizes, width, now, hourOverride = -1, sky = null, scenery }) {
	const when = moment(panel) ?? now;
	const light = look(hourOverride >= 0 ? hourOverride : hourOf(when), sunFor(hourOverride >= 0 ? now : when, sky));
	let covered = 0;
	for (const s of sizes) covered += s.w * s.h;
	const share = width > 0 && layout.height > 0 ? covered / (width * layout.height) : 0;
	const back = chooseBackdrop(panel, { live: Boolean(panel.live), share });
	const faceCentre = layout.face ? { x: layout.face.x + layout.face.w / 2, y: layout.face.y + layout.face.h / 2 } : null;
	const seed = hash(panel.id) % 997;
	const rooms = scenery ? scenery.rooms : [];
	// An inset is a small picture of its own, as in a comic: it has its own room, placed in the inset's coordinates.
	const inset = layout.clip && layout.clip.inset ? layout.clip : null;
	const room = (back.kind === "room" || inset) && pose ? chooseRoom(rooms, pose.setting, seed) : null;
	const roomPlace = room && width > 0 && layout.height > 0 ? placeRoom(room, inset ? inset.w : width, inset ? inset.h : layout.height, panel.side) : null;
	const weather = sky && sky.condition && Math.abs(now - when) < WEATHER_MS ? sky : null;
	const plate = room ? choosePlate(scenery.plates, season(new Date(when)), seed) : null;
	// Her words and face, which a prop or a cutaway's pieces keep clear of.
	const clear = layout.elements.filter((e) => e !== null && e !== undefined);
	if (layout.face) clear.push(layout.face);
	let props = [];
	if (roomPlace && !inset) {
		const chosen = chooseProps(scenery.props, { date: new Date(when), weather, room, seed });
		props = placeProps(chosen, room, roomPlace, width, layout.height, clear);
	}
	return {
		when,
		light,
		backdrop: back,
		faceCentre,
		seed,
		room,
		roomPlace,
		inset,
		weather,
		plate,
		props,
		clear,
		sky: skyLook(light, weather ? weather.condition : ""),
		blur: focusBlur(layout.framing),
	};
}
