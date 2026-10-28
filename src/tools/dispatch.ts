// Queue new AUTO tasks for org-dispatch, and nudge this host's dispatcher. June writes the heading as text, as agents
// do; resuming existing headings goes through org-edit. The dispatcher, not June, launches the work.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { type Config, expandHome } from "../config.ts";
import { type Run, runProcess } from "./herdr.ts";
import { createFollowTask, FOLLOW_DEFAULTS, type FollowOptions, follow } from "./follow.ts";
import type { Herdr } from "./herdr.ts";
import { type Org, parseHeading } from "./org.ts";
import { User, user } from "../user.ts";

export type QueueRequest = {
	file: string;
	title: string;
	body: string;
	host: string;
	dir?: string;
	review: boolean;
	/** Stable across a tool's replay, so a rerun finds its own heading instead of writing a second one. */
	key: string;
};

/** The heading text June writes: keyword, title, one host tag, a property drawer, then the body. */
export function renderTask(request: QueueRequest, id: string): string {
	const properties = [`:ID: ${id}`, `:JUNE_REQUEST: ${request.key}`];
	if (request.dir) properties.push(`:DIR: ${request.dir}`);
	if (!request.review) properties.push(":REVIEW: no");
	const body = request.body.trim();
	return [`* AUTO ${request.title} :${request.host}:`, ":PROPERTIES:", ...properties, ":END:", ...(body ? [body] : []), ""].join("\n");
}

export function checkRequest(request: QueueRequest, hosts: readonly string[]): void {
	if (!hosts.includes(request.host)) throw new Error(`June may queue only for ${hosts.join(", ")}; ${request.host} has no dispatcher she may use`);
	if (/[\n\r]/.test(request.title) || request.title.trim() !== request.title || request.title === "")
		throw new Error("The title is one line without surrounding spaces");
	if (/^(TODO|AUTO|PROG|EVAL|HOLD|DONE)\b/.test(request.title) || /\s:[\w@#%:]+:$/.test(request.title))
		throw new Error("The title must not carry a keyword or tags");
	// Second-level headings and below are fine; a first-level one would split the task in two.
	if (/^\* /m.test(request.body)) throw new Error("The body must not contain a first-level heading");
	if (/^\s*:(PROPERTIES|END):/m.test(request.body)) throw new Error("The body must not contain a property drawer");
	if (request.dir !== undefined && !request.dir.startsWith("/") && !request.dir.startsWith("~/"))
		throw new Error("dir is an absolute or ~/ path");
}

export type TaskParts = { reason: string; scope: string; checklist: readonly string[] };

/**
 * The body June writes, built here rather than by the model so it always has the same shape: who queued it and why
 * (the dispatcher tells the agent the user set the AUTO), then Scope and a checkbox Checklist.
 */
export function taskBody(parts: TaskParts): string {
	const line = (text: string, what: string) => {
		const flat = text.trim();
		if (flat === "" || /[\n\r]/.test(flat)) throw new Error(`${what} is one non-empty line`);
		return flat;
	};
	const scope = parts.scope.trim().replace(/\n{3,}/g, "\n\n");
	if (scope === "") throw new Error("scope is required");
	if (parts.checklist.length === 0) throw new Error("checklist needs at least one item");
	const items = parts.checklist.map((item) => `- [ ] ${line(item, "Each checklist item").replace(/^-\s*(\[[ X]\]\s*)?/, "")}`);
	return [`Queued by June: ${line(parts.reason, "reason")}`, "", "** Scope", scope, "", "** Checklist", ...items].join("\n");
}

/** Insert `text` before the first heading, newest first, as project files keep their threads. */
export function insertAfterPreamble(content: string, text: string): string {
	const first = /^\* /m.exec(content);
	if (first === null) return `${content.replace(/\n*$/, "\n\n")}${text}`;
	const before = content.slice(0, first.index).replace(/\n*$/, "");
	return `${before ? `${before}\n\n` : ""}${text}\n${content.slice(first.index)}`;
}

/**
 * An agenda Org file June may write: never asana.org (rebuilt from Asana), the inbox, archives, or a file with a
 * Syncthing conflict copy beside it, and only files on the agenda, where the dispatcher and the user's phone see them.
 */
export async function writable(org: Org, config: Config, file: string): Promise<string> {
	const path = await org.file(file);
	const name = basename(path);
	const rel = org.rel(path);
	if (name === "asana.org" || name === "inbox.org" || name === "archive.org" || /(^|\/)archive\//.test(rel) || name.includes(".sync-conflict-"))
		throw new Error(`June does not write ${rel}`);
	const siblings = await readdir(dirname(path));
	if (siblings.some((f) => f.startsWith(name.replace(/\.org$/, ".sync-conflict-"))))
		throw new Error(`${rel} has a Syncthing conflict copy beside it; the user should resolve it first`);
	const agenda = await readFile(config.org.agendaFiles, "utf8").catch(() => {
		throw new Error(`No agenda list at ${config.org.agendaFiles}; the dispatcher has not run on this host`);
	});
	if (!agenda.split("\n").includes(path)) throw new Error(`${rel} is not an agenda file, so neither the dispatcher nor the agenda would see it`);
	return path;
}

export type ProjectRequest = {
	domain: string;
	project: string;
	title: string;
	github?: string;
	dir?: string;
};

export type ResumeRequest = {
	file: string;
	heading: string;
	expected: "TODO" | "EVAL" | "HOLD";
	host: string;
	note: string;
	key: string;
};

export class Dispatch {
	readonly #org: Org;
	readonly #config: Config;
	readonly #run: Run;

	constructor(org: Org, config: Config, run: Run = runProcess) {
		this.#org = org;
		this.#config = config;
		this.#run = run;
	}

	#target(file: string): Promise<string> {
		return writable(this.#org, this.#config, file);
	}

	/** Create metadata only, then refresh the dispatcher's agenda before any task can be queued here. */
	async createProject(request: ProjectRequest) {
		// Some model calls send empty strings for omitted optional fields.
		request = { ...request, github: request.github || undefined, dir: request.dir || undefined };
		for (const segment of [request.domain, request.project]) {
			if (!/^[a-z0-9][a-z0-9._-]*$/i.test(segment) || segment === "archive" || segment.includes(".sync-conflict-"))
				throw new Error("domain and project must be plain directory names, not archive or conflict paths");
		}
		if (!request.title.trim() || /[\n\r]/.test(request.title)) throw new Error("Project title is one non-empty line");
		if (request.github !== undefined && !/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(request.github))
			throw new Error("github must be https://github.com/owner/repo without .git");
		if (request.github?.endsWith(".git")) throw new Error("Omit .git from github");
		if (request.dir !== undefined) {
			if ((!request.dir.startsWith("/") && !request.dir.startsWith("~/")) || /[\n\r\[\]]/.test(request.dir))
				throw new Error("dir must be an absolute or ~/ path usable in an Org link");
			if (!(await stat(expandHome(request.dir)).catch(() => undefined))?.isDirectory())
				throw new Error(`dir ${request.dir} is not a directory`);
		}
		const root = await realpath(this.#config.org.root);
		let directory = root;
		for (const segment of ["work", request.domain, request.project]) {
			directory = join(directory, segment);
			await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
			});
			directory = await realpath(directory);
			if (relative(root, directory).startsWith("..")) throw new Error("Project directory leaves the Org root");
		}
		const file = join("work", request.domain, request.project, `${request.project}.org`);
		const path = join(directory, `${request.project}.org`);
		const siblings = await readdir(directory);
		if (siblings.some((name) => name.startsWith(`${request.project}.sync-conflict-`)))
			throw new Error(`${file} has a Syncthing conflict copy beside it; the user should resolve it first`);
		const links = [
			...(request.dir ? [`[[file:${request.dir.replace(/\/$/, "")}/][local]]`] : []),
			...(request.github ? [`[[${request.github}][GitHub]]`] : []),
		];
		const preamble = `#+TITLE: ${request.title.trim()}\n#+CATEGORY: ${request.project.slice(0, 10)}\n`
			+ (links.length ? `\nRepositories:\n- ${request.project}: ${links.join(" | ")}\n` : "");
		const created = await writeFile(path, preamble, { flag: "wx" }).then(() => true, (error: NodeJS.ErrnoException) => {
			if (error.code === "EEXIST") return false;
			throw error;
		});
		// scan refreshes the cache without launching work. If discovery fails, keep the empty record for a retry.
		await this.#run(["org-dispatch", "scan"], 60_000);
		await this.#target(file);
		return { file, created, directory: dirname(await this.#org.file(file)) };
	}

	/** Write the task once. A replay with the same key returns the heading it already wrote. */
	async queue(request: QueueRequest) {
		checkRequest(request, this.#config.dispatch.hosts);
		if (request.dir !== undefined) {
			const dir = await stat(expandHome(request.dir)).catch(() => undefined);
			if (!dir?.isDirectory()) throw new Error(`dir ${request.dir} is not a directory; use one of the project's repository links`);
		}
		const path = await this.#target(request.file);
		for (let attempt = 0; attempt < 3; attempt++) {
			const before = await stat(path);
			const content = await readFile(path, "utf8");
			const existing = new RegExp(`^:JUNE_REQUEST: ${request.key}$`, "m").exec(content);
			if (existing !== null) return { file: this.#org.rel(path), written: false, ...this.#located(content, existing.index) };
			const id = randomUUID();
			const next = insertAfterPreamble(content, renderTask(request, id));
			// Replace only if nobody (Emacs, Syncthing) changed the file since it was read.
			if ((await stat(path)).mtimeMs !== before.mtimeMs) continue;
			const temp = join(dirname(path), `.${basename(path)}.june-${process.pid}`);
			await writeFile(temp, next, { mode: before.mode & 0o777 });
			await rename(temp, path);
			return { file: this.#org.rel(path), written: true, id, heading: `AUTO ${request.title} :${request.host}:` };
		}
		throw new Error(`${this.#org.rel(path)} kept changing; try again shortly`);
	}

	/** Resume the same heading, with Org applying the state, tags, and Dialog entry in one save. */
	async resume(request: ResumeRequest, herdr: Herdr) {
		if (!this.#config.dispatch.hosts.includes(request.host)) throw new Error(`No allowed dispatcher on ${request.host}`);
		if (!["TODO", "EVAL", "HOLD"].includes(request.expected)) throw new Error("Only TODO, EVAL, or HOLD tasks can resume");
		if (!request.note.trim() || /[\n\r]/.test(request.note)) throw new Error(`note must be one non-empty line recording ${user()}'s instruction`);
		const path = await this.#target(request.file);
		const task = await this.#org.read(request.file, request.heading);
		const properties = task.text.split(/\n\*+ /, 1)[0]!;
		const replay = properties.split("\n").some((line) => line.trim() === `:JUNE_REQUEST: ${request.key}`);
		if (!replay) {
			for (const host of new Set(task.herdrSessions.map((session) => session.host))) {
				const agents = await herdr.agents(host);
				if (agents.some((agent) => ["working", "blocked"].includes(agent.status) && task.herdrSessions.some((session) => session.host === host && session.session === agent.session)))
					throw new Error(`The task still has an active agent on ${host}; wait for it to finish`);
			}
		}
		const out = await this.#run([
			"org-edit", "todo", path, request.heading, "AUTO", "--expect", request.expected,
			"--request", request.key, "--host", request.host, "--note", request.note.trim(),
		], 60_000);
		try {
			const result = JSON.parse(out) as { id: string; title: string; host: string; written: boolean };
			return { ...result, file: this.#org.rel(path) };
		} catch (cause) {
			throw new Error("org-edit did not return a resume result; check the installed org-edit version", { cause });
		}
	}

	/** Close a task June created, after she reviews its outcome. Org supplies CLOSED and logging. */
	async complete(file: string, heading: string) {
		const path = await this.#target(file);
		const task = await this.#org.read(file, heading);
		const own = task.text.split(/\n\*+ /, 1)[0]!;
		const id = /^:ID: (.+)$/m.exec(own)?.[1];
		if (!id || !/^:JUNE_REQUEST: .+$/m.test(own) || !/^Queued by June: .+$/m.test(own))
			throw new Error("June may close only tasks she created, not tasks she merely resumed");
		const state = parseHeading(task.text.split("\n")[0]!, task.line)?.state;
		if (state !== "EVAL" && state !== "DONE") throw new Error(`Expected EVAL, found ${state ?? "no state"}; read the task again`);
		if (state === "DONE") return { file: task.file, id, state, written: false };
		await this.#run(["org-edit", "todo", path, `id:${id}`, "DONE", "--expect", "EVAL"], 60_000);
		return { file: task.file, id, state: "DONE", written: true };
	}

	#located(content: string, index: number) {
		const head = content.slice(0, index).lastIndexOf("\n* ");
		const line = content.slice(head + 1).split("\n")[0];
		const id = /^:ID: (.+)$/m.exec(content.slice(head + 1))?.[1];
		return { heading: line?.replace(/^\* /, ""), ...(id ? { id } : {}) };
	}

	/** Run this host's dispatcher now, the same unit its timer starts, then report what it would launch. */
	async nudge(): Promise<string> {
		await this.#run(["systemctl", "--user", "start", "org-dispatch.service"], 300_000);
		const scan = await this.#run(["org-dispatch", "scan"], 60_000);
		return scan.trim() || "Nothing waiting to launch.";
	}

	/** Start this host's dispatcher without waiting for it, so a task June just wrote launches now. */
	async kick(): Promise<void> {
		await this.#run(["systemctl", "--user", "start", "--no-block", "org-dispatch.service"], 30_000);
	}
}

/** One id per state directory, so request keys stay unique if the database is ever recreated. */
export function instanceId(stateDir: string): string {
	const file = join(stateDir, "instance");
	if (!existsSync(file)) writeFileSync(file, `${randomUUID()}\n`, { mode: 0o600 });
	return readFileSync(file, "utf8").trim();
}

export function createDispatchExtension(
	config: Config,
	org: Org,
	herdr: Herdr,
	instance: string,
	run: Run = runProcess,
	followOptions: FollowOptions = FOLLOW_DEFAULTS,
): Extension {
	const dispatch = new Dispatch(org, config, run);
	const followTask = createFollowTask(org, herdr, followOptions);
	const hosts = config.dispatch.hosts;
	return defineExtension({
		name: "dispatch",
		tasks: [followTask],
		tools: [
			defineTool({
				name: "org_create_project",
				description: "Create ~/org/work/<domain>/<project>/<project>.org with a title, category, and optional repository links, then confirm dispatcher agenda discovery. First use org_projects and search for an existing project. Honor a destination the user names. Otherwise GitHub owner/repo guides domain/project for a new repo project; unmatched work and clear one-offs go under domain june with a short descriptive project name. Never overwrite an existing record. This tool queues no work; use org_queue_task afterward.",
				parameters: Type.Object({
					domain: Type.String({ description: "Existing logical domain, GitHub owner for a new repo project, or june for unmatched work and one-offs" }),
					project: Type.String({ description: "Short directory name; GitHub repository name when it fits" }),
					title: Type.String({ description: "Human-readable project title, one line" }),
					github: Type.Optional(Type.String({ description: "Repository this project actually concerns, as https://github.com/owner/repo without .git; omit or leave empty for unrelated one-offs" })),
					dir: Type.Optional(Type.String({ description: "Existing checkout this project actually concerns, absolute or ~/ path; omit or leave empty for work without one" })),
				}),
				replay: "safe",
				execute: async (args) => ({ output: [{ type: "text", text: JSON.stringify(await dispatch.createProject(args), null, 1) }] }),
			}),
			defineTool({
				name: "org_queue_task",
				description: `Queue new work for an unattended Pi agent: write a new AUTO heading with one host tag (${hosts.join(", ")}) into an Org agenda file. The dispatcher on that host launches it, and this tool starts the one on this host right away, and the agent ends at EVAL for review by you or the user unless review is explicitly waived. You then follow it: a [follow] message tells you when it fails to launch, blocks, holds, or finishes. Search for an existing task and use org_projects to find its project first. If no project fits, use org_create_project before queueing. The tool writes the body from reason, scope, and checklist.`,
				parameters: Type.Object({
					file: Type.String({ description: "Org file under ~/org, usually the project's <project>.org" }),
					title: Type.String({ description: "Concise verb-led heading title, without keyword or tags" }),
					reason: Type.String({ description: 'One line, written after "Queued by June: ": the reason itself, naming the user rather than writing "you", such as `${User()} asked for a read-only docs check.`' }),
					scope: Type.String({ description: "Outcome, constraints, and success criteria in Org; one physical line per paragraph" }),
					checklist: Type.Array(Type.String(), { minItems: 1, description: "Steps for the agent, one line each, without dashes or boxes" }),
					host: Type.String({ description: `Machine whose dispatcher runs it: ${hosts.join(", ")}; default ${hosts[0]}` }),
					dir: Type.Optional(Type.String({ description: "Existing working directory override, usually one of the project's local repository links. Omit for one-offs without a checkout: the dispatcher uses the project directory" })),
					review: Type.Optional(Type.Boolean({ description: `Default true: the worker stops at EVAL for human or agent review, including read-only lookups you will review yourself. Set false only when ${user()} explicitly waives review` })),
				}),
				// Idempotent by key: a rerun after a restart finds the heading it wrote.
				replay: "safe",
				execute: async (args, api, context) => {
					const { reason, scope, checklist, ...rest } = args;
					const result = await dispatch.queue({
						...rest,
						body: taskBody({ reason, scope, checklist }),
						review: args.review ?? true,
						key: `${instance}:${api.taskId}`,
					});
					// Follow it, once, whether this call wrote the heading or a replay found it.
					if (result.id !== undefined) {
						const input = { id: result.id, title: args.title, host: args.host, queuedAt: Date.now() };
						await api.commit((tx) => follow(tx, followTask, input, Number(api.conversationId)), context);
					}
					// The dispatcher launches headings June wrote without settling, so start it now instead of waiting a minute.
					let started = "";
					if (result.written && args.host === config.herdr.host)
						started = await dispatch.kick().then(
							() => " The dispatcher was started and launches it now.",
							(error: Error) => ` Starting the dispatcher failed (${error.message}); its timer runs within a minute.`,
						);
					const note = `You are following this task and will get [follow] messages when it fails to launch, blocks, holds, or finishes.${started} Tell the user you will report back.`;
					return { output: [{ type: "text", text: `${JSON.stringify(result, null, 1)}\n${note}` }] };
				},
			}),
			defineTool({
				name: "org_resume_task",
				description: "When the user explicitly asks to start or resume an existing task, change TODO, EVAL, or HOLD to AUTO through org-edit. Read the task and Dialog first. Preserve its ID, scope, history, directory, and schedule; record the user's instruction in Dialog, set review on and deploy off, and select one host. Refuse an active agent. Start this host's dispatcher and follow the task, including another run after EVAL. Never create a duplicate task to resume work.",
				parameters: Type.Object({
					file: Type.String({ description: "Org agenda file under ~/org" }),
					heading: Type.String({ description: "Exact title or id:UUID, as org_read_task accepts" }),
					expected: Type.Union([Type.Literal("TODO"), Type.Literal("EVAL"), Type.Literal("HOLD")], { description: "Current state just read; a stale request is refused" }),
					host: Type.String({ description: `Keep the existing host unless the user changes it; otherwise default ${hosts[0]}. Allowed: ${hosts.join(", ")}` }),
					note: Type.String({ description: `One line recording ${user()}'s request and any answer or revised scope, naming ${user()} rather than writing you` }),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const key = `${instance}:${api.taskId}`;
					const result = await dispatch.resume({ ...args, key }, herdr);
					await api.commit((tx) => follow(tx, followTask, {
						id: result.id, title: result.title, host: result.host, queuedAt: Date.now(), request: key,
					}, Number(api.conversationId)), context);
					// A repeated kick is harmless, including recovery after a crash between the save and kick.
					const started = args.host === config.herdr.host
						? await dispatch.kick().then(
							() => " The dispatcher was started; it launches when eligible.",
							(error: Error) => ` Starting the dispatcher failed (${error.message}); its timer will retry.`,
						)
						: " That host's dispatcher will pick it up on its timer.";
					return { output: [{ type: "text", text: `${JSON.stringify(result, null, 1)}\nYou are following this task and will get [follow] reports.${started} Tell the user you will report back. Existing SCHEDULED dates still apply.` }] };
				},
			}),
			defineTool({
				name: "org_complete_task",
				description: `After reading the whole task, outcome, and verification evidence, mark your own EVAL task DONE through org-edit. Use only when the request is satisfied and no decision, approval, or review from ${user()} remains. You must have created the task; merely resuming ${user()}'s task does not make it yours. Leave incomplete or uncertain work, and work needing ${user()}'s review, at EVAL and report what remains. Report the reviewed result to ${user()} after closing. Refuses other states; an already DONE task is unchanged on replay.`,
				parameters: Type.Object({
					file: Type.String({ description: "Org agenda file under ~/org" }),
					heading: Type.String({ description: "Exact title or id:UUID of the EVAL task you just reviewed" }),
				}),
				replay: "safe",
				execute: async (args) => ({ output: [{ type: "text", text: JSON.stringify(await dispatch.complete(args.file, args.heading), null, 1) }] }),
			}),
			defineTool({
				name: "org_dispatch_now",
				description: `Run the dispatcher on ${config.herdr.host} now and show what it would launch. Queueing already starts it; use this to retry a task that did not launch.`,
				parameters: Type.Object({}),
				// Starting the dispatcher twice is harmless: it holds a lock and skips running tasks.
				replay: "safe",
				execute: async () => ({ output: [{ type: "text", text: await dispatch.nudge() }] }),
			}),
		],
	});
}
