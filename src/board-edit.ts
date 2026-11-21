// The user's own edits from June's boards (see "Agents and projects" in docs/interfaces.org): a task's state, its
// assignment to a clanker (AUTO with a host and agent), a Dialog reply, optionally resuming the worker with it, and
// its SCHEDULED or DEADLINE. Each is one org-edit call, as June's own task tools make them, with the state the board
// showed as --expect, so a task changed since is refused rather than overwritten. These are the user's acts, sent by
// their client; June is not asked.
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import type { Task } from "./board.ts";
import { type Run, runProcess } from "./tools/herdr.ts";

const REPO = dirname(import.meta.dirname);
/** This checkout's org-edit, so the boards use the commands they were written with; it shares the dispatcher's lock. */
const ORG_EDIT = join(REPO, "org/edit/org-edit");

export type TaskEdit =
	| { action: "state"; state: "TODO" | "PROG" | "EVAL" | "HOLD" | "DONE" }
	| { action: "assign"; agent: string; host?: string }
	| { action: "reply"; text: string; resume?: boolean }
	| { action: "schedule" | "deadline"; when: string };

const SETTABLE = ["TODO", "PROG", "EVAL", "HOLD", "DONE"];

/** How org-edit names a task: its ID, else its outline path. */
export function headingOf(task: Task): string {
	return task.id ? `id:${task.id}` : [...task.path, task.title].join(" / ");
}

export class TaskEdits {
	readonly #config: Config;
	readonly #run: Run;

	constructor(config: Config, run: Run = runProcess) {
		this.#config = config;
		this.#run = run;
	}

	/** The agent a task is run by: its AGENT, else its newest session's, else the dispatcher's default. */
	agentOf(task: Task): string {
		const last = task.sessions.length ? task.sessions[task.sessions.length - 1]! : "";
		return task.agent ?? /^herdr:[^/]+\/([a-z]+):/.exec(last)?.[1] ?? this.#config.dispatch.agent ?? "pi";
	}

	hostOf(task: Task): string {
		return task.host ?? this.#config.dispatch.host ?? this.#config.dispatch.hosts[0] ?? this.#config.herdr.host;
	}

	/** Apply EDIT to TASK through org-edit; resolves with what org-edit printed. `request` makes an AUTO grant replayable. */
	async apply(task: Task, edit: TaskEdit, request: string): Promise<string> {
		const file = join(this.#config.org.root, task.file);
		const heading = headingOf(task);
		const user = this.#config.user.name ?? "User";
		const edit_ = (...args: string[]) => this.#run(["bash", ORG_EDIT, ...args], 120_000);
		switch (edit.action) {
			case "state": {
				if (!SETTABLE.includes(edit.state)) throw new Error(`State must be one of ${SETTABLE.join(", ")}; assign a clanker for AUTO`);
				if (!task.state) throw new Error("That heading has no state to change");
				return edit_("todo", file, heading, edit.state, "--expect", task.state);
			}
			case "assign":
				return this.#assign(task, file, heading, edit.agent, edit.host ?? this.hostOf(task), request, `${user} assigned it to ${edit.agent} on ${edit.host ?? this.hostOf(task)} from June's board.`);
			case "reply": {
				const text = String(edit.text ?? "").trim();
				if (text === "" || text.length > 4000) throw new Error("A reply needs words, at most 4000 characters");
				const out = await edit_("reply", file, heading, JSON.stringify({ who: user, text }));
				if (!edit.resume) return out;
				return out + await this.#assign(task, file, heading, this.agentOf(task), this.hostOf(task), request, `${user} replied in Dialog and resumed it from June's board.`);
			}
			case "schedule":
			case "deadline": {
				const when = String(edit.when ?? "").trim();
				if (when === "" || /[\n\r]/.test(when)) throw new Error("Give a date such as fri 9:00, 2026-11-28, +2d, or none to clear it");
				return edit_(edit.action, file, heading, when);
			}
			default:
				throw new Error(`Unknown edit ${(edit as { action?: unknown }).action}`);
		}
	}

	#assign(task: Task, file: string, heading: string, agent: string, host: string, request: string, note: string): Promise<string> {
		if (!["TODO", "EVAL", "HOLD"].includes(task.state ?? "")) throw new Error("Only a TODO, EVAL or HOLD task can be assigned; stop a running one first");
		const agents = this.#config.dispatch.agents ?? [this.#config.dispatch.agent ?? "pi"];
		if (!agents.includes(agent)) throw new Error(`Agent must be one of ${agents.join(", ")}`);
		if (this.#config.dispatch.hosts.length > 0 && !this.#config.dispatch.hosts.includes(host)) throw new Error(`Host must be one of ${this.#config.dispatch.hosts.join(", ")}`);
		return this.#run(["bash", ORG_EDIT, "todo", file, heading, "AUTO", "--expect", task.state!, "--request", request, "--host", host, "--agent", agent, "--note", note], 120_000);
	}
}
