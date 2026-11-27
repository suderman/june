// Live June: the desktop client's minimised form shows what she is doing right now. This module decides which live state
// that is, from runtime state and the clock alone, never from a model, and spots the finished reply she should pop up
// with. QML imports it and test/desktop.test.mjs runs it under Node, so it is plain JavaScript as QML's engine knows
// it: no Array.prototype.at, Object.hasOwn, or object spread. See "Live June" in docs/interfaces.org.

/** Live June's states; a copy of LIVE_STATES in src/avatar.ts, kept in step by test/desktop.test.mjs. */
export const LIVE_STATES = [
	"typing",
	"thinking",
	"digging",
	"delegating",
	"watching",
	"tidying",
	"listening",
	"speaking",
	"pop-in",
	"handing-note",
	"waking",
	"sipping",
	"reading",
	"music",
	"doodling",
	"stretching",
	"snoozing",
	"offline",
];

// Tools that hand work to someone else; any other tool is her digging something up herself.
export const DELEGATING = ["work", "org_queue_task", "org_queue_plan", "org_dispatch_now", "org_resume_task", "herdr_prompt_agent"];

/** How long she has been idle, in minutes, and the hour, decide what she does with herself. */
export function idleState(date, minutes) {
	const hour = date.getHours();
	if (minutes < 10) return "sipping";
	if (hour >= 23 || hour < 6) return "snoozing";
	if (hour >= 18) return "music";
	return minutes >= 60 ? "doodling" : "reading";
}

/**
 * What live June is doing now. `view` is the folded view, `linked` whether the daemon is reachable, `now` a Date,
 * `idleSince` when her last run ended (ms), and `once` a state playing once until `once.until` (ms), such as pop-in.
 */
export function liveState({ view, linked, now, idleSince, once }) {
	if (once && now.getTime() < once.until) return once.state;
	if (!linked) return "offline";
	const state = view.state ?? {};
	if (state.compacting) return "tidying";
	if (state.running) {
		const items = view.items ?? [];
		const lastUser = items.map((i) => i.kind).lastIndexOf("user");
		const turn = items.slice(lastUser + 1).filter((i) => !i.private);
		let lastWords = -1;
		for (let i = turn.length - 1; i >= 0; i--)
			if (turn[i].kind === "assistant" && (turn[i].text ?? "").trim() !== "") {
				lastWords = i;
				break;
			}
		const words = lastWords >= 0 ? turn[lastWords] : null;
		const tools = turn.slice(lastWords + 1).filter((i) => i.kind === "tool");
		if (tools.length > 0) return tools.some((t) => DELEGATING.includes(t.name)) ? "delegating" : "digging";
		if (words && words.streaming) return "typing";
		return "thinking";
	}
	if ((state.background ?? 0) > 0) return "delegating";
	// Tasks she dispatched and follows are still going (the daemon's state.following).
	if ((state.following ?? 0) > 0) return "watching";
	return idleState(now, Math.max(0, (now.getTime() - (idleSince ?? now.getTime())) / 60000));
}

/**
 * Whether live June should pop up with a newly finished desktop reply: not when the full overlay is open, June's
 * window is visibly shown at a usable size on any current workspace, live June is off, or do-not-disturb is on.
 */
export function shouldPopReply({ overlayShown, windowVisible, windowFocused, liveEnabled, quiet }) {
	const visible = windowVisible !== undefined ? Boolean(windowVisible) : Boolean(windowFocused);
	return !overlayShown && !visible && Boolean(liveEnabled) && !quiet;
}

/**
 * Deterministic positive integer hash for a working clanker's key, so each bot keeps its own patrol rhythm without
 * syncing up or resetting when other bots join or leave the shelf.
 */
export function patrolSeed(key) {
	const s = String(key ?? "");
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Deterministic unit float [0, 1) from `seed` and `step` (mulberry32 single step). */
function patrolRand(seed, step) {
	let t = (seed + Math.imul(step + 1, 0x6d2b79f5)) >>> 0;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Starting X along a track of `trackWidth` for a bot of `botWidth`, spread across the shelf by key. */
export function patrolStartX(key, trackWidth, botWidth) {
	const span = Math.max(0, Number(trackWidth) - Number(botWidth));
	if (span <= 0) return 0;
	return Math.round(patrolRand(patrolSeed(key), 0) * span);
}

/**
 * Next leg of a clanker's busy shelf patrol: picks a fresh destination across the track (preferring the opposite side
 * so it travels back and forth), travel duration in ms proportional to distance, facing direction (-1 or 1), and a
 * brief inspection pause after arriving.
 */
export function nextPatrolStep(key, currentX, trackWidth, botWidth, step) {
	const span = Math.max(0, Number(trackWidth) - Number(botWidth));
	const cur = Math.min(span, Math.max(0, Number(currentX) || 0));
	if (span <= 8) return { targetX: 0, durationMs: 1200, pauseMs: 1400, facing: 1 };
	const seed = patrolSeed(key);
	const r1 = patrolRand(seed, step * 3 + 1);
	const r2 = patrolRand(seed, step * 3 + 2);
	const r3 = patrolRand(seed, step * 3 + 3);
	// Prefer crossing toward the side with more room so bots roam the whole shelf instead of pacing one corner.
	const goRight = cur < span * 0.25 ? true : cur > span * 0.75 ? false : r1 >= 0.5;
	const minHop = Math.min(span * 0.65, Math.max(70, span * 0.22));
	const room = goRight ? span - cur : cur;
	const hop = room <= minHop ? room : minHop + r1 * (room - minHop);
	const targetX = Math.round(Math.min(span, Math.max(0, goRight ? cur + hop : cur - hop)));
	const dist = Math.abs(targetX - cur);
	const speed = 48 + r2 * 34; // 48-82 px/s: brisk, lively hover
	const durationMs = Math.round(Math.min(5400, Math.max(900, (dist / speed) * 1000)));
	const pauseMs = Math.round(700 + r3 * 1600);
	return { targetX, durationMs, pauseMs, facing: targetX >= cur ? 1 : -1 };
}

/**
 * What `june-desktop cycle` (Left Alt tap) should do: hide the full overlay, focus an already-visible June window
 * instead of spawning a second minimised June, or toggle minimised June as usual.
 */
export function cycleAction({ overlayShown, windowVisible, liveEnabled, miniShown, miniInput }) {
	if (overlayShown) return "hide";
	if (windowVisible) return "focusWindow";
	if (!liveEnabled) return "show";
	if (miniShown && miniInput) return "hideMini";
	if (miniShown) return "answerMini";
	return "showMini";
}

/**
 * The newest finished reply meant to interrupt the user at the desktop (`alert` "gui"), when it is not `seen`; null
 * otherwise. Live June pops up with it as her own notification.
 */
export function newReply(items, seen) {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind !== "assistant" || item.streaming || item.alert !== "gui" || (item.text ?? "").trim() === "") continue;
		return item.id === seen ? null : item;
	}
	return null;
}

/**
 * What live June's balloon says of a reply: its last paragraph, the most recent thing she said, cut at a sentence or
 * word near `max` characters.
 */
export function excerpt(text, max = 200) {
	const paragraphs = text
		.trim()
		.split(/\n\s*\n/)
		.filter((p) => p.trim() !== "");
	const last = (paragraphs[paragraphs.length - 1] ?? "").trim();
	if (last.length <= max) return last;
	const cut = last.slice(0, max);
	const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
	if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
	return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max)}…`;
}

/**
 * Live June's art from one avatar set, by state, with URLs under `base`: a still, or a sprite sheet with `frames` and
 * `fps`. Lenient where src/avatar.ts is strict: an entry the desktop client cannot show is skipped.
 */
export function readLive(manifest, base) {
	const out = {};
	const live = manifest && typeof manifest.live === "object" && manifest.live !== null ? manifest.live : {};
	for (const state of Object.keys(live)) {
		const a = live[state];
		if (!LIVE_STATES.includes(state) || !a || typeof a.file !== "string") continue;
		const sheet = Number.isInteger(a.frames) && a.frames > 1 && a.fps > 0;
		out[state] = { url: base + a.file, play: ["still", "loop", "once"].includes(a.play) ? a.play : "still", frames: sheet ? a.frames : 1, fps: sheet ? a.fps : 0 };
	}
	return out;
}

/** How long a popped-up reply stays to be read, in ms: five seconds plus about 60 ms a character, 5 to 30 seconds. */
export function readingTime(text) {
	return Math.round(Math.min(30000, Math.max(5000, 5000 + (text ?? "").length * 60)));
}

// A reply this recent still shows above the note when she is summoned.
export const RECENT_MS = 10 * 60 * 1000;

/** Whether a reply that arrived at `at` (ms) is recent enough to show again when she is summoned at `now` (ms). */
export function recent(at, now) {
	return at > 0 && now - at <= RECENT_MS;
}

/** Live June's chibi reactions from one avatar set, by expression, with URLs under `base`; anything unusable is skipped. */
export function readChibi(manifest, base) {
	const out = {};
	const chibi = manifest && typeof manifest.chibi === "object" && manifest.chibi !== null ? manifest.chibi : {};
	for (const name of Object.keys(chibi)) {
		const a = chibi[name];
		if (!a || typeof a.file !== "string") continue;
		out[name] = { url: base + a.file };
	}
	return out;
}

/** How long live June holds her reaction before going back to what she is doing, in ms. */
export const REACTION_MS = 2600;

/**
 * The newest reply whose face has been picked, when it is not `seen`; null when there is none or it was seen. Live June
 * reacts once to each.
 */
export function newFace(items, seen) {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind !== "assistant" || !item.expression) continue;
		return item.id === seen ? null : item;
	}
	return null;
}

/** The chibi for an expression: the first in its fallback chain (`chain`, from compose.mjs) that the set has. */
export function reactionArt(chibi, chain) {
	for (const name of chain) if (chibi[name]) return chibi[name];
	return null;
}

