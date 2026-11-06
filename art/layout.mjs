// Where a generated image goes on its finished canvas: the sizes and face scale from the art list, as plain geometry so
// test/art.test.mjs can check it without images. june-art.mjs does the pixel work. Boxes are { x, y, w, h } in pixels.

/** Canvas sizes by kind, in pixels. */
export const CANVAS = {
	pose: [2048, 2662],
	tall: [2048, 4096],
	chibi: [1024, 1024],
	room: [3200, 2000],
	plate: [1600, 1000],
};

/** Her face's height as a share of the canvas, and where its centre sits, so every pose of a kind frames alike. */
export const FACE = {
	pose: { h: 0.27, cy: 0.33 },
	tall: { h: 0.1, cy: 0.13 },
};

/** The least clear space around a figure, as a share of the canvas side. */
export const MARGIN = 0.04;
/** How wide a pose's canvas may grow for a wide gesture (Jon, 2026-11-05: a starting limit, not a contract), and the step. */
export const MAX_WIDTH = 3072;
export const WIDTH_STEP = 128;

const round = (n, places = 3) => Math.round(n * 10 ** places) / 10 ** places;

/** The kind of piece a manifest section and entry make. */
export function kindOf(section, entry) {
	if (section === "poses") return Array.isArray(entry?.framings) && entry.framings.includes("full") ? "tall" : "pose";
	if (section === "chibi") return "chibi";
	if (section === "rooms") return "room";
	if (section === "plates") return "plate";
	if (section === "props") return "prop";
	return null;
}

/**
 * A pose on its canvas: scaled so her face (`face`, in source pixels) is the kind's height, centred across and at the
 * kind's height, then moved to keep the figure (`figure`, the source's opaque box) clear of the sides and the top. A
 * figure may run off the bottom, where a waist-up or knee-length pose is cut. Returns the scale, where the source's
 * corner lands, the face as canvas fractions, and any problem a person should look at.
 */
export function placePose(kind, figure, face, { maxWidth = MAX_WIDTH } = {}) {
	let [W, H] = CANVAS[kind];
	const target = FACE[kind];
	const scale = (target.h * H) / face.h;
	const problems = [];
	const m = MARGIN;
	// A gesture wider than the canvas widens it, at the same height and face size, rather than losing her fingers; past
	// the limit the drawing itself is too spread out for a panel.
	const needed = (figure.w * scale) / (1 - 2 * m);
	if (needed > W) {
		const wider = Math.ceil(needed / WIDTH_STEP) * WIDTH_STEP;
		const ratio = Math.round((figure.w / face.h) * 100) / 100;
		if (wider > maxWidth) return { refused: `the figure is ${ratio} times her face height wide; at this face size it needs ${wider} px, past the ${maxWidth} px limit` };
		problems.push(`widened to ${wider} px (${ratio} times her face height) so the gesture keeps every finger`);
		W = wider;
	}
	let x = W / 2 - (face.x + face.w / 2) * scale;
	let y = target.cy * H - (face.y + face.h / 2) * scale;
	const left = () => x + figure.x * scale;
	const right = () => x + (figure.x + figure.w) * scale;
	if (left() < W * m) x += W * m - left();
	else if (right() > W * (1 - m)) x -= right() - W * (1 - m);
	const top = y + figure.y * scale;
	if (top < H * m) {
		y += H * m - top;
		problems.push("her hair was near the top, so she sits lower than the other poses");
	}
	if (kind === "pose" && y + (figure.y + figure.h) * scale < H * (1 - m)) problems.push("the figure stops above the canvas bottom, so a waist framing may show her floating");
	const faceOut = [round((x + face.x * scale) / W), round((y + face.y * scale) / H), round((face.w * scale) / W), round((face.h * scale) / H)];
	return { scale, x, y, size: [W, H], face: faceOut, problems };
}

/** Project opaque source-pixel centers before gesture boxes are clamped. This does not certify anatomy or panel visibility. */
export function gesturePreservation(gestures, source, place) {
	const { w, h, alpha } = source;
	if (alpha.length !== w * h) throw new Error("gesture preservation needs one 8-bit alpha plane");
	const [W, H] = place.size;
	const sx = Math.round(w * place.scale) / w;
	const sy = Math.round(h * place.scale) / h;
	const dx = Math.round(place.x), dy = Math.round(place.y);
	return gestures.map((g) => {
		const b = g.box;
		if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[0] < 0 || b[1] < 0 || b[2] <= 0 || b[3] <= 0 || b[0] + b[2] > w || b[1] + b[3] > h) throw new Error(`${g.name}: gesture box must be inside the source`);
		let total = 0, outside = 0;
		const edges = { left: 0, right: 0, top: 0, bottom: 0 };
		for (let y = Math.floor(b[1]); y < Math.ceil(b[1] + b[3]); y++) {
			for (let x = Math.floor(b[0]); x < Math.ceil(b[0] + b[2]); x++) {
				if (alpha[y * w + x] <= 127) continue;
				total++;
				if (x === 0) edges.left++;
				if (x === w - 1) edges.right++;
				if (y === 0) edges.top++;
				if (y === h - 1) edges.bottom++;
				const px = dx + (x + 0.5) * sx, py = dy + (y + 0.5) * sy;
				if (px < 0 || px >= W || py < 0 || py >= H) outside++;
			}
		}
		return { name: g.name, solid_source_pixels: total, projected_outside_canvas: outside, source_edge_pixels: edges };
	});
}

/** A mouth point below the middle of the face, where a balloon tail aims when none is given. */
export function mouthOf(face) {
	return [round(face[0] + face[2] / 2), round(face[1] + face[3] * 0.8)];
}

/** A chibi on its square canvas: the whole figure as large as fits inside the margins, centred, standing on the bottom margin. */
export function placeChibi(figure) {
	const [W, H] = CANVAS.chibi;
	const scale = Math.min((W * (1 - 2 * MARGIN)) / figure.w, (H * (1 - 2 * MARGIN)) / figure.h);
	return { scale, x: W / 2 - (figure.x + figure.w / 2) * scale, y: H * (1 - MARGIN) - (figure.y + figure.h) * scale, size: [W, H], problems: [] };
}

/** A room or window view covering its canvas: scaled to fill it and centred, the overflow cropped. */
export function placeCover(kind, source) {
	const [W, H] = CANVAS[kind];
	const scale = Math.max(W / source.w, H / source.h);
	const problems = Math.abs(source.w / source.h - W / H) > 0.05 ? [`the source is ${source.w} × ${source.h}, so ${source.w / source.h > W / H ? "its sides are" : "its top and bottom are"} cropped`] : [];
	return { scale, x: (W - source.w * scale) / 2, y: (H - source.h * scale) / 2, size: [W, H], problems };
}

/** A prop trimmed to its figure and scaled to fit the size it is planned at in room pixels (`fit`, [w, h]). */
export function placeProp(figure, fit) {
	const scale = Math.min(fit[0] / figure.w, fit[1] / figure.h);
	const size = [Math.max(1, Math.round(figure.w * scale)), Math.max(1, Math.round(figure.h * scale))];
	return { scale, x: -figure.x * scale, y: -figure.y * scale, size, problems: [] };
}

/** A room's window as fractions of the canvas, from the box of its see-through pixels on the canvas. */
export function windowOf(hole, size) {
	return [round(hole.x / size[0]), round(hole.y / size[1]), round(hole.w / size[0]), round(hole.h / size[1])];
}

/** A box from ImageMagick's trim geometry, `WxH+X+Y`; null for an empty image. */
export function parseBox(text) {
	const m = /^(\d+)x(\d+)([+-]\d+)([+-]\d+)/.exec(String(text).trim());
	if (!m) return null;
	const box = { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
	return box.w > 0 && box.h > 0 ? box : null;
}

/** A box from `x,y,w,h` on the command line. */
export function parseNumbers(text, count) {
	const parts = String(text).split(",").map(Number);
	if (parts.length !== count || !parts.every(Number.isFinite)) throw new Error(`expected ${count} numbers separated by commas, got "${text}"`);
	return parts;
}
