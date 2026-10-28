// Read-only Org tools. Search runs ripgrep; context comes from heading lines alone. These tools never parse or write
// Org structure themselves: changes go through org-edit and org-dispatch, which run Org in Emacs.
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { type Run, runProcess } from "./herdr.ts";

const STATES = ["TODO", "AUTO", "PROG", "EVAL", "HOLD", "DONE"] as const;
const HEADING = /^(\*+)\s+(?:(TODO|AUTO|PROG|EVAL|HOLD|DONE)\s+)?(?:\[#[A-Z]\]\s+)?(.*?)(?:\s+(:[\w@#%:]+:))?\s*$/;
const HERDR_LINK = /herdr:([a-z0-9-]+)\/([a-z]+):([0-9a-f-]{36})(?:@([A-Za-z0-9:]+))?/g;

export type Heading = { line: number; level: number; state?: string; title: string; tags: string[] };

export function parseHeading(text: string, line: number): Heading | undefined {
	const match = HEADING.exec(text);
	if (match === null) return undefined;
	return {
		line,
		level: match[1]!.length,
		...(match[2] ? { state: match[2] } : {}),
		title: match[3]!,
		tags: match[4] ? match[4].split(":").filter(Boolean) : [],
	};
}

/** Every heading's title in an Org text. */
function headingTitles(text: string): string[] {
	return text.split("\n").flatMap((line, i) => {
		const heading = line.startsWith("*") ? parseHeading(line, i + 1) : undefined;
		return heading === undefined ? [] : [heading.title];
	});
}

/** The headings enclosing `line` (1-based), outermost first. */
export function outline(lines: readonly string[], line: number): Heading[] {
	const path: Heading[] = [];
	let level = Number.POSITIVE_INFINITY;
	for (let i = line - 1; i >= 0 && level > 1; i--) {
		const heading = lines[i]!.startsWith("*") ? parseHeading(lines[i]!, i + 1) : undefined;
		if (heading !== undefined && heading.level < level) {
			path.unshift(heading);
			level = heading.level;
		}
	}
	return path;
}

/** Heading at `line` through the line before the next heading of the same or a higher level. */
export function subtree(lines: readonly string[], line: number): { start: number; end: number } {
	const heading = parseHeading(lines[line - 1] ?? "", line);
	if (heading === undefined) throw new Error(`Line ${line} is not a heading`);
	let end = line;
	while (end < lines.length) {
		const next = lines[end]!.startsWith("*") ? parseHeading(lines[end]!, end + 1) : undefined;
		if (next !== undefined && next.level <= heading.level) break;
		end++;
	}
	return { start: line, end };
}

/**
 * The line of the one heading `heading` names: a line number, id:UUID, an exact title (any case), or an outline path
 * such as "Trinity / Pickup" matched from its end, as org-edit accepts.
 */
export function locate(lines: readonly string[], heading: string | number, file: string): number {
	if (typeof heading === "number") return heading;
	let found: number[];
	if (heading.startsWith("id:")) {
		const id = heading.slice(3).trim();
		const at = lines.findIndex((l) => new RegExp(`^\\s*:ID:\\s+${id.replace(/[^\w-]/g, "")}\\s*$`, "i").test(l));
		const owner = at < 0 ? undefined : outline(lines, at + 1).at(-1)?.line;
		found = owner === undefined ? [] : [owner];
	} else {
		const headings = lines.map((text, i) => (text.startsWith("*") ? parseHeading(text, i + 1) : undefined)).filter((h): h is Heading => h !== undefined);
		const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
		found = headings.filter((h) => same(h.title, heading)).map((h) => h.line);
		const parts = heading.split(" / ");
		if (found.length === 0 && parts.length > 1)
			found = headings
				.filter((h) => {
					const path = outline(lines, h.line).map((o) => o.title);
					return path.length >= parts.length && parts.every((part, i) => same(path[path.length - parts.length + i]!, part));
				})
				.map((h) => h.line);
	}
	if (found.length === 0) throw new Error(`No heading ${JSON.stringify(heading)} in ${file}`);
	if (found.length > 1) throw new Error(`"${heading}" matches ${found.length} headings in ${file}; name it by outline path, such as "Parent / ${heading}", or by line number`);
	return found[0]!;
}

export function herdrLinks(text: string) {
	return [...text.matchAll(HERDR_LINK)].map((m) => ({
		link: m[0],
		host: m[1]!,
		agent: m[2]!,
		session: m[3]!,
		...(m[4] ? { pane: m[4] } : {}),
	}));
}

const EXCLUDE = ["!archive.org", "!**/archive/**", "!*.sync-conflict-*", "!**/.stversions/**"];

export class Org {
	readonly #root: string;
	readonly #run: Run;

	constructor(root: string, run: Run = runProcess) {
		this.#root = root;
		this.#run = run;
	}

	/** An Org file inside the root, given relative to it or absolute. */
	async file(path: string): Promise<string> {
		const root = await realpath(this.#root);
		const full = await realpath(path.startsWith("/") ? path : join(root, path)).catch(() => undefined);
		if (full === undefined) throw new Error(`No such Org file: ${path}`);
		const inside = relative(root, full);
		if (inside.startsWith("..") || !full.endsWith(".org")) throw new Error(`${path} is not an Org file under ${this.#root}`);
		return full;
	}

	rel(path: string): string {
		return relative(this.#root, path);
	}

	/** ripgrep matches as { path, line, text }. Exit status 1 (no matches) is an empty result. */
	async grep(pattern: string, options: { fixed?: boolean; dir?: string; limit?: number } = {}) {
		const argv = ["rg", "--json", "--ignore-case", "--max-count", "50", "--glob", "*.org"];
		for (const glob of EXCLUDE) argv.push("--glob", glob);
		if (options.fixed !== false) argv.push("--fixed-strings");
		argv.push("--", pattern, options.dir ?? this.#root);
		// Exit 1 is no match; exit 2 with output means some files were unreadable but others matched.
		const out = await this.#run(argv, 20_000).catch((error: Error & { exitCode?: number; stdout?: string }) => {
			if (error.exitCode === 1) return "";
			if (error.exitCode === 2 && error.stdout) return error.stdout;
			throw error;
		});
		const hits: { path: string; line: number; text: string }[] = [];
		for (const line of out.split("\n")) {
			if (!line.startsWith('{"type":"match"')) continue;
			const data = JSON.parse(line).data;
			hits.push({ path: data.path.text, line: data.line_number, text: data.lines.text.trimEnd() });
			if (hits.length >= (options.limit ?? 200)) break;
		}
		return hits;
	}

	async lines(path: string): Promise<string[]> {
		return (await readFile(path, "utf8")).split("\n");
	}

	/** Project records only, not client files, task material, or archives. Preambles include repository mappings. */
	/**
	 * Projects whose name, preamble, or task headings (archived ones included) hold a word of `query`, best match first.
	 * A topic such as "Hyprland" finds the project that has worked on it before, even when its name says otherwise.
	 */
	async projects(query = "", limit = 100) {
		const work = join(this.#root, "work");
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		const results: { file: string; preamble: string; headings?: string[]; named: number; hits: number[] }[] = [];
		const domains = await readdir(work, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		for (const domain of domains) {
			if (!domain.isDirectory() || domain.name.startsWith(".") || domain.name === "archive") continue;
			for (const project of await readdir(join(work, domain.name), { withFileTypes: true })) {
				if (!project.isDirectory() || project.name.startsWith(".") || project.name === "archive") continue;
				const file = join("work", domain.name, project.name, `${project.name}.org`);
				if (file.includes(".sync-conflict-")) continue;
				const path = await this.file(file).catch(() => undefined);
				if (path === undefined) continue;
				const content = await readFile(path, "utf8");
				const preamble = content.split(/^\* /m, 1)[0]!.trim();
				if (words.length === 0) {
					results.push({ file, preamble, named: 0, hits: [] });
					continue;
				}
				const preambleText = preamble.toLowerCase();
				const archive = await readFile(join(dirname(path), "archive.org"), "utf8").catch(() => "");
				const all = [...new Set([...headingTitles(content), ...headingTitles(archive).map((title) => `${title} (archived)`)])];
				// The project's own name ranks first; a preamble match, such as a repository link, counts as ten headings.
				const named = words.filter((word) => file.toLowerCase().includes(word)).length;
				const hits = words.map((word) => (preambleText.includes(word) ? 10 : 0) + all.filter((title) => title.toLowerCase().includes(word)).length);
				if (named === 0 && hits.every((n) => n === 0)) continue;
				const titles = all.filter((title) => words.some((word) => title.toLowerCase().includes(word)));
				results.push({ file, preamble, ...(titles.length > 0 ? { headings: titles.slice(0, 3) } : {}), named, hits });
			}
		}
		// A word few projects share says more than a common one, so each word's hits weigh by its rarity.
		const spread = words.map((_, i) => Math.max(1, results.filter((r) => r.hits[i]! > 0).length));
		const score = (r: (typeof results)[number]) => r.hits.reduce((sum, n, i) => sum + n / spread[i]!, 0);
		results.sort((a, b) => b.named - a.named || score(b) - score(a));
		return { projects: results.slice(0, limit).map(({ named: _, hits: __, ...project }) => project), total: results.length };
	}

	/** Matches grouped under their nearest enclosing heading. */
	async search(query: string, scope: string, limit: number) {
		const dir = scope === "all" ? this.#root : await this.file(scope).catch(() => join(this.#root, scope));
		const hits = await this.grep(query, { dir, limit: limit * 4 });
		const results = new Map<string, any>();
		const cache = new Map<string, string[]>();
		for (const hit of hits) {
			const lines = cache.get(hit.path) ?? (await this.lines(hit.path));
			cache.set(hit.path, lines);
			const path = outline(lines, hit.line);
			const heading = path.at(-1);
			const key = `${hit.path}:${heading?.line ?? 0}`;
			const result = results.get(key) ?? {
				file: this.rel(hit.path),
				...(heading ? { heading: heading.title, line: heading.line, state: heading.state, tags: heading.tags } : {}),
				outline: path.map((h) => h.title).join(" / "),
				matches: [],
			};
			if (result.matches.length < 3) result.matches.push(`${hit.line}: ${hit.text.slice(0, 200)}`);
			results.set(key, result);
			if (results.size >= limit) break;
		}
		return [...results.values()];
	}

	async tasks(states: readonly string[], scope: string, limit: number) {
		const dir = scope === "all" ? this.#root : join(this.#root, scope);
		const pattern = `^\\*+ (${states.join("|")}) `;
		const hits = await this.grep(pattern, { fixed: false, dir, limit: 2000 });
		return hits.slice(0, limit).map((hit) => {
			const heading = parseHeading(hit.text, hit.line)!;
			return { file: this.rel(hit.path), line: hit.line, state: heading.state, title: heading.title, tags: heading.tags };
		});
	}

	async read(file: string, heading: string | number) {
		const path = await this.file(file);
		const lines = await this.lines(path);
		const line = locate(lines, heading, file);
		const { start, end } = subtree(lines, line);
		const text = lines.slice(start - 1, end).join("\n");
		return {
			file: this.rel(path),
			line: start,
			outline: outline(lines, start).map((h) => h.title).join(" / "),
			herdrSessions: herdrLinks(text),
			text: text.length > 30_000 ? `${text.slice(0, 30_000)}\n[truncated; ${end - start + 1} lines]` : text,
		};
	}

	/** The heading that owns `:ID: id`, with its state and subtree; undefined when no live Org file has it. */
	async byId(id: string) {
		if (!/^[0-9A-Za-z-]{8,64}$/.test(id)) throw new Error("Invalid Org ID");
		const [hit] = await this.grep(`^\\s*:ID:\\s+${id}\\s*$`, { fixed: false, limit: 1 });
		if (hit === undefined) return undefined;
		const lines = await this.lines(hit.path);
		const heading = outline(lines, hit.line).at(-1);
		if (heading === undefined) return undefined;
		const { start, end } = subtree(lines, heading.line);
		const text = lines.slice(start - 1, end).join("\n");
		return { file: this.rel(hit.path), line: start, state: heading.state, title: heading.title, herdrSessions: herdrLinks(text) };
	}

	/** Org headings that link a Herdr session id. */
	async sessionTasks(session: string) {
		if (!/^[0-9a-f-]{8,36}$/.test(session)) throw new Error("Session id must be hex");
		const hits = await this.grep(`herdr:[a-z0-9-]+/[a-z]+:${session}`, { fixed: false, limit: 20 });
		const out = [];
		for (const hit of hits) {
			const heading = outline(await this.lines(hit.path), hit.line).find((h) => h.level === 1) ?? undefined;
			out.push({ file: this.rel(hit.path), line: hit.line, task: heading?.title, state: heading?.state });
		}
		return out;
	}
}

function json(value: unknown) {
	return { output: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}

export function createOrgExtension(config: Config, org = new Org(config.org.root), run: Run = runProcess): Extension {
	const scope = Type.Optional(
		Type.String({ description: 'Directory or file under ~/org, such as "work", "life", or "work/acme/site"; default "all"' }),
	);
	return defineExtension({
		name: "org",
		tools: [
			defineTool({
				name: "org_projects",
				description: "Find existing projects under ~/org/work before choosing where to file a task. Returns project paths and preambles, including local and GitHub repository links, best match first. Each word of query is matched against project names, repository links, and task headings, archived ones included, so a topic finds the project that worked on it before; matching headings are listed. Omit query to list projects. Does not scan task bodies or material.",
				parameters: Type.Object({
					query: Type.Optional(Type.String()),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "Default 100; total reports whether more match" })),
				}),
				replay: "safe",
				execute: async (args) => json(await org.projects(args.query, args.limit)),
			}),
			defineTool({
				name: "org_search",
				description:
					"Search the user's Org files (not archives) for text. Returns each matching heading with its outline path, TODO state, tags, and matching lines.",
				parameters: Type.Object({
					query: Type.String({ minLength: 2 }),
					scope,
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Default 15" })),
				}),
				replay: "safe",
				execute: async (args) => json(await org.search(args.query, args.scope ?? "all", args.limit ?? 15)),
			}),
			defineTool({
				name: "org_tasks",
				description: "List Org headings in the given TODO states, such as active work (PROG, EVAL, HOLD) or queued AUTO tasks.",
				parameters: Type.Object({
					states: Type.Array(Type.Union(STATES.map((s) => Type.Literal(s))), { minItems: 1 }),
					scope,
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "Default 100" })),
				}),
				replay: "safe",
				execute: async (args) => json(await org.tasks(args.states, args.scope ?? "all", args.limit ?? 100)),
			}),
			defineTool({
				name: "org_read_task",
				description:
					"Read one Org heading with its whole subtree: scope, checklist, dialog, and linked Herdr sessions. Name it by line number, exact title, or id:UUID.",
				parameters: Type.Object({
					file: Type.String({ description: "Path under ~/org, as org_search returns it" }),
					heading: Type.Union([Type.Integer({ minimum: 1 }), Type.String()]),
				}),
				replay: "safe",
				execute: async (args) => json(await org.read(args.file, args.heading)),
			}),
			defineTool({
				name: "org_session_task",
				description: "Find the Org task that links a Herdr agent session, by its session id.",
				parameters: Type.Object({ session: Type.String() }),
				replay: "safe",
				execute: async (args) => json(await org.sessionTasks(args.session)),
			}),
			defineTool({
				name: "org_dispatch_scan",
				description: "Show which AUTO tasks the dispatcher on this machine would launch now (new, resume, or settling). Read-only.",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async () => {
					const out = await run(["org-dispatch", "scan"], 60_000);
					return { output: [{ type: "text", text: out.trim() || "Nothing to launch." }] };
				},
			}),
		],
	});
}
