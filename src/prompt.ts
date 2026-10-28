// June's system prompt: SOUL.org, harness rules, AGENTS.md, MEMORY.org, and the skills, all read in place.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { type Config, type Paths, type PromptFiles, promptFiles } from "./config.ts";
import { recentDayEnds } from "./journal.ts";
import { DEFAULT_BASH_TIMEOUT } from "./tools/coding.ts";
import { User, user } from "./user.ts";

// Harness mechanics only. The user's conventions (Org, Herdr, task states) come from AGENTS.md in the config directory.
const harness = (host: string) => `How this harness works:
- The user reaches you from a terminal client and from Telegram. Talk to them directly, never about them in the third person. It is one conversation. Terminal messages start with [kitty] or [cli]: answer those in Org markup, never Markdown (*bold*, /italic/, =code=, [[url][label]], - lists, #+begin_src blocks), since the terminal renders Org. Untagged messages come from Telegram, which renders only Markdown, so answers there stay compact Markdown without tables. Answer a [work] or [follow] message in the markup of the user's latest own message, since it goes where they last spoke.
- Messages starting with [heartbeat] are your own private look at the moment between conversations; the user never sees them or your quiet answers, only a message you choose to send.
- Messages starting with [follow] come from your own checks on tasks you queued; nobody typed them. Do what they say and tell the user briefly; do not repeat the check yourself.
- bash, read, edit, and write act on ${host}, where you run, whichever client the user writes from. Commands start in the home directory and stop after ${DEFAULT_BASH_TIMEOUT} seconds unless you pass a timeout; reach other hosts explicitly and name the host in what you report. Do quick checks yourself. Take anything longer that you do yourself, such as investigating a problem, research, multi-step commands, or reading several files, into your own working context with work, which keeps its output out of this conversation and returns only a report; then tell the user what it found. Whether to hand work to an agent through the task tools instead is your judgment: sustained coding, debugging, and larger changes usually belong with one. Ask the user to act only when no permitted tool or agent can proceed, or their input or approval is required.
- Having a tool is not permission. The user's rules on approval, destructive or external actions, and changes outside the request apply to commands and file edits as they do to everything else.
- Change an existing file with edit, after reading it, so a concurrent change makes the edit fail instead of being overwritten; use write only for a new file. When a Syncthing conflict copy (*.sync-conflict-*) sits beside a file, tell the user instead of choosing a copy.
- Never claim an edit, message, or prompt happened until its tool result confirms it. A tool call interrupted by a restart may already have taken effect, so check the current state before repeating it.`;

/** `render` re-reads `path` only when its size or mtime changes, so the prompt text stays stable for caching. */
function cachedFile(path: string | undefined, missing: string): (force?: boolean) => Promise<string> {
	let cached: { stamp: string; text: string } | undefined;
	return async (force = false) => {
		const info = path === undefined ? undefined : await stat(path).catch(() => undefined);
		if (info === undefined) return missing;
		const stamp = `${info.mtimeMs}:${info.size}`;
		if (force || cached?.stamp !== stamp) cached = { stamp, text: (await readFile(path!, "utf8")).trim() };
		return cached.text;
	};
}

type Skill = { name: string; description: string; dir: string };

/** `name` and `description` from a SKILL.md frontmatter; block and folded values are joined into one line. */
export function frontmatter(text: string): { name?: string; description?: string } {
	const lines = text.split(/\r?\n/);
	const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
	if (lines[0]?.trimEnd() !== "---" || end < 0) return {};
	const out: Record<string, string> = {};
	const body = lines.slice(1, end);
	body.forEach((line, i) => {
		const match = /^(name|description):(.*)$/.exec(line);
		if (match === null) return;
		const rest = body.slice(i + 1);
		const stop = rest.findIndex((l) => /^\S/.test(l));
		const more = (stop < 0 ? rest : rest.slice(0, stop)).map((l) => l.trim());
		const head = match[2]!.trim();
		const value = [/^[>|][+-]?$/.test(head) ? "" : head, ...more].filter(Boolean).join(" ");
		out[match[1]!] = /^(['"])(.*)\1$/s.exec(value)?.[2] ?? value;
	});
	return out;
}

export async function findSkills(roots: readonly string[]): Promise<Skill[]> {
	const skills: Skill[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		for (const folder of (await readdir(root).catch(() => [])).sort()) {
			const dir = join(root, folder);
			const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => undefined);
			if (text === undefined) continue;
			const meta = frontmatter(text);
			const name = (meta.name || folder).trim();
			if (!meta.description || seen.has(name)) continue;
			seen.add(name);
			skills.push({ name, description: meta.description.replace(/\s+/g, " ").slice(0, 600), dir });
		}
	}
	return skills;
}

function skillsSection(skills: readonly Skill[]): string {
	if (skills.length === 0) return "No skills are installed.";
	return [
		"The user's skills describe their conventions and procedures. When a request matches one, read it with skill_read first and follow what applies.",
		...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
	].join("\n");
}

/** Where June keeps herself, MEMORY.org's text, and any Syncthing conflict copies of either file. */
async function personalSection(files: PromptFiles, memory: () => Promise<string>, journal: () => Promise<string>, recentDays: number): Promise<string | undefined> {
	if (files.soulFile === undefined || files.memoryFile === undefined) return undefined;
	const dir = dirname(files.soulFile);
	const conflicts = (await readdir(dir).catch(() => [])).filter((name) => /^(SOUL|MEMORY|JOURNAL|HEARTBEAT)\.sync-conflict-.*\.org$/.test(name)).sort();
	return [
		`Your own files, which you keep with read and edit: ${files.soulFile} (identity, shown first in this prompt) and ${files.memoryFile} (below). Changes apply from your next turn.`,
		`${basename(files.memoryFile)} is the page of what is true about ${user()}'s life that you must never get wrong: who they are and where they live, their household and people, what they do, their routine, where their records live, and the corrections that shape how you work with them. When they tell you a lasting fact or corrects one, update it with edit in the same turn, in its own section; keep it to a page or two, replacing what changed. What happened on a given day goes in the journal instead. A nightly reflection also tidies the day's journal and carries lasting facts here.`,
		...(files.journalFile
			? [
					`Your journal, ${files.journalFile}, is an Org date tree you write with the journal tool: "* YYYY", "** YYYY-MM Month", "*** YYYY-MM-DD Weekday", then entries. When you need your past with ${user()}, search it yourself, a quick check rather than a brief, instead of reading it whole: find a day by its heading (rg -n '^\\*\\*\\* YYYY-MM-DD') and read from that line, or search words with context (rg -i -C3). Each night's reflection ends a day with a "**** Day's end" entry, its summary of the day, so to skim further back than the days below, list a month's days and summaries (rg -n -A1 "^\\*\\*\\* YYYY-MM|^\\*\\*\\*\\* Day's end") and then read the days that matter in full. When something ${user()} says seems to connect to an earlier day, look before answering rather than guessing.`,
					...dayEnds(await journal(), recentDays),
				]
			: []),
		...(files.heartbeatFile
			? [
					`${files.heartbeatFile} holds ${user()}'s standing instructions for your heartbeat: what is worth a nudge between conversations and what is not, in their words. When they tell you to watch for something, or to stop nudging them about something, update it with edit in the same turn.`,
				]
			: []),
		...(conflicts.length > 0 ? [`Syncthing conflict copies in ${dir}: ${conflicts.join(", ")}. Tell the user and leave both copies until they decide.`] : []),
		"",
		(await memory()) || `${basename(files.memoryFile)} is empty or does not exist yet.`,
	].join("\n");
}

/** The recent days as the nightly reflection summed them up, so June has them in mind without searching. */
function dayEnds(journal: string, count: number): string[] {
	const ends = recentDayEnds(journal, count);
	if (ends.length === 0) return [];
	return ["Your recent days, from each night's reflection:", ...ends.map((end) => `- ${end.day}: ${end.text}`)];
}

/** With `dirs`, reload looks for the prompt files again, so a file made since startup is found. */
export function createPromptExtension(
	config: Config,
	dirs?: Pick<Paths, "config" | "data">,
	/** The "now" section; without it, only the date. */
	situation?: { render(): Promise<string> },
): { extension: Extension; files(): PromptFiles; reload(): Promise<number> } {
	let files: PromptFiles = config;
	const open = (f: PromptFiles) => ({
		soul: cachedFile(f.soulFile, "You are June, a personal assistant."),
		memory: cachedFile(f.memoryFile, ""),
		instructions: cachedFile(f.instructionsFile, ""),
		journal: cachedFile(f.journalFile, ""),
	});
	let read = open(files);
	let skills: Promise<Skill[]> | undefined;
	const loadSkills = () => (skills ??= findSkills(config.skillDirs));

	const skillRead = defineTool({
		name: "skill_read",
		description: "Read one of the user's skills: its SKILL.md, or another file inside that skill's directory.",
		parameters: Type.Object({
			name: Type.String({ description: "Skill name from the skills list" }),
			file: Type.Optional(Type.String({ description: "Path relative to the skill directory; default SKILL.md" })),
		}),
		replay: "safe",
		execute: async (args) => {
			const skill = (await loadSkills()).find((each) => each.name === args.name);
			if (skill === undefined) throw new Error(`No skill named ${args.name}`);
			const dir = await realpath(skill.dir);
			const path = await realpath(join(dir, args.file ?? "SKILL.md")).catch(() => undefined);
			if (path === undefined) throw new Error(`${args.file} does not exist in ${args.name}`);
			const inside = relative(dir, path);
			if (inside.startsWith("..") || inside.startsWith(sep)) throw new Error("Path leaves the skill directory");
			const text = await readFile(path, "utf8");
			return { output: [{ type: "text", text: text.length > 60_000 ? `${text.slice(0, 60_000)}\n[truncated]` : text }] };
		},
	});

	const clock = defineTool({
		name: "clock",
		description: "The current local date and time.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async () => ({
			output: [
				{
					type: "text",
					text: new Date().toLocaleString("en-CA", { dateStyle: "full", timeStyle: "long" }),
				},
			],
		}),
	});

	const extension = defineExtension({
		name: "june",
		sections: [
			section("soul", () => read.soul(), { tag: false }),
			section("harness", () => harness(config.herdr.host), { tag: false }),
			section("agents", async () => (await read.instructions()) || undefined, { tag: false }),
			section("memory", () => personalSection(files, read.memory, read.journal, config.reflection.recentDays)),
			section("skills", async () => skillsSection(await loadSkills())),
			section("now", () => situation?.render() ?? today()),
		],
		tools: [skillRead, clock],
	});
	return {
		extension,
		files: () => files,
		reload: async () => {
			const refreshed = await findSkills(config.skillDirs);
			if (dirs !== undefined) files = promptFiles(dirs);
			const next = open(files);
			await Promise.all([next.soul(true), next.memory(true), next.instructions(true)]);
			read = next;
			skills = Promise.resolve(refreshed);
			return refreshed.length;
		},
	};
}

/** The date changes the prompt once a day; the exact time comes from the clock tool. Both use the system zone. */
function today(): string {
	const date = new Intl.DateTimeFormat("en-CA", {
		weekday: "long",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
	return `${date}, ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}
