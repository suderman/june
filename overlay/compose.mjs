// The comic layout engine: given a panel's width, June's pose, and the measured sizes of its balloons and notes, it
// decides where everything goes. The art is framed like a hero image, scaled and cropped by the face box rather than
// sizing the panel; the panel's height comes from its words. QML measures the text and draws; this module holds every
// decision, so test/overlay.test.mjs can check the compositions without Qt. Plain JavaScript as QML's engine knows
// it: no Array.prototype.at, Object.hasOwn, or object spread. See "Look: a comic strip" and "Poses" in
// docs/interfaces.org for the contract with the art.

/** Each expression's fallback; a copy of src/avatar.ts, kept in step by test/overlay.test.mjs. */
export const FALLBACK = {
	warm: "idle",
	wry: "idle",
	curious: "idle",
	skeptical: "wry",
	determined: "idle",
	serious: "idle",
	gentle: "warm",
	smug: "wry",
	exasperated: "skeptical",
	laughing: "wry",
	surprised: "curious",
	confused: "curious",
	indignant: "exasperated",
	pout: "wry",
	bashful: "warm",
	delighted: "warm",
	cheering: "delighted",
};
export const FRAMINGS = ["close-up", "head", "bust", "waist", "full"];
// A pose that names no framings fills these; `full` (a three-quarter or full figure) only when it says so.
const USUAL = ["close-up", "head", "bust", "waist"];
const MARKS = ["sparkle", "heart", "sweat", "vein", "steam", "emphasis"];

/**
 * How each mark is drawn: an SVG path in a 100-unit box, scaled to the mark's size, stroked 7 units wide with round
 * ends, and filled where it has a fill. A stroke of "ink" takes the look's ink.
 */
export const MARK_SHAPES = {
	sparkle: { stroke: "#f2b81c", fill: "transparent", path: "M 50 8 L 50 34 M 20 22 L 34 40 M 80 22 L 66 40 M 8 56 L 30 58 M 92 56 L 70 58" },
	emphasis: { stroke: "ink", fill: "transparent", path: "M 10 30 L 34 44 M 18 8 L 38 34 M 46 2 L 50 30 M 74 8 L 62 34 M 92 30 L 68 44" },
	heart: { stroke: "#e2557a", fill: "#ffb3c7", path: "M 50 86 C 18 64 6 46 14 28 C 22 12 44 12 50 30 C 56 12 78 12 86 28 C 94 46 82 64 50 86 Z" },
	sweat: { stroke: "#3a7bc8", fill: "#bfe0ff", path: "M 50 6 C 66 34 78 50 78 66 C 78 82 64 94 50 94 C 36 94 22 82 22 66 C 22 50 34 34 50 6 Z" },
	vein: { stroke: "#d0342c", fill: "transparent", path: "M 14 38 Q 38 38 38 14 M 62 14 Q 62 38 86 38 M 86 62 Q 62 62 62 86 M 38 86 Q 38 62 14 62" },
	steam: { stroke: "#7b7f8c", fill: "#ffffff", path: "M 20 70 C 4 70 4 46 22 46 C 22 28 46 24 54 38 C 64 22 92 30 86 52 C 100 58 94 80 76 78 C 70 92 44 92 40 80 C 32 86 20 82 20 70 Z" },
};
// What a pose can show her doing; a copy of POSE_ACTIVITIES in src/avatar.ts, kept in step by test/overlay.test.mjs.
export const ACTIVITIES = ["thinking", "working", "watching"];
/** Where a pose has her: at her desk, on the couch, in the kitchen, or standing. A copy of SETTINGS in src/avatar.ts. */
export const SETTINGS = ["desk", "couch", "kitchen", "standing"];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** A stable number for a string, for choices that must not change between redraws. */
export function hash(text) {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
	return Math.abs(h);
}

/** The expressions to try for a name: itself, its fallbacks, then idle. */
export function chain(expression) {
	const out = [];
	let next = expression === "idle" || Object.prototype.hasOwnProperty.call(FALLBACK, expression) ? expression : "idle";
	while (next !== undefined && !out.includes(next)) {
		out.push(next);
		next = FALLBACK[next];
	}
	if (!out.includes("idle")) out.push("idle");
	return out;
}

const fraction = (n) => typeof n === "number" && n >= 0 && n <= 1;

/**
 * A pose's gestures (its manifest =gestures=): each a name and a box in fractions of the image, the primary one first.
 * A pose whose defining gesture lies away from her face lists one; the strip checks the primary one is seen.
 */
function readGestures(list) {
	if (!Array.isArray(list)) return [];
	const out = list
		.filter((g) => g && typeof g.name === "string" && Array.isArray(g.box) && g.box.length === 4 && g.box.every(fraction) && g.box[2] > 0 && g.box[3] > 0)
		.map((g) => ({ name: g.name, box: { x: g.box[0], y: g.box[1], w: g.box[2], h: g.box[3] }, primary: g.primary === true }));
	const primary = out.findIndex((g) => g.primary);
	if (primary > 0) out.unshift(...out.splice(primary, 1));
	return out;
}

/**
 * The usable poses of one avatar set, with image URLs under `base`. Lenient where src/avatar.ts is strict: a pose the
 * overlay cannot place is skipped, so one bad entry never blanks the strip.
 */
export function readPoses(manifest, base) {
	const out = [];
	for (const [id, p] of Object.entries(manifest?.poses ?? {})) {
		if (typeof p?.file !== "string" || typeof p.expression !== "string") continue;
		if (!Array.isArray(p.size) || !(p.size[0] > 0 && p.size[1] > 0)) continue;
		if (!Array.isArray(p.face) || p.face.length !== 4 || !p.face.every(fraction) || !(p.face[2] > 0 && p.face[3] > 0)) continue;
		if (!Array.isArray(p.mouth) || p.mouth.length !== 2 || !p.mouth.every(fraction)) continue;
		const framings = Array.isArray(p.framings) ? p.framings.filter((f) => FRAMINGS.includes(f)) : [];
		out.push({
			id,
			url: base + p.file,
			width: p.size[0],
			height: p.size[1],
			expression: p.expression,
			activity: ACTIVITIES.includes(p.activity) ? p.activity : null,
			setting: SETTINGS.includes(p.setting) ? p.setting : "desk",
			face: { x: p.face[0], y: p.face[1], w: p.face[2], h: p.face[3] },
			mouth: { x: p.mouth[0], y: p.mouth[1] },
			facing: ["left", "right"].includes(p.facing) ? p.facing : "front",
			mirror: p.mirror !== false,
			framings: framings.length > 0 ? framings : [...USUAL],
			marks: Array.isArray(p.marks) ? p.marks.filter((m) => MARKS.includes(m)) : [],
			gestures: readGestures(p.gestures),
			added: typeof p.added === "string" && !Number.isNaN(Date.parse(p.added)) ? Date.parse(p.added) : null,
			special: p.special === true,
		});
	}
	return out;
}

/**
 * The pose for a request: the named pose; for an `activity`, a pose showing her doing it; otherwise one with the
 * requested expression or the next in its chain. A pose that shows an activity never answers an expression, so a
 * settled panel never shows her still at work. `avoid` is the previous panel's pose, skipped when another fits, and
 * `seed` picks among equals so a panel keeps its choice. Given her `side`, poses that can stand there come first.
 */
export function choosePose(poses, request = {}, avoid = "", seed = "", side = null) {
	if (poses.length === 0) return null;
	if (request.pose) {
		const named = poses.find((p) => p.id === request.pose);
		if (named) return named;
	}
	const pick = (all) => {
		const standing = side ? all.filter((p) => standsOn(p, side)) : all;
		const fits = standing.length > 0 ? standing : all;
		const fresh = fits.filter((p) => p.id !== avoid);
		const pool = (fresh.length > 0 ? fresh : fits).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		return pool[hash(seed) % pool.length];
	};
	if (request.activity) {
		const doing = poses.filter((p) => p.activity === request.activity);
		if (doing.length > 0) return pick(doing);
	}
	const reactions = poses.filter((p) => !p.activity);
	for (const expression of chain(request.expression ?? "idle")) {
		const fits = reactions.filter((p) => p.expression === expression);
		if (fits.length === 0) continue;
		return pick(fits);
	}
	return reactions[0] ?? poses[0];
}

/**
 * What the panel June is answering in should show her doing, from runtime state alone: thinking before her first words,
 * working while tool calls run or patter comes through after them, or tidying while compacting. Null once she is
 * writing her reply (her expression shows then) or when no run is busy, so the panel settles to her reaction.
 */
export function liveActivity(state, panel) {
	if (!state || !(state.running || state.compacting)) return null;
	if (state.compacting) return "working";
	const elements = panel.elements;
	const last = elements[elements.length - 1];
	if (last && last.kind === "june" && last.streaming && last.text.trim() !== "") return null;
	const since = elements.slice(elements.map((e) => e.kind).lastIndexOf("june") + 1);
	if (since.some((e) => e.kind === "tools")) return "working";
	return "thinking";
}

// Until the daemon sends June's expression (see "Send expression and activity to clients"), the overlay picks one from
// what it can see. Common faces only: rare ones stay rare, and these choices must never claim a feeling she did not show.
const STAND_IN = ["idle", "warm", "wry", "curious", "smug", "laughing", "serious"];

/**
 * What a settled panel asks for: the face the daemon picked for its latest reply (the expression and, when named, the
 * pose), or null before one has arrived.
 */
export function picked(panel) {
	for (let i = panel.elements.length - 1; i >= 0; i--) {
		const e = panel.elements[i];
		if (e.kind === "june" && e.expression) {
			const request = e.pose ? { pose: e.pose, expression: e.expression } : { expression: e.expression };
			if (e.side) request.side = e.side;
			return request;
		}
	}
	return null;
}

/** The reply whose picked face a settled panel shows, or "" before one has arrived. */
function pickedReply(panel) {
	for (let i = panel.elements.length - 1; i >= 0; i--) {
		const e = panel.elements[i];
		if (e.kind === "june" && e.expression) return e.replyId || "";
	}
	return "";
}

/** A stand-in request for a panel: a failure gets exasperation, a reply in progress curiosity, the rest a common face. */
export function standIn(panel, live) {
	if (panel.elements.some((e) => e.kind === "burst")) return { expression: "exasperated" };
	if (live) return { expression: "curious" };
	if (panel.elements.some((e) => e.kind === "tools" && e.items.length > 1)) return { expression: "serious" };
	return { expression: STAND_IN[hash(panel.id) % STAND_IN.length] };
}

/**
 * Each panel's pose and side, oldest first, as every client composes the strip. Recorded choices win. A panel without
 * one takes the other side from the latest earlier recorded pose, as the daemon will record it, so her side is set when
 * the panel opens and kept through streaming, settling, and reloads; her pose may change, preferring poses that can
 * stand there. Before any recorded pose, a panel derives its side and stand-in from its id and the art available at
 * selection time, never from client memory.
 * `memory` ({ sides, poseIds, livePoses }) keeps live presentation state between calls. The panel she is answering in
 * shows the pose of the moment; when the run ends, `holding` (the client's few seconds after a run) keeps her talking
 * pose there until the daemon's picked face arrives, then a
 * stand-in. Returns the panels with `side`, `pose`, and `live` added.
 */
export function composeStrip(panels, state, poses, memory, holding = false) {
	// One of June's private looks adds nothing to the newest panel, so the panel keeps its settled face through it.
	const running = Boolean(state && ((state.running && !state.looking) || state.compacting));
	let previousPose = "";
	let previousReply = "";
	// The side of the latest panel so far whose picked face named a pose: the reply the daemon alternates from.
	let anchor = null;
	return panels.map((p, i) => {
		const live = i === panels.length - 1 && running;
		// While she works or thinks, a pose showing that; while she writes, her expression; settled, the face the daemon
		// picked for her reply, or a kept stand-in until it arrives.
		const doing = live ? liveActivity(state, p) : null;
		const recorded = picked(p);
		const face = live ? null : recorded;
		// A long reply runs on into later panels. Those show another pose of the same face where one can stand on her
		// side, so the strip does not print one picture twice; the panel's id keeps the choice for every client.
		const reply = pickedReply(p);
		const continued = face !== null && reply !== "" && reply === previousReply;
		// Her side is settled before her pose and kept while the pose changes: the recorded side, even while a later run
		// makes this panel live again; else the other side from the latest earlier recorded pose, which is the side the
		// daemon will record for this reply (resolvePick in expression.ts); else, with no record before it, from its id.
		const held = recorded?.side ?? (anchor === null ? null : anchor === "left" ? "right" : "left");
		const hold = !live && !face && i === panels.length - 1 && holding && memory.livePoses[p.id] !== undefined;
		const find = (id) => poses.find((x) => x.id === id) ?? null;
		// A settled panel chooses only among poses in the set when it happened, so adding art never changes it.
		const time = selectionMoment(p);
		const pool = poses.filter((x) => availableAt(x, time));
		let pose = live
			? choosePose(poses, doing ? { activity: doing, expression: "curious" } : standIn(p, true), previousPose, p.id, held)
			: face
				? continued
					? choosePose(pool, { expression: face.expression }, previousPose, p.id, held)
					: (face.pose ? find(face.pose) : null) ?? choosePose(pool, face, "", p.id, held)
				: hold
					? find(memory.livePoses[p.id])
					: choosePose(pool, standIn(p, false), "", p.id, held);
		if (live && pose) memory.livePoses[p.id] = pose.id;
		if (!pose && !live) {
			pose = choosePose(pool, standIn(p, false), "", p.id, held);
			if (pose) memory.poseIds[p.id] = pose.id;
		}
		// The pose yields only when none that can stand on her side answers the request.
		const preferred = held ?? (hash(p.id) % 2 === 0 ? "left" : "right");
		memory.sides[p.id] = chooseSide(preferred === "left" ? "right" : "left", pose);
		if (recorded?.pose) anchor = recorded.side ?? "";
		previousPose = pose ? pose.id : "";
		previousReply = reply;
		return Object.assign({}, p, { side: memory.sides[p.id], pose, live });
	});
}

/**
 * A pose that can fill a tall panel standing in for `pose`: one with a `full` framing and the same expression, or the
 * next in its chain, so a long panel shows the whole of her rather than an inset. Null when the set has none.
 */
export function tallFor(poses, pose) {
	if (!pose) return null;
	if (pose.framings.includes("full")) return pose;
	const tall = poses.filter((p) => p.framings.includes("full"));
	// A pose showing her at work keeps her at work if a tall one does; otherwise she stands in her expression's pose.
	if (pose.activity) {
		const doing = tall.find((p) => p.activity === pose.activity);
		if (doing) return doing;
	}
	for (const expression of chain(pose.expression)) {
		const found = tall.find((p) => p.expression === expression && !p.activity);
		if (found) return found;
	}
	return null;
}

/** When a panel happened, in epoch milliseconds: the latest time on its words; null when none carries one. */
export function moment(panel) {
	let at = null;
	for (const e of panel.elements ?? []) {
		const t = e.kind === "user" ? e.item?.at : e.kind === "june" ? e.at : undefined;
		if (typeof t === "number" && (at === null || t > at)) at = t;
	}
	return at;
}

/** The last picked reply's selection time, separate from the words' time used for lighting. */
export function selectionMoment(panel) {
	for (let i = panel.elements.length - 1; i >= 0; i--) {
		const e = panel.elements[i];
		if (e.kind === "june" && e.expression) return typeof e.expressionAt === "number" ? e.expressionAt : e.at ?? moment(panel);
	}
	return moment(panel);
}

/** Shared native-menu decisions; input gestures and menu drawing belong to each client. */
export function takeMenu(panel, busy = false) {
	if (panel.live) return [];
	const reply = panel.elements.slice().reverse().find((e) => e.kind === "june" && e.replyId);
	if (!reply || reply.streaming) return [];
	const action = (op, label) => ({ op, label, reply: reply.replyId, revision: reply.artVersion ?? "", enabled: !busy });
	const menu = [action("retake", "Another take")];
	if (reply.canRestore) menu.push(action("restore", "Back"));
	if (reply.canAdvance) menu.push(action("advance", "Forward"));
	return menu;
}

/** Whether `pose` was in the set when a panel at `time` was composed: poses added later never change an old panel. */
export function availableAt(pose, time) {
	return pose.added === null || pose.added === undefined || time === null || time === undefined || pose.added <= time;
}

/** How much of a pose's primary gesture must be seen, and how small her face may grow to show it, as shares. */
export const GESTURE_SHOWN = 0.7;
export const GESTURE_FACE = 0.75;

/**
 * How much of the primary gesture of `pose`, as framed by `layout`, is seen: inside the art's clip and under none of
 * the panel's elements (balloons, notes, chips, cards), sampled on a grid. 1 for a pose without a gesture.
 */
export function gestureShown(layout, pose) {
	const g = pose?.gestures?.[0];
	if (!g || !layout?.art) return 1;
	const art = layout.art;
	const bx = layout.mirror ? 1 - g.box.x - g.box.w : g.box.x;
	const box = { x: art.x + bx * art.w, y: art.y + g.box.y * art.h, w: g.box.w * art.w, h: g.box.h * art.h };
	const clip = layout.clip;
	const covers = (layout.elements ?? []).filter(Boolean);
	const inside = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
	const N = 12;
	let seen = 0;
	for (let i = 0; i < N; i++)
		for (let j = 0; j < N; j++) {
			const x = box.x + ((i + 0.5) / N) * box.w;
			const y = box.y + ((j + 0.5) / N) * box.h;
			if (inside(clip, x, y) && !covers.some((r) => inside(r, x, y))) seen++;
		}
	return seen / (N * N);
}

/**
 * The framings of `pose` (face and gesture boxes as fractions) that keep its primary gesture in view, judged by height
 * alone as =frame= crops around her face. Ingest writes them, so a pose never offers a crop that loses its gesture; the
 * panel's own check, after the words are placed, has the last word.
 */
export function framingsShowing(pose) {
	const g = pose.gestures?.[0];
	if (!g) return [...USUAL];
	const cy = pose.face.y + pose.face.h / 2;
	return USUAL.filter((framing) => {
		const area = pose.face.h / FACE_SHARE[framing];
		const top = cy - FACE_Y[framing] * area;
		const seen = Math.max(0, Math.min(g.box.y + g.box.h, top + area) - Math.max(g.box.y, top));
		return seen / g.box.h >= GESTURE_SHOWN;
	});
}

/** A stable order for `list` by panel: sorted by id, starting where the panel's id lands, so a panel keeps its choice. */
function stableOrder(list, seed) {
	const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	if (sorted.length === 0) return sorted;
	const start = hash(seed) % sorted.length;
	return [...sorted.slice(start), ...sorted.slice(0, start)];
}

/**
 * Lay out a composed panel (composeStrip): planned with its pose first, and if the words run long enough to need an
 * inset, a pose of the same expression drawn tall takes over and she fills the panel instead. A pose with a gesture
 * must show it, not crop it or hide it behind the words; failing that, in order: the same pose framed wider while her
 * face keeps most of its size; another pose with the same expression and gesture; another with the same expression;
 * and else the pose as first framed. Only poses in the set when the panel happened count, and every choice follows
 * from the panel, its pose, the layout, and the set, so a panel keeps its art. A drawn special (=special=) is never
 * replaced: framed wider if that shows it, else kept, with =cropped= set so a client can offer it whole. Returns the
 * layout and the pose it framed.
 */
export function panelLayout({ panel, width, sizes, poses }) {
	const time = selectionMoment(panel);
	const usable = poses.filter((p) => availableAt(p, time));
	const lay = (pose, framing) => {
		const first = plan({ width, side: panel.side, pose, elements: sizes, framing: framing ?? panel.framing });
		const tall = first.clip.inset && !pose?.special ? tallFor(usable, pose) : null;
		if (!tall) return { layout: first, pose };
		return { layout: plan({ width, side: panel.side, pose: tall, elements: sizes, framing: framing ?? panel.framing }), pose: tall };
	};
	const first = lay(panel.pose);
	const pose = first.pose;
	if (!pose?.gestures?.length) return first;
	// Her face's size and the crop this panel would give any pose: the yardstick for how far out she may be framed.
	const natural = plan({ width, side: panel.side, pose: Object.assign({}, pose, { framings: [...new Set([...USUAL, ...pose.framings])] }), elements: sizes, framing: panel.framing });
	const faceH = natural.face?.h ?? 0;
	const fits = (l) => (l.layout.face?.h ?? 0) >= faceH * GESTURE_FACE && gestureShown(l.layout, l.pose) >= GESTURE_SHOWN;
	if (fits(first)) return first;
	// The same pose framed wider, as long as her face keeps most of its size.
	const from = Math.max(0, USUAL.indexOf(natural.framing));
	for (const framing of USUAL.slice(from).filter((f) => pose.framings.includes(f) && f !== first.layout.framing)) {
		const wider = lay(pose, framing);
		if (wider.pose === pose && fits(wider)) return wider;
	}
	if (pose.special) return { layout: Object.assign({}, first.layout, { cropped: gestureShown(first.layout, pose) < GESTURE_SHOWN }), pose };
	const others = usable.filter((p) => p.id !== pose.id && !p.activity && !p.special && p.expression === pose.expression);
	const gesture = pose.gestures[0].name;
	const alike = others.filter((p) => p.gestures?.[0]?.name === gesture);
	const rest = others.filter((p) => p.gestures?.[0]?.name !== gesture);
	for (const group of [alike, rest])
		for (const candidate of stableOrder(group, panel.id)) {
			const tried = lay(candidate);
			if (fits(tried)) return tried;
		}
	return first;
}

/**
 * Which side June stands on: the other side from the panel before, unless the pose faces away from the text there and
 * may not be mirrored, in which case she takes the side where she faces in.
 */
export function chooseSide(previous, pose) {
	const preferred = previous === "left" ? "right" : "left";
	return standsOn(pose, preferred) ? preferred : preferred === "left" ? "right" : "left";
}

/** Whether `pose` can stand on `side` facing the words: it faces front, may be mirrored, or already faces in. */
export function standsOn(pose, side) {
	if (!pose || pose.mirror || pose.facing === "front") return true;
	return side === "left" ? pose.facing === "right" : pose.facing === "left";
}

/**
 * The panel's proportions at `width`. From 480 px June stands beside the words, with less of the width as it narrows;
 * below that she is stacked: a band across the panel, what comes before her first balloon above it, and her words at
 * full width beneath it.
 */
export function metrics(width) {
	const stacked = width < 480;
	const pad = stacked ? 12 : 18;
	const artZone = stacked ? 0 : width * (width >= 700 ? 0.4 : 0.34);
	const overlap = stacked ? 0 : width * 0.05;
	return {
		stacked,
		pad,
		gap: 12,
		artZone,
		overlap,
		band: stacked ? Math.round(clamp(width * 0.44, 120, 190)) : 0,
		// The words' column: everything except the art's side, plus a little overlap onto the art (never onto her face).
		textWidth: Math.floor(width - artZone + overlap - 2 * pad),
		minHeight: Math.round(clamp(width * 0.27, 140, 230)),
		// Past this the art stops growing with the panel and sits in an inset at the top instead.
		maxArt: Math.round(clamp(width * 0.62, 240, 480)),
	};
}

// The lane between June's face and the words, where balloon tails run.
const FACE_GAP = 26;
// How much of the art area's height her face fills, and where its centre sits, per framing. A close-up still keeps her
// hair and the top of her shoulders in frame, as a comic close-up does.
const FACE_SHARE = { "close-up": 0.6, head: 0.46, bust: 0.34, waist: 0.25, full: 0.15 };
const FACE_Y = { "close-up": 0.5, head: 0.44, bust: 0.38, waist: 0.3, full: 0.15 };

/** The framing for an art area `height` tall in a panel `width` wide, honouring a hint and what the pose supports. */
export function chooseFraming(width, height, pose, hint) {
	const allowed = pose?.framings ?? USUAL;
	if (hint && allowed.includes(hint)) return hint;
	// Against at least a desktop-ish width, so a phone-narrow strip does not read every panel as tall and pull back.
	const ratio = height / Math.max(width, 560);
	const want = ratio < 0.32 ? "close-up" : ratio < 0.45 ? "head" : ratio < 0.62 ? "bust" : ratio < 0.85 ? "waist" : "full";
	const order = [...FRAMINGS].sort((a, b) => Math.abs(FRAMINGS.indexOf(a) - FRAMINGS.indexOf(want)) - Math.abs(FRAMINGS.indexOf(b) - FRAMINGS.indexOf(want)));
	return order.find((f) => allowed.includes(f)) ?? want;
}

/**
 * Frame a pose into `area` (x, y, w, h in panel coordinates) with June's face hugging `edge`, the x the words begin
 * (side left) or end (side right). Returns the image's rectangle, which may run past the area and is clipped to it, and
 * where her face and mouth land.
 */
export function frame(pose, area, side, edge, framing, mirror) {
	const faceAspect = (pose.face.w * pose.width) / (pose.face.h * pose.height);
	let faceH = area.h * FACE_SHARE[framing];
	// Her face stays clear of the words, with a lane between for balloon tails, and inside the area.
	const room = side === "left" ? edge - area.x - FACE_GAP - 4 : area.x + area.w - edge - FACE_GAP - 4;
	faceH = Math.min(faceH, (room * 0.98) / faceAspect, area.h - 8);
	let scale = faceH / (pose.face.h * pose.height);
	const fx = mirror ? 1 - pose.face.x - pose.face.w : pose.face.x;
	const mx = mirror ? 1 - pose.mouth.x : pose.mouth.x;
	const fcy = pose.face.y + pose.face.h / 2;
	// No floating torso: the image reaches the area's bottom when the pose has body enough, growing a little if needed.
	const centerY = area.y + area.h * FACE_Y[framing];
	const reach = (area.y + area.h - centerY) / (pose.height * (1 - fcy));
	if (reach > scale) scale = Math.min(reach, scale * 1.35, ((room * 0.98) / faceAspect) / (pose.face.h * pose.height));
	const w = pose.width * scale;
	const h = pose.height * scale;
	const faceW = pose.face.w * w;
	faceH = pose.face.h * h;
	const centerX = side === "left" ? edge - FACE_GAP - faceW / 2 : edge + FACE_GAP + faceW / 2;
	const x = centerX - (fx + pose.face.w / 2) * w;
	let y = centerY - fcy * h;
	// Still short of the bottom: move her down to meet it, but never so far that her chin leaves the area.
	if (y + h < area.y + area.h) y = Math.max(y, Math.min(area.y + area.h - h, area.y + area.h - 4 - (pose.face.y + pose.face.h) * h));
	const face = { x: x + fx * w, y: y + pose.face.y * h, w: faceW, h: faceH };
	return { image: { x, y, w, h }, face, mouth: { x: x + mx * w, y: y + pose.mouth.y * h } };
}

const TAIL_BASE = 22;
const TAIL_LEAN = (50 * Math.PI) / 180;
const NORMALS = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

/** How far a ray from (x, y) along (ux, uy) travels before entering `box` grown by `margin`; Infinity if it misses. */
function entry(x, y, ux, uy, box, margin) {
	let near = 0;
	let far = Infinity;
	for (const [p, u, lo, hi] of [
		[x, ux, box.x - margin, box.x + box.w + margin],
		[y, uy, box.y - margin, box.y + box.h + margin],
	]) {
		if (Math.abs(u) < 1e-9) {
			if (p < lo || p > hi) return Infinity;
			continue;
		}
		const t1 = (lo - p) / u;
		const t2 = (hi - p) / u;
		near = Math.max(near, Math.min(t1, t2));
		far = Math.min(far, Math.max(t1, t2));
	}
	return near <= far ? near : Infinity;
}

/**
 * A balloon's tail toward June's mouth. It may leave the balloon's side facing her (when the side has a straight run) or
 * its top or bottom edge near her, whichever faces her mouth; beside her face the side is preferred, and otherwise the
 * candidate with the longer clear path wins. The tip stops short of her face and of every box in `obstacles`.
 * `stacked` (a narrow panel, her band above the words) allows only the top edge, under her mouth, so a balloon boxed
 * in from above goes without a tail rather than pointing out of the panel. Coordinates are relative to the balloon.
 */
export function aimTail(box, mouth, face, side, obstacles = [], stacked = false) {
	const r = Math.min(box.h / 2, 26);
	const straight = box.h - 2 * r;
	const beside = box.y < face.y + face.h && face.y < box.y + box.h;
	const candidates = [];
	// Stacked, she is above the words, never beside them: a side tail would point out of the panel.
	if (straight >= 12 && !stacked) {
		const base = Math.min(TAIL_BASE, straight - 2);
		const at = clamp(mouth.y - box.y, r + base / 2, box.h - r - base / 2);
		candidates.push({ edge: side, at, base, bx: side === "left" ? box.x : box.x + box.w, by: box.y + at });
	}
	// The top or bottom edge, near her side, when it has a straight run wide enough for a base.
	const across = box.w - 2 * r;
	if (across >= 12) {
		const vertical = mouth.y >= box.y + box.h ? "bottom" : "top";
		const base = Math.min(TAIL_BASE, across - 2);
		// Stacked, the tail leaves the top under her mouth; otherwise near her side.
		const at = stacked ? clamp(mouth.x - box.x, r + base / 2, box.w - r - base / 2) : side === "left" ? r + base / 2 : box.w - r - base / 2;
		candidates.push({ edge: vertical, at, base, bx: box.x + at, by: vertical === "bottom" ? box.y + box.h : box.y });
	}
	// A balloon too small for any base has no tail; Balloon.qml keeps balloons above that size.
	if (candidates.length === 0) return null;
	let best = null;
	for (const c of candidates) {
		const dx = mouth.x - c.bx;
		const dy = mouth.y - c.by;
		const dist = Math.hypot(dx, dy) || 1;
		// A tail leans at most TAIL_LEAN from its edge's outward normal: past that it reads as a bent spike, so it
		// points as near her mouth as that allows.
		const normal = NORMALS[c.edge];
		const want = Math.atan2(dy / dist, dx / dist);
		const out = Math.atan2(normal[1], normal[0]);
		let lean = want - out;
		while (lean > Math.PI) lean -= 2 * Math.PI;
		while (lean < -Math.PI) lean += 2 * Math.PI;
		const angle = out + clamp(lean, -TAIL_LEAN, TAIL_LEAN);
		const ux = Math.cos(angle);
		const uy = Math.sin(angle);
		// Stop short of where the line enters her face box, or runs into another balloon.
		const blocked = Math.min(entry(c.bx, c.by, ux, uy, face, 8), ...obstacles.map((o) => entry(c.bx + ux, c.by + uy, ux, uy, o, 4)));
		// Less than this much clear room and the tail would sit on something: this edge cannot have one.
		if (blocked - 2 < 12) continue;
		const length = Math.min(blocked - 2, 46);
		const tail = { edge: c.edge, at: c.at, base: c.base, tip: { x: c.bx + ux * length - box.x, y: c.by + uy * length - box.y }, length, lean: Math.abs(lean) };
		// Beside her face the side facing her wins; otherwise the edge that needs the least bending, then the longer tail.
		const preferred = beside && c.edge === side;
		const better = best === null || preferred || (!(beside && best.edge === side) && (tail.lean < best.lean - 0.2 || (Math.abs(tail.lean - best.lean) <= 0.2 && length > best.length + 4)));
		if (better) best = tail;
	}
	// Every edge is boxed in: no tail is better than one drawn over another balloon.
	if (best === null) return null;
	delete best.length;
	delete best.lean;
	return best;
}

// A thought trail's circles: how far along the trail each sits, and its diameter, as Panel.qml draws them.
export const TRAIL = [
	{ at: 14, size: 13 },
	{ at: 30, size: 8 },
];

/**
 * Where a thought cloud's trail of circles starts, relative to the cloud, and the unit direction it drifts: from the
 * cloud's corner nearest her face, toward her face, skipping a corner whose circles would land on one of `obstacles`.
 * Null when every corner is boxed in: the cloud alone still reads as a thought.
 */
export function aimTrail(box, face, obstacles = []) {
	const cx = face.x + face.w / 2;
	const cy = face.y + face.h / 2;
	const corners = [
		[box.x + 18, box.y + 6],
		[box.x + box.w - 18, box.y + 6],
		[box.x + 18, box.y + box.h - 6],
		[box.x + box.w - 18, box.y + box.h - 6],
	].sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
	const hits = (x, y, r) => obstacles.some((o) => x + r > o.x - 2 && x - r < o.x + o.w + 2 && y + r > o.y - 2 && y - r < o.y + o.h + 2);
	for (const [x, y] of corners) {
		const dist = Math.hypot(cx - x, cy - y) || 1;
		const dx = (cx - x) / dist;
		const dy = (cy - y) / dist;
		if (TRAIL.some((c) => hits(x + dx * c.at, y + dy * c.at, c.size / 2))) continue;
		// A trail leaves the cloud: from a far corner it would cross the cloud itself.
		const last = TRAIL[TRAIL.length - 1];
		const ex = x + dx * last.at;
		const ey = y + dy * last.at;
		if (ex > box.x && ex < box.x + box.w && ey > box.y && ey < box.y + box.h) continue;
		return { x: x - box.x, y: y - box.y, dx, dy };
	}
	return null;
}

/**
 * Lay out one panel. `elements` are in reading order with their measured sizes: `user` (the user's notes, set to the
 * outer edge, away from June), `june` (her balloons, toward her, staggered), `thought`, `chip` (one tool, above the
 * balloon after it), `card` (several tools, beside the next balloon when both fit), and `burst`. The panel's height
 * follows the words; the art is framed into it, or into an inset at the top when the words run long.
 */
export function plan({ width, side, pose, elements, framing: hint, mirror: allowMirror = true }) {
	const m = metrics(width);
	const textLeft = side === "left" && !m.stacked ? m.artZone - m.overlap + m.pad : m.pad;
	const textRight = textLeft + m.textWidth;
	const placed = [];
	// Stacked, everything before her first balloon (the user's note, the tools she ran, her thought) sits above her
	// band, and her words below it, so the panel reads in order and her balloon is right under her, its tail up to
	// her mouth.
	let bandTop = m.stacked && elements.length > 0 && elements[0].kind !== "june" ? -1 : 0;
	let y = bandTop === 0 ? m.band + m.pad : m.pad;
	const placeBand = () => {
		bandTop = Math.round(y - m.gap + m.pad);
		y = bandTop + m.band + m.pad;
	};
	let stagger = 0;
	for (let i = 0; i < elements.length; i++) {
		const e = elements[i];
		if (bandTop < 0 && e.kind === "june") placeBand();
		const w = Math.min(e.w, m.textWidth);
		const outer = (width) => (side === "left" ? textRight - width : textLeft);
		const inner = (width, shift) => (side === "left" ? textLeft + shift : textRight - width - shift);
		if (!m.stacked && e.kind === "card" && elements[i + 1]?.kind === "june" && w + m.gap + Math.min(elements[i + 1].w, m.textWidth) <= m.textWidth) {
			// A status card and the balloon after it share a row: the card outside, the balloon toward June. Never when
			// stacked, where the card goes above her band and the balloon under it.
			const next = elements[i + 1];
			const nw = Math.min(next.w, m.textWidth);
			placed.push({ x: outer(w), y, w, h: e.h });
			placed.push({ x: inner(nw, 0), y, w: nw, h: next.h, june: true });
			y += Math.max(e.h, next.h) + m.gap;
			i++;
			continue;
		}
		let x;
		if (e.kind === "user" || e.kind === "card") x = outer(w);
		else if (e.kind === "burst") x = textLeft + (m.textWidth - w) / 2;
		else {
			const shift = e.kind === "thought" ? 30 : e.kind === "june" ? stagger : 0;
			x = inner(w, Math.min(shift, m.textWidth - w));
			if (e.kind === "june") stagger = stagger === 0 ? 22 : 0;
		}
		placed.push({ x, y, w, h: e.h, june: e.kind === "june", thought: e.kind === "thought" });
		y += e.h + (e.kind === "chip" ? 6 : m.gap);
	}
	// No balloon yet (her answer has not begun): the band closes the panel.
	const bandLast = bandTop < 0;
	if (bandLast) placeBand();
	const contentBottom = placed.length > 0 && !bandLast ? y - m.gap : m.pad;
	const height = Math.round(m.stacked ? (bandLast ? bandTop + m.band : Math.max(bandTop + m.band + 60, contentBottom + m.pad + 6)) : Math.max(m.minHeight, contentBottom + m.pad + 6));

	let art = null;
	let clip = { x: 0, y: 0, w: width, h: height, inset: false };
	// In a stacked panel, the band she is framed in; her clip reaches past it, up to the top and down behind her first balloon.
	let band = null;
	let face = null;
	let mouth = null;
	let framing = null;
	let mirror = false;
	if (pose) {
		mirror = allowMirror && pose.mirror && ((side === "left" && pose.facing === "left") || (side === "right" && pose.facing === "right"));
		const tall = !m.stacked && height > m.maxArt + m.pad;
		const edgeOf = (area) => (m.stacked ? (side === "left" ? width * 0.62 : width * 0.38) : side === "left" ? Math.min(textLeft, area.x + area.w) : Math.max(textRight, area.x));
		let framed = null;
		if (tall && pose.framings.includes("full")) {
			// Long words and a pose drawn tall: June down the whole panel, kept only if her figure fills it.
			framing = "full";
			framed = frame(pose, clip, side, edgeOf(clip), framing, mirror);
			// Her face stays near the top; a figure that only reaches the bottom by sliding down the panel is too short.
			if (framed.image.y + framed.image.h < height - 1 || framed.face.y > height * 0.3) framed = null;
		}
		if (framed === null) {
			if (m.stacked) {
				// A band across the panel, under any opening notes: her face toward the middle, the rest of her running off
				// her side.
				clip = { x: 0, y: bandTop, w: width, h: m.band, inset: false };
				band = { y: bandTop, h: m.band };
			} else if (tall) {
				// Long words and no tall pose: June in an inset at the top of her side, not stretched down the panel.
				const w = Math.round(side === "left" ? textLeft - m.pad - 6 : width - textRight - m.pad - 6);
				clip = { x: side === "left" ? m.pad : width - m.pad - w, y: m.pad, w, h: Math.round(Math.min(m.maxArt * 0.75, w * 1.25)), inset: true };
			}
			const kept = pose.framings.filter((f) => f !== "full");
			framing = chooseFraming(width, clip.h, Object.assign({}, pose, { framings: kept.length > 0 ? kept : USUAL }), m.stacked ? (hint ?? "close-up") : hint);
			framed = frame(pose, clip, side, edgeOf(clip), framing, mirror);
			// Framed in her band, but seen on down behind her first balloon under it, so her body runs on behind the words
			// rather than stopping at a gap above them, and up to the panel's top behind any notes over the band, so her hair
			// is cut only where the panel ends, never flat along the band's edge.
			if (m.stacked) {
				const under = placed.find((e) => e.y >= bandTop + m.band);
				const bottom = under ? Math.min(height, under.y + under.h) : bandTop + m.band;
				clip = Object.assign({}, clip, { y: 0, h: bottom });
			}
		}
		art = framed.image;
		face = framed.face;
		mouth = framed.mouth;
	}

	const out = placed.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), w: p.w, h: p.h }));
	if (mouth) {
		// Consecutive balloons are one speech: each beside her face gets its own tail; otherwise only the one nearest her
		// mouth does, so tails never stack up across a run of balloons.
		const beside = (b) => b.y < face.y + face.h && face.y < b.y + b.h;
		const distance = (b) => (mouth.y < b.y ? b.y - mouth.y : mouth.y > b.y + b.h ? mouth.y - b.y - b.h : 0);
		let run = [];
		const close = () => {
			const tailed = run.some((i) => beside(out[i])) ? run.filter((i) => beside(out[i])) : run.length > 0 ? [run.reduce((a, b) => (distance(out[b]) < distance(out[a]) ? b : a))] : [];
			for (const i of tailed) out[i].tail = aimTail(out[i], mouth, face, side, out.filter((_, j) => j !== i), m.stacked);
			run = [];
		};
		// Tool chips, status cards, and thoughts are narration inside her speech, so they do not end a run; the user's
		// notes and bursts do.
		placed.forEach((p, i) => {
			if (p.june) run.push(i);
			else if (["user", "burst"].includes(elements[i]?.kind)) close();
		});
		close();
	}
	for (const [i, p] of placed.entries()) if (p.thought && face) out[i].trail = aimTrail(out[i], face, out.filter((_, j) => j !== i));

	const marks = [];
	if (pose && face) {
		const size = Math.round(clamp(face.h * 0.34, 26, 64));
		for (const [i, kind] of pose.marks.slice(0, 2).entries()) {
			// Above her head on the outside, away from the words.
			const x = side === "left" ? face.x - size * (0.4 + i * 0.9) : face.x + face.w - size * (0.6 - i * 0.9);
			marks.push({ kind, size, x: Math.round(clamp(x, clip.x + 2, clip.x + clip.w - size - 2)), y: Math.round(clamp(face.y - size * 0.55, clip.y + 2, clip.y + clip.h - size - 2)) });
		}
	}

	return { width, height, side, framing, mirror, clip, band, art, face, mouth, elements: out, marks, metrics: m };
}

/**
 * A June balloon and its tail as one SVG outline, so the tail joins without a seam: a rounded rectangle `w` by `h`
 * from the origin, the tail's base `base` wide centred `at` along `edge` (top, right, bottom, or left), ending at `tip`.
 */
export function balloonPath(w, h, tail) {
	const r = Math.min(h / 2, 26);
	const n = (v) => Math.round(v * 10) / 10;
	const arc = (x, y) => `A ${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y)}`;
	const t = tail ?? null;
	const tip = t ? `L ${n(t.tip.x)} ${n(t.tip.y)}` : "";
	let d = `M ${n(r)} 0`;
	d += t?.edge === "top" ? ` H ${n(t.at - t.base / 2)} ${tip} L ${n(t.at + t.base / 2)} 0` : "";
	d += ` H ${n(w - r)} ${arc(w, r)}`;
	d += t?.edge === "right" ? ` V ${n(t.at - t.base / 2)} ${tip} L ${n(w)} ${n(t.at + t.base / 2)}` : "";
	d += ` V ${n(h - r)} ${arc(w - r, h)}`;
	d += t?.edge === "bottom" ? ` H ${n(t.at + t.base / 2)} ${tip} L ${n(t.at - t.base / 2)} ${n(h)}` : "";
	d += ` H ${n(r)} ${arc(0, h - r)}`;
	d += t?.edge === "left" ? ` V ${n(t.at + t.base / 2)} ${tip} L 0 ${n(t.at - t.base / 2)}` : "";
	d += ` V ${n(r)} ${arc(r, 0)} Z`;
	return d;
}

/**
 * A thought bubble's outline: a cloud of shallow scallops around a `w` by `h` box. Neighbouring points about
 * `2 × bump` apart sit on a rectangle inset by `depth`, and each scallop is an arc bulging `depth` past its chord, so
 * the cloud never leaves the box. A depth well under the spacing keeps it subtle rather than poofy.
 */
export function cloudPath(w, h, bump = 14, depth = bump) {
	const n = (v) => Math.round(v * 10) / 10;
	const points = [];
	const edge = (x0, y0, x1, y1) => {
		// Rounded up, so no bump is wider than the margin it bulges into.
		const count = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (bump * 2)));
		for (let i = 0; i < count; i++) points.push([x0 + ((x1 - x0) * i) / count, y0 + ((y1 - y0) * i) / count]);
	};
	const b = depth;
	edge(b, b, w - b, b);
	edge(w - b, b, w - b, h - b);
	edge(w - b, h - b, b, h - b);
	edge(b, h - b, b, b);
	let d = `M ${n(points[0][0])} ${n(points[0][1])}`;
	for (let i = 1; i <= points.length; i++) {
		const [x0, y0] = points[i - 1];
		const [x1, y1] = points[i % points.length];
		// The circle through both points whose arc rises `depth` above the chord: r = (c²/4 + depth²) / 2·depth.
		const half = Math.hypot(x1 - x0, y1 - y0) / 2;
		const rise = Math.min(depth, half);
		const r = Math.max((half * half + rise * rise) / (2 * rise), 1);
		d += ` A ${n(r)} ${n(r)} 0 0 1 ${n(x1)} ${n(y1)}`;
	}
	return `${d} Z`;
}

/** A burst balloon's outline: a rectangle `w` by `h` whose edges zigzag out by `spike`, about every `step` pixels. */
export function jagged(w, h, spike, step = 24) {
	const n = (v) => Math.round(v * 10) / 10;
	const points = [];
	const edge = (x0, y0, x1, y1, ox, oy) => {
		const teeth = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / (2 * step)));
		for (let i = 0; i < 2 * teeth; i++) {
			const t = i / (2 * teeth);
			const out = i % 2 === 1 ? spike : 0;
			points.push(`${n(x0 + (x1 - x0) * t + ox * out)} ${n(y0 + (y1 - y0) * t + oy * out)}`);
		}
	};
	const s = spike;
	edge(s, s, w - s, s, 0, -1);
	edge(w - s, s, w - s, h - s, 1, 0);
	edge(w - s, h - s, s, h - s, 0, 1);
	edge(s, h - s, s, s, -1, 0);
	return `M ${points.join(" L ")} Z`;
}
