// Copy-ready blocks stay intact across paragraphs and typography changes. Clients receive the original body and
// optional syntax tokens; display clipping never changes what their copy button writes.
import { highlight, type Token } from "./highlight.ts";
import { plain } from "./plain.ts";

export type ReplyPart = { text: string; artifact?: true; language?: string; lines?: Token[][] };

/** Org src/example/quote blocks and Markdown fences, including an unfinished block while streaming. */
export function replyParts(text: string): ReplyPart[] {
	const parts: ReplyPart[] = [];
	const opener = /^[ \t]*(?:#\+begin_(src|example|quote)\b([^\r\n]*)|(`{3,}|~{3,})([^\r\n]*))\r?\n/gim;
	let from = 0;
	let match: RegExpExecArray | null;
	while ((match = opener.exec(text)) !== null) {
		if (match.index > from) parts.push({ text: plain(text.slice(from, match.index)) });
		const org = match[1]?.toLowerCase();
		const fence = match[3];
		const hint = (org === "src" ? match[2] : fence ? match[4] : "")?.trim().split(/\s+/)[0] || "text";
		const closer = new RegExp(org ? `^[ \\t]*#\\+end_${org}[ \\t]*(?:\\r?\\n|$)` : `^[ \\t]*${fence![0]}{${fence!.length},}[ \\t]*(?:\\r?\\n|$)`, "gim");
		closer.lastIndex = opener.lastIndex;
		const end = closer.exec(text);
		// The newline before the closing delimiter belongs to the frame, not the copied body. Other whitespace stays.
		const raw = text.slice(opener.lastIndex, end?.index ?? text.length);
		const body = end ? raw.replace(/\r?\n$/, "") : raw;
		const lit = hint !== "text" && body.length <= 200_000 ? highlight(body, hint) : undefined;
		parts.push({ text: body, artifact: true, language: hint, ...(lit ? { lines: lit.lines } : {}) });
		from = end ? closer.lastIndex : text.length;
		opener.lastIndex = from;
	}
	if (from < text.length) parts.push({ text: plain(text.slice(from)) });
	return parts;
}
