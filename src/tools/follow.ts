// Follow the tasks June queued: a durable background task per heading checks Org and Herdr on a timer, without a
// model call, and tells June only when something changed that the user would want to hear.
import { defineDoc, defineTask, type Tx } from "@earendil-works/pi-durable";
import { deliverIn, type Notice, noticeSurface, submitNotice, type Surface } from "../notify.ts";
import type { Herdr } from "./herdr.ts";
import type { Org } from "./org.ts";
import { User, user } from "../user.ts";

export type FollowInput = { id: string; title: string; host: string; queuedAt: number; request?: string };
type FollowState = { phase: "watch"; due: number; checks: number; last: string };

/** Org ID → follow task, so a task is followed once however often it is queued or replayed. */
export const Follows = defineDoc<{ ids: Record<string, number> }>({
	kind: "june.follows",
	version: 1,
	scope: "session",
	initial: () => ({ ids: {} }),
});

export type Observation = {
	state: string | undefined;
	missing: boolean;
	/** The agent's Herdr status, when the heading links a session on its host. */
	agent?: string;
	file?: string;
};

export type FollowOptions = {
	readonly intervalMs: number;
	/** A task still AUTO this long after queueing has not launched: the dispatcher settles for two minutes. */
	readonly launchMs: number;
	/** Stop following after this long, so an abandoned task does not keep a timer forever. */
	readonly maxMs: number;
};

export const FOLLOW_DEFAULTS: FollowOptions = { intervalMs: 60_000, launchMs: 7 * 60_000, maxMs: 7 * 24 * 3600_000 };

/**
 * What to say for `seen`, given the last signal: undefined while nothing worth reporting changed. `signal` is
 * remembered, so each transition is reported once; a return to work resets it, so a later HOLD is reported again.
 */
export function decide(input: FollowInput, seen: Observation, last: string, now: number, options: FollowOptions) {
	const where = seen.file ? ` (${seen.file})` : "";
	const name = `the task «${input.title}»${where} you queued`;
	const Name = name[0]!.toUpperCase() + name.slice(1);
	if (seen.missing) return { signal: "missing", done: true, say: `${Name} is no longer in Org; it was moved, archived, or deleted. You are no longer following it.` };
	if (now - input.queuedAt > options.maxMs) return { signal: "expired", done: true, say: undefined };
	switch (seen.state) {
		case "EVAL":
		case "DONE":
			return {
				signal: seen.state,
				done: true,
				say: `${Name} is now ${seen.state}. Read it with org_read_task, including its outcome and verification evidence.${seen.state === "EVAL" ? ` If you created it, the request is satisfied, and no decision or review from ${user()} remains, use org_complete_task to mark it DONE before reporting. Otherwise leave EVAL and explain what needs ${user()}'s review.` : ""} Tell ${user()} what came of it in a line or two.`,
			};
		case "HOLD":
			return { signal: "HOLD", done: false, say: `${Name} is on HOLD. Read its Dialog with org_read_task and pass the agent's question to the user.` };
		case "TODO":
			// The user took it back; nothing to report.
			return { signal: "TODO", done: true, say: undefined };
		case "AUTO":
			if (now - input.queuedAt > options.launchMs && last !== "stalled")
				return { signal: "stalled", done: false, say: `${Name} has not launched ${Math.round((now - input.queuedAt) / 60_000)} minutes after queueing. Check org_dispatch_scan and tell the user what is holding it.` };
			return { signal: last === "stalled" ? "stalled" : "AUTO", done: false, say: undefined };
		case "PROG":
			if (seen.agent === "blocked")
				return { signal: "blocked", done: false, say: `The agent working on ${name} is blocked, waiting for a person. Read its output with herdr_read_agent and tell the user what it is asking.` };
			return { signal: "PROG", done: false, say: undefined };
		default:
			return { signal: seen.state ?? "none", done: false, say: undefined };
	}
}

export function createFollowTask(org: Org, herdr: Herdr, options: FollowOptions = FOLLOW_DEFAULTS) {
	const observe = async (input: FollowInput): Promise<Observation> => {
		const task = await org.byId(input.id);
		if (task === undefined) return { state: undefined, missing: true };
		const session = task.herdrSessions.filter((s) => s.host === input.host && s.pane).at(-1);
		let agent: string | undefined;
		if (task.state === "PROG" && session?.pane) {
			// An unreachable host only means no Herdr signal this time.
			const got = await herdr.json(input.host, ["agent", "get", session.pane]).catch(() => undefined);
			agent = got?.result?.agent?.agent_status;
		}
		return { state: task.state, missing: false, file: task.file, ...(agent ? { agent } : {}) };
	};

	return defineTask<FollowInput, FollowState, null>({
		name: "june.follow",
		version: 1,
		initial: (input) => ({ phase: "watch", due: input.queuedAt + options.intervalMs, checks: 0, last: "AUTO" }),
		phases: {
			watch: async (task, runtime, context) => {
				const { due, checks, last } = task.state.checkpoint;
				// The due time is in the checkpoint, so a restart keeps the schedule instead of starting it over.
				if (runtime.now() < due) await runtime.sleep(due, context);
				let superseded = false;
				let surface: Surface = "terminal";
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(Follows);
					superseded = doc.ids[task.input.id] !== Number(task.id);
					if (!superseded) surface = await noticeSurface(tx, runtime.registry, runtime.conversationId);
					return superseded ? { status: "terminal", outcome: { status: "completed", result: null } } : undefined;
				}, context);
				if (superseded) return;
				const seen = await observe(task.input).catch((error: Error) => {
					runtime.report(error);
					return undefined;
				});
				const now = runtime.now();
				const next = seen === undefined ? undefined : decide(task.input, seen, last, now, options);
				const notice: Notice | undefined =
					next?.say !== undefined && next.signal !== last
						? {
								requestId: `follow:${task.input.request ?? task.input.id}:${next.signal}:${checks}`,
								content: `[follow] ${next.say}`,
								source: "follow",
								label: next.say,
							}
						: undefined;
				// To Telegram, the delivery is created with the checkpoint that records it; to the terminal, a rerun after a
				// crash submits the same request id, which finds the first submission.
				if (notice !== undefined && surface === "terminal") await submitNotice(await runtime.conversation(runtime.conversationId, context), notice, context);
				await runtime.commit(async (tx) => {
					if (notice !== undefined && surface === "telegram") await deliverIn(tx, runtime.registry, runtime.conversationId, notice);
					return next?.done
						? { status: "terminal", outcome: { status: "completed", result: null } }
						: { status: "running", checkpoint: { phase: "watch", due: now + options.intervalMs, checks: checks + 1, last: next?.signal ?? last } };
				}, context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

export type FollowTask = ReturnType<typeof createFollowTask>;

/** One follow per queue request. Resuming replaces a previous run's watcher, even after it ended. */
export async function follow(tx: Tx, task: FollowTask, input: FollowInput, conversationId: number): Promise<number> {
	const doc = await tx.doc(Follows);
	const known = doc.ids[input.id];
	if (known !== undefined) {
		const previous = await tx.task(known as never);
		// This document only records june.follow tasks, whose input is FollowInput.
		if (previous && (previous.input as FollowInput).request === input.request) return known;
	}
	const id = await tx.createTask(task, input, { ownership: { kind: "conversation" }, background: true, conversationId: conversationId as never });
	doc.ids[input.id] = Number(id);
	return doc.ids[input.id]!;
}
