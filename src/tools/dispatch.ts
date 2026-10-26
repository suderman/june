// Queue new AUTO tasks for org-dispatch, and nudge this host's dispatcher. June writes the heading as text, as agents
// do; resuming existing headings goes through org-edit. The dispatcher, not June, launches the work.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { type Config, expandHome } from "../config.ts";
import { type Run, runProcess } from "./herdr.ts";
import { createFollowTask, FOLLOW_DEFAULTS, type FollowOptions, follow } from "./follow.ts";
import type { Herdr } from "./herdr.ts";
import type { Org } from "./org.ts";

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

	async #target(file: string): Promise<string> {
		const path = await this.#org.file(file);
		const name = basename(path);
		const rel = this.#org.rel(path);
		if (name === "asana.org" || name === "inbox.org" || name === "archive.org" || /(^|\/)archive\//.test(rel) || name.includes(".sync-conflict-"))
			throw new Error(`June does not write ${rel}`);
		const siblings = await readdir(dirname(path));
		if (siblings.some((f) => f.startsWith(name.replace(/\.org$/, ".sync-conflict-"))))
			throw new Error(`${rel} has a Syncthing conflict copy beside it; the user should resolve it first`);
		const agenda = await readFile(this.#config.org.agendaFiles, "utf8").catch(() => {
			throw new Error(`No agenda list at ${this.#config.org.agendaFiles}; the dispatcher has not run on this host`);
		});
		if (!agenda.split("\n").includes(path)) throw new Error(`${rel} is not an agenda file, so the dispatcher would never see the task`);
		return path;
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
		if (!request.note.trim() || /[\n\r]/.test(request.note)) throw new Error("note must be one non-empty line recording Jon's instruction");
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
				name: "org_queue_task",
				description: `Queue new work for an unattended Pi agent: write a new AUTO heading with one host tag (${hosts.join(", ")}) into an Org agenda file. The dispatcher on that host launches it, and this tool starts the one on this host right away, and the agent ends at EVAL for the user's review unless review is false. You then follow it: a [follow] message tells you when it fails to launch, blocks, holds, or finishes. Search for an existing task first. The tool writes the body from reason, scope, and checklist.`,
				parameters: Type.Object({
					file: Type.String({ description: "Org file under ~/org, usually the project's <project>.org" }),
					title: Type.String({ description: "Concise verb-led heading title, without keyword or tags" }),
					reason: Type.String({ description: 'One line, written after "Queued by June: ": the reason itself, naming the user rather than writing "you", such as "Jon asked for a read-only docs check."' }),
					scope: Type.String({ description: "Outcome, constraints, and success criteria in Org; one physical line per paragraph" }),
					checklist: Type.Array(Type.String(), { minItems: 1, description: "Steps for the agent, one line each, without dashes or boxes" }),
					host: Type.String({ description: `Machine whose dispatcher runs it: ${hosts.join(", ")}; default ${hosts[0]}` }),
					dir: Type.Optional(Type.String({ description: "Working directory when the project file links several repositories: one of its local links, exactly" })),
					review: Type.Optional(Type.Boolean({ description: "Default true: the agent stops at EVAL" })),
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
					note: Type.String({ description: "One line recording Jon's request and any answer or revised scope, naming Jon rather than writing you" }),
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
