// June's long-running Emacs for Org (org/server/june-org-server.el): the board's edits and agenda reads go to one
// Emacs that stays up, instead of a batch Emacs per call that spends most of its time starting, loading Org and reading
// every agenda file. Requests go one at a time. An edit holds the dispatcher's lock around it, as the org-edit wrapper
// does, waiting its turn behind a dispatcher pass. A request that hangs, or an Emacs that dies, is restarted; a caller
// that gets OrgWorkerDown falls back to the one-off commands.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Logger } from "./runtime.ts";

const REPO = dirname(import.meta.dirname);
const ORG = join(REPO, "org");

/** The worker could not answer: not started, crashed, or timed out. Callers use the one-off commands instead. */
export class OrgWorkerDown extends Error {}

/** org-edit's own refusal, with the exit code the wrapper would give: 75 when the dispatcher held the lock. */
export class OrgEditError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode = 1) {
		super(message);
		this.exitCode = exitCode;
	}
}

type Pending = { resolve: (out: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export type OrgWorkerOptions = {
	log: Logger;
	/** Environment for the Emacs and the lock, such as ORG_EDIT_PROTECTED and TZDIR. */
	env?: NodeJS.ProcessEnv;
	/** How long one request may take. */
	timeoutMs?: number;
	/** Requests before the Emacs is replaced, so nothing it holds grows without end. */
	recycleAfter?: number;
	/** The argv that runs the server; tests may replace it. */
	argv?: string[];
};

export class OrgWorker {
	readonly #o: Required<Omit<OrgWorkerOptions, "argv">> & { argv: string[] };
	#child: ChildProcess | undefined;
	#pending = new Map<number, Pending>();
	#next = 0;
	#served = 0;
	#queue: Promise<unknown> = Promise.resolve();
	#stopped = false;

	constructor(options: OrgWorkerOptions) {
		const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
		// OrgWorker runs for June's daemon, never as a coding worker inheriting an hc terminal.
		for (const key of ["HC_TERMINAL_ID", "CLAUDECODE", "PI_SESSION_ID"]) {
			if (!options.env?.[key]) delete env[key];
		}
		// org-dispatch.el pins Calgary time; NixOS keeps zone data in /etc/zoneinfo, not the libc default.
		if (!env.TZDIR && !existsSync("/usr/share/zoneinfo") && existsSync("/etc/zoneinfo")) env.TZDIR = "/etc/zoneinfo";
		this.#o = {
			log: options.log,
			env,
			timeoutMs: options.timeoutMs ?? 60_000,
			recycleAfter: options.recycleAfter ?? 500,
			argv: options.argv ?? ["emacs", "-Q", "--batch", "-L", join(ORG, "dispatch"), "-L", join(ORG, "edit"), "-L", join(ORG, "agenda"), "-L", join(ORG, "server"), "-l", "june-org-server", "-f", "june-org-serve"],
		};
	}

	/** One org-edit command (ARGS as the wrapper takes them), under the dispatcher's lock; resolves with what it printed. */
	edit(args: readonly string[], lockWaitS: number): Promise<string> {
		const locked = args[0] !== "date";
		return this.#serial(async () => {
			const release = locked ? await this.#lock(lockWaitS) : () => {};
			try {
				return await this.#request("edit", args);
			} finally {
				release();
			}
		});
	}

	/** The agenda export's JSON for the agenda files listed in LIST, for DAYS days from today. */
	agenda(list: string, days: number): Promise<string> {
		return this.#serial(() => this.#request("agenda", [list, String(days)]));
	}

	/** The running Emacs's pid, if one is up. */
	get pid(): number | undefined {
		return this.#child?.pid;
	}

	stop(): void {
		this.#stopped = true;
		this.#child?.stdin?.end();
		this.#child?.kill();
		this.#child = undefined;
	}

	#serial<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(work, work);
		this.#queue = run.catch(() => {});
		return run;
	}

	#start(): ChildProcess {
		if (this.#stopped) throw new OrgWorkerDown("June's Org worker is stopped");
		const [command, ...args] = this.#o.argv;
		const child = spawn(command!, args, { stdio: ["pipe", "pipe", "pipe"], env: this.#o.env });
		child.on("error", (error) => this.#fail(child, new OrgWorkerDown(`June's Org worker did not start: ${error.message}`)));
		child.on("exit", (code) => this.#fail(child, new OrgWorkerDown(`June's Org worker exited (${code})`)));
		child.stderr!.on("data", () => {});
		createInterface({ input: child.stdout! }).on("line", (line) => {
			let answer: { id?: number; ok?: boolean; out?: string; error?: string };
			try {
				answer = JSON.parse(Buffer.from(line, "base64").toString("utf8"));
			} catch {
				return;
			}
			const pending = this.#pending.get(answer.id ?? -1);
			if (!pending) return;
			this.#pending.delete(answer.id!);
			clearTimeout(pending.timer);
			if (answer.ok) pending.resolve(answer.out ?? "");
			else pending.reject(new OrgEditError(answer.error ?? "org-edit failed without saying why"));
		});
		this.#child = child;
		this.#served = 0;
		this.#o.log.info("org_worker_started", { pid: child.pid });
		return child;
	}

	#fail(child: ChildProcess, error: Error): void {
		if (this.#child === child) this.#child = undefined;
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.#pending.delete(id);
		}
	}

	#request(op: string, args: readonly string[]): Promise<string> {
		if (this.#child && this.#served >= this.#o.recycleAfter) {
			this.#child.stdin?.end();
			this.#child = undefined;
		}
		const child = this.#child ?? this.#start();
		this.#served++;
		const id = ++this.#next;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				this.#o.log.warn("org_worker_timeout", { op });
				child.kill();
				reject(new OrgWorkerDown(`June's Org worker took over ${this.#o.timeoutMs / 1000} s`));
			}, this.#o.timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			child.stdin!.write(`${Buffer.from(JSON.stringify({ id, op, args }), "utf8").toString("base64")}\n`);
		});
	}

	/** Hold the dispatcher's lock as the org-edit wrapper does, waiting up to WAIT seconds; resolves with its release. */
	#lock(wait: number): Promise<() => void> {
		const file = join(this.#o.env.XDG_RUNTIME_DIR || "/tmp", "org-dispatch.lock");
		return new Promise((resolve, reject) => {
			const holder = spawn("flock", ["-w", String(wait), "-E", "75", file, "sh", "-c", "echo held; exec cat >/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
			let held = false;
			holder.stdout.once("data", () => {
				held = true;
				resolve(() => holder.stdin.end());
			});
			holder.on("error", (error) => reject(new OrgWorkerDown(`flock: ${error.message}`)));
			holder.on("exit", (code) => {
				if (!held) reject(code === 75 ? new OrgEditError("dispatcher or task edit busy; read the task again before retrying", 75) : new OrgWorkerDown(`flock exited ${code}`));
			});
		});
	}
}
