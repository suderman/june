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
 * same panel until a different reply starts or it holds about a panel's worth, then continues in the next panel at one
 * of her balloons, taking the tool calls and thought that lead into that balloon with it. Each panel has one reply's
 * performance and take menu. Private items (detail only) are left out.
 *
 * A panel's elements, in reading order: `user` (their message), `june` (one beat of a reply, `streaming` on the last
 * while she writes), `tools` (consecutive tool calls, drawn as a chip or a status card), `thought` (patter; a panel keeps
 * only its latest), and `burst` (a notice, or a reply that failed).
 */
export function panels(items, now = Date.now()) {
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
			// The comic draws the pictures (polaroids) and files (document cards) clipped to the note; the console says
			// them in words.
			current.elements.push({ kind: "user", id: item.id, item, text: noteText(item, false, false), pictures: item.imageCount ?? 0, files: noteFiles(item, now) });
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
				if (lastJune >= 0 && (current.elements[lastJune].replyId !== item.id || weight() > PANEL_BUDGET)) {
					// The next panel starts with what leads into this balloon: the tools and thought since her last one.
					const carried = current.elements.splice(lastJune + 1);
					open(`${item.id}#${i}`, carried);
				}
				const beat = { kind: "june", id: `${item.id}#${i}`, text, streaming: item.streaming && i === parts.length - 1 };
				// The face the daemon picked for the reply (expression.ts), once it has settled.
				if (item.expression) beat.expression = item.expression;
				if (item.pose) beat.pose = item.pose;
				beat.replyId = item.id;
				beat.artVersion = item.artVersion ?? "";
				beat.canRestore = (item.takes ?? []).some(t => t.take < item.take);
				beat.canAdvance = (item.takes ?? []).some(t => t.take > item.take);
				if (item.side) beat.side = item.side;
				if (typeof item.expressionAt === "number") beat.expressionAt = item.expressionAt;
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

/** A herdr: link to an agent's session, HOST/AGENT:SESSION[@PANE], as org/bin/herdr-link stamps it. */
const HERDR = /^herdr:[a-z0-9-]+\/[a-z]+:[0-9a-f-]{36}(?:@[A-Za-z0-9:]+)?$/;

/**
 * What a link in June's words opens, or null for one a tap leaves alone: "web" for an http or https page, "herdr" for an
 * agent's session, "file" for a file Emacs opens (file:PATH or file:PATH::SEARCH, PATH from ~ or /). Links come from
 * the model, so only these, and only ones that open or focus, never run anything.
 */
export function linkKind(url) {
	if (/^https?:\/\/[^\s<>"]+$/.test(url)) return "web";
	if (HERDR.test(url)) return "herdr";
	if (/^file:(~\/|\/)[^\n<>"]*$/.test(url)) return "file";
	return null;
}

/**
 * The emacsclient call that opens a file link in Emacs at its search: suderman/june-open in Jon's Emacs configuration
 * takes the path and search as strings, so they are quoted as Lisp strings (JSON's escapes are Lisp's) and never read
 * as code. -r reuses the frame Jon has, or makes one.
 */
export function emacsCall(url) {
	const [path, ...rest] = url.slice("file:".length).split("::");
	return ["emacsclient", "-r", "-n", "--eval", `(suderman/june-open ${JSON.stringify(path)} ${JSON.stringify(rest.join("::"))})`];
}

const unescape = (text) => text.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/**
 * June's Markdown as Qt rich text for a balloon. Stressed words (**bold**, *italic*, _italic_) become `stress` spans in
 * the display face, `code` a monospace span; links, as [label](url) or Org's [[url][label]], become anchors when
 * linkKind opens them and their label otherwise; headings and quotes lose their markers. Everything else is escaped,
 * so nothing she writes can inject markup.
 */
export function markup(text, style = {}) {
	const stress = style.stress ?? "font-weight:800";
	const code = style.code ?? "font-family:monospace";
	const lines = text.split("\n").map((line) => {
		let out = escape(line.replace(/^\s{0,3}(#{1,6}|>)\s+/, ""));
		out = out.replace(/`([^`]+)`/g, (_, inner) => `<span style="${code}">${inner}</span>`);
		// Links wait as numbered marks while the stress passes run, so nothing reshapes an address.
		const links = [];
		const link = (url, label) => {
			if (linkKind(unescape(url)) === null) return label;
			links.push(`<a href="${url}">${label}</a>`);
			return `\u0000${links.length - 1}\u0000`;
		};
		out = out.replace(/\[\[([^\]]+)\]\[([^\]]+)\]\]/g, (_, url, label) => link(url, label));
		// A file link's search may name a heading with spaces, which June writes in Markdown's form too.
		out = out.replace(/\[([^\]]+)\]\((file:[^)\n]+|[^)\s]+)\)/g, (_, label, url) => link(url, label));
		out = out.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<span style="${stress}">${a ?? b}</span>`);
		out = out.replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)|(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, (_, p1, a, p2, b) => `${p1 ?? p2}<span style="${stress}">${a ?? b}</span>`);
		return out.replace(/\u0000(\d+)\u0000/g, (_, n) => links[Number(n)]);
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
 * `detail` for a tap. `seen` are followKeys the user dismissed. Busy first (tidying, a reply, workers), then what she keeps an eye on, then where she is. A
 * followed task that needs the user is always said. Clients say their own connection state; this is for a live link.
 */
export function status(state, host, seen = []) {
	// A daemon older than the names sends only the count.
	const named = state.follows !== undefined;
	const follows = state.follows ?? Array.from({ length: state.following ?? 0 }, () => ({ title: "", signal: "PROG" }));
	// Dismissed by the user, a task that needs them is calm until its signal changes (a new HOLD, a newly blocked agent).
	const asks = (f) => NEEDS_YOU.includes(f.signal) && !seen.includes(followKey(f));
	const needs = follows.filter(asks);
	const detail = (named ? follows : []).map((f) => ({ title: f.title, state: SIGNALS[f.signal] ?? String(f.signal).toLowerCase(), needsYou: asks(f), key: followKey(f) }));
	const busy = state.compacting ? "tidying her notes" : state.running ? "working on a reply" : state.background > 0 ? (state.background === 1 ? "has a worker on it" : `has ${state.background} workers out`) : "";
	const parts = [];
	if (busy) parts.push(busy);
	if (needs.length > 0) parts.push(needs.length === 1 ? `«${clipTitle(needs[0].title)}» needs you` : `${needs.length} tasks need you`);
	const calm = follows.length - needs.length;
	if (calm > 0 && (busy || needs.length > 0)) parts.push(calm === 1 && needs.length === 0 ? "following 1 task" : `following ${calm} more`);
	else if (calm > 0) {
		const title = follows.find((f) => !asks(f)).title;
		parts.push(calm === 1 ? (title ? `keeping an eye on «${clipTitle(title)}»` : "keeping an eye on 1 task") : `keeping an eye on ${calm} tasks`);
	}
	if (parts.length === 0) parts.push(`on ${host}`);
	return { text: parts.join(" · "), detail };
}

/** A followed task at its signal, as a dismissal names it: the same task at a later signal is news again. */
export function followKey(f) {
	return `${f.title}|${f.signal}`;
}

/**
 * What the user's note says: their words, and what came with them, a line each, so a picture sent with a word or with
 * none ("look") still shows. `pictures` false leaves the pictures out, for a client that draws them.
 */
export function noteText(item, pictures = true, files = true) {
	const lines = [];
	const words = (item.text ?? "").trim();
	if (words) lines.push(words);
	if (pictures && item.imageCount) lines.push(item.imageCount === 1 ? "+ picture" : `+ ${item.imageCount} pictures`);
	if (files) for (const file of item.files ?? []) lines.push(`+ ${file.name}`);
	return lines.join("\n");
}

// June's inbox keeps a file this long (INBOX_DAYS in src/inbox.ts); after it the daemon no longer serves it.
const INBOX_MS = 30 * 24 * 60 * 60_000;

/**
 * The files a note brought, each with its place in the message (`n`, for the `file/n` path under the hello's
 * `attached`), its name, its size in words, its type ("" when unknown), and whether the inbox has dropped it, which a
 * card shows greyed and closed.
 */
export function noteFiles(item, now = Date.now()) {
	const gone = typeof item.at === "number" && now - item.at > INBOX_MS;
	return (item.files ?? []).map((file, n) => {
		const type = String(file.mimeType ?? "");
		return { n, name: String(file.name ?? ""), size: fileSize(file.size), type, preview: previewKind(type), expired: gone };
	});
}

/**
 * How a preview shows a file of `type`: "picture" fitted to the window, "pdf" a page at a time as the daemon renders
 * them, "text" as its words, or "file", only its name, for anything else. Every preview also offers the browser.
 */
export function previewKind(type) {
	if (type.startsWith("image/")) return "picture";
	if (type === "application/pdf") return "pdf";
	if (type.startsWith("text/") || type === "application/json") return "text";
	return "file";
}

/** A file's size for a card: 812 B, 14 KB, 3.2 MB. */
export function fileSize(bytes) {
	if (typeof bytes !== "number" || !(bytes >= 0)) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
