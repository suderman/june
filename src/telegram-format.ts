// Markdown to Telegram HTML, and splitting under Telegram's 4,096-character limit. Ported from pi-durable-telegram 0.1.5
// (dist/format/: escape, fence, markdown-html, chunk), MIT License, Copyright (c) 2026 smixs. Changes: TypeScript, one
// file, and each chunk also carries its Markdown with a split fence closed and reopened, for rich messages.

export const TELEGRAM_TEXT_LIMIT = 4096;
const MARKDOWN_WINDOW = 3500;

/** Telegram HTML needs only `&`, `<` and `>` escaped in text. */
export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
	return escapeHtml(text).replace(/"/g, "&quot;");
}

/** Move a cut index back so it does not split a UTF-16 surrogate pair. */
function codePointCut(text: string, index: number): number {
	if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
	const code = text.charCodeAt(index - 1);
	return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

/** The last `count` code units of `text`, not starting inside a surrogate pair. */
export function tail(text: string, count: number): string {
	if (text.length <= count) return text;
	let start = text.length - count;
	const code = text.charCodeAt(start);
	if (code >= 0xdc00 && code <= 0xdfff) start += 1;
	return text.slice(start);
}

type Fence = { marker: string; line: string; lang: string };
const fenceLine = /^ {0,3}(`{3,}|~{3,})([^`]*)$/;

function parseFenceOpener(line: string): Fence | undefined {
	const match = fenceLine.exec(line);
	if (match === null) return undefined;
	return { marker: match[1] ?? "```", line: line.trim(), lang: (match[2] ?? "").trim() };
}

function closesFence(line: string, opener: Fence): boolean {
	const trimmed = line.trim();
	return trimmed.length >= opener.marker.length && /^(`+|~+)$/.test(trimmed) && trimmed[0] === opener.marker[0];
}

/** Fence state after reading `text` that starts in `state` (undefined: outside any fence). */
export function fenceStateAfter(text: string, state: Fence | undefined): Fence | undefined {
	let current = state;
	for (const line of text.split("\n")) {
		if (current === undefined) current = parseFenceOpener(line);
		else if (closesFence(line, current)) current = undefined;
	}
	return current;
}

/** Private-use character marking held fragments; removed from the input first. */
const PLACEHOLDER = "";
type Hold = (html: string) => string;

/**
 * Convert model Markdown to Telegram-safe HTML. Text is escaped first; only Telegram's tags are emitted, always properly
 * nested: an inline span is wrapped only when its content is already balanced.
 */
export function markdownToTelegramHtml(markdown: string, options: { autoCloseFence?: boolean } = {}): string {
	const slots: string[] = [];
	const hold: Hold = (html) => `${PLACEHOLDER}${slots.push(html) - 1}${PLACEHOLDER}`;
	const source = markdown.replace(/\r\n?/g, "\n").replaceAll(PLACEHOLDER, "");
	const withoutFences = extractFences(source, hold, options.autoCloseFence ?? true);
	const lines = withoutFences.split("\n").map((line) => renderLine(line, hold));
	const html = groupBlockquotes(lines).join("\n");
	return html.replace(/(\d+)/g, (_m, index: string) => slots[Number(index)] ?? "");
}

function extractFences(source: string, hold: Hold, autoClose: boolean): string {
	const out: string[] = [];
	let open: { opener: Fence; body: string[] } | undefined;
	for (const line of source.split("\n")) {
		if (open === undefined) {
			const opener = parseFenceOpener(line);
			if (opener === undefined) out.push(line);
			else open = { opener, body: [] };
		} else if (closesFence(line, open.opener)) {
			out.push(hold(codeBlock(open.body.join("\n"), open.opener.lang)));
			open = undefined;
		} else open.body.push(line);
	}
	if (open !== undefined) out.push(...(autoClose ? [hold(codeBlock(open.body.join("\n"), open.opener.lang))] : [open.opener.line, ...open.body]));
	return out.join("\n");
}

function codeBlock(code: string, lang: string): string {
	const safeLang = lang.replace(/[^A-Za-z0-9_+-]/g, "").slice(0, 32);
	const open = safeLang === "" ? "<pre>" : `<pre><code class="language-${safeLang}">`;
	const close = safeLang === "" ? "</pre>" : "</code></pre>";
	return `${open}${escapeHtml(code.replace(/\n+$/, ""))}${close}`;
}

const inlineRules = [
	{ pattern: /\*\*(?=\S)([^\n]*?\S)\*\*/g, tag: "b" },
	{ pattern: /(?<![\w_])__(?=\S)([^\n]*?\S)__(?![\w_])/g, tag: "b" },
	{ pattern: /~~(?=\S)([^\n]*?\S)~~/g, tag: "s" },
	{ pattern: /\|\|(?=\S)([^\n]*?\S)\|\|/g, tag: "tg-spoiler" },
	{ pattern: /(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, tag: "i" },
	{ pattern: /(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, tag: "i" },
];

function renderLine(line: string, hold: Hold): string {
	let text = line.replace(/(`+)([^`\n]+?)\1(?!`)/g, (_m, _ticks, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
	text = text.replace(/\[([^\]\n]+)\]\(\s*([^)\s]+)\s*\)/g, (match, label: string, url: string) =>
		/^(https?:|tg:|mailto:)/i.test(url) ? hold(`<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`) : match,
	);
	text = escapeHtml(text);
	for (const rule of inlineRules) text = text.replace(rule.pattern, (match, inner: string) => (isBalanced(inner) ? `<${rule.tag}>${inner}</${rule.tag}>` : match));
	const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(text);
	return heading === null ? text : `<b>${heading[1]}</b>`;
}

function groupBlockquotes(lines: string[]): string[] {
	const out: string[] = [];
	let quote: string[] = [];
	const flush = () => {
		if (quote.length > 0) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
		quote = [];
	};
	for (const line of lines) {
		const match = /^&gt; ?(.*)$/.exec(line);
		if (match === null) {
			flush();
			out.push(line);
		} else quote.push(match[1] ?? "");
	}
	flush();
	return out;
}

/** Whether every tag in `html` is closed in order. */
function isBalanced(html: string): boolean {
	const stack: string[] = [];
	for (const match of html.matchAll(/<(\/?)([a-z-]+)(?:\s[^>]*)?>/g)) {
		if (match[1] === "") stack.push(match[2] ?? "");
		else if (stack.pop() !== match[2]) return false;
	}
	return stack.length === 0;
}

/** One message's worth: its Markdown (a split fence closed and reopened), that Markdown as HTML, and the text as written. */
export type Chunk = { markdown: string; html: string; plain: string };

/**
 * Split Markdown into Telegram messages. Cuts prefer a blank line, then a newline, then a space in the second half of
 * the window, else a hard cut on a code point boundary. A cut inside a fenced block closes it and reopens it with the
 * same opener in the next chunk. Each chunk is re-rendered with a smaller window until its HTML fits `limit`.
 */
export function splitForTelegram(markdown: string, limit = TELEGRAM_TEXT_LIMIT): Chunk[] {
	const text = markdown.replace(/\r\n?/g, "\n");
	const chunks: Chunk[] = [];
	let pos = skipNewlines(text, 0);
	let fence: Fence | undefined;
	while (pos < text.length) {
		const piece = fitPiece(text, pos, fence, limit);
		if (piece.plain.trim() !== "") chunks.push({ markdown: piece.markdown, html: piece.html, plain: piece.plain });
		fence = piece.fenceAfter;
		pos = skipNewlines(text, piece.next);
	}
	return chunks;
}

type Piece = Chunk & { next: number; fenceAfter: Fence | undefined };

function fitPiece(text: string, pos: number, fence: Fence | undefined, limit: number): Piece {
	let window = MARKDOWN_WINDOW;
	for (;;) {
		const piece = renderPiece(text, pos, window, fence);
		if (piece.html.length <= limit || window <= 1) return piece;
		window = Math.max(1, window - Math.max(100, Math.floor(window / 10)));
	}
}

function renderPiece(text: string, pos: number, window: number, fence: Fence | undefined): Piece {
	const cut = findCut(text, pos, window);
	const plain = text.slice(pos, cut).trimEnd();
	const fenceAfter = fenceStateAfter(plain, fence);
	const reopened = fence === undefined ? "" : `${fence.line}\n`;
	const closed = fenceAfter === undefined ? "" : `\n${fenceAfter.marker}`;
	const markdown = `${reopened}${plain}${closed}`;
	return { markdown, html: markdownToTelegramHtml(markdown), plain, next: cut, fenceAfter: cut >= text.length ? undefined : fenceAfter };
}

/** End index (exclusive) of the slice starting at `pos` and at most `window` long. */
function findCut(text: string, pos: number, window: number): number {
	const end = pos + window;
	if (end >= text.length) return text.length;
	const slice = text.slice(pos, end);
	const half = Math.floor(window / 2);
	for (const separator of ["\n\n", "\n", " "]) {
		const at = slice.lastIndexOf(separator);
		if (at >= half) return pos + at + separator.length;
	}
	const hard = codePointCut(text, end);
	return hard > pos ? hard : Math.min(text.length, end + 1);
}

/** Skip the line breaks at a cut; indentation of the next line is kept. */
function skipNewlines(text: string, pos: number): number {
	let index = pos;
	while (index < text.length && text[index] === "\n") index += 1;
	return index;
}
