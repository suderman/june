// The console look: the same strip as plain lines in a terminal style, for when June should look professional rather
// than cute (a client meeting). Each expression from the vocabulary is a text face, an emoticon rather than an emoji;
// tools, patter, and notices are marked lines. No art, rooms, light, or marks. QML imports it and
// test/overlay.test.mjs runs it under Node, so it is plain JavaScript as QML's engine knows it: no
// Array.prototype.at, Object.hasOwn, or object spread. See "The console look" in docs/interfaces.org.
import { chain } from "./compose.mjs";
import { caption, noteText } from "./strip.mjs";

/** The two looks a device can choose between. */
export const LOOKS = ["comic", "console"];

/** A text face for every expression in the vocabulary (src/avatar.ts). */
export const FACES = {
	idle: ":)",
	warm: "^_^",
	wry: ";)",
	curious: "o_o",
	skeptical: "¬_¬",
	determined: ">:]",
	serious: ":|",
	gentle: "c:",
	smug: ":>",
	exasperated: "-_-",
	laughing: "XD",
	surprised: ":O",
	confused: ":S",
	indignant: ">:(",
	pout: ":<",
	bashful: "^^;",
	delighted: ":D",
	cheering: "\\o/",
};

/** The face for an expression, or the next in its chain, ending at idle's. */
export function face(expression) {
	for (const name of chain(expression ?? "idle")) if (FACES[name]) return FACES[name];
	return FACES.idle;
}

/** Live June's face in the console: her latest expression, except asleep or out of touch. */
export function liveFace(state, expression) {
	if (state === "offline") return "x_x";
	if (state === "snoozing") return "-.-";
	return face(expression);
}

const SOURCES = { tui: "terminal", kitty: "terminal", apk: "phone", telegram: "telegram", cli: "command line" };
const MARKS = { ok: "✓", error: "✗", running: "…" };

/**
 * A panel (strip.mjs `panels`) as console lines, in reading order. Each line has a `kind` (user, june, tool, thought,
 * burst), a `prefix`, and `text`. The first beat of a reply is prefixed with her name and its face once the daemon has
 * picked one; the reply's later beats continue under it. A streaming beat is marked `streaming`; a tool line carries
 * its `status`.
 */
export function lines(panel) {
	const out = [];
	let reply = "";
	for (const e of panel.elements) {
		if (e.kind === "user") {
			const source = e.item.source && e.item.source !== "gui" ? `${SOURCES[e.item.source] ?? e.item.source} ` : "";
			out.push({ kind: "user", prefix: `${source}›`, text: noteText(e.item) });
			reply = "";
		} else if (e.kind === "june") {
			const item = e.id.split("#")[0];
			const prefix = item === reply ? "" : e.expression ? `june ${face(e.expression)}` : "june";
			reply = item;
			// A code block is already monospace here; markup drops its #+begin_src and #+end_src lines.
			const line = { kind: "june", prefix, text: e.text.replace(/\n+$/, "") };
			if (e.streaming) line.streaming = true;
			out.push(line);
		} else if (e.kind === "tools") {
			for (const call of e.items) {
				const status = call.status === "error" ? "error" : call.status === "running" ? "running" : "ok";
				out.push({ kind: "tool", prefix: MARKS[status], text: caption(call), status });
			}
		} else if (e.kind === "thought") {
			out.push({ kind: "thought", prefix: "~", text: e.item.text });
		} else if (e.kind === "shown") {
			for (const file of e.files) out.push({ kind: "tool", prefix: "⎘", text: `shown: ${file.name} (${file.size})`, status: "ok" });
		} else if (e.kind === "burst") {
			out.push({ kind: "burst", prefix: "!", text: e.item.error ?? e.item.text ?? "" });
		}
	}
	return out;
}
