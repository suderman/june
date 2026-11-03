// Live June: the overlay's minimised form shows what she is doing right now. This module decides which live state
// that is, from runtime state and the clock alone, never from a model, and spots the finished reply she should pop up
// with. QML imports it and test/overlay.test.mjs runs it under Node, so it is plain JavaScript as QML's engine knows
// it: no Array.prototype.at, Object.hasOwn, or object spread. See "Live June" in docs/interfaces.org.

/** Live June's states; a copy of LIVE_STATES in src/avatar.ts, kept in step by test/overlay.test.mjs. */
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
const DELEGATING = ["work", "org_queue_task", "org_queue_plan", "org_dispatch_now", "org_resume_task", "herdr_prompt_agent"];

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
	return idleState(now, Math.max(0, (now.getTime() - (idleSince ?? now.getTime())) / 60000));
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

/** The start of a reply for live June's balloon: its first paragraph, cut at a sentence or word near `max` characters. */
export function excerpt(text, max = 200) {
	const first = text.trim().split(/\n\s*\n/)[0] ?? "";
	if (first.length <= max) return first;
	const cut = first.slice(0, max);
	const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
	if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
	return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max)}…`;
}

/**
 * Live June's art from one avatar set, by state, with URLs under `base`: a still, or a sprite sheet with `frames` and
 * `fps`. Lenient where src/avatar.ts is strict: an entry the overlay cannot show is skipped.
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

