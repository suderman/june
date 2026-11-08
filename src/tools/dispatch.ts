// Queue new AUTO tasks for org-dispatch, and nudge this host's dispatcher. June writes the heading as text, as agents
// do; resuming existing headings goes through org-edit. The dispatcher, not June, launches the work.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { arr, bool, lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { type Config, expandHome } from "../config.ts";
import { type Run, runProcess } from "./herdr.ts";
import { createFollowTask, FOLLOW_DEFAULTS, type FollowInput, type FollowOptions, follow, listFollowing } from "./follow.ts";
import type { Herdr } from "./herdr.ts";
import { type Org, orgTime, parseHeading } from "./org.ts";
import { User, user } from "../user.ts";

export type QueueRequest = {
	file: string;
	title: string;
	body: string;
	host: string;
	/** The agent the dispatcher starts; June's config default, pi without one. */
	agent?: string;
	dir?: string;
	review: boolean;
	/** Stable across a tool's replay, so a rerun finds its own heading instead of writing a second one. */
	key: string;
	/** When the dispatcher may start it, as org-edit date takes it, such as `2026-11-07 09:30` or `fri 9:30`; unset starts now. */
	scheduled?: string;
};

/**
 * The heading text June writes: keyword, title, the SCHEDULED planning line when it waits, a property drawer that names
 * the agent and host, then the body. `stamp` is the Org timestamp org-edit made from `request.scheduled`.
 */
export function renderTask(request: QueueRequest, id: string, stamp?: string): string {
	const properties = [`:ID: ${id}`, `:AGENT: ${request.agent ?? "pi"}`, `:HOST: ${request.host}`, `:JUNE_REQUEST: ${request.key}`];
	if (request.dir) properties.push(`:DIR: ${request.dir}`);
	if (!request.review) properties.push(":REVIEW: no");
	const body = request.body.trim();
	return [`* AUTO ${request.title}`, ...(stamp ? [`SCHEDULED: ${stamp}`] : []), ":PROPERTIES:", ...properties, ":END:", ...(body ? [body] : []), ""].join("\n");
}

/** The agents June may choose for a task: `dispatch.agents`, or her default agent alone. */
export function dispatchAgents(dispatch: Config["dispatch"]): readonly string[] {
	return dispatch.agents ?? [dispatch.agent ?? "pi"];
}

/** The agents org-dispatch can start, as its `org-dispatch-launchable` lists them. */
export const LAUNCHABLE = ["pi", "claude"] as const;

/** Agents the dispatcher could start that June's config does not let her choose. */
export function disabledAgents(dispatch: Config["dispatch"]): string[] {
	const agents = dispatchAgents(dispatch);
	return LAUNCHABLE.filter((agent) => !agents.includes(agent));
}

function checkAgent(agent: string | undefined, agents: readonly string[]): void {
	if (agent === undefined || agents.includes(agent)) return;
	if ((LAUNCHABLE as readonly string[]).includes(agent))
		throw new Error(`The dispatcher can run ${agent}, but June's config does not enable it: dispatch.agents allows only ${agents.join(", ")}. ${User()} can add ${agent} there; do not route around it with tags`);
	throw new Error(`The agent is one of ${agents.join(", ")}`);
}

/** One date and an optional start time, without a range, repeater, or warning, which a one-off queued task has no use for. */
const START = /^<\d{4}-\d{2}-\d{2} [A-Za-z]{2,3}(?: \d{2}:\d{2})?>$/;

export function checkRequest(request: QueueRequest, dispatch: Config["dispatch"]): void {
	const { hosts } = dispatch;
	if (!hosts.includes(request.host)) throw new Error(`June may queue only for ${hosts.join(", ")}; ${request.host} has no dispatcher she may use`);
	checkAgent(request.agent, dispatchAgents(dispatch));
	if (/[\n\r]/.test(request.title) || request.title.trim() !== request.title || request.title === "")
		throw new Error("The title is one line without surrounding spaces");
	if (/^(TODO|AUTO|PROG|EVAL|HOLD|DONE)\b/.test(request.title) || /\s:[\w@#%:]+:$/.test(request.title))
		throw new Error("The title must not carry a keyword or tags");
	// Second-level headings and below are fine; a first-level one would split the task in two.
	if (/^\* /m.test(request.body)) throw new Error("The body must not contain a first-level heading");
	if (/^\s*:(PROPERTIES|END):/m.test(request.body)) throw new Error("The body must not contain a property drawer");
	if (request.dir !== undefined && !request.dir.startsWith("/") && !request.dir.startsWith("~/"))
		throw new Error("dir is an absolute or ~/ path");
	if (request.scheduled !== undefined && (/[\n\r<>\[\]]/.test(request.scheduled) || request.scheduled.trim() === ""))
		throw new Error("scheduled is one line, such as 2026-11-07 09:30 or fri 9:30, without brackets");
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

/** The checkout June runs from, where a fix to her goes; a Nix store copy cannot be changed. */
const SOURCE = join(import.meta.dirname, "..", "..");

/**
 * The task june_improve writes: the user's words on one line, so nothing in them can start a heading, June's reading,
 * and where the agent reads the conversation itself, which stays on the daemon's host rather than in synced Org.
 */
export function improveBody(complaint: string, gap: string, since: Date, host: string): string {
	const words = complaint.replace(/\s+/g, " ").trim();
	if (words === "") throw new Error("complaint is required");
	const scope = [
		`${User()} hit a gap while talking to June and asked for it to be fixed. In their words: «${words}»`,
		"",
		`June's reading: ${gap.replace(/\s+/g, " ").trim()}`,
		"",
		`The conversation is on ${host}: read it there with =june transcript --since ${since.toISOString()} --detail=, or =--json= for the raw entries, rather than relying on the summary above. Keep it out of Org, which syncs to other devices.`,
		"",
		`Fix it in June's code, prompt, skills, or tools, whichever fits. If the cause is somewhere else, such as org-dispatch or a skill in another repository, say so, and fix it there only when that is clearly within reach. Do not restart =june.service= or rebuild the system; say in the outcome what ${user()} must do to apply the change.`,
	].join("\n");
	return taskBody({
		reason: `${User()} asked June to fix a gap in what she can do.`,
		scope,
		checklist: [
			"Read the conversation with june transcript and work out what June did and why.",
			"Find the cause and make the smallest change that closes the gap.",
			"Add or adjust tests and run the full check.",
			`Record what changed and what ${user()} must do to apply it, such as restarting June or rebuilding.`,
		],
	});
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
		throw new Error(`${rel} has a Syncthing conflict copy beside it; resolve it with the org-conflicts skill, then retry`);
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

export type PlanTask = {
	/** Short name other tasks in the plan use in `depends`. */
	key: string;
	file: string;
	title: string;
	body: string;
	/** Keys of earlier or later tasks in this plan, or `id:UUID` of tasks already in Org. */
	depends?: readonly string[];
	host?: string;
	agent?: string;
	dir?: string;
	review?: boolean;
};

export type PlanRequest = {
	/** Stable across a replay; `org-dispatch plan` derives every ID from it. */
	key: string;
	title: string;
	/** Where the plan's table of tasks goes. */
	file: string;
	tasks: readonly PlanTask[];
};

export type PlannedTask = { key: string; id: string; file: string; title: string; host: string; depends: string[] };

export type ResumeRequest = {
	file: string;
	heading: string;
	expected: "TODO" | "EVAL" | "HOLD";
	host: string;
	/** Unset keeps the task's agent, or org-edit fills the default. */
	agent?: string;
	/** `id:UUID` prerequisites to add in the same save, so the task never sits AUTO without them. */
	depends?: readonly string[];
	note: string;
	key: string;
};

export type RemoveDependenciesRequest = {
	file: string;
	heading: string;
	expected: "TODO" | "EVAL" | "HOLD" | "AUTO";
	revision: string;
	remove: readonly string[];
	note: string;
	key: string;
};

export class Dispatch {
	readonly #org: Org;
	readonly #config: Config;
	readonly #run: Run;

	readonly #now: () => number;

	constructor(org: Org, config: Config, run: Run = runProcess, now: () => number = Date.now) {
		this.#org = org;
		this.#config = config;
		this.#run = run;
		this.#now = now;
	}

	/** The Org timestamp for `when`, made by org-edit as for any other date, refused unless it is one plain start. */
	async #stamp(when: string): Promise<string> {
		// Org may print a bell before the stamp when it adjusts a date.
		const stamp = (await this.#run(["org-edit", "date", when.trim()], 60_000)).replace(/[\x00-\x1f]/g, "").trim();
		// An older org-edit moves an impossible or far-off date silently; never queue for a day other than the one asked for.
		const asked = /^\d{4}-\d{2}-\d{2}/.exec(when.trim())?.[0];
		if (asked !== undefined && !stamp.startsWith(`<${asked} `) && stamp !== `<${asked}>`)
			throw new Error(`There is no ${asked} Org can schedule; it reads it as ${stamp}`);
		if (!START.test(stamp)) throw new Error(`scheduled is a date and optional start time, such as 2026-11-07 09:30, without a range or repeater; ${when} gives ${stamp}`);
		return stamp;
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
			throw new Error(`${file} has a Syncthing conflict copy beside it; resolve it with the org-conflicts skill, then retry`);
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

	/**
	 * Write the task once. A replay with the same key returns the heading it already wrote. A scheduled task is written
	 * with its SCHEDULED line in the same save, so no dispatcher run, here or on another host, can see it without one.
	 */
	async queue(request: QueueRequest) {
		// Some model calls send empty strings for omitted optional fields.
		if (request.scheduled === "") request = { ...request, scheduled: undefined };
		checkRequest(request, this.#config.dispatch);
		if (request.dir !== undefined) {
			const dir = await stat(expandHome(request.dir)).catch(() => undefined);
			if (!dir?.isDirectory()) throw new Error(`dir ${request.dir} is not a directory; use one of the project's repository links`);
		}
		const path = await this.#target(request.file);
		let stamp: string | undefined;
		for (let attempt = 0; attempt < 3; attempt++) {
			const before = await stat(path);
			const content = await readFile(path, "utf8");
			const existing = new RegExp(`^:JUNE_REQUEST: ${request.key}$`, "m").exec(content);
			if (existing !== null) return { file: this.#org.rel(path), written: false, ...this.#located(content, existing.index) };
			// Only before the first write: a replay finds the heading above, whatever the date now means.
			if (request.scheduled !== undefined) stamp ??= await this.#stamp(request.scheduled);
			const startsAt = stamp === undefined ? undefined : orgTime(stamp)!;
			if (startsAt !== undefined && startsAt <= this.#now())
				throw new Error(`scheduled ${stamp} has already passed in Calgary time; omit scheduled to start now, or choose a later time`);
			const id = randomUUID();
			const next = insertAfterPreamble(content, renderTask({ agent: this.#config.dispatch.agent ?? "pi", ...request }, id, stamp));
			// Replace only if nobody (Emacs, Syncthing) changed the file since it was read.
			if ((await stat(path)).mtimeMs !== before.mtimeMs) continue;
			const temp = join(dirname(path), `.${basename(path)}.june-${process.pid}`);
			await writeFile(temp, next, { mode: before.mode & 0o777 });
			await rename(temp, path);
			return { file: this.#org.rel(path), written: true, id, heading: `AUTO ${request.title}`, ...(stamp ? { scheduled: stamp } : {}) };
		}
		throw new Error(`${this.#org.rel(path)} kept changing; try again shortly`);
	}

	/**
	 * Write a plan of connected tasks through `org-dispatch plan`, which assigns stable IDs, writes `:DEPENDS:` edges,
	 * checks the graph, and starts nothing. A replay with the same key and tasks finds what the first run wrote.
	 */
	async plan(request: PlanRequest): Promise<PlannedTask[]> {
		if (!/^[\w-]+$/.test(request.key)) throw new Error("plan key is a plain name");
		if (request.tasks.length === 0) throw new Error("A plan needs at least one task");
		const keys = new Set<string>();
		for (const task of request.tasks) {
			if (!/^[a-z0-9][a-z0-9_-]*$/i.test(task.key) || keys.has(task.key)) throw new Error(`Task key ${task.key} must be a unique plain name`);
			keys.add(task.key);
		}
		const defaultHost = this.#config.dispatch.host ?? this.#config.dispatch.hosts[0]!;
		const defaultAgent = this.#config.dispatch.agent ?? "pi";
		const tasks = [];
		for (const task of request.tasks) {
			const host = task.host ?? defaultHost;
			checkRequest({ file: task.file, title: task.title, body: task.body, host, agent: task.agent, dir: task.dir, review: task.review ?? true, key: request.key }, this.#config.dispatch);
			if (task.dir !== undefined && !(await stat(expandHome(task.dir)).catch(() => undefined))?.isDirectory())
				throw new Error(`dir ${task.dir} is not a directory`);
			for (const ref of task.depends ?? []) {
				if (ref === task.key) throw new Error(`${task.key} cannot depend on itself`);
				if (!keys.has(ref) && !/^id:[0-9A-Za-z-]{8,64}$/.test(ref)) throw new Error(`${task.key} depends on ${ref}, which is neither a task key in this plan nor id:UUID`);
			}
			tasks.push({
				key: task.key,
				file: this.#org.rel(await this.#target(task.file)),
				title: task.title,
				body: task.body.trim(),
				host,
				agent: task.agent ?? defaultAgent,
				...(task.depends?.length ? { depends: [...task.depends] } : {}),
				...(task.dir ? { dir: task.dir } : {}),
				...(task.review === false ? { review: false } : {}),
			});
		}
		if (/[\n\r]/.test(request.title) || !request.title.trim()) throw new Error("The plan title is one non-empty line");
		const spec = { key: request.key, title: request.title.trim(), file: this.#org.rel(await this.#target(request.file)), tasks };
		// The spec is runtime input, kept out of synced Org and removed once the dispatcher has read it.
		const dir = await mkdtemp(join(tmpdir(), "june-plan-"));
		let out: string;
		try {
			const path = join(dir, `${request.key}.json`);
			await writeFile(path, JSON.stringify(spec), { mode: 0o600 });
			out = await this.#run(["org-dispatch", "plan", path], 120_000);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
		let written: { id: string; file: string }[];
		try {
			// The dispatcher logs to stdout too, such as a fallback to its cached agenda; the result is the last line.
			written = JSON.parse(out.trim().split("\n").at(-1)!);
		} catch (cause) {
			throw new Error("org-dispatch plan did not return its tasks; check that the installed dispatcher supports plans", { cause });
		}
		if (!Array.isArray(written) || written.length !== tasks.length) throw new Error("org-dispatch plan returned a different number of tasks");
		const ids = new Map(tasks.map((task, i) => [task.key, written[i]!.id]));
		// Emacs reports true file names.
		const root = await realpath(this.#config.org.root);
		return tasks.map((task, i) => ({
			key: task.key,
			id: written[i]!.id,
			file: relative(root, written[i]!.file),
			title: task.title,
			host: task.host,
			depends: (task.depends ?? []).map((ref) => ids.get(ref) ?? ref.slice(3)),
		}));
	}

	/** Resume the same heading, with Org applying the state, tags, and Dialog entry in one save. */
	async resume(request: ResumeRequest, herdr: Herdr) {
		if (!this.#config.dispatch.hosts.includes(request.host)) throw new Error(`No allowed dispatcher on ${request.host}`);
		if (!["TODO", "EVAL", "HOLD"].includes(request.expected)) throw new Error("Only TODO, EVAL, or HOLD tasks can resume");
		checkAgent(request.agent, dispatchAgents(this.#config.dispatch));
		if (!request.note.trim() || /[\n\r]/.test(request.note)) throw new Error(`note must be one non-empty line recording ${user()}'s instruction`);
		for (const ref of request.depends ?? [])
			if (!/^id:[0-9A-Za-z][0-9A-Za-z-]{0,63}$/.test(ref)) throw new Error(`depends takes id:UUID of existing Org tasks, not ${ref}`);
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
			"--request", request.key, "--host", request.host, ...(request.agent ? ["--agent", request.agent] : []),
			// Only when asked, so a plain resume still works with an org-edit that predates --depends.
			...(request.depends?.length ? ["--depends", request.depends.join(" ")] : []),
			"--note", request.note.trim(),
		], 120_000).catch((error: Error) => {
			// Parsing options precedes any edit, so an older org-edit refuses without writing.
			if (/unknown option --depends/.test(error.message))
				throw new Error(`The installed org-edit cannot add dependencies yet and wrote nothing; ${user()} needs to update June's Nix input and rebuild. Do not resume the task without them, since it would launch early.`);
			throw error;
		});
		try {
			// Loading the agenda for --depends can log to stdout first, as org-dispatch plan does; the result is the last line.
			const result = JSON.parse(out.trim().split("\n").at(-1)!) as { id: string; title: string; host: string; depends?: string[]; written: boolean };
			// org-edit reports the task's whole DEPENDS, including edges it already had.
			return { ...result, depends: (result.depends ?? []).map((ref) => ref.replace(/^id:/, "")), file: this.#org.rel(path) };
		} catch (cause) {
			throw new Error("org-edit did not return a resume result; check the installed org-edit version", { cause });
		}
	}

	/** Remove selected edges without launching work. A queued task is paused for a separate, reviewed resume. */
	async removeDependencies(request: RemoveDependenciesRequest, herdr: Herdr) {
		if (!/^id:[0-9A-Za-z][0-9A-Za-z-]{0,63}$/.test(request.heading)) throw new Error("heading must be id:UUID of the existing task");
		if (!["TODO", "EVAL", "HOLD", "AUTO"].includes(request.expected)) throw new Error("Only TODO, EVAL, HOLD, or AUTO tasks allow dependency removal");
		if (!/^[0-9a-f]{64}$/.test(request.revision)) throw new Error("revision must be the SHA256 returned by org_read_task");
		if (!request.remove.length || request.remove.some((ref) => !/^id:[0-9A-Za-z][0-9A-Za-z-]{0,63}$/.test(ref))) throw new Error("remove needs selected id:UUID dependency edges");
		if (!request.note.trim() || /[\n\r]/.test(request.note)) throw new Error(`note must be one non-empty line recording ${user()}'s instruction and any prose gate lifted`);
		const path = await this.#target(request.file);
		const task = await this.#org.read(request.file, request.heading);
		const properties = task.text.split(/\n\*+ /, 1)[0]!;
		const replay = properties.split("\n").some((line) => line.trim() === `:JUNE_DEPENDENCY_EDIT: ${request.key}`);
		if (!replay) {
			if (task.revision !== request.revision) throw new Error("task revision changed; read the task and Dialog again");
			for (const host of new Set(task.herdrSessions.map((session) => session.host))) {
				const agents = await herdr.agents(host);
				if (agents.some((agent) => ["working", "blocked"].includes(agent.status) && task.herdrSessions.some((session) => session.host === host && session.session === agent.session)))
					throw new Error(`The task still has an active agent on ${host}; wait for it to finish`);
			}
		}
		const out = await this.#run([
			"org-edit", "remove-dependencies", path, request.heading, "--expect", request.expected,
			"--revision", request.revision, "--remove", request.remove.join(" "), "--request", request.key, "--note", request.note.trim(),
		], 120_000).catch((error: Error) => {
			if (/usage: org-edit todo\|schedule\|deadline/.test(error.message))
				throw new Error(`The installed org-edit cannot remove dependencies yet and wrote nothing; ${user()} needs to update June's Nix input and rebuild. Do not edit DEPENDS by hand on an AUTO task.`);
			throw error;
		});
		try {
			const result = JSON.parse(out.trim().split("\n").at(-1)!) as { id: string; title: string; state: string; depends: string[]; written: boolean };
			return { ...result, file: this.#org.rel(path) };
		} catch (cause) {
			throw new Error("org-edit did not return a dependency removal result; re-read the task before retrying", { cause });
		}
	}

	/** Close a task June created, after she reviews its outcome. Org supplies CLOSED and logging. */
	async complete(file: string, heading: string) {
		const path = await this.#target(file);
		const task = await this.#org.read(file, heading);
		const own = task.text.split(/\n\*+ /, 1)[0]!;
		const id = /^:ID: (.+)$/m.exec(own)?.[1];
		// org_queue_task marks its heading JUNE_REQUEST; org-dispatch plan marks hers PLAN_REQUEST with June's prefix.
		if (!id || !/^:(JUNE_REQUEST: .+|PLAN_REQUEST: june-.+)$/m.test(own) || !/^Queued by June: .+$/m.test(own))
			throw new Error("June may close only tasks she created, not tasks she merely resumed");
		const state = parseHeading(task.text.split("\n")[0]!, task.line)?.state;
		if (state !== "EVAL" && state !== "DONE") throw new Error(`Expected EVAL, found ${state ?? "no state"}; read the task again`);
		if (state === "DONE") return { file: task.file, id, state, written: false };
		await this.#run(["org-edit", "todo", path, `id:${id}`, "DONE", "--expect", "EVAL"], 60_000);
		return { file: task.file, id, state: "DONE", written: true };
	}

	#located(content: string, index: number) {
		const head = content.slice(0, index).lastIndexOf("\n* ");
		const [line, planning] = content.slice(head + 1).split("\n");
		const id = /^:ID: (.+)$/m.exec(content.slice(head + 1))?.[1];
		const scheduled = /^SCHEDULED: (<[^>]+>)$/.exec(planning ?? "")?.[1];
		return { heading: line?.replace(/^\* /, ""), ...(id ? { id } : {}), ...(scheduled ? { scheduled } : {}) };
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
	const minute = followOptions.minuteMs ?? 60_000;
	const hosts = config.dispatch.hosts;
	const defaultHost = config.dispatch.host ?? hosts[0];
	const defaultAgent = config.dispatch.agent ?? "pi";
	const agents = dispatchAgents(config.dispatch);
	const agentParameter = (description: string) => opt(union(agents.map((agent) => lit(agent)), { description }));
	// Say what the dispatcher could run but June may not choose, so she gives one accurate answer instead of a workaround.
	const disabled = disabledAgents(config.dispatch);
	const agentNote = disabled.length === 0
		? ""
		: ` The dispatcher can also run ${disabled.join(" and ")}, but ${user()} has not enabled ${disabled.length === 1 ? "it" : "them"} for you: dispatch.agents in your config lists only ${agents.join(", ")}. If ${user()} asks for ${disabled.join(" or ")}, say exactly that and that adding it to dispatch.agents enables it; never add agent tags such as :${disabled[0]}:, edit the drawer, or give the work to another agent instead.`;
	/** Write the task, follow it once whether this call wrote it or a replay found it, and start this host's dispatcher. */
	const queueAndFollow = async (request: QueueRequest, followIt: (input: FollowInput) => Promise<unknown>): Promise<string> => {
		const result = await dispatch.queue(request);
		if (result.id !== undefined) await followIt({ id: result.id, title: request.title, host: request.host, queuedAt: Date.now() });
		// The dispatcher launches headings June wrote without settling, so start it now instead of waiting a minute.
		// A scheduled task would only be skipped now; the dispatcher's timer launches it when its time comes.
		let started = "";
		if (result.scheduled)
			started = ` It is SCHEDULED for ${result.scheduled}, Calgary time: the dispatcher holds it until then and its timer launches it within about a minute after.`;
		else if (result.written && request.host === config.herdr.host)
			started = await dispatch.kick().then(
				() => " The dispatcher was started and launches it now.",
				(error: Error) => ` Starting the dispatcher failed (${error.message}); its timer runs within a minute.`,
			);
		const note = `You are following this task and will get [follow] messages when it fails to launch, blocks, holds, or finishes.${started} Tell the user you will report back.`;
		return `${JSON.stringify(result, null, 1)}\n${note}`;
	};
	const improve = config.dispatch.improve;
	const improveHost = improve?.host ?? defaultHost;
	const improveAgent = improve?.agent ?? defaultAgent;
	return defineExtension({
		name: "dispatch",
		tasks: [followTask],
		tools: [
			defineTool({
				name: "org_create_project",
				description: "Create ~/org/work/<domain>/<project>/<project>.org with a title, category, and optional repository links, then confirm dispatcher agenda discovery. First use org_projects and search for an existing project. Honor a destination the user names. Otherwise GitHub owner/repo guides domain/project for a new repo project; unmatched work and clear one-offs go under domain june with a short descriptive project name. Never overwrite an existing record. This tool queues no work; use org_queue_task afterward. If it cannot confirm agenda discovery, tell the user why and ask how to proceed rather than filing the task elsewhere.",
				parameters: obj({
					domain: str({ description: "Existing logical domain, GitHub owner for a new repo project, or june for unmatched work and one-offs" }),
					project: str({ description: "Short directory name; GitHub repository name when it fits" }),
					title: str({ description: "Human-readable project title, one line" }),
					github: opt(str({ description: "Repository this project actually concerns, as https://github.com/owner/repo without .git; omit or leave empty for unrelated one-offs" })),
					dir: opt(str({ description: "Existing checkout this project actually concerns, absolute or ~/ path; omit or leave empty for work without one" })),
				}),
				replay: "safe",
				execute: async (args) => ({ output: [{ type: "text", text: JSON.stringify(await dispatch.createProject(args), null, 1) }] }),
			}),
			defineTool({
				name: "org_queue_task",
				description: `Queue new work for an unattended agent: write a new AUTO heading, its host (${hosts.join(", ")}) and agent in its property drawer, into an Org agenda file. The dispatcher on that host launches it, and this tool starts the one on this host right away, and the agent ends at EVAL for review by you or the user unless review is explicitly waived. You then follow it: a [follow] message tells you when it fails to launch, blocks, holds, or finishes. Search for an existing task and use org_projects to find its project first. If no project fits, use org_create_project before queueing. The tool writes the body from reason, scope, and checklist. If it refuses the file, tell ${user()} why and ask how to proceed; never get around a refusal by queueing in another file. To start it later, pass scheduled: the dispatcher already honours SCHEDULED, and this writes it with the task. Never queue first and set the date afterward with org_set_date, since the dispatcher may launch it in between; for an existing task, set the date while it is still TODO, EVAL, or HOLD, then use org_resume_task.${agentNote}`,
				parameters: obj({
					file: str({ description: "Org file under ~/org, usually the project's <project>.org" }),
					title: str({ description: "Concise verb-led heading title, without keyword or tags" }),
					reason: str({ description: 'One line, written after "Queued by June: ": the reason itself, naming the user rather than writing "you", such as `${User()} asked for a read-only docs check.`' }),
					scope: str({ description: "Outcome, constraints, and success criteria in Org; one physical line per paragraph" }),
					checklist: arr(str(), { minItems: 1, description: "Steps for the agent, one line each, without dashes or boxes" }),
					host: str({ description: `Machine whose dispatcher runs it: ${hosts.join(", ")}; default ${defaultHost}` }),
					agent: agentParameter(`Coding agent the dispatcher starts: ${agents.join(" or ")}; default ${defaultAgent}. Choose one when ${user()} names it. It is written as :AGENT: in the drawer, which the dispatcher reads before any agent tag, so no tag is needed`),
					dir: opt(str({ description: "Existing working directory override, usually one of the project's local repository links. Omit for one-offs without a checkout: the dispatcher uses the project directory" })),
					review: opt(bool({ description: `Default true: the worker stops at EVAL for human or agent review, including read-only lookups you will review yourself. Set false only when ${user()} explicitly waives review` })),
					scheduled: opt(str({ description: `Only when ${user()} wants it to start later: the earliest start, in Calgary time as the dispatcher reads it, as a date (2026-11-07, today, tomorrow, fri, +2d; a weekday name is the next one, never today) and optional time (09:30). Omit to start now. It goes into the heading before the file is saved, so the task cannot launch early; a time already past is refused` })),
				}),
				// Idempotent by key: a rerun after a restart finds the heading it wrote.
				replay: "safe",
				execute: async (args, api, context) => {
					const { reason, scope, checklist, ...rest } = args;
					const request = { ...rest, body: taskBody({ reason, scope, checklist }), review: args.review ?? true, key: `${instance}:${api.taskId}` };
					const text = await queueAndFollow(request, (input) => api.commit((tx) => follow(tx, followTask, input, Number(api.conversationId)), context));
					return { output: [{ type: "text", text }] };
				},
			}),
			defineTool({
				name: "org_queue_plan",
				description: `Queue a plan of connected tasks for unattended agents when ${user()} asks for a series of tasks on a bigger project, some in parallel and some waiting on others. Each task is a new AUTO heading in its project file, with a :DEPENDS: edge to each task it waits on; the dispatcher launches a task only once every prerequisite is DONE, never at EVAL, and waiting costs nothing. A table of the plan's tasks goes in file. You follow every task: [follow] messages report a failed launch, a blocked agent, HOLD, and each finish. Each task ends at EVAL unless review is waived; review it as for org_queue_task, and close it with org_complete_task when satisfied, which is what lets its dependents start: you are what moves the plan along. A task left at EVAL for ${user()}'s review or decision holds everything after it, so tell ${user()} which tasks are waiting behind it. Report each task as it finishes, and tell ${user()} when the whole plan is done. Use this rather than queueing connected tasks one at a time; for a single task use org_queue_task. Search for existing tasks first, and use org_projects and org_create_project as for org_queue_task. Never use it to resume existing tasks. A plan cannot be scheduled: tasks without prerequisites launch as soon as it is written, so if ${user()} wants it to start later, say so and ask rather than adding dates afterward.${agentNote}`,
				parameters: obj({
					title: str({ description: "One-line name of the plan, used for its table heading" }),
					file: str({ description: "Org agenda file for the plan's table, usually the main project's file" }),
					reason: str({ description: 'One line, written after "Queued by June: " in every task, naming the user, such as `${User()} asked for the launch plan for Boom Boom Baby.`' }),
					tasks: arr(obj({
						key: str({ description: "Short plain name for this task within the plan, such as landing or api; letters, digits, - and _" }),
						file: str({ description: "Org file under ~/org for this task, usually its project's <project>.org" }),
						title: str({ description: "Concise verb-led heading title, without keyword or tags" }),
						scope: str({ description: "Outcome, constraints, and success criteria in Org, including what this task hands to the tasks after it; one physical line per paragraph" }),
						checklist: arr(str(), { minItems: 1, description: "Steps for the agent, one line each, without dashes or boxes" }),
						depends: opt(arr(str(), { description: "Keys of tasks in this plan that must be DONE first, or id:UUID of existing Org tasks" })),
						host: opt(str({ description: `Machine whose dispatcher runs it: ${hosts.join(", ")}; default ${defaultHost}` })),
						agent: agentParameter(`Coding agent: ${agents.join(" or ")}; default ${defaultAgent}`),
						dir: opt(str({ description: "Existing working directory, usually one of the project's local repository links; omit to use the project directory" })),
						review: opt(bool({ description: `Default true: the worker stops at EVAL for review. Set false only when ${user()} explicitly waives review for this task` })),
					}), { minItems: 1 }),
				}),
				// org-dispatch plan derives every ID from the key, so a replay finds the tasks the first run wrote.
				replay: "safe",
				execute: async (args, api, context) => {
					const key = `june-${instance}-${api.taskId}`.replace(/[^\w-]/g, "-");
					const planned = await dispatch.plan({
						key,
						title: args.title,
						file: args.file,
						tasks: args.tasks.map(({ scope, checklist, ...task }) => ({ ...task, body: taskBody({ reason: args.reason, scope, checklist }) })),
					});
					const now = Date.now();
					await api.commit(async (tx) => {
						for (const task of planned)
							await follow(tx, followTask, { id: task.id, title: task.title, host: task.host, queuedAt: now, request: `${key}:${task.key}`, ...(task.depends.length ? { depends: task.depends } : {}) }, Number(api.conversationId));
					}, context);
					let started = "";
					if (planned.some((task) => task.host === config.herdr.host))
						started = await dispatch.kick().then(
							() => " The dispatcher was started; tasks without prerequisites launch now.",
							(error: Error) => ` Starting the dispatcher failed (${error.message}); its timer runs within a minute.`,
						);
					const note = `You are following every task in this plan. Review each one at EVAL and close it with org_complete_task when satisfied, so the tasks waiting on it can start.${started} Tell ${user()} what you queued and that you will report back.`;
					return { output: [{ type: "text", text: `${JSON.stringify(planned, null, 1)}\n${note}` }] };
				},
			}),
			...(improve === undefined ? [] : [defineTool({
				name: "june_improve",
				description: `When ${user()} says you could not do something they expected, or did it badly, and wants it fixed, or agrees when you offer: queue a task for a coding agent to change your own code, prompt, skills, or tools. It goes in ${improve.file} for ${improveAgent} on ${improveHost}, with ${user()}'s words, your reading of the gap, and the june transcript command for that stretch of conversation, which the agent reads itself. It ends at EVAL for ${user()}'s review, and you follow it as for org_queue_task. Never use it on your own initiative, and not for work on ${user()}'s projects.`,
				parameters: obj({
					title: str({ description: "Concise verb-led title for the fix, without keyword or tags, such as \"Let June give timed updates on a task\"" }),
					complaint: str({ description: `${User()}'s own words about the gap, copied exactly from their messages` }),
					gap: str({ description: "One line: what you could not do or did badly, and why, as far as you can tell" }),
					minutes: opt(num({ description: "How many minutes ago the relevant exchange began, so the agent reads from there; default 30, at most 1440" })),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const minutes = args.minutes ?? 30;
					if (!(minutes >= 1 && minutes <= 1440)) throw new Error("minutes must be from 1 to 1440");
					const request = {
						file: improve.file,
						title: args.title,
						body: improveBody(args.complaint, args.gap, new Date(Date.now() - minutes * 60_000), improveHost),
						host: improveHost,
						agent: improveAgent,
						...(SOURCE.startsWith("/nix/store/") ? {} : { dir: SOURCE }),
						review: true,
						key: `${instance}:${api.taskId}`,
					};
					const text = await queueAndFollow(request, (input) => api.commit((tx) => follow(tx, followTask, input, Number(api.conversationId)), context));
					return { output: [{ type: "text", text }] };
				},
			})]),
			defineTool({
				name: "org_resume_task",
				description: `When the user explicitly asks to start or resume an existing task, change TODO, EVAL, or HOLD to AUTO through org-edit. Read the task and Dialog first. Preserve its ID, scope, history, directory, and schedule; record the user's instruction in Dialog, set review on and deploy off, and select one host. Refuse an active agent. Start this host's dispatcher and follow the task, including another run after EVAL. Never create a duplicate task to resume work. To resume it later rather than now, first set its SCHEDULED with org_set_date while it is still TODO, EVAL, or HOLD, then resume: the dispatcher holds it until then. Never date a task that is already AUTO. When ${user()} wants it to wait for other tasks, pass their IDs in depends: org-edit adds them to :DEPENDS: in the same save that sets AUTO, after refusing missing or duplicate IDs, the task itself, and cycles, so it never launches early. The dispatcher then launches it only once every prerequisite is DONE, never at EVAL, and waiting costs nothing. Edges the task already has are kept. To remove selected edges, first use org_remove_dependencies, which pauses AUTO at HOLD; re-read scope and Dialog and resolve any prose gates before resuming.${agentNote}`,
				parameters: obj({
					file: str({ description: "Org agenda file under ~/org" }),
					heading: str({ description: "Exact title or id:UUID, as org_read_task accepts" }),
					expected: union([lit("TODO"), lit("EVAL"), lit("HOLD")], { description: "Current state just read; a stale request is refused" }),
					host: str({ description: `Keep the existing host unless the user changes it; otherwise default ${defaultHost}. Allowed: ${hosts.join(", ")}` }),
					agent: agentParameter(`Only when ${user()} asks for a different agent: ${agents.join(" or ")}. Omit to keep the task's agent`),
					note: str({ description: `One line recording ${user()}'s request and any answer or revised scope, naming ${user()} rather than writing you` }),
					depends: opt(arr(str(), { description: "id:UUID of existing Org tasks that must be DONE before this one launches, read with org_read_task first; added to any it already has" })),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const key = `${instance}:${api.taskId}`;
					const result = await dispatch.resume({ ...args, key }, herdr);
					await api.commit((tx) => follow(tx, followTask, {
						id: result.id, title: result.title, host: result.host, queuedAt: Date.now(), request: key,
						...(result.depends.length ? { depends: result.depends } : {}),
					}, Number(api.conversationId)), context);
					// A repeated kick is harmless, including recovery after a crash between the save and kick.
					const started = args.host === config.herdr.host
						? await dispatch.kick().then(
							() => " The dispatcher was started; it launches when eligible.",
							(error: Error) => ` Starting the dispatcher failed (${error.message}); its timer will retry.`,
						)
						: " That host's dispatcher will pick it up on its timer.";
					const waits = result.depends.length ? ` It waits until ${result.depends.map((id) => `id:${id}`).join(", ")} ${result.depends.length === 1 ? "is" : "are"} DONE; tell the user what it waits on.` : "";
					return { output: [{ type: "text", text: `${JSON.stringify(result, null, 1)}\nYou are following this task and will get [follow] reports.${started}${waits} Tell the user you will report back. Existing SCHEDULED dates still apply.` }] };
				},
			}),
			defineTool({
				name: "org_remove_dependencies",
				description: `When ${user()} explicitly asks to remove prerequisites from an existing task, remove only those DEPENDS edges through org-edit. Read the whole task and Dialog first and pass its revision. Refuse PROG, DONE, active agents, stale reads, absent edges, ambiguous IDs and invalid remaining graphs. Run only on the task's dispatcher host; a remote task needs that host's June or ${user()}. AUTO becomes HOLD in the same locked save, so removing a gate never launches work. Other states stay unchanged. Keep identity, schedules, unrelated edges and history. note must record ${user()}'s approval and explicitly identify any older prose gate it supersedes; never rewrite Dialog or silently waive other instructions. Afterward re-read the task, reconcile any remaining scope conflicts, then use org_resume_task only if ${user()} authorized starting it. No dispatcher kick or resume occurs here.`,
				parameters: obj({
					file: str({ description: "Org agenda file under ~/org" }),
					heading: str({ description: "id:UUID of the existing task, from org_read_task" }),
					expected: union([lit("TODO"), lit("EVAL"), lit("HOLD"), lit("AUTO")], { description: "State just read; AUTO will be paused at HOLD" }),
					revision: str({ description: "Exact revision returned by org_read_task; a changed task is refused" }),
					remove: arr(str(), { description: "Selected id:UUID edges already in this task's DEPENDS; unrelated edges are preserved" }),
					note: str({ description: `One line recording ${user()}'s approval and specifically which earlier prose gate, if any, is lifted; other instructions remain in force` }),
				}),
				replay: "safe",
				execute: async (args, api) => {
					const result = await dispatch.removeDependencies({ ...args, key: `${instance}:${api.taskId}` }, herdr);
					return { output: [{ type: "text", text: `${JSON.stringify(result, null, 1)}\nNo work was started. Re-read scope and Dialog before a separate authorized org_resume_task.` }] };
				},
			}),
			defineTool({
				name: "org_following",
				description: "List the tasks you are still following, with the last signal each check saw, not a fresh Org or agent read. Follows persist and resume automatically after a daemon restart, including their timing and last reported state. Use this to check what you are watching, rather than re-following tasks after a restart. An empty list means no active follows.",
				parameters: obj({}),
				replay: "safe",
				execute: async (_args, api, context) => ({
					output: [{ type: "text", text: JSON.stringify(await api.commit(listFollowing, context), null, 1) }],
				}),
			}),
			defineTool({
				name: "org_follow_task",
				description: `When ${user()} asks for regular updates on a task or the agent working on it, follow the task: every everyMinutes while it is PROG you get a [follow] message to read its agent and report, and you hear when it blocks, holds, or finishes, as for tasks you queue. Works for any Org task, including ones you did not queue. Never sends the agent anything. Follows persist and resume automatically after a daemon restart; inspect them with org_following, not this tool. Following a task again replaces the earlier follow, so everyMinutes 0 stops the timed updates and keeps the rest.`,
				parameters: obj({
					file: str({ description: "Path under ~/org, as org_search returns it" }),
					heading: str({ description: "Exact title, outline path, or id:UUID, as org_read_task accepts" }),
					everyMinutes: num({ description: "Minutes between updates, at least 2; 0 stops timed updates" }),
					hours: opt(num({ description: "How long timed updates last, 1 to 24; default 4" })),
				}),
				// A replay finds the follow its first run started, by request key.
				replay: "safe",
				execute: async (args, api, context) => {
					if (args.everyMinutes !== 0 && !(args.everyMinutes >= 2)) throw new Error("everyMinutes must be 0 or at least 2");
					const hours = args.hours ?? 4;
					if (!(hours >= 1 && hours <= 24)) throw new Error("hours must be from 1 to 24");
					const task = await org.read(args.file, args.heading);
					const own = task.text.split(/\n(?=\*+ )/)[0]!;
					const id = /^\s*:ID:\s+(\S+)\s*$/m.exec(own)?.[1];
					const host = /^\s*:HOST:\s+(\S+)\s*$/m.exec(own)?.[1] ?? task.herdrSessions.filter((s) => s.pane).at(-1)?.host ?? config.herdr.host;
					const depends = [...(/^\s*:DEPENDS:\s+(.+)$/m.exec(own)?.[1] ?? "").matchAll(/id:([0-9A-Za-z-]+)/g)].map((m) => m[1]!);
					const now = Date.now();
					const input = {
						...(depends.length ? { depends } : {}),
						// Without an ID, the outline path finds the heading again, as org_read_task does.
						...(id ? { id, title: parseHeading(own.split("\n")[0]!, task.line)!.title } : { id: `${task.file}::${task.outline}`, title: task.outline, file: task.file }),
						host,
						queuedAt: now,
						request: `${instance}:${api.taskId}`,
						adopted: true,
						...(args.everyMinutes > 0 ? { everyMs: args.everyMinutes * minute, updatesUntil: now + hours * 60 * minute } : {}),
					};
					await api.commit((tx) => follow(tx, followTask, input, Number(api.conversationId)), context);
					const updates = args.everyMinutes > 0 ? `a progress update every ${args.everyMinutes} minutes while it is PROG, for ${hours} hours, and ` : "";
					return { output: [{ type: "text", text: `Following «${input.title}» on ${host}: you will get ${updates}[follow] messages when it blocks, holds, or finishes.` }] };
				},
			}),
			defineTool({
				name: "org_complete_task",
				description: `After reading the whole task, outcome, and verification evidence, mark your own EVAL task DONE through org-edit. Use only when the request is satisfied and no decision, approval, or review from ${user()} remains. You must have created the task; merely resuming ${user()}'s task does not make it yours. Leave incomplete or uncertain work, and work needing ${user()}'s review, at EVAL and report what remains. Report the reviewed result to ${user()} after closing. Refuses other states; an already DONE task is unchanged on replay.`,
				parameters: obj({
					file: str({ description: "Org agenda file under ~/org" }),
					heading: str({ description: "Exact title or id:UUID of the EVAL task you just reviewed" }),
				}),
				replay: "safe",
				execute: async (args) => ({ output: [{ type: "text", text: JSON.stringify(await dispatch.complete(args.file, args.heading), null, 1) }] }),
			}),
			defineTool({
				name: "org_dispatch_now",
				description: `Run the dispatcher on ${config.herdr.host} now and show what it would launch. Queueing already starts it; use this to retry a task that did not launch.`,
				parameters: obj({}),
				// Starting the dispatcher twice is harmless: it holds a lock and skips running tasks.
				replay: "safe",
				execute: async () => ({ output: [{ type: "text", text: await dispatch.nudge() }] }),
			}),
		],
	});
}
