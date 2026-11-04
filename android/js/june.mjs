// The decisions the phone shares with the desktop overlay, bundled into one script (june.js, a global `June`) for
// QuickJS: which panels the conversation makes, how each is laid out, how it is lit, what live June is doing, and the
// console look. The modules stay in overlay/, written in the plain JavaScript both QML and QuickJS run; see "What the
// phone shares with the desktop" in docs/interfaces.org. Below them, the phone's own glue: it keeps the strip's memory
// and the avatar set's poses in the engine between calls, and hands back layouts ready to draw.
import * as compose from "../../overlay/compose.mjs";
import * as looks from "../../overlay/console.mjs";
import * as light from "../../overlay/light.mjs";
import * as scenery from "../../overlay/scenery.mjs";
import * as strip from "../../overlay/strip.mjs";

export { compose, light, looks, scenery, strip };
export * as live from "../../overlay/live.mjs";

// Each panel's side and pose once chosen, kept for as long as the screen lives (composeStrip).
const memory = { sides: {}, poseIds: {}, livePoses: {} };
let poses = [];
let rooms = { rooms: [], plates: [], props: [] };

/** Read an avatar set's manifest: its poses, rooms, views, and props, their urls its files as the app's assets name them. */
export function setArt(manifest) {
	poses = compose.readPoses(manifest, "");
	rooms = scenery.mergeScenery([scenery.readScenery(manifest, "")]);
	return poses.length;
}

/** The strip for the view: its panels, composed with June's pose and side, oldest first. */
export function panels(items, state, holding) {
	const composed = compose.composeStrip(strip.panels(items), state, poses, memory, holding === true);
	// Tool calls carry their caption line, as the overlay's chips and cards show them.
	for (const panel of composed)
		for (const e of panel.elements) if (e.kind === "tools") e.items = e.items.map((item) => Object.assign({}, item, { caption: strip.caption(item) }));
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
 * lamp, and how she is graded and lit. A cutaway's own drawing is the desktop's alone for now; here it is its ground.
 */
function scene(panel, laid, pose, sizes, width, now, hourOverride, sky) {
	const sc = scenery.panelScene({ panel, layout: laid, pose, sizes, width, now, hourOverride, sky, scenery: rooms });
	const L = sc.light;
	const g = (c) => (c === "transparent" ? c : light.graded(c, L));
	const back = sc.backdrop;
	const pattern = back.kind === "abstract" ? light.PATTERNS[back.pattern] : null;
	const ground = back.kind === "cutaway" ? light.cutaway(back, width, laid.height, sc.seed).ground : g(back.kind === "calm" ? light.CALM_GROUND : pattern ? pattern.ground : tint(panel.id));
	const win = sc.roomPlace ? sc.roomPlace.window : null;
	return {
		kind: back.kind,
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
	return panels(items, state, holding).map((panel) => ({ id: panel.id, live: panel.live === true, lines: looks.lines(panel) }));
}
