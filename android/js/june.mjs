// The decisions the phone shares with the desktop overlay, bundled into one script (june.js, a global `June`) for
// QuickJS: which panels the conversation makes, how each is laid out, how it is lit, what live June is doing, and the
// console look. The modules stay in overlay/, written in the plain JavaScript both QML and QuickJS run; see "What the
// phone shares with the desktop" in docs/interfaces.org. Below them, the phone's own glue: it keeps the strip's memory
// and the avatar set's poses in the engine between calls, and hands back layouts ready to draw.
import * as compose from "../../overlay/compose.mjs";
import * as strip from "../../overlay/strip.mjs";

export { compose, strip };
export * as live from "../../overlay/live.mjs";
export * as light from "../../overlay/light.mjs";
export * as scenery from "../../overlay/scenery.mjs";
export * as looks from "../../overlay/console.mjs";

// Each panel's side and pose once chosen, kept for as long as the screen lives (composeStrip).
const memory = { sides: {}, poseIds: {}, livePoses: {} };
let poses = [];

/** Read an avatar set's manifest; its poses' urls are its files, as the app names them in its assets. */
export function setArt(manifest) {
	poses = compose.readPoses(manifest, "");
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
 * framed, the ground, and each element's outline as SVG path text (a balloon with its tail, a thought cloud, a burst).
 */
export function layout(panel, width, sizes) {
	const laid = compose.panelLayout({ panel, width, sizes, poses });
	const elements = laid.layout.elements.map((e, i) => {
		const kind = sizes[i] ? sizes[i].kind : "";
		if (!e) return e;
		if (kind === "june") return Object.assign({}, e, { path: compose.balloonPath(e.w, e.h, e.tail ?? null) });
		if (kind === "thought") return Object.assign({}, e, { path: compose.cloudPath(e.w, e.h, 24, 5), trailDots: e.trail ? compose.TRAIL : [] });
		if (kind === "burst") return Object.assign({}, e, { path: compose.jagged(e.w, e.h, 9) });
		return e;
	});
	return Object.assign({}, laid.layout, { elements, pose: laid.pose, tint: tint(panel.id) });
}
