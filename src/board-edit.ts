// The user's own edits from June's boards (see "Agents and projects" in docs/interfaces.org): a task's state, its
// assignment to a clanker (AUTO with a host and agent, optionally from a start time), a Dialog reply, optionally
// resuming the worker with it, its SCHEDULED or DEADLINE, and its title. Each is an org-edit call, as June's own task
// tools make them, with the state or revision the board showed, so a task changed since is refused rather than
// overwritten. These are the user's acts, sent by their client and written in their name; June is not asked. In a
// protected file (org.protected), which another program rebuilds, the boards only set TODO or DONE.
import { dirname, join } from "node:path";
import { type Config, protectedOf } from "./config.ts";
import { outlineKey, type Task } from "./board.ts";
import { OrgEditError, type OrgWorker, OrgWorkerDown } from "./org-worker.ts";
import { findCard, readClankers } from "./roster.ts";
import { type Run, runProcess } from "./tools/herdr.ts";

const REPO = dirname(import.meta.dirname);
/** This checkout's org-edit, so the boards use the commands they were written with; it shares the dispatcher's lock. */
const ORG_EDIT = join(REPO, "org/edit/org-edit");

export type TaskEdit =
	| { action: "state"; state: "TODO" | "PROG" | "EVAL" | "HOLD" | "DONE"; /** Putting back the last change: its reverse is allowed. */ undo?: boolean }
	| { action: "assign"; agent: string; host?: string; when?: string }
	| { action: "reply"; text: string; resume?: boolean }
	| { action: "schedule" | "deadline"; when: string }
	| { action: "title"; title: string };

const SETTABLE = ["TODO", "PROG", "EVAL", "HOLD", "DONE"];

/** desktop/board.mjs FLOW: where each state may go; an undo may make a move's reverse. */
const FLOW: Record<string, string[]> = {
	TODO: ["AUTO", "PROG", "HOLD", "DONE"],
	PROG: ["TODO", "EVAL", "HOLD", "DONE"],
	EVAL: ["TODO", "PROG", "AUTO", "HOLD", "DONE"],
	AUTO: ["TODO", "HOLD", "DONE"],
	HOLD: ["TODO", "PROG", "AUTO", "DONE"],
	DONE: ["TODO"],
};
const flows = (from: string, to: string, undo: boolean) => (FLOW[from] ?? []).includes(to) || (undo && (FLOW[to] ?? []).includes(from));
const ASSIGNABLE = ["TODO", "EVAL", "HOLD"];

/** How org-edit names a task: its ID, else its outline path. */
export function headingOf(task: Task): string {
	return task.id ? `id:${task.id}` : [...task.path, task.title].join(" / ");
}

/** How long a board edit waits for the dispatcher's lock, which it holds through each pass (8 to 12 s on kit). */
const LOCK_WAIT_S = 25;

/** What org-edit said, without the command line: its last line of stderr. */
function said(error: unknown): string {
	const e = error as { stderr?: string; message?: string; exitCode?: number };
	const lines = String(e.stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
	if (e.exitCode === 75) return `The dispatcher held the file for over ${LOCK_WAIT_S} s; try again`;
	return lines.length > 0 ? lines[lines.length - 1]! : "org-edit failed without saying why";
}

export class TaskEdits {
	readonly #config: Config;
	readonly #run: Run;
	readonly #org: OrgWorker | undefined;
	readonly #dataDir: string | undefined;

	/** ORG, June's long-running Emacs, makes the edits when it is up; RUN runs the org-edit wrapper otherwise. */
	constructor(config: Config, run: Run = runProcess, org?: OrgWorker, dataDir?: string) {
		this.#config = config;
		this.#run = run;
		this.#org = org;
		this.#dataDir = dataDir;
	}

	/** The agent a task is run by: its AGENT, else its newest session's, else the dispatcher's default. */
	agentOf(task: Task): string {
		const last = task.sessions.length ? task.sessions[task.sessions.length - 1]! : "";
		return task.agent ?? /^herdr:[^/]+\/([a-z]+):/.exec(last)?.[1] ?? this.#config.dispatch.agent ?? "pi";
	}

	hostOf(task: Task): string {
		return task.host ?? this.#config.dispatch.host ?? this.#config.dispatch.hosts[0] ?? this.#config.herdr.host;
	}

	/** Apply EDIT to TASK; resolves with what org-edit printed and the task's key afterwards. `request` makes an AUTO
	 * grant replayable. */
	async apply(task: Task, edit: TaskEdit, request: string): Promise<{ text: string; key: string }> {
		const file = join(this.#config.org.root, task.file);
		const heading = headingOf(task);
		const user = this.#config.user.name ?? "User";
		let key = task.key;
		if (task.protected && !(edit.action === "state" && (edit.state === "TODO" || edit.state === "DONE"))) {
			throw new Error(`${task.file} is rebuilt by another program; only TODO or DONE can be set there`);
		}
		const text = await (async () => {
			switch (edit.action) {
				case "state": {
					if (!SETTABLE.includes(edit.state)) throw new Error(`State must be one of ${SETTABLE.join(", ")}; assign a clanker for AUTO`);
					if (!task.state) throw new Error("That heading has no state to change");
					if (!task.protected && !flows(task.state, edit.state, edit.undo === true)) throw new Error(`${task.state} does not go to ${edit.state}; its next states are ${(FLOW[task.state] ?? []).filter((s) => s !== "AUTO").join(", ")}`);
					return this.#edit("todo", file, heading, edit.state, "--expect", task.state, ...(task.protected ? ["--protected"] : []));
				}
				case "assign": {
					const host = edit.host ?? this.hostOf(task);
					this.#assignable(task, edit.agent, host);
					// A start time goes in first, so the dispatcher never sees the task AUTO without it.
					const when = String(edit.when ?? "").trim();
					if (when !== "") await this.#edit("schedule", file, heading, this.#when(when));
					return this.#assign(task, file, heading, edit.agent, host, request, `Handed to ${edit.agent} on ${host} from June's board.`, user);
				}
				case "reply": {
					const text = String(edit.text ?? "").trim();
					if (text === "" || text.length > 4000) throw new Error("A reply needs words, at most 4000 characters");
					const agent = this.agentOf(task);
					const host = this.hostOf(task);
					if (edit.resume) this.#assignable(task, agent, host);
					const out = await this.#edit("reply", file, heading, JSON.stringify({ who: user, text }));
					if (!edit.resume) return out;
					return out + await this.#assign(task, file, heading, agent, host, request, `Resumed with ${agent} on ${host} from June's board.`, user);
				}
				case "title": {
					const title = String(edit.title ?? "").trim();
					if (title === "" || /[\n\r]/.test(title)) throw new Error("A title is one line of words");
					if (!task.revision) throw new Error("The board has no revision for that task yet; wait for it to refresh");
					// A queued task is renamed under the dispatcher's lock (org-edit update-task), never running work.
					if (!["TODO", "EVAL", "HOLD", "AUTO", undefined].includes(task.state)) throw new Error("Only a plain, TODO, EVAL, HOLD or queued AUTO task can be renamed, never running work");
					const out = await this.#edit("update-task", file, heading, JSON.stringify({ revision: task.revision, request, note: `${user} renamed it from June's board.`, title }));
					if (!task.id) key = outlineKey(task.file, task.path, title);
					return out;
				}
				case "schedule":
				case "deadline": {
					const when = String(edit.when ?? "").trim();
					if (when === "") throw new Error("Give a date such as fri 9:00, 2026-11-28, +2d, or none to clear it");
					// A queued task's start moves only while nothing has launched it, checked under the dispatcher's lock.
					if (edit.action === "schedule" && task.state === "AUTO") {
						if (!task.id || !task.revision) throw new Error("A queued task's start moves once the board has its ID and revision; wait for it to refresh");
						if (!/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/.test(when)) throw new Error("Pick a date and time for a queued task's new start");
						return this.#edit("reschedule-task", file, heading, when, JSON.stringify({ revision: task.revision, request, note: "Moved from June's board.", who: user }));
					}
					return this.#edit(edit.action, file, heading, this.#when(when));
				}
				default:
					throw new Error(`Unknown edit ${(edit as { action?: unknown }).action}`);
			}
		})();
		return { text, key };
	}

	#when(when: string): string {
		if (/[\n\r]/.test(when) || when.length > 60) throw new Error("Give a date such as fri 9:00, 2026-11-28, +2d, or none to clear it");
		return when;
	}

	#assignable(task: Task, agent: string, host: string): void {
		if (!ASSIGNABLE.includes(task.state ?? "")) throw new Error("Only a TODO, EVAL or HOLD task can be handed to a clanker; stop a running one first");
		const agents = this.#config.dispatch.agents ?? [this.#config.dispatch.agent ?? "pi"];
		if (!agents.includes(agent)) {
			const card = this.#dataDir ? findCard(readClankers(this.#dataDir), agent) : undefined;
			if (!card) throw new Error(`Agent must be one of ${agents.join(", ")}`);
			if (card.problems.length) throw new Error(`${card.name} cannot be used: ${card.problems.join("; ")}`);
		}
		if (this.#config.dispatch.hosts.length > 0 && !this.#config.dispatch.hosts.includes(host)) throw new Error(`Host must be one of ${this.#config.dispatch.hosts.join(", ")}`);
	}

	#assign(task: Task, file: string, heading: string, agent: string, host: string, request: string, note: string, user: string): Promise<string> {
		return this.#edit("todo", file, heading, "AUTO", "--expect", task.state!, "--request", request, "--host", host, "--agent", agent, "--who", user, "--note", note);
	}

	/** One org-edit call, waiting its turn behind a dispatcher pass rather than failing. */
	async #edit(...args: string[]): Promise<string> {
		if (this.#org) {
			try {
				return await this.#org.edit(args, LOCK_WAIT_S);
			} catch (error) {
				if (error instanceof OrgEditError) throw new Error(said({ stderr: error.message, exitCode: error.exitCode }));
				if (!(error instanceof OrgWorkerDown)) throw error;
				// The worker is down: the one-off command still works, only slower.
			}
		}
		const argv = ["env", `ORG_EDIT_PROTECTED=${protectedOf(this.#config.org).join(":")}`, `ORG_EDIT_WAIT=${LOCK_WAIT_S}`, "bash", ORG_EDIT, ...args];
		try {
			return await this.#run(argv, (LOCK_WAIT_S + 60) * 1000);
		} catch (error) {
			throw new Error(said(error));
		}
	}
}
