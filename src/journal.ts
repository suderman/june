// June's journal: her own dated record of the user and their days together, written in her perspective. Entries go into an
// Org date tree (year, month, day), the shape of the user's own journal.org, so the latest days are easy to find.
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { User, user } from "./user.ts";

export type JournalEntry = { readonly date: string; readonly time?: string; readonly title: string; readonly text: string };

const header = () => `#+TITLE: June's journal\n\nJune's own record of ${user()} and their days together, in her words. Newest at the end.\n`;

/** The local date and time, as an entry records them. */
export function localStamp(now = new Date()): { date: string; time: string } {
	const pad = (n: number) => String(n).padStart(2, "0");
	return { date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, time: `${pad(now.getHours())}:${pad(now.getMinutes())}` };
}

/** `text` with the entry filed under its day, creating the year, month, and day headings in order as needed. */
export function insertEntry(text: string, entry: JournalEntry): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry.date);
	if (match === null) throw new Error(`Journal date must be YYYY-MM-DD, not ${entry.date}`);
	const [, year, month, day] = match as unknown as [string, string, string, string];
	const when = new Date(Number(year), Number(month) - 1, Number(day));
	if (when.getMonth() !== Number(month) - 1) throw new Error(`No such date ${entry.date}`);
	const title = entry.title.replace(/\s+/g, " ").trim();
	if (!title) throw new Error("A journal entry needs a title");
	const body = paragraphs(entry.text);
	if (body.length === 0) throw new Error("A journal entry needs some text");

	const lines = (text.trim() ? text : header()).replace(/\n+$/, "").split("\n");
	const monthName = when.toLocaleString("en-CA", { month: "long" });
	const weekday = when.toLocaleString("en-CA", { weekday: "long" });
	let [start, end] = [0, lines.length];
	for (const [level, key, heading] of [
		[1, year, year],
		[2, `${year}-${month}`, `${year}-${month} ${monthName}`],
		[3, entry.date, `${entry.date} ${weekday}`],
	] as const) {
		[start, end] = node(lines, start, end, level, key, heading);
	}
	put(lines, end, [`**** ${entry.time ? `${entry.time} ` : ""}${title}`, ...body]);
	return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** Each paragraph on one physical line, as Org prose is kept; a line starting with a star would become a heading. */
function paragraphs(text: string): string[] {
	const out = text
		.split(/\n\s*\n/)
		.map((p) => p.split("\n").map((l) => l.trim()).filter(Boolean))
		.filter((p) => p.length > 0)
		.flatMap((p, i) => [...(i > 0 ? [""] : []), ...(p.every((l) => /^[-+] |^\d+[.)] /.test(l)) ? p : [p.join(" ")])]);
	if (out.some((l) => /^\*+\s/.test(l))) throw new Error("Journal text must not start a line with stars");
	return out;
}

/** The line range of the child heading `key` at `level` within [start, end), created in date order when missing. */
function node(lines: string[], start: number, end: number, level: number, key: string, heading: string): [number, number] {
	const stars = `${"*".repeat(level)} `;
	let at = end;
	for (let i = start; i < end; i++) {
		const line = lines[i]!;
		if (!line.startsWith(stars)) continue;
		const title = line.slice(stars.length);
		if (title === key || title.startsWith(`${key} `)) {
			let close = i + 1;
			while (close < end && (/^(\*+) /.exec(lines[close]!)?.[1]!.length ?? Infinity) > level) close++;
			return [i, close];
		}
		if (title.split(" ")[0]! > key) {
			at = i;
			break;
		}
	}
	const inserted = put(lines, at, [`${stars}${heading}`]);
	return [inserted, inserted + 1];
}

/** Insert a heading block at `at`, keeping one blank line between finished text and the next heading. Returns its index. */
function put(lines: string[], at: number, block: string[]): number {
	const before = lines[at - 1];
	const gap = before !== undefined && before !== "" && !/^\*+ /.test(before) ? [""] : [];
	const after = lines[at];
	const tail = after !== undefined && after !== "" && block.length > 1 ? [""] : [];
	lines.splice(at, 0, ...gap, ...block, ...tail);
	return at + gap.length;
}

/** The day's subtree, from its `*** YYYY-MM-DD` heading to the next heading at that level or above. */
export function daySection(text: string, date: string): { start: number; end: number; text: string } | undefined {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line === `*** ${date}` || line.startsWith(`*** ${date} `));
	if (start < 0) return undefined;
	let end = start + 1;
	while (end < lines.length && !/^\*{1,3} /.test(lines[end]!)) end++;
	return { start, end, text: lines.slice(start, end).join("\n").replace(/\n+$/, "") };
}

/** The last `count` days' "Day's end" entries, oldest first, each as its day heading's text and the entry's paragraphs. */
export function recentDayEnds(text: string, count: number): { day: string; text: string }[] {
	const found: { day: string; text: string }[] = [];
	let day: string | undefined;
	let body: string[] | undefined;
	const close = () => {
		if (day !== undefined && body !== undefined) found.push({ day, text: body.filter(Boolean).join(" ") });
		body = undefined;
	};
	for (const line of text.split("\n")) {
		if (/^\*+ /.test(line)) {
			close();
			if (line.startsWith("*** ")) day = line.slice(4).trim();
			else if (/^\*{1,2} /.test(line)) day = undefined;
			else if (/^\*{4} Day's end\s*$/.test(line)) body = [];
		} else body?.push(line.trim());
	}
	close();
	return count > 0 ? found.slice(-count) : [];
}

/** `text` with the day's subtree replaced by `day`, keeping one blank line before the next heading. */
export function replaceDay(text: string, date: string, day: string): string {
	const found = daySection(text, date);
	if (found === undefined) throw new Error(`No ${date} in the journal`);
	const lines = text.split("\n");
	const tail = found.end < lines.length ? [""] : [];
	lines.splice(found.start, found.end - found.start, ...day.replace(/\n+$/, "").split("\n"), ...tail);
	return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function read(file: string): string {
	try {
		if (!lstatSync(file).isFile()) throw new Error(`${basename(file)} must be a regular file`);
		return readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

/** The end of the journal, for a review to see what is already written. */
export function journalTail(file: string, chars = 6000): string {
	const text = read(file);
	return text.length > chars ? text.slice(-chars) : text;
}

/**
 * File entries in the journal. An entry whose text is already there is skipped, so a replayed review writes once. The
 * file is replaced atomically and only if nothing changed it meanwhile, so an edit from Emacs or Syncthing is never lost.
 */
export function appendJournal(file: string, entries: readonly JournalEntry[]): number {
	checkJournalConflicts(file);
	const base = read(file);
	let next = base;
	let added = 0;
	for (const entry of entries) {
		if (base.includes(paragraphs(entry.text)[0]!)) continue;
		next = insertEntry(next, entry);
		added++;
	}
	if (added === 0) return 0;
	replaceIfUnchanged(file, base, next);
	return added;
}

export function checkJournalConflicts(file: string): void {
	if (readdirSync(dirname(file)).some((name) => /^JOURNAL\.sync-conflict-.*\.org$/.test(name)))
		throw new Error("JOURNAL.org has a Syncthing conflict copy; resolve it first");
}

/** Replace `file` with `next` atomically, only if it still reads `base` (empty for a missing file). */
export function replaceIfUnchanged(file: string, base: string, next: string): void {
	const temp = `${file}.${process.pid}.tmp`;
	try {
		const fd = openSync(temp, "w", 0o600);
		try {
			writeFileSync(fd, next);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (read(file) !== base) throw new Error(`${basename(file)} changed while writing; try again`);
		renameSync(temp, file);
	} finally {
		try {
			unlinkSync(temp);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
