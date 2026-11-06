// June's timeline: the verbatim record of what she and the user said and did, for when precision matters. It adds no
// store. Durable keeps every entry of the root conversation forever, through compaction and /new, so the timeline is a
// fold of those entries held in the daemon: built on the first query, caught up before each one, and rebuilt after a
// restart. Only what the user saw is in it: their messages, her replies (including one a heartbeat or follow-up
// produced), patter, one line per tool call, and notes such as a stop. Thinking, tool output, and her private looks
// stay out. Entries the user hides are left out of the timeline, `june transcript`, and attached views, but stay in
// the database, which cannot delete them.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";
import { SOURCES } from "./protocol.ts";
import { isQuiet, PRIVATE, sourceName, summarize, textOf } from "./transcript.ts";

/** The user's own messages, June's words, her side remarks, her tool calls and background work, and everything else. */
export const KINDS = ["user", "june", "patter", "action", "note"] as const;
export type Kind = (typeof KINDS)[number];

/** `source` is where a user's message came from, or for June's words, what she was answering. */
export type TimelineItem = { id: number; at: number; kind: Kind; source?: string; text: string; files?: { name: string; path: string }[] };

export type TimelineQuery = {
	/** Words that must all appear, any case; a "quoted phrase" must appear as it is. */
	readonly query?: string;
	readonly since?: number;
	readonly until?: number;
	readonly kinds?: readonly string[];
	readonly limit?: number;
};

/** The most items one query returns. */
export const MAX_ITEMS = 200;
const PAGE = 500;
const CLIENTS = new Set<string>(SOURCES);

/** Folds entries, oldest first, into timeline items, keeping what a look and the time carry from one entry to the next. */
export class TimelineFold {
	/** Inside one of June's private looks, which shows only her message to the user. */
	#looking = false;
	/** The input June's next words answer. */
	#source = "";
	/** An entry without a time of its own, such as patter, takes the time of the entry before it. */
	#at = 0;

	push(entry: any): TimelineItem[] {
		const message = entry?.model?.[0];
		if (typeof message?.timestamp === "number") this.#at = message.timestamp;
		const id = Number(entry?.id);
		const item = (kind: Kind, text: string, source?: string, files?: TimelineItem["files"]): TimelineItem[] =>
			text.trim() === "" ? [] : [{ id, at: this.#at, kind, ...(source ? { source } : {}), text: text.trim(), ...(files?.length ? { files } : {}) }];
		switch (entry?.kind) {
			case "june.input": {
				const source = sourceName(String(entry.data?.source ?? "?"));
				this.#looking = PRIVATE.has(source);
				this.#source = source;
				if (this.#looking) return [];
				if (!CLIENTS.has(source)) return item("note", String(entry.data?.text ?? ""), source);
				const count = Number(entry.data?.imageCount ?? 0);
				const files = Array.isArray(entry.data?.files) ? entry.data.files.map((f: any) => ({ name: String(f?.name ?? ""), path: String(f?.path ?? "") })) : [];
				const said = String(entry.data?.text ?? "");
				return item("user", count || files.length ? `${said}${count ? ` [${count} image${count === 1 ? "" : "s"}]` : ""}` : said, source, files);
			}
			case "pi.user": {
				// Before June recorded june.input, a Telegram message was an untagged user message.
				const text = textOf(message?.content);
				const tag = /^\[(\/?\w+)\]/.exec(text)?.[1] ?? "";
				this.#looking = PRIVATE.has(tag);
				this.#source = tag || "telegram";
				if (tag === "/stop") return item("note", "stopped");
				if (this.#looking) return [];
				return tag ? item("note", text, tag) : item("user", text, "telegram");
			}
			case "pi.assistant": {
				const out: TimelineItem[] = [];
				for (const block of message?.content ?? []) {
					if (block?.type === "text" && typeof block.text === "string" && !isQuiet(block.text)) out.push(...item("june", block.text, this.#source));
					else if (block?.type === "toolCall" && !this.#looking) out.push(...item("action", `${block.name} ${summarize(block.arguments)}`));
				}
				if (!this.#looking && (message?.stopReason === "error" || message?.stopReason === "aborted"))
					out.push(...item("note", `June ${message.stopReason}${message.errorMessage ? `: ${message.errorMessage}` : ""}`));
				return out;
			}
			case "june.patter":
				return item("patter", String(entry.data?.text ?? ""));
			case "june.work":
				return item("action", `background work ${entry.data?.state ?? "?"}: ${entry.data?.brief ?? ""}`);
			case "pi.reset":
				return item("note", "new context");
			case "pi.compaction":
				return item("note", "earlier conversation compacted");
			default:
				return [];
		}
	}
}

/** Words and "quoted phrases", lower case. */
export function terms(query: string): string[] {
	return [...query.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2]!).toLowerCase()).filter((t) => t.trim() !== "");
}

type Load = (query: Parameters<Conversation["entries"]>[0], limit: number, cursor: Parameters<Conversation["entries"]>[2], context: Context) => ReturnType<Conversation["entries"]>;

/** The folded items of the root conversation, caught up from its entries before every query. */
export class Timeline {
	readonly #load: Load;
	readonly #hidden: Hidden;
	readonly #fold = new TimelineFold();
	readonly #items: TimelineItem[] = [];
	/** The first entry id not yet folded. */
	#next = 0;
	#reading: Promise<void> = Promise.resolve();

	constructor(load: Load, hidden: Hidden) {
		this.#load = load;
		this.#hidden = hidden;
	}

	/** Fold the entries committed since the last read; one read at a time, each continuing where the last stopped. */
	catchUp(context: Context): Promise<void> {
		const run = this.#reading.then(() => this.#read(context));
		this.#reading = run.catch(() => {});
		return run;
	}

	async #read(context: Context): Promise<void> {
		let cursor: Parameters<Load>[2];
		do {
			const page = await this.#load({ minEntryId: this.#next as never, order: "ascending" }, PAGE, cursor, context);
			for (const entry of page.items) {
				this.#items.push(...this.#fold.push(entry));
				this.#next = Number(entry.id) + 1;
			}
			cursor = page.next;
		} while (cursor !== undefined);
	}

	#visible(): TimelineItem[] {
		const hidden = this.#hidden.matcher();
		return this.#items.filter((item) => !hidden(item.id));
	}

	/** Matching items, newest first; with no words, the newest in the time range. `more` says the limit cut some off. */
	async search(query: TimelineQuery, context: Context): Promise<{ items: TimelineItem[]; more: boolean }> {
		await this.catchUp(context);
		const words = terms(query.query ?? "");
		const kinds = query.kinds?.length ? new Set(query.kinds) : undefined;
		const limit = Math.min(Math.max(1, query.limit ?? 20), MAX_ITEMS);
		const found: TimelineItem[] = [];
		const items = this.#visible();
		for (let i = items.length - 1; i >= 0 && found.length <= limit; i--) {
			const item = items[i]!;
			if (query.until !== undefined && item.at >= query.until) continue;
			if (query.since !== undefined && item.at < query.since) break;
			if (kinds && !kinds.has(item.kind)) continue;
			const text = item.text.toLowerCase();
			if (words.every((word) => text.includes(word))) found.push(item);
		}
		return { items: found.slice(0, limit), more: found.length > limit };
	}

	/** The items around entry `id`, oldest first: the item at it, or the next one when it has none, and its neighbours. */
	async around(id: number, before = 5, after = 5, context: Context): Promise<{ items: TimelineItem[]; more: boolean }> {
		await this.catchUp(context);
		const items = this.#visible();
		const at = items.findIndex((item) => item.id >= id);
		if (at < 0) return { items: [], more: false };
		const clamp = (n: number) => Math.min(Math.max(0, n), MAX_ITEMS);
		const from = Math.max(0, at - clamp(before));
		const to = Math.min(items.length, at + clamp(after) + 1);
		return { items: items.slice(from, to), more: from > 0 || to < items.length };
	}
}

/** Entry id ranges the user hid, inclusive, kept in the state directory and read again whenever the file changes. */
export class Hidden {
	readonly #file: string;
	#ranges: [number, number][] = [];
	#stamp = "";

	constructor(file: string) {
		this.#file = file;
	}

	ranges(): [number, number][] {
		let stamp = "";
		try {
			const stat = statSync(this.#file);
			stamp = `${stat.mtimeMs}:${stat.size}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (stamp !== this.#stamp) {
			this.#stamp = stamp;
			// A file mangled by hand keeps the ranges last read, so views keep working and nothing hidden reappears.
			try {
				this.#ranges = stamp === "" ? [] : parseRanges(JSON.parse(readFileSync(this.#file, "utf8"))?.ranges);
			} catch {}
		}
		return this.#ranges;
	}

	/** A test for hidden ids, reading the file once: take one per query or fold, not per entry. */
	matcher(): (id: number) => boolean {
		const ranges = this.ranges();
		return ranges.length === 0 ? () => false : (id) => ranges.some(([from, to]) => id >= from && id <= to);
	}

	has(id: number): boolean {
		return this.matcher()(id);
	}

	add(from: number, to = from): [number, number][] {
		return this.#save(merge([...this.ranges(), [Math.min(from, to), Math.max(from, to)]]));
	}

	remove(from: number, to = from): [number, number][] {
		const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
		return this.#save(this.ranges().flatMap(([a, b]): [number, number][] => (b < lo || a > hi ? [[a, b]] : [...(a < lo ? [[a, lo - 1] as [number, number]] : []), ...(b > hi ? [[hi + 1, b] as [number, number]] : [])])));
	}

	#save(ranges: [number, number][]): [number, number][] {
		mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
		const temp = `${this.#file}.${randomUUID()}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ ranges })}\n`, { mode: 0o600 });
		renameSync(temp, this.#file);
		this.#stamp = "";
		return this.ranges();
	}
}

function parseRanges(value: unknown): [number, number][] {
	if (!Array.isArray(value)) return [];
	return merge(value.filter((r): r is [number, number] => Array.isArray(r) && Number.isSafeInteger(r[0]) && Number.isSafeInteger(r[1])).map(([a, b]) => [Math.min(a, b), Math.max(a, b)]));
}

function merge(ranges: [number, number][]): [number, number][] {
	const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
	const out: [number, number][] = [];
	for (const [a, b] of sorted) {
		const last = out.at(-1);
		if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

/** "12" or "12-40" as an inclusive range; undefined for anything else. */
export function parseRange(text: string): [number, number] | undefined {
	const match = /^(\d+)(?:-(\d+))?$/.exec(text);
	if (!match) return undefined;
	const from = Number(match[1]);
	const to = match[2] === undefined ? from : Number(match[2]);
	return [Math.min(from, to), Math.max(from, to)];
}

/**
 * Items as lines: `#id date time who: text`, continuation lines indented. Search hits are clipped around their first
 * match; context is shown whole up to `fullChars`. `mark` is the entry an `around` was asked for.
 */
export function renderTimeline(items: readonly TimelineItem[], options: { user?: string; query?: string; mark?: number; fullChars?: number } = {}): string {
	const { user = "user", fullChars = 2000 } = options;
	const words = terms(options.query ?? "");
	const marked = options.mark === undefined ? undefined : items.find((item) => item.id >= options.mark!)?.id;
	return items
		.map((item) => {
			const when = new Date(item.at);
			const stamp = `${when.toLocaleDateString("en-CA")} ${when.toTimeString().slice(0, 5)}`;
			const who =
				item.kind === "user" ? `${user} (${item.source ?? "?"})`
				: item.kind === "june" ? (item.source && PRIVATE.has(item.source) ? `June (after ${item.source})` : "June")
				: item.kind === "patter" ? "June (patter)"
				: item.kind === "action" ? "June did"
				: item.source ? `[${item.source}]` : "--";
			const files = (item.files ?? []).map((f) => ` [file ${f.name}${f.path && !existsSync(f.path) ? ", no longer kept" : ""}]`).join("");
			const text = `${words.length ? excerpt(item.text, words[0]!, 400) : cut(item.text, fullChars)}${files}`;
			return `${item.id === marked ? ">" : "#"}${item.id} ${stamp} ${who}: ${text.replace(/\n/g, "\n      ")}`;
		})
		.join("\n");
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One line of about `max` characters around the first place `word` appears. */
function excerpt(text: string, word: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const at = Math.max(0, flat.toLowerCase().indexOf(word));
	const start = Math.max(0, Math.min(at - Math.floor(max / 3), flat.length - max));
	return `${start > 0 ? "…" : ""}${flat.slice(start, start + max).trim()}${start + max < flat.length ? "…" : ""}`;
}

