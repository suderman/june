// June's journal: her own dated record of Jon and their days together, written in her perspective. Entries go into an
// Org date tree (year, month, day), the shape of Jon's own journal.org, so the latest days are easy to find.
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type JournalEntry = { readonly date: string; readonly time?: string; readonly title: string; readonly text: string };

const HEADER = "#+TITLE: June's journal\n\nJune's own record of Jon and their days together, in her words. Newest at the end.\n";

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

	const lines = (text.trim() ? text : HEADER).replace(/\n+$/, "").split("\n");
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

function read(file: string): string {
	try {
		if (!lstatSync(file).isFile()) throw new Error("JOURNAL.org must be a regular file");
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
	if (readdirSync(dirname(file)).some((name) => /^JOURNAL\.sync-conflict-.*\.org$/.test(name)))
		throw new Error("JOURNAL.org has a Syncthing conflict copy; resolve it first");
	const base = read(file);
	let next = base;
	let added = 0;
	for (const entry of entries) {
		if (base.includes(paragraphs(entry.text)[0]!)) continue;
		next = insertEntry(next, entry);
		added++;
	}
	if (added === 0) return 0;
	const temp = `${file}.${process.pid}.tmp`;
	try {
		const fd = openSync(temp, "w", 0o600);
		try {
			writeFileSync(fd, next);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (read(file) !== base) throw new Error("JOURNAL.org changed while writing; try again");
		renameSync(temp, file);
	} finally {
		try {
			unlinkSync(temp);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return added;
}
