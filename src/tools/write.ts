// Safe Org writes: a new TODO, a note on a heading, a state, a date. June writes heading and body text herself, as
// agents do, replacing the file only if nobody changed it meanwhile; Org sets states and dates through org-edit, so
// CLOSED, repeaters, logbook entries, and weekdays come out as Emacs makes them. Each write is safe to replay.
import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { replaceIfUnchanged } from "../journal.ts";
import { writable } from "./dispatch.ts";
import { type Run, runProcess } from "./herdr.ts";
import { locate, type Org, outline, parseHeading, subtree } from "./org.ts";
import { user } from "../user.ts";

/** The states June may set by hand. AUTO grants an agent work, so it has its own tools. */
export const SETTABLE = ["TODO", "PROG", "EVAL", "HOLD", "DONE"] as const;
type Settable = (typeof SETTABLE)[number];

export type NewTask = {
	file: string;
	title: string;
	/** The heading to file it under; omitted, it becomes a first-level heading after the preamble, newest first. */
	under?: string;
	body?: string;
	scheduled?: string;
	deadline?: string;
};

const oneLine = (text: string, what: string) => {
	if (/[\n\r]/.test(text) || text.trim() !== text || text === "") throw new Error(`${what} is one line without surrounding spaces`);
	return text;
};

/** Body text June may write under a heading at `level`: no heading at or above it, no planning line, no drawer. */
function checkBody(body: string, level: number): string {
	const text = body.trim().replace(/\n{3,}/g, "\n\n");
	if (new RegExp(`^\\*{1,${level}} `, "m").test(text)) throw new Error(`The text must not contain a heading of level ${level} or above`);
	if (/^\s*(SCHEDULED|DEADLINE|CLOSED):/m.test(text)) throw new Error("Dates go in scheduled and deadline, not the text");
	if (/^\s*:[A-Z]+:\s*$/m.test(text)) throw new Error("The text must not contain a drawer");
	return text;
}

/**
 * Put `block` between `before` and `after` by the Org layout rules: a blank line after finished text, none after a
 * heading, planning line, or drawer; and one after the block, if it ends in text and anything follows.
 */
function splice(before: readonly string[], block: readonly string[], after: readonly string[], floor: number): string {
	const kept = [...before];
	while (kept.length > floor && kept.at(-1) === "") kept.pop();
	const last = kept.at(-1) ?? "";
	const bare = kept.length === 0 || /^\*+ /.test(last) || /^\s*(:END:|SCHEDULED:|DEADLINE:|CLOSED:)/.test(last);
	const rest = [...after];
	while (rest.length > 0 && rest[0] === "") rest.shift();
	const tail = rest.length === 0 ? [""] : /^\*+ /.test(block.at(-1)!) ? rest : ["", ...rest];
	return [...kept, ...(bare ? [] : [""]), ...block, ...tail].join("\n");
}

export class OrgWrites {
	readonly #org: Org;
	readonly #config: Config;
	readonly #run: Run;

	constructor(org: Org, config: Config, run: Run = runProcess) {
		this.#org = org;
		this.#config = config;
		this.#run = run;
	}

	/** Write a TODO once: a replay, or a second ask, finds the open one with the same title in the same place. */
	async addTask(task: NewTask) {
		oneLine(task.title, "The title");
		if (/^(TODO|AUTO|PROG|EVAL|HOLD|DONE)\b/.test(task.title) || /\s:[\w@#%:]+:$/.test(task.title)) throw new Error("The title must not carry a keyword or tags");
		const under = task.under || undefined;
		// A bad date is refused before anything is written.
		for (const when of [task.scheduled, task.deadline]) if (when) await this.#run(["org-edit", "date", when], 60_000);
		const path = await writable(this.#org, this.#config, task.file);
		const content = await readFile(path, "utf8");
		const lines = content.split("\n");
		const parent = under === undefined ? undefined : locate(lines, under, this.#org.rel(path));
		const level = parent === undefined ? 1 : parseHeading(lines[parent - 1]!, parent)!.level + 1;
		const body = task.body ? checkBody(task.body, level) : "";
		const span = parent === undefined ? { start: 1, end: lines.length } : subtree(lines, parent);
		const same = lines.slice(span.start - 1, span.end).findIndex((text) => {
			const h = text.startsWith("*") ? parseHeading(text, 0) : undefined;
			return h?.level === level && h.state !== "DONE" && h.title.toLowerCase() === task.title.toLowerCase();
		});
		const path_ = [...(parent === undefined ? [] : outline(lines, parent).map((h) => h.title)), task.title].join(" / ");
		let written = false;
		if (same < 0) {
			const block = [`${"*".repeat(level)} TODO ${task.title}`, ...(body ? body.split("\n") : [])];
			let next: string;
			if (parent === undefined) {
				// After the preamble, newest first, as project files keep their threads.
				const first = lines.findIndex((l) => /^\* /.test(l));
				next = first < 0 ? splice(lines, block, [], 0) : splice(lines.slice(0, first), block, lines.slice(first), 0);
			} else next = splice(lines.slice(0, span.end), block, lines.slice(span.end), span.start);
			replaceIfUnchanged(path, content, next);
			written = true;
		}
		// Dates last, through Org; on a replay they are set again to the same thing.
		const dates: string[] = [];
		if (task.scheduled) dates.push(await this.#run(["org-edit", "schedule", path, path_, task.scheduled], 60_000));
		if (task.deadline) dates.push(await this.#run(["org-edit", "deadline", path, path_, task.deadline], 60_000));
		return { file: this.#org.rel(path), heading: path_, written, ...(dates.length ? { planning: dates.at(-1)!.trim() } : {}) };
	}

	/** Add a paragraph or list to the end of a heading's own text, before its subheadings; once, however often asked. */
	async addNote(file: string, heading: string, text: string) {
		const path = await writable(this.#org, this.#config, file);
		const content = await readFile(path, "utf8");
		const lines = content.split("\n");
		const line = locate(lines, heading, this.#org.rel(path));
		const level = parseHeading(lines[line - 1]!, line)!.level;
		const note = checkBody(text, level);
		if (note === "") throw new Error("The note is empty");
		const { start, end } = subtree(lines, line);
		if (lines.slice(start - 1, end).join("\n").includes(note)) return { file: this.#org.rel(path), heading, written: false };
		// The heading's own text ends at its first subheading.
		let own = start;
		while (own < end && !(lines[own]!.startsWith("*") && parseHeading(lines[own]!, own + 1))) own++;
		replaceIfUnchanged(path, content, splice(lines.slice(0, own), note.split("\n"), lines.slice(own), start));
		return { file: this.#org.rel(path), heading, written: true };
	}

	/** Change a state through Org, refused if it is no longer `expected`; already there is a replay, not a conflict. */
	async setState(file: string, heading: string, state: Settable, expected: string) {
		if (!SETTABLE.includes(state)) throw new Error(`June sets ${SETTABLE.join(", ")} by hand; AUTO has its own tools`);
		const path = await writable(this.#org, this.#config, file);
		const lines = await this.#org.lines(path);
		const line = locate(lines, heading, this.#org.rel(path));
		const current = parseHeading(lines[line - 1]!, line)!.state;
		if (current === state) return { file: this.#org.rel(path), heading: lines[line - 1], written: false };
		if (current === "AUTO") throw new Error("An AUTO task belongs to the dispatcher until an agent finishes it");
		if ((current ?? "") !== expected.trim().toUpperCase()) throw new Error(`Expected ${expected || "no state"}, found ${current ?? "no state"}; read it again`);
		// Org checks again as it saves, in case the file changed since this read.
		const check = current === undefined ? [] : ["--expect", current];
		const out = await this.#run(["org-edit", "todo", path, outline(lines, line).map((h) => h.title).join(" / "), state, ...check], 60_000);
		return { file: this.#org.rel(path), heading: out.trim().split("\n")[0], written: true };
	}

	/** Set or clear SCHEDULED or DEADLINE through Org. */
	async setDate(file: string, heading: string, kind: "scheduled" | "deadline", when: string) {
		const path = await writable(this.#org, this.#config, file);
		const lines = await this.#org.lines(path);
		const line = locate(lines, heading, this.#org.rel(path));
		const out = await this.#run(["org-edit", kind === "scheduled" ? "schedule" : "deadline", path, outline(lines, line).map((h) => h.title).join(" / "), when], 60_000);
		return { file: this.#org.rel(path), heading: out.trim() };
	}
}

const WHEN = "As org-edit takes it: a date (2026-10-30, +3d, fri, today), an optional time or range (14:00, 9:00-10:30), and optional repeater or warning cookies (+1w, .+1d, -2d)";

export function createOrgWriteExtension(config: Config, org: Org, run: Run = runProcess): Extension {
	const writes = new OrgWrites(org, config, run);
	const json = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] });
	const file = Type.String({ description: "Agenda Org file under ~/org, as org_search returns it" });
	const heading = Type.String({ description: 'Exact title, outline path such as "Parent / Title", or id:UUID' });
	return defineExtension({
		name: "org-write",
		tools: [
			defineTool({
				name: "org_add_task",
				description: `Add a TODO for ${user()} to an agenda file, where their agenda and phone see it, optionally with a SCHEDULED or DEADLINE time; a deadline is how to remind them at a set time. File it where it belongs: under the heading it concerns in a life file, or in the project file, after searching. Writes once: an open TODO with the same title in the same place is reused. Never for agent work, which org_queue_task queues.`,
				parameters: Type.Object({
					file,
					title: Type.String({ description: "Concise verb-led title, without keyword or tags" }),
					under: Type.Optional(Type.String({ description: "Heading to file it under, as heading; omit for a first-level heading after the preamble" })),
					body: Type.Optional(Type.String({ description: "Optional Org text: one physical line per paragraph or list item" })),
					scheduled: Type.Optional(Type.String({ description: `When to start; ${WHEN}` })),
					deadline: Type.Optional(Type.String({ description: `When it is due; ${WHEN}` })),
				}),
				replay: "safe",
				execute: async (args) => json(await writes.addTask(args)),
			}),
			defineTool({
				name: "org_add_note",
				description: "Add a paragraph or list to the end of an Org heading's own text, before its subheadings. Use it for a fact that belongs with a task or topic, such as a changed time or a reply received; not for Dialog entries on agent tasks. Writes once: text already there is not added again.",
				parameters: Type.Object({ file, heading, text: Type.String({ description: "Org text, one physical line per paragraph or list item; no headings, dates, or drawers" }) }),
				replay: "safe",
				execute: async (args) => json(await writes.addNote(args.file, args.heading, args.text)),
			}),
			defineTool({
				name: "org_set_state",
				description: `Change a heading's TODO state through Org, which writes CLOSED and logging. Only when ${user()} asks, or for a TODO you added for them that is plainly done. Never AUTO; agent tasks close through org_complete_task. Refused if the state is no longer expected.`,
				parameters: Type.Object({
					file,
					heading,
					state: Type.Union(SETTABLE.map((s) => Type.Literal(s))),
					expected: Type.String({ description: "The state you just read, or empty for none" }),
				}),
				replay: "safe",
				execute: async (args) => json(await writes.setState(args.file, args.heading, args.state, args.expected)),
			}),
			defineTool({
				name: "org_set_date",
				description: "Set or remove a heading's SCHEDULED or DEADLINE through Org, which writes the weekday and handles repeaters.",
				parameters: Type.Object({
					file,
					heading,
					kind: Type.Union([Type.Literal("scheduled"), Type.Literal("deadline")]),
					when: Type.String({ description: `${WHEN}; or none to remove it` }),
				}),
				replay: "safe",
				execute: async (args) => json(await writes.setDate(args.file, args.heading, args.kind, args.when)),
			}),
		],
	});
}
