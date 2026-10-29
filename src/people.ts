// The user's rolodex, an Org file with one heading per person: who they are (:WHO:) and their addresses (:EMAIL:), so
// mail and other inputs can name a sender before June reads anything. The address book (khard) adds names for
// everyone else the user keeps a contact for.
import { readFileSync } from "node:fs";
import { type Run, runProcess } from "./tools/herdr.ts";

export type Known = { name: string; who?: string };

/** Email address to person, from the rolodex's :EMAIL: properties; a missing or unreadable file is empty. */
export function rolodex(file: string | undefined): Map<string, Known> {
	const people = new Map<string, Known>();
	if (file === undefined) return people;
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return people;
	}
	for (const entry of text.split(/^(?=\*+ )/m)) {
		const title = /^\*+ (.+?)(?:\s+:[\w@#%:]+:)?\s*$/m.exec(entry.split("\n")[0]!)?.[1];
		const drawer = /^\s*:PROPERTIES:\s*$([\s\S]*?)^\s*:END:\s*$/m.exec(entry)?.[1];
		if (title === undefined || drawer === undefined) continue;
		const property = (key: string) => new RegExp(`^\\s*:${key}:[ \\t]*(.*)$`, "mi").exec(drawer)?.[1]?.trim();
		const who = property("WHO");
		for (const address of (property("EMAIL") ?? "").split(/[\s,;]+/).filter((a) => a.includes("@")))
			people.set(address.toLowerCase(), { name: title, ...(who ? { who } : {}) });
	}
	return people;
}

/** Email address to name, from the address book; empty when khard is missing. */
export async function contacts(run: Run = runProcess): Promise<Map<string, string>> {
	const out = await run(["khard", "email", "--parsable"], 30_000).catch(() => "");
	const found = new Map<string, string>();
	for (const line of out.split("\n")) {
		const [address, name] = line.split("\t");
		if (address?.includes("@")) found.set(address.trim().toLowerCase(), name?.trim() ?? "");
	}
	return found;
}

/** What the nightly reflection learned about one person: `name` is their heading, or a new person's full name. */
export type PersonUpdate = { name: string; who?: string; summary?: string | null; notes?: readonly string[] };

const HEADING = /^(\*+) (.+?)(?:\s+:[\w@#%:]+:)?\s*$/;
const LIST = /^\s*(?:[-+]|\d+[.)]) /;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The rolodex with each update applied: a person's summary is the paragraph right under their drawer, replaced or
 * added, and notes are dated list items appended after their last line. Nothing else in the file changes. A name
 * the rolodex lacks becomes a new person under the top-level New heading.
 */
export function applyPeople(text: string, date: string, updates: readonly PersonUpdate[]): string {
	let lines = text.replace(/\n+$/, "").split("\n");
	for (const update of updates) {
		const notes = (update.notes ?? []).map(oneLine).filter(Boolean).map((note) => `- ${date}: ${/[.!?"')\]]$/.test(note) ? note : `${note}.`} Source: June's journal, ${date}.`);
		const summary = update.summary ? oneLine(update.summary) : undefined;
		if (notes.length === 0 && summary === undefined) continue;
		const at = findPerson(lines, update.name);
		lines = at === undefined ? addPerson(lines, update, summary, notes) : updatePerson(lines, at, summary, notes);
	}
	return `${lines.join("\n")}\n`;
}

/** The line of the heading for `name`: a heading with a property drawer, matched exactly, then ignoring case. */
function findPerson(lines: readonly string[], name: string): number | undefined {
	const people = lines.flatMap((line, i) => {
		const title = HEADING.exec(line)?.[2];
		return title !== undefined && lines[i + 1]?.trim() === ":PROPERTIES:" ? [{ i, title }] : [];
	});
	const wanted = oneLine(name);
	return (people.find((p) => p.title === wanted) ?? people.find((p) => p.title.toLowerCase() === wanted.toLowerCase()))?.i;
}

function updatePerson(lines: string[], heading: number, summary: string | undefined, notes: readonly string[]): string[] {
	const out = [...lines];
	const end = out.findIndex((line, i) => i > heading && line.trim() === ":END:");
	if (end < 0) return out;
	const next = () => {
		const i = out.findIndex((line, i) => i > end && HEADING.test(line));
		return i < 0 ? out.length : i;
	};
	if (summary !== undefined) {
		const first = end + 1;
		const line = out[first];
		if (first < next() && line !== undefined && line.trim() !== "" && !LIST.test(line)) {
			let last = first;
			while (last + 1 < next() && out[last + 1]!.trim() !== "" && !LIST.test(out[last + 1]!)) last++;
			out.splice(first, last - first + 1, summary);
		} else out.splice(first, 0, ...(line !== undefined && line.trim() !== "" ? [summary, ""] : [summary]));
	}
	if (notes.length > 0) {
		let last = next() - 1;
		while (last > end && out[last]!.trim() === "") last--;
		const after = last === end || LIST.test(out[last]!) ? notes : ["", ...notes];
		out.splice(last + 1, 0, ...after);
		const following = last + 1 + after.length;
		if (following < out.length && HEADING.test(out[following]!)) out.splice(following, 0, "");
	}
	return out;
}

function addPerson(lines: string[], update: PersonUpdate, summary: string | undefined, notes: readonly string[]): string[] {
	const out = [...lines];
	let group = out.findIndex((line) => /^\* New\s*$/.test(line));
	if (group < 0) {
		if (out.at(-1)?.trim()) out.push("");
		out.push("* New");
		group = out.length - 1;
	}
	let at = out.findIndex((line, i) => i > group && /^\* /.test(line));
	if (at < 0) at = out.length;
	while (at - 1 > group && out[at - 1]!.trim() === "") at--;
	const block = [`** ${oneLine(update.name)}`, ":PROPERTIES:", ...(update.who ? [`:WHO: ${oneLine(update.who)}`] : []), ":END:", ...(summary ? [summary] : []), ...(summary && notes.length ? [""] : []), ...notes];
	out.splice(at, 0, ...(at - 1 === group ? [] : [""]), ...block, ...(out[at]?.trim() ? [""] : []));
	return out;
}
