// June's watch over dispatched work she did not start: every minute, without a model call, it reads org-dispatch's run
// records on each dispatch host, checks each live run's Org state and agent, and remembers the last signal per run in a
// small ledger. When a run reaches EVAL, HOLD, or DONE, or its agent is blocked, the change waits in the ledger until the
// user's waking hours and at least `gapMinutes` since her last such notice, then all pending changes reach June as one
// [watch] input, which she turns into a short message. Tasks she queued herself are left to their follow tasks.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Conversation, Harness, RegistrySnapshot, TaskId } from "@earendil-works/pi-durable";
import type { Logger } from "pi-durable-telegram";
import type { Config } from "./config.ts";
import { within } from "./heartbeat.ts";
import { deliverIn, type Notice, noticeSurface, submitNotice } from "./notify.ts";
import { Follows } from "./tools/follow.ts";
import type { Herdr, Run } from "./tools/herdr.ts";
import type { Org } from "./tools/org.ts";
import { user } from "./user.ts";

/** One run as org-dispatch records it in ~/.local/state/org-dispatch/<id>.json. */
export type DispatchRun = { id: string; heading?: string; file?: string; status?: string; started?: number; pane?: string };

type Seen = { signal: string; title: string; host: string; file?: string };
/** `hosts` have had a first look, which only learns what is there. */
type Ledger = { runs: Record<string, Seen>; pending: Record<string, Seen>; notified: number; hosts: string[] };

/** Signals worth telling the user about; any other signal clears a pending one. */
const NEWS = new Set(["EVAL", "HOLD", "DONE", "blocked"]);
/** Once a finished run shows one of these, it has nothing more to say until it is run again. */
const SETTLED = new Set(["EVAL", "HOLD", "DONE", "TODO", "missing"]);

const STATE_DIR = ".local/state/org-dispatch";

export function createWatch(options: {
	config: Config["watch"];
	hosts: readonly string[];
	/** The local host, whose run records are read directly; others go over SSH. */
	host: string;
	ssh: Readonly<Record<string, { ssh?: string }>>;
	/** From the rhythm's wake until its quiet. */
	window: { start: string; end: string };
	org: Pick<Org, "byId">;
	registry: { snapshot(): RegistrySnapshot };
	herdr: Pick<Herdr, "json">;
	run: Run;
	state: string;
	log: Logger;
	/** Tests run the clock, the loop, and the local run records. */
	now?: () => Date;
	tickMs?: number;
	home?: string;
}): { start(harness: Harness, root: Conversation): () => void } {
	const { config, log } = options;
	const now = options.now ?? (() => new Date());
	const file = join(options.state, "watch.json");
	const load = (): Ledger | undefined => {
		try {
			return JSON.parse(readFileSync(file, "utf8")) as Ledger;
		} catch {
			return undefined;
		}
	};
	const save = (ledger: Ledger) => {
		mkdirSync(options.state, { recursive: true });
		writeFileSync(file, `${JSON.stringify(ledger)}\n`);
	};

	/** Every run record on `host`, or undefined when it cannot be reached, such as a laptop asleep. */
	const runs = async (host: string): Promise<DispatchRun[] | undefined> => {
		if (host === options.host) {
			const dir = join(options.home ?? homedir(), STATE_DIR);
			let names: string[];
			try {
				names = readdirSync(dir).filter((name) => name.endsWith(".json"));
			} catch {
				return [];
			}
			return names.flatMap((name) => parse(readFileSync(join(dir, name), "utf8")));
		}
		const argv = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", options.ssh[host]?.ssh ?? host, `for f in ~/${STATE_DIR}/*.json; do [ -f "$f" ] && cat "$f" && echo; done`];
		const out = await options.run(argv, 15_000).catch((error: Error) => {
			log.debug("watch_host_unreachable", { host, error: error.message });
			return undefined;
		});
		return out?.split("\n").flatMap(parse);
	};

	/** Where the run stands now: its Org state, or "blocked" while its agent waits for a person. */
	const observe = async (host: string, run: DispatchRun): Promise<{ signal: string; title: string; file?: string }> => {
		const task = await options.org.byId(run.id);
		const title = task?.title ?? run.heading ?? run.id;
		if (task === undefined) return { signal: "missing", title };
		let signal = task.state ?? "none";
		if (signal === "PROG" && run.status !== "finished" && run.pane) {
			const got = await options.herdr.json(host, ["agent", "get", run.pane]).catch(() => undefined);
			if (got?.result?.agent?.agent_status === "blocked") signal = "blocked";
		}
		return { signal, title, file: task.file };
	};

	let busy = false;
	const start = (harness: Harness, root: Conversation) => {
		const tick = async () => {
			if (busy) return;
			busy = true;
			try {
				const at = now();
				const ledger: Ledger = { runs: {}, pending: {}, notified: 0, hosts: [], ...load() };
				const live = new Set<string>();
				// June's own follows report her tasks; a run she follows is recorded here but never raised.
				const followed = await harness.commit(async (tx) => {
					const ids = (await tx.doc(Follows)).ids;
					const mine = new Set<string>();
					for (const [id, task] of Object.entries(ids)) {
						const record = await tx.task(task as unknown as TaskId);
						if (record !== undefined && ["pending", "running", "waiting"].includes(record.state.status)) mine.add(id);
					}
					return mine;
				}, BG);
				for (const host of options.hosts) {
					const found = await runs(host);
					// An unreachable host keeps what is known of it, so its runs are not news when it is back.
					if (found === undefined) {
						for (const key of Object.keys(ledger.runs)) if (key.startsWith(`${host}:`)) live.add(key);
						continue;
					}
					const first = !ledger.hosts.includes(host);
					for (const run of found) {
						const key = `${host}:${run.id}:${run.started ?? 0}`;
						live.add(key);
						const last = ledger.runs[key];
						if (last !== undefined && run.status === "finished" && SETTLED.has(last.signal)) continue;
						const seen = { ...(await observe(host, run)), host };
						ledger.runs[key] = seen;
						if (seen.signal === last?.signal) continue;
						// The first look at a host only learns what is there; it raises nothing.
						if (first || followed.has(run.id)) continue;
						if (NEWS.has(seen.signal)) ledger.pending[key] = seen;
						else delete ledger.pending[key];
					}
					if (first) ledger.hosts.push(host);
				}
				for (const key of Object.keys(ledger.runs)) if (!live.has(key)) delete ledger.runs[key];
				for (const key of Object.keys(ledger.pending)) if (!live.has(key)) delete ledger.pending[key];

				const pending = Object.values(ledger.pending);
				const due = pending.length > 0 && within(at, options.window) && at.getTime() - ledger.notified >= config.gapMinutes * 60_000;
				if (!due) return save(ledger);
				const notice: Notice = { requestId: `watch:${at.getTime()}`, content: `[watch] ${message(pending)}`, source: "watch", label: `${pending.length} dispatched task${pending.length === 1 ? "" : "s"} changed` };
				// The ledger first: a crash after it loses one notice; one before it would repeat it.
				save({ ...ledger, pending: {}, notified: at.getTime() });
				const surface = await harness.commit(async (tx) => {
					const registry = options.registry.snapshot();
					const where = await noticeSurface(tx, registry, root.id);
					if (where === "telegram") await deliverIn(tx, registry, root.id, notice);
					return where;
				}, BG);
				if (surface === "terminal") await submitNotice(root as never, notice, BG);
				log.info("watch_notified", { count: pending.length, surface });
			} finally {
				busy = false;
			}
		};
		const timer = setInterval(() => void tick().catch((error) => log.warn("watch_failed", { error: (error as Error).message })), options.tickMs ?? 60_000);
		return () => clearInterval(timer);
	};
	return { start };
}

/** A run record, or nothing for a partial or foreign file. */
function parse(text: string): DispatchRun[] {
	if (!text.trim()) return [];
	try {
		const run = JSON.parse(text) as DispatchRun;
		return typeof run?.id === "string" && /^[0-9A-Za-z-]{8,64}$/.test(run.id) ? [run] : [];
	} catch {
		return [];
	}
}

const SAY: Record<string, string> = {
	EVAL: "is now EVAL, ready for review",
	HOLD: "is on HOLD, waiting on an answer in its Dialog",
	DONE: "is DONE",
	blocked: "has an agent blocked, waiting for a person",
};

export function message(pending: readonly Seen[]): string {
	const lines = pending.map((p) => `- «${p.title}»${p.file ? ` (${p.file})` : ""} on ${p.host} ${SAY[p.signal] ?? `is ${p.signal}`}.`);
	return [
		`Dispatched tasks you did not queue changed since you last heard:`,
		...lines,
		`These are ${user()}'s own tasks, so leave their states alone. Read what matters with org_read_task, or herdr_read_agent for a blocked agent, then tell ${user()} in a line or two what came of each and what, if anything, needs them.`,
	].join("\n");
}
