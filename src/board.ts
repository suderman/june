// The agenda and the agents, for June's clients (see "Agents and projects" in docs/interfaces.org). Emacs computes the
// agenda by Org's own rules (org/agenda/june-agenda.el); hc reports the agents. Both are read-only here: edits go through
// org-edit. A board is computed on request, and kept fresh while a client subscribes.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Config } from "./config.ts";
import type { Logger } from "./runtime.ts";
import { type AgentSummary, Herdr, type Run, runProcess } from "./tools/herdr.ts";
import { orgTime } from "./tools/org.ts";

const REPO = dirname(import.meta.dirname);
const STATES = ["TODO", "AUTO", "PROG", "EVAL", "HOLD", "DONE"] as const;

/** A Dialog entry: who wrote it (Jon, Agent, June, Dispatcher), the Org timestamp it carries, and what it says. */
export type DialogEntry = { who: string; at?: string; text: string };

/** One Org heading. `file` is relative to the Org root; `key` is id:UUID, else FILE::*Outline/Path/Title. */
export type Task = {
	key: string;
	id?: string;
	file: string;
	line: number;
	level: number;
	title: string;
	state?: string;
	priority?: string;
	tags: string[];
	/** The headings above it. */
	path: string[];
	/** The file's #+TITLE, else its category. */
	project: string;
	scheduled?: string;
	deadline?: string;
	closed?: string;
	/** For AUTO, who runs it and where, as the dispatcher will resolve them; else the drawer's HOST and AGENT. */
	host?: string;
	agent?: string;
	/** Why the dispatcher cannot run it as it stands. */
	problem?: string;
	depends?: string[];
	/** Who reviews it at EVAL, as the dispatcher reads REVIEW (inherited from the file too): jon, agent, or none. */
	review?: string;
	/** The phase of its independent review loop (REVIEW_PHASE): review, fixes, human, or escalated; gone once accepted. */
	reviewPhase?: string;
	/** When it was put to the user: an EVAL with a question or a problem for them (ASKED). */
	asked?: string;
	/** For an independent review task, the ID of the development task it reviews (REVIEW_PARENT). */
	reviewParent?: string;
	/** The task has an independent development and review loop under way (REVIEW_PHASE). */
	devReview?: true;
	/** For AUTO with DEPENDS, the dispatcher's verdict: ready, waiting, or blocked, with the task it waits on. */
	dependency?: { kind: string; reason?: string };
	/** The worker's last one-line report, the state it was written for, and when (epoch ms). */
	headline?: { text: string; state?: string; at?: number };
	sessions: string[];
	dialog?: DialogEntry[];
};

/** One line of Org's agenda on a day: `type` is Org's (scheduled, past-scheduled, deadline, upcoming-deadline, timestamp, block, sexp). */
export type AgendaEntry = { task: string; type: string; time?: string; extra?: string; date?: string };

export type Agenda = {
	generatedAt: number;
	today: string;
	/** Scheduled items and deadlines from before today that are still open. */
	overdue: AgendaEntry[];
	/** Today first, then the following days. */
	days: { date: string; entries: AgendaEntry[] }[];
	tasks: Record<string, Task>;
	counts: Partial<Record<(typeof STATES)[number], number>>;
	/** Each file holding open tasks, with its counts, most open first. */
	projects: { file: string; title: string; counts: Partial<Record<(typeof STATES)[number], number>> }[];
};

export type Worker = AgentSummary & { /** The Org task it works on, by key. */ taskKey?: string };

/**
 * Something that needs the user, most urgent first: 1, a worker blocked on a permission or question dialog, which
 * only Herdr can answer; 2, a task newly in EVAL for them, until they have seen it: a question or a problem put to
 * them (ASKED), or work ready for their review. HOLD is never a need: it means the task waits on something outside,
 * and the user has done what they can. EVAL that agents are reviewing is not theirs yet.
 */
export type Need = { level: 1 | 2; kind: "blocked" | "asks" | "review"; task?: string; worker?: { host: string; terminal: string }; since?: number };

export type Agents = {
	generatedAt: number;
	hosts: { host: string; ok: boolean; error?: string }[];
	workers: Worker[];
	needs: Need[];
	/** AUTO tasks by start time, soonest first. */
	queued: string[];
	/** Tasks in EVAL that agents are reviewing: open independent reviews, the development tasks they review, and standing (REVIEW agent) reviews the dispatcher has yet to start or advance. */
	reviewing: string[];
	/** Tasks a worker reported on in the last day, newest first, apart from those in needs. */
	recent: string[];
	/** Every task the lists above name. */
	tasks: Record<string, Task>;
};

/** The JSON june-agenda.el prints, before it is shaped for clients. */
type Raw = { today: string; days: { date: string; entries: AgendaEntry[] }[]; tasks: Record<string, any> };

/** The argv that runs the export: this checkout's Emacs Lisp, Calgary zone data, and `env` for tests. */
export function exportArgv(listFile: string, env: Record<string, string> = {}): string[] {
	const zones = process.env.TZDIR ?? (existsSync("/usr/share/zoneinfo") ? undefined : "/etc/zoneinfo");
	const vars = { ...(zones ? { TZDIR: zones } : {}), ...env };
	return ["env", ...Object.entries(vars).map(([k, v]) => `${k}=${v}`), "emacs", "-Q", "--batch",
		"-l", join(REPO, "org/dispatch/org-dispatch.el"), "-l", join(REPO, "org/agenda/june-agenda.el"), "-f", "june-agenda-export", listFile];
}

/** Run the export and shape it. The JSON is the last line; Org may log before it. */
export async function loadAgenda(listFile: string, root: string, run: Run = runProcess, env?: Record<string, string>, now = Date.now()): Promise<Agenda> {
	const out = await run(exportArgv(listFile, env), 120_000);
	const last = out.trimEnd().split("\n").pop() ?? "";
	return shapeAgenda(JSON.parse(last) as Raw, root, now);
}

const compact = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined)) as T;

export function shapeAgenda(raw: Raw, root: string, now = Date.now()): Agenda {
	// Without an ID, a task is named by its file and outline path, which edits elsewhere in the file leave alone; the
	// export's FILE::LINE keys are mapped to those. A repeated path in one file takes its line as well.
	const tasks: Record<string, Task> = {};
	const keys = new Map<string, string>();
	for (const [key, t] of Object.entries(raw.tasks)) {
		const task = shapeTask(key, t, root);
		if (tasks[task.key] !== undefined) task.key = `${task.key}::${task.line}`;
		tasks[task.key] = task;
		keys.set(key, task.key);
	}
	const entry = (e: AgendaEntry) => compact({ ...e, task: keys.get(e.task) ?? e.task });
	const [first, ...rest] = raw.days;
	const later = new Set(rest.map((day) => day.date));
	const overdue: AgendaEntry[] = [];
	const today: AgendaEntry[] = [];
	for (const item of (first?.entries ?? []).map(entry)) {
		const past = item.date !== undefined && item.date < raw.today;
		if (item.type === "past-scheduled" || (item.type === "deadline" && past)) overdue.push(item);
		// A deadline coming up this week is shown on its own day, not also as today's warning.
		else if (!(item.type === "upcoming-deadline" && item.date !== undefined && later.has(item.date))) today.push(item);
	}
	// As Org's agenda sorts a day: timed items first, by time; the rest keep the agenda files' order.
	const byTime = (entries: AgendaEntry[]) => entries.map((e, i) => ({ e, i })).sort((a, b) => (a.e.time ?? "99").localeCompare(b.e.time ?? "99") || a.i - b.i).map(({ e }) => e);
	const days = [{ date: first?.date ?? raw.today, entries: byTime(today) }, ...rest.map((day) => ({ date: day.date, entries: byTime(day.entries.map(entry)) }))];
	const counts: Agenda["counts"] = {};
	const files = new Map<string, Agenda["projects"][number]>();
	for (const task of Object.values(tasks)) {
		if (task.state === undefined) continue;
		const state = task.state as keyof Agenda["counts"];
		counts[state] = (counts[state] ?? 0) + 1;
		const project = files.get(task.file) ?? { file: task.file, title: task.project, counts: {} };
		project.counts[state] = (project.counts[state] ?? 0) + 1;
		files.set(task.file, project);
	}
	const open = (p: Agenda["projects"][number]) => STATES.filter((s) => s !== "DONE").reduce((n, s) => n + (p.counts[s] ?? 0), 0);
	const projects = [...files.values()].filter((p) => open(p) > 0).sort((a, b) => open(b) - open(a) || a.title.localeCompare(b.title));
	return { generatedAt: now, today: raw.today, overdue, days, tasks, counts, projects };
}

function shapeTask(key: string, t: any, root: string): Task {
	const file = relative(root, t.file);
	const at = Number(t.headlineAt);
	return compact({
		key: key.startsWith("id:") ? key : `${file}::*${[...(t.path ?? []), t.title].join("/")}`,
		id: t.id ?? undefined,
		file,
		line: t.line,
		level: t.level,
		title: t.title,
		state: t.state ?? undefined,
		priority: t.priority ?? undefined,
		tags: t.tags ?? [],
		path: t.path ?? [],
		project: t.fileTitle ?? t.category ?? file,
		scheduled: t.scheduled ?? undefined,
		deadline: t.deadline ?? undefined,
		closed: t.closed ?? undefined,
		host: t.host ?? undefined,
		agent: t.agent ?? undefined,
		problem: t.problem ?? undefined,
		depends: t.depends ? String(t.depends).split(/\s+/).filter(Boolean) : undefined,
		review: t.review ?? undefined,
		reviewPhase: t.reviewPhase ?? undefined,
		asked: t.asked ?? undefined,
		reviewParent: t.reviewParent ?? undefined,
		devReview: t.devReview === true ? true : undefined,
		dependency: t.dependency ? compact({ kind: t.dependency.kind, reason: t.dependency.reason ?? undefined }) : undefined,
		headline: t.headline ? compact({ text: t.headline, state: t.headlineState ?? undefined, at: Number.isFinite(at) && at > 0 ? Math.round(at * 1000) : undefined }) : undefined,
		sessions: t.sessions ?? [],
		dialog: t.dialog ? parseDialog(t.dialog) : undefined,
	});
}

/** Dialog's list items, `- Who [timestamp]: text`, with indented continuation lines joined to the entry above. */
export function parseDialog(text: string): DialogEntry[] {
	const entries: DialogEntry[] = [];
	for (const line of text.split("\n")) {
		const start = /^- ([A-Z][\w-]*(?: [A-Z][\w-]*)?) (\[[^\]]+\])(?:\s*:)?\s?(.*)$/.exec(line);
		if (start) entries.push({ who: start[1]!, at: start[2]!, text: start[3]!.replace(/^:\s*/, "") });
		else if (line.startsWith("- ")) entries.push({ who: "", text: line.slice(2) });
		else if (entries.length > 0 && line.trim() !== "") entries.at(-1)!.text += `\n${line.trim()}`;
	}
	return entries;
}

const DAY = 86_400_000;

/**
 * Join live workers to their Org tasks and rank what needs the user. `seen` holds the review marks already seen
 * (reviewKey); a task in EVAL is a need until its mark is seen.
 */
export function shapeAgents(input: { workers: AgentSummary[]; hosts: Agents["hosts"]; agenda: Agenda; seen: ReadonlySet<string>; now?: number }): Agents {
	const { agenda, seen } = input;
	const now = input.now ?? Date.now();
	const byId = new Map<string, Task>();
	const bySession = new Map<string, Task>();
	for (const task of Object.values(agenda.tasks)) {
		if (task.id) byId.set(task.id, task);
		for (const link of task.sessions) {
			const session = /:([0-9a-f-]{36})/.exec(link)?.[1];
			if (session) bySession.set(session, task);
		}
	}
	const workers: Worker[] = input.workers.map((w) => {
		const task = (w.task ? byId.get(w.task) : undefined) ?? (w.session ? bySession.get(w.session) : undefined);
		return task ? { ...w, taskKey: task.key } : { ...w };
	});
	const needs: Need[] = [];
	for (const w of workers) if (w.status === "blocked") needs.push({ level: 1, kind: "blocked", worker: { host: w.host, terminal: w.terminal }, ...(w.taskKey ? { task: w.taskKey } : {}) });
	const tasks = Object.values(agenda.tasks);
	// A development task is under agent review while a review of it is still open; the review task itself is June's to advance.
	const underReview = new Set(tasks.filter((t) => t.reviewParent && t.state !== "DONE").map((t) => t.reviewParent!));
	const standing = (t: Task) => t.review === "agent" && [undefined, "review", "fixes"].includes(t.reviewPhase);
	const reviewing = tasks.filter((t) => t.state === "EVAL" && t.asked === undefined &&
		(t.reviewParent !== undefined || (t.id !== undefined && underReview.has(t.id)) || standing(t))).map((t) => t.key);
	const agentReview = new Set(reviewing);
	for (const task of tasks) {
		if (seen.has(reviewKey(task))) continue;
		if (task.state === "EVAL" && !agentReview.has(task.key))
			needs.push({ level: 2, kind: task.asked !== undefined ? "asks" : "review", task: task.key, ...since(task) });
		// The dispatcher's one HOLD for the user: a review that could not start for certain (HOLD with ASKED).
		else if (task.state === "HOLD" && task.asked !== undefined) needs.push({ level: 2, kind: "asks", task: task.key, ...since(task) });
	}
	needs.sort((a, b) => a.level - b.level || (b.since ?? 0) - (a.since ?? 0));
	const needed = new Set(needs.map((n) => n.task).filter(Boolean));
	const start = (task: Task) => (task.scheduled ? orgTime(task.scheduled) : undefined) ?? 0;
	const queued = tasks.filter((t) => t.state === "AUTO").sort((a, b) => start(a) - start(b)).map((t) => t.key);
	const recent = tasks
		.filter((t) => t.headline?.at !== undefined && now - t.headline.at < DAY && !needed.has(t.key) && ["EVAL", "HOLD", "DONE"].includes(t.state ?? ""))
		.sort((a, b) => b.headline!.at! - a.headline!.at!)
		.map((t) => t.key);
	const named = new Set([...workers.map((w) => w.taskKey), ...needed, ...queued, ...reviewing, ...recent].filter((k): k is string => k !== undefined));
	return { generatedAt: now, hosts: input.hosts, workers, needs, queued, reviewing, recent, tasks: Object.fromEntries([...named].map((k) => [k, agenda.tasks[k]!])) };
}

function since(task: Task): { since?: number } {
	return task.headline?.at !== undefined && task.headline.state === task.state ? { since: task.headline.at } : {};
}

/** The mark that says the user has seen a task's review: a new report, a new question or a new trip to EVAL makes a new one. */
export function reviewKey(task: Task): string {
	return `${task.key}@${task.headline?.state === "EVAL" ? (task.headline.at ?? "") : ""}${task.asked ? `@${task.asked}` : ""}`;
}

/** Review marks the user has seen, kept in the state directory so every device agrees. */
export class Seen {
	readonly #file: string;
	#marks: Set<string> | undefined;

	constructor(file: string) {
		this.#file = file;
	}

	/** Whether marks were ever saved; before then, every current review counts as seen, so nothing old floods in. */
	get started(): boolean {
		return this.#load() !== undefined;
	}

	marks(): ReadonlySet<string> {
		return this.#load() ?? new Set();
	}

	add(marks: Iterable<string>): void {
		this.#save([...new Set([...(this.#load() ?? []), ...marks])]);
	}

	/** Keep only marks for reviews still open, so the file does not grow without end. */
	prune(open: ReadonlySet<string>): void {
		const marks = this.#load();
		if (marks && [...marks].some((m) => !open.has(m))) this.#save([...marks].filter((m) => open.has(m)));
	}

	#save(marks: string[]): void {
		const tmp = `${this.#file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(marks)}\n`, { mode: 0o600 });
		renameSync(tmp, this.#file);
		this.#marks = new Set(marks);
	}

	#load(): Set<string> | undefined {
		if (this.#marks === undefined && existsSync(this.#file)) {
			try {
				this.#marks = new Set(JSON.parse(readFileSync(this.#file, "utf8")));
			} catch {
				this.#marks = new Set();
			}
		}
		return this.#marks;
	}
}

export type BoardsOptions = {
	config: Config;
	seenFile: string;
	log: Logger;
	herdr?: Herdr;
	run?: Run;
	/** Extra environment for the Emacs export, for tests. */
	env?: Record<string, string>;
	/** How often the agents are checked while a client subscribes. */
	agentsMs?: number;
	/** How often the agenda is recomputed while a client subscribes, beside file changes. */
	agendaMs?: number;
};

type Held<T> = { value: T; revision: string; at: number };

/**
 * The two boards. Each is computed once at a time; while any client subscribes, the agenda follows changes to the
 * agenda files and the agents are checked every `agentsMs`, and listeners hear of a new revision.
 */
export class Boards {
	readonly #o: Required<Omit<BoardsOptions, "env" | "herdr">> & { env?: Record<string, string>; herdr: Herdr };
	readonly #seen: Seen;
	readonly #listeners = new Set<() => void>();
	#agenda?: Held<Agenda>;
	#agents?: Held<Agents>;
	#workers?: { workers: AgentSummary[]; hosts: Agents["hosts"] };
	#agendaRun?: Promise<Held<Agenda>>;
	#workersRun?: Promise<void>;
	#subscribers = 0;
	#timers: ReturnType<typeof setInterval>[] = [];
	#watchers: FSWatcher[] = [];
	#debounce?: ReturnType<typeof setTimeout>;
	/** When the agenda files were first watched in the current subscription. */
	#watchedSince?: number;

	constructor(options: BoardsOptions) {
		this.#o = { run: runProcess, agentsMs: 15_000, agendaMs: 600_000, herdr: new Herdr(options.config.herdr), ...options };
		this.#seen = new Seen(options.seenFile);
	}

	revisions(): { agenda?: string; agents?: string } {
		return { ...(this.#agenda ? { agenda: this.#agenda.revision } : {}), ...(this.#agents ? { agents: this.#agents.revision } : {}) };
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The agenda, recomputed unless it is under `maxAgeMs` old or was computed while its files were watched. */
	async agenda(maxAgeMs = 30_000): Promise<Held<Agenda>> {
		const held = this.#agenda;
		const watched = this.#watchedSince !== undefined && held !== undefined && held.at >= this.#watchedSince;
		if (held && (watched || Date.now() - held.at < maxAgeMs)) return held;
		return this.#refreshAgenda();
	}

	/** The agents, with hc checked again once they are `maxAgeMs` old; a subscription checks every `agentsMs`. */
	async agents(maxAgeMs = 20_000): Promise<Held<Agents>> {
		await this.agenda();
		if (!this.#agents || !this.#workers || Date.now() - this.#agents.at >= maxAgeMs) await this.#refreshWorkers();
		return this.#agents!;
	}

	/** Mark reviews seen, by task key; answers with the agents board they change. */
	async seen(keys: readonly string[]): Promise<Held<Agents>> {
		const agenda = (await this.agenda()).value;
		const marks = keys.map((k) => agenda.tasks[k]).filter((t): t is Task => t?.state === "EVAL").map(reviewKey);
		if (marks.length > 0) {
			this.#seen.add(marks);
			this.#recompute();
		}
		return this.agents();
	}

	/** Keep both boards fresh until the returned function is called. */
	subscribe(): () => void {
		if (this.#subscribers++ === 0) this.#start();
		let done = false;
		return () => {
			if (done) return;
			done = true;
			if (--this.#subscribers === 0) this.#stop();
		};
	}

	stop(): void {
		this.#subscribers = 0;
		this.#stop();
	}

	#start(): void {
		this.#watchedSince = Date.now();
		void this.#refreshAgenda().catch(() => {});
		this.#timers.push(
			setInterval(() => void this.#refreshWorkers().catch(() => {}), this.#o.agentsMs),
			setInterval(() => void this.#refreshAgenda().catch(() => {}), this.#o.agendaMs),
		);
		this.#watch();
	}

	#stop(): void {
		this.#watchedSince = undefined;
		for (const timer of this.#timers) clearInterval(timer);
		for (const watcher of this.#watchers) watcher.close();
		clearTimeout(this.#debounce);
		this.#timers = [];
		this.#watchers = [];
	}

	/** Watch each agenda file's directory, and the list's, since editors and Syncthing replace files rather than write them. */
	#watch(): void {
		const list = this.#o.config.org.agendaFiles;
		let files: Set<string>;
		try {
			files = new Set(readFileSync(list, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
		} catch {
			files = new Set();
		}
		const dirs = new Set([...files].map((f) => dirname(f)));
		dirs.add(dirname(list));
		for (const dir of dirs) {
			try {
				this.#watchers.push(watch(dir, (_event, name) => {
					const path = name ? join(dir, name.toString()) : "";
					if (path === list || files.has(path)) this.#soon();
				}));
			} catch (error) {
				this.#o.log.warn("agenda_watch_failed", { dir, error: (error as Error).message });
			}
		}
	}

	#soon(): void {
		clearTimeout(this.#debounce);
		this.#debounce = setTimeout(() => void this.#refreshAgenda().catch(() => {}), 2_000);
	}

	#refreshAgenda(): Promise<Held<Agenda>> {
		return (this.#agendaRun ??= (async () => {
			try {
				const value = await loadAgenda(this.#o.config.org.agendaFiles, this.#o.config.org.root, this.#o.run, this.#o.env);
				const held = hold(value, this.#agenda);
				this.#agenda = held;
				this.#recompute();
				return held;
			} catch (error) {
				this.#o.log.warn("agenda_failed", { error: (error as Error).message.slice(0, 500) });
				if (this.#agenda) return this.#agenda;
				throw error;
			} finally {
				this.#agendaRun = undefined;
			}
		})());
	}

	#refreshWorkers(): Promise<void> {
		return (this.#workersRun ??= (async () => {
			try {
				const herdr = this.#o.herdr;
				const results = await Promise.all(herdr.hosts().map(async (host) => {
					try {
						return { host, ok: true, workers: await herdr.agents(host) };
					} catch (error) {
						return { host, ok: false, error: (error as Error).message.slice(0, 200), workers: [] as AgentSummary[] };
					}
				}));
				this.#workers = {
					workers: results.flatMap((r) => r.workers),
					hosts: results.map((r) => ({ host: r.host, ok: r.ok, ...(r.error ? { error: r.error } : {}) })),
				};
				this.#recompute();
			} finally {
				this.#workersRun = undefined;
			}
		})());
	}

	/** Join the latest agenda and workers into the agents board, and tell listeners when either board changed. */
	#recompute(): void {
		if (!this.#agenda) return;
		const agenda = this.#agenda.value;
		const reviews = Object.values(agenda.tasks).filter((t) => t.state === "EVAL").map(reviewKey);
		if (!this.#seen.started) this.#seen.add(reviews);
		else this.#seen.prune(new Set(reviews));
		const before = this.revisions();
		if (this.#workers) {
			const value = shapeAgents({ ...this.#workers, agenda, seen: this.#seen.marks() });
			this.#agents = hold(value, this.#agents);
		}
		const after = this.revisions();
		if (before.agenda !== after.agenda || before.agents !== after.agents) for (const listener of this.#listeners) listener();
	}
}

/** A value with the revision of its content, which leaves out when it was made; the old one stays if nothing changed. */
function hold<T extends { generatedAt: number }>(value: T, old: Held<T> | undefined): Held<T> {
	const { generatedAt: _, ...content } = value;
	const revision = createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16);
	return old?.revision === revision ? { ...old, at: Date.now() } : { value, revision, at: Date.now() };
}
