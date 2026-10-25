// June's system prompt: SOUL.md, operating rules, and the shared skills, read in place from Jon's skill directories.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { Config } from "./config.ts";

const OPERATING = `How you work:
- Jon reaches you from a terminal client and from Telegram. It is one conversation. Terminal messages start with [kitty] or [cli]; untagged messages come from Telegram, where answers should stay compact Markdown without tables.
- Org files under ~/org are the authority for tasks, projects, notes, and long-term facts. Herdr is the authority for live agent sessions. This transcript is short-term continuity only, so look facts up with your tools instead of trusting memory, and verify anything with a date against Org.
- Task states are TODO (not started), PROG (in progress), EVAL (waiting for Jon's review), HOLD (blocked or waiting), and DONE. AUTO marks a task for the org-dispatch dispatcher, which starts a Pi agent in Herdr on the host named by the task's tag (kit, cog, or lux). Only Jon sets AUTO.
- To answer what an agent is doing, inspect Herdr. To start new work, find or describe the Org task and ask Jon to queue it; do not invent a second dispatcher.
- A Herdr status of idle or done means the terminal settled, not that the task succeeded. Read the output and the task's Org state before reporting success.
- You have only the tools listed. You have no shell. When a tool cannot do something, say so and suggest how Jon can.
- Never claim an edit, message, or prompt happened until its tool result confirms it. A tool call interrupted by a restart may already have taken effect, so check the current state before repeating it.`;

/** `render` re-reads `path` only when its size or mtime changes, so the prompt text stays stable for caching. */
function cachedFile(path: string, missing: string): () => Promise<string> {
	let cached: { stamp: string; text: string } | undefined;
	return async () => {
		const info = await stat(path).catch(() => undefined);
		if (info === undefined) return missing;
		const stamp = `${info.mtimeMs}:${info.size}`;
		if (cached?.stamp !== stamp) cached = { stamp, text: (await readFile(path, "utf8")).trim() };
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
		"Jon's skills describe his conventions and procedures. When a request matches one, read it with skill_read first and follow what applies. They were written for agents with a shell, so use only the tools you have and tell Jon when a step needs one you lack.",
		...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
	].join("\n");
}

export function createPromptExtension(config: Config): Extension {
	const soul = cachedFile(config.soulFile, "You are June, Jon's personal assistant.");
	let skills: Promise<Skill[]> | undefined;
	const loadSkills = () => (skills ??= findSkills(config.skillDirs));

	const skillRead = defineTool({
		name: "skill_read",
		description: "Read one of Jon's skills: its SKILL.md, or another file inside that skill's directory.",
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
		description: "The current local date and time in Calgary.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async () => ({
			output: [
				{
					type: "text",
					text: new Date().toLocaleString("en-CA", { timeZone: "America/Edmonton", dateStyle: "full", timeStyle: "long" }),
				},
			],
		}),
	});

	return defineExtension({
		name: "june",
		sections: [
			section("soul", () => soul(), { tag: false }),
			section("operating", () => OPERATING, { tag: false }),
			section("skills", async () => skillsSection(await loadSkills())),
			section("today", () => today()),
		],
		tools: [skillRead, clock],
	});
}

/** The date changes the prompt once a day; the exact time comes from the clock tool. */
function today(): string {
	const date = new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/Edmonton",
		weekday: "long",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
	return `${date}, America/Edmonton`;
}
