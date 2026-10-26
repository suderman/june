// Queue new AUTO tasks for org-dispatch, and nudge this host's dispatcher. June writes the heading as text, as agents
// do; states and dates on existing headings stay with org-edit. The dispatcher, not June, launches the work.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
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

/** Insert `text` before the first heading, newest first, as project files keep their threads. */
export function insertAfterPreamble(content: string, text: string): string {
	const first = /^\* /m.exec(content);
	if (first === null) return `${content.replace(/\n*$/, "\n\n")}${text}`;
	const before = content.slice(0, first.index).replace(/\n*$/, "");
	return `${before ? `${before}\n\n` : ""}${text}\n${content.slice(first.index)}`;
}

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
				description: `Queue new work for an unattended Pi agent: write a new AUTO heading with one host tag (${hosts.join(", ")}) into an Org agenda file. The dispatcher on that host launches it about two minutes after the text last changed, and the agent ends at EVAL for the user's review unless review is false. You then follow it: a [follow] message tells you when it fails to launch, blocks, holds, or finishes. Search for an existing task first. Write the body in Org: a short note that you queued it and why, then ** Scope and ** Checklist sections.`,
				parameters: Type.Object({
					file: Type.String({ description: "Org file under ~/org, usually the project's <project>.org" }),
					title: Type.String({ description: "Concise verb-led heading title, without keyword or tags" }),
					body: Type.String({ description: "Org text under the heading; one physical line per paragraph or list item" }),
					host: Type.String({ description: `Machine whose dispatcher runs it: ${hosts.join(", ")}; default ${hosts[0]}` }),
					dir: Type.Optional(Type.String({ description: "Working directory, when not the project's single repository" })),
					review: Type.Optional(Type.Boolean({ description: "Default true: the agent stops at EVAL" })),
				}),
				// Idempotent by key: a rerun after a restart finds the heading it wrote.
				replay: "safe",
				execute: async (args, api, context) => {
					const result = await dispatch.queue({
						...args,
						review: args.review ?? true,
						key: `${instance}:${api.taskId}`,
					});
					// Follow it, once, whether this call wrote the heading or a replay found it.
					if (result.id !== undefined) {
						const input = { id: result.id, title: args.title, host: args.host, queuedAt: Date.now() };
						await api.commit((tx) => follow(tx, followTask, input, api.conversationId as unknown as number), context);
					}
					return { output: [{ type: "text", text: JSON.stringify({ ...result, following: result.id !== undefined }, null, 1) }] };
				},
			}),
			defineTool({
				name: "org_dispatch_now",
				description: `Run the dispatcher on ${config.herdr.host} now instead of waiting for its one-minute timer, then show what it would launch. A task still settling launches once its text has been unchanged for two minutes.`,
				parameters: Type.Object({}),
				// Starting the dispatcher twice is harmless: it holds a lock and skips running tasks.
				replay: "safe",
				execute: async () => ({ output: [{ type: "text", text: await dispatch.nudge() }] }),
			}),
		],
	});
}
