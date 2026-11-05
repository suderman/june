// The overlay's logic without Qt: it keeps the folded view, groups it into comic panels, turns June's Markdown into
// the rich text a balloon shows, and reads what the user typed. QML imports it (`import "strip.mjs" as Strip`), and
// test/overlay.test.mjs runs it under Node, so it uses nothing but the language, as far as QML's engine knows it: no
// Array.prototype.at, Object.hasOwn, or object spread.

/** A fresh copy of the view after `reply`, a `view` reply from the daemon; any other reply returns `view` as it was. */
export function applyView(view, reply) {
	if (reply === null || typeof reply !== "object" || reply.type !== "view") return view;
	if (reply.reset === true) {
		return { items: [...reply.items], state: reply.state ?? view.state, earlier: reply.earlier === true };
	}
	const items = [...view.items];
	for (const change of reply.changes ?? []) {
		if (change.op === "drop") {
			const at = items.findIndex((item) => item.id === change.id);
			if (at >= 0) items.splice(at, 1);
			continue;
		}
		if (change.op !== "put") continue;
		const old = items.findIndex((item) => item.id === change.item.id);
		if (old >= 0) items.splice(old, 1);
		const after = change.after === null ? -1 : items.findIndex((item) => item.id === change.after);
		items.splice(after + 1, 0, change.item);
	}
	return { items, state: reply.state ?? view.state, earlier: view.earlier };
}

export const emptyView = () => ({ items: [], state: { running: false, background: 0, queued: 0, model: "", compacting: false }, earlier: false });

/**
 * A reply's beats: its paragraphs, with short ones joined to the next and a list kept with the line that introduces it,
 * at most four, so a long answer reads as a few balloons rather than one wall or a dozen scraps.
 */
export function beats(text) {
	const paragraphs = text
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter((p) => p !== "");
	const out = [];
	for (const p of paragraphs) {
		const last = out[out.length - 1];
		const list = /^([-*+]|\d+[.)])\s/.test(p);
		if (last !== undefined && (last.length < 120 || list || /:$/.test(last))) out[out.length - 1] = `${last}\n\n${p}`;
		else out.push(p);
	}
	if (out.length > 4) return [...out.slice(0, 3), out.slice(3).join("\n\n")];
	return out;
}

// About how much a panel holds before an exchange continues in the next panel, in characters of words. The user's
// message counts, and a tool card or a thought counts as a short line, so a panel keeps a fair share of art to words.
const PANEL_BUDGET = 480;
const weightOf = (e) => (e.kind === "user" ? e.text.length : e.kind === "june" ? e.text.length : e.kind === "burst" ? 60 : 80);

/**
 * The strip's panels, oldest first. Each of the user's messages opens a panel; what June does after it follows in the
 * same panel until it holds about a panel's worth, then continues in the next panel at one of her balloons, taking the
 * tool calls and thought that lead into that balloon with it. Items before the first message share a panel. Private
 * items (detail only) are left out.
 *
 * A panel's elements, in reading order: `user` (their message), `june` (one beat of a reply, `streaming` on the last
 * while she writes), `tools` (consecutive tool calls, drawn as a chip or a status card), `thought` (patter; a panel keeps
 * only its latest), and `burst` (a notice, or a reply that failed).
 */
export function panels(items) {
	const out = [];
	let current = null;
	const open = (id, carried = []) => {
		current = { id: carried.length > 0 ? carried[0].id : id, user: null, elements: carried };
		out.push(current);
	};
	const weight = () => current.elements.reduce((sum, e) => sum + weightOf(e), 0);
	for (const item of items) {
		if (item.private === true) continue;
		if (item.kind === "user") {
			open(item.id);
			current.user = item;
			current.elements.push({ kind: "user", id: item.id, item, text: noteText(item) });
			continue;
		}
		if (current === null) open(item.id);
		if (item.kind === "assistant" && !item.error) {
			// A turn of only tool calls leaves an assistant item with no words: nothing to letter.
			if (item.text.trim() === "" && !item.streaming) continue;
			const parts = beats(item.text);
			if (parts.length === 0) parts.push("");
			for (const [i, text] of parts.entries()) {
				const lastJune = current.elements.map((e) => e.kind).lastIndexOf("june");
				if (lastJune >= 0 && weight() > PANEL_BUDGET) {
					// The next panel starts with what leads into this balloon: the tools and thought since her last one.
					const carried = current.elements.splice(lastJune + 1);
					open(`${item.id}#${i}`, carried);
				}
				const beat = { kind: "june", id: `${item.id}#${i}`, text, streaming: item.streaming && i === parts.length - 1 };
				// The face the daemon picked for the reply (expression.ts), once it has settled.
				if (item.expression) beat.expression = item.expression;
				if (item.pose) beat.pose = item.pose;
				// When she wrote it, for the panel's light (light.mjs).
				if (typeof item.at === "number") beat.at = item.at;
				current.elements.push(beat);
			}
		} else if (item.kind === "tool") {
			const last = current.elements[current.elements.length - 1];
			if (last?.kind === "tools") last.items.push(item);
			else current.elements.push({ kind: "tools", id: item.id, items: [item] });
		} else if (item.kind === "patter") {
			current.elements = current.elements.filter((e) => e.kind !== "thought");
			current.elements.push({ kind: "thought", id: item.id, item });
		} else {
			current.elements.push({ kind: "burst", id: item.id, item });
		}
	}
	return out;
}

/**
 * A tool summary as narration: `key=value` arguments lose their keys, paths keep only their last part, and paging
 * arguments such as offset and limit go.
 */
export function narrate(summary) {
	return summary
		.replace(/\b(?:offset|limit)=\S+/g, "")
		.replace(/\b[a-z_]+=/g, "")
		.replace(/[^\s/]*(?:\/[^\s/]+)*\/([^\s/]+)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

/** One line for a tool's caption box: its summary as narration, and the first line of a failure. */
export function caption(item) {
	const told = item.summary ? narrate(item.summary) : "";
	const summary = `${item.name}${told ? ` · ${told}` : ""}`;
	if (item.status === "error") return `${summary} · failed${item.error ? `: ${item.error}` : ""}`;
	return summary;
}

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * June's Markdown as Qt rich text for a balloon. Stressed words (**bold**, *italic*, _italic_) become `stress` spans in
 * the display face, `code` a monospace span, links their label; headings and quotes lose their markers. Everything else
 * is escaped, so nothing she writes can inject markup.
 */
export function markup(text, style = {}) {
	const stress = style.stress ?? "font-weight:800";
	const code = style.code ?? "font-family:monospace";
	const lines = text.split("\n").map((line) => {
		let out = escape(line.replace(/^\s{0,3}(#{1,6}|>)\s+/, ""));
		out = out.replace(/`([^`]+)`/g, (_, inner) => `<span style="${code}">${inner}</span>`);
		out = out.replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1");
		out = out.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<span style="${stress}">${a ?? b}</span>`);
		out = out.replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)|(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, (_, p1, a, p2, b) => `${p1 ?? p2}<span style="${stress}">${a ?? b}</span>`);
		return out;
	});
	return lines.join("<br>");
}

const COMMANDS = new Set(["stop", "compact", "status", "reload", "help"]);

/**
 * What the user's balloon asks for: a message to submit, a command, or a refusal shown in place. The overlay never
 * offers /new: one conversation, and a fresh context is the terminal's to start.
 */
export function readInput(text) {
	const trimmed = text.trim();
	if (trimmed === "") return { kind: "empty" };
	const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (match !== null) {
		const name = match[1];
		if (name === "new") return { kind: "refuse", message: "/new belongs to the terminal; the overlay keeps the one conversation." };
		if (COMMANDS.has(name)) return { kind: "command", name, args: (match[2] ?? "").trim() };
	}
	return { kind: "submit", text };
}

/** A followed task's last signal (the daemon's state.follows) in plain words. */
const SIGNALS = { AUTO: "queued", waiting: "waiting on another task", stalled: "not launched yet", PROG: "in progress", blocked: "its agent needs you", HOLD: "on hold for you" };
/** Signals that wait on the user, which the status line always says. */
export const NEEDS_YOU = ["blocked", "HOLD"];
const clipTitle = (title) => (title.length > 36 ? `${title.slice(0, 35).replace(/\s+$/, "")}…` : title);

/**
 * What June is doing, in one plain phrase for the masthead and the phone's status line, with the tasks she follows as
 * `detail` for a tap. Busy first (tidying, a reply, workers), then what she keeps an eye on, then where she is. A
 * followed task that needs the user is always said. Clients say their own connection state; this is for a live link.
 */
export function status(state, host) {
	// A daemon older than the names sends only the count.
	const named = state.follows !== undefined;
	const follows = state.follows ?? Array.from({ length: state.following ?? 0 }, () => ({ title: "", signal: "PROG" }));
	const needs = follows.filter((f) => NEEDS_YOU.includes(f.signal));
	const detail = (named ? follows : []).map((f) => ({ title: f.title, state: SIGNALS[f.signal] ?? String(f.signal).toLowerCase(), needsYou: NEEDS_YOU.includes(f.signal) }));
	const busy = state.compacting ? "tidying her notes" : state.running ? "working on a reply" : state.background > 0 ? (state.background === 1 ? "has a worker on it" : `has ${state.background} workers out`) : "";
	const parts = [];
	if (busy) parts.push(busy);
	if (needs.length > 0) parts.push(needs.length === 1 ? `«${clipTitle(needs[0].title)}» needs you` : `${needs.length} tasks need you`);
	const calm = follows.length - needs.length;
	if (calm > 0 && (busy || needs.length > 0)) parts.push(calm === 1 && needs.length === 0 ? "following 1 task" : `following ${calm} more`);
	else if (calm > 0) {
		const title = follows.find((f) => !NEEDS_YOU.includes(f.signal)).title;
		parts.push(calm === 1 ? (title ? `keeping an eye on «${clipTitle(title)}»` : "keeping an eye on 1 task") : `keeping an eye on ${calm} tasks`);
	}
	if (parts.length === 0) parts.push(`on ${host}`);
	return { text: parts.join(" · "), detail };
}

/**
 * What the user's note says: their words, and what came with them, a line each, so a picture sent with a word or with
 * none ("look") still shows in the strip.
 */
export function noteText(item) {
	const lines = [];
	const words = (item.text ?? "").trim();
	if (words) lines.push(words);
	if (item.imageCount) lines.push(item.imageCount === 1 ? "+ picture" : `+ ${item.imageCount} pictures`);
	for (const file of item.files ?? []) lines.push(`+ ${file.name}`);
	return lines.join("\n");
}

/** The small badge for June's state, or "" when she is idle. */
export function activity(state, linked) {
	if (!linked) return "offline";
	if (state.compacting) return "tidying up";
	if (state.running) return "thinking";
	if (state.background > 0) return state.background === 1 ? "1 brief running" : `${state.background} briefs running`;
	if ((state.following ?? 0) > 0) return state.following === 1 ? "following 1 task" : `following ${state.following} tasks`;
	return "";
}
