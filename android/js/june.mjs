// The decisions the phone shares with the desktop overlay, bundled into one script (june.js, a global `June`) for
// QuickJS: which panels the conversation makes, how each is laid out, how it is lit, what live June is doing, and the
// console look. The modules stay in overlay/, written in the plain JavaScript both QML and QuickJS run; see "What the
// phone shares with the desktop" in docs/interfaces.org. Below them, the phone's own glue: it keeps the strip's memory
// and the avatar set's poses in the engine between calls, and hands back layouts ready to draw.
import * as compose from "../../overlay/compose.mjs";
import * as looks from "../../overlay/console.mjs";
import * as light from "../../overlay/light.mjs";
import * as live from "../../overlay/live.mjs";
import * as scenery from "../../overlay/scenery.mjs";
import * as strip from "../../overlay/strip.mjs";

export { compose, light, live, looks, scenery, strip };

// Per-screen live presentation state; settled choices come from the recorded take or stable legacy derivation.
const memory = { sides: {}, poseIds: {}, livePoses: {} };
let poses = [];
let rooms = { rooms: [], plates: [], props: [] };
let liveArt = {};
let chibiArt = {};

/**
 * Read the avatar sets: the app's base set, and the daemon's (Jon's art) when it has one, which wins where both name a
 * piece, as the overlay merges its sets. Base urls are paths in the app's assets; the daemon's start with `daemon:`.
 */
export function setArt(manifest, daemon) {
	const sets = (daemon ? [[daemon, "daemon:"], [manifest, ""]] : [[manifest, ""]]).map(([m, prefix]) => ({
		poses: compose.readPoses(m, prefix),
		live: live.readLive(m, prefix),
		chibi: live.readChibi(m, prefix),
		scenery: scenery.readScenery(m, prefix),
	}));
	const seen = {};
	poses = [];
	for (const set of sets) for (const pose of set.poses) if (!seen[pose.id]) { seen[pose.id] = true; poses.push(pose); }
	rooms = scenery.mergeScenery(sets.map((s) => s.scenery));
	liveArt = {};
	chibiArt = {};
	for (let i = sets.length - 1; i >= 0; i--) {
		Object.assign(liveArt, sets[i].live);
		Object.assign(chibiArt, sets[i].chibi);
	}
	return poses.length;
}

/** The strip for the view: its panels, composed with June's pose and side, oldest first. */
export function panels(items, state, holding) {
	const composed = compose.composeStrip(strip.panels(items), state, poses, memory, holding === true);
	// Tool calls carry their caption line, as the overlay's chips and cards show them.
	for (const panel of composed) {
		panel.takeMenu = compose.takeMenu(panel);
		for (const e of panel.elements) if (e.kind === "tools") e.items = e.items.map((item) => Object.assign({}, item, { caption: strip.caption(item) }));
	}
	return composed;
}

/** The panel ground's tint, as Theme.qml picks it, so neighbours differ. */
const TINTS = ["#e6d7ea", "#f6dccb", "#d7e4f2", "#dfead6", "#f2e3c8"];
function tint(id) {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
	return TINTS[Math.abs(h) % TINTS.length];
}

/**
 * Lay out one composed panel at `width` with its elements' measured `sizes`, ready to draw: the layout, the pose it
 * framed, each element's outline as SVG path text (a balloon with its tail, a thought cloud, a burst), and the scene
 * behind her (`scene`, below) at `now` under the daemon's `sky`.
 */
export function layout(panel, width, sizes, now, hourOverride, sky) {
	const laid = compose.panelLayout({ panel, width, sizes, poses });
	const elements = laid.layout.elements.map((e, i) => {
		const kind = sizes[i] ? sizes[i].kind : "";
		if (!e) return e;
		if (kind === "june") return Object.assign({}, e, { path: compose.balloonPath(e.w, e.h, e.tail ?? null) });
		if (kind === "thought") return Object.assign({}, e, { path: compose.cloudPath(e.w, e.h, 24, 5), trailDots: e.trail ? compose.TRAIL : [] });
		if (kind === "burst") return Object.assign({}, e, { path: compose.jagged(e.w, e.h, 9) });
		return e;
	});
	const out = Object.assign({}, laid.layout, { elements, pose: laid.pose, tint: tint(panel.id), markShapes: compose.MARK_SHAPES });
	out.scene = scene(panel, out, laid.pose, sizes, width, now ?? Date.now(), hourOverride ?? -1, sky ?? null);
	return out;
}

/**
 * What stands behind her, ready to paint (Backdrop.qml and Scenery.qml on the desktop): the graded ground, an abstract
 * pattern, her room with the window's sky, sun, stars, weather, view, and props, how far out of focus it is, the
 * lamp, and how she is graded and lit; or a cutaway's panes, chain, or drawers while she works.
 */
function scene(panel, laid, pose, sizes, width, now, hourOverride, sky) {
	const sc = scenery.panelScene({ panel, layout: laid, pose, sizes, width, now, hourOverride, sky, scenery: rooms });
	const L = sc.light;
	const g = (c) => (c === "transparent" ? c : light.graded(c, L));
	const back = sc.backdrop;
	const pattern = back.kind === "abstract" ? light.PATTERNS[back.pattern] : null;
	const ground = back.kind === "cutaway" ? light.cutaway(back, width, laid.height, sc.seed, sc.clear).ground : g(back.kind === "calm" ? light.CALM_GROUND : pattern ? pattern.ground : tint(panel.id));
	const win = sc.roomPlace ? sc.roomPlace.window : null;
	return {
		kind: back.kind,
		cutaway: back.kind === "cutaway" ? Object.assign({ scene: back.scene }, light.cutaway(back, width, laid.height, sc.seed, sc.clear)) : null,
		ground,
		pattern: pattern ? { path: light.patternPath(back.pattern, width, laid.height, sc.faceCentre, sc.seed), stroke: g(pattern.stroke), fill: g(pattern.fill), width: pattern.width, opacity: pattern.opacity } : null,
		room: sc.roomPlace ? { url: sc.room.url, place: sc.roomPlace } : null,
		window: win,
		sky: sc.sky,
		falling: win && sc.sky.falling ? light.fallingPath(sc.sky.falling, win.w, win.h, sc.seed) : "",
		plate: sc.plate ? { url: sc.plate.url, width: sc.plate.width, height: sc.plate.height } : null,
		props: sc.props,
		blur: sc.blur,
		grade: L.grade,
		gradeAmount: L.gradeAmount,
		figure: { grade: L.figureGrade, brightness: L.figureBrightness, saturation: L.figureSaturation },
		key: { colour: L.key, strength: L.keyStrength },
		lamp: back.kind === "cutaway" || !sc.faceCentre ? 0 : L.lampOn,
		faceCentre: sc.faceCentre,
	};
}

/** The strip in the console look: each panel's lines (console.mjs), and whether she is still working in it. */
export function consoleStrip(items, state, holding) {
	return panels(items, state, holding).map((panel) => ({ id: panel.id, live: panel.live === true, lines: looks.lines(panel), takeMenu: compose.takeMenu(panel) }));
}

/**
 * Live June now (live.mjs): what she is doing from the view and the clock, `idleSince` being when her last run ended,
 * and the art for it, the set's sipping loop standing in for a state it lacks.
 */
export function liveNow(items, state, linked, idleSince, now) {
	const which = live.liveState({ view: { items, state }, linked, now: new Date(now), idleSince, once: null });
	return { state: which, art: liveArt[which] ?? liveArt.sipping ?? null };
}

/** A newly picked face since `seen` (a reply's id), with its chibi for her brief reaction; an empty object when none. */
export function reactionTo(items, seen) {
	const face = live.newFace(items, seen);
	if (!face) return {};
	const art = live.reactionArt(chibiArt, compose.chain(face.expression));
	return { id: face.id, expression: face.expression, url: art ? art.url : null };
}
