// Terminal slash commands. Shared commands match pi-durable-telegram; /reload is terminal-only.
// That package exports neither its command handlers nor a custom-command hook.
import type { Context } from "@earendil-works/chord";
import type { Message, Models, Usage } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { type Conversation, type Harness, InboxDoc, LiveDoc, UsageDoc, type UsageState, UserEntry } from "@earendil-works/pi-durable";
import { COMMANDS, type Status } from "./protocol.ts";
import { MemoryReview } from "./memory.ts";
import { WorkDoc } from "./tools/work.ts";

export type CommandScope = {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly models: Models;
	readonly status: () => Promise<Status>;
	readonly reload: () => Promise<number>;
	/** Back to default mode; a fresh context starts relaxed. */
	readonly relax?: () => Promise<unknown>;
};

export async function runCommand(scope: CommandScope, name: string, args: string, requestId: string, context: Context) {
	switch (name) {
		case "new":
			return runNew(scope, context);
		case "stop":
			return runStop(scope, requestId, context);
		case "compact":
			return runCompact(scope, args, context);
		case "status":
			return runStatus(scope, context);
		case "reload":
			return `Reloaded prompt files and skills (${await scope.reload()}). Chat kept. Applies on the next model turn; code and config changes need a restart.`;
		case "help":
			return COMMANDS.map((c) => `/${c.name} - ${c.description}`).join("\n");
		default:
			throw new Error(`Unknown command /${name}; /help lists them`);
	}
}

/** Abort the run and queued inputs, then start a fresh context; the transcript stays in storage. */
async function runNew({ harness, root, relax }: CommandScope, context: Context): Promise<string> {
	const live = await harness.snapshot(LiveDoc, root.id, context);
	const inbox = await harness.snapshot(InboxDoc, root.id, context);
	const queued = (inbox?.items ?? []).flatMap((item) => (item.mode === "write" ? [] : [startOf(item.content)]));
	await root.abort(context);
	await root.reset(undefined, context);
	await relax?.();
	const lines = ["New context. Old history is kept."];
	if (live?.run !== undefined) lines.push("The request in progress was stopped.");
	if (queued.length > 0) {
		const shown = queued.slice(0, 5).map((start) => `«${start}»`);
		const more = queued.length > 5 ? ` and ${queued.length - 5} more` : "";
		lines.push(`Dropped without an answer (${queued.length}): ${shown.join(", ")}${more}. Send again what still matters.`);
	}
	return lines.join("\n");
}

/**
 * Abort the task running the current input, not the conversation, so queued messages continue after a boundary, along
 * with any brief that run handed to the background. With nothing running in the main thread, stop the background
 * briefs instead.
 */
async function runStop({ harness, root }: CommandScope, requestId: string, context: Context): Promise<string> {
	const live = async () => (await harness.snapshot(LiveDoc, root.id, context))?.run;
	const stopping = await live();
	const active = Object.entries((await harness.snapshot(WorkDoc, context))?.active ?? {});
	const work = stopping === undefined ? active : active.filter(([, w]) => w.run === Number(stopping.inputs[0]));
	for (const [id] of work) {
		await harness.abortTask(Number(id) as never, context);
		await harness.waitForTask(Number(id) as never, context);
	}
	const briefs = work.map(([, w]) => `«${w.brief.replace(/\s+/g, " ").slice(0, 120)}»`).join(", ");
	const stopped = work.length > 0 ? ` stopped your working context: ${briefs}` : "";
	if (stopping === undefined) {
		if (work.length === 0) return "Nothing is running.";
		const message = { role: "user" as const, content: `[/stop]${stopped}`, timestamp: Date.now() };
		await root.submit({ type: "write", requestId: `stop:${requestId}`, entry: { kind: UserEntry.kind, model: [message] } }, context);
		return work.length === 1 ? "Stopped the background work." : `Stopped ${work.length} background briefs.`;
	}
	let current: typeof stopping | undefined = stopping;
	while (current !== undefined && current.inputs[0] === stopping.inputs[0]) {
		await harness.abortTask(current.taskId, context);
		await harness.waitForTask(current.taskId, context);
		current = await live();
	}
	const queued = (await harness.snapshot(InboxDoc, root.id, context))?.items.length ?? 0;
	const message = { role: "user" as const, content: `[/stop]${stopped}`, timestamp: Date.now() };
	await root.submit({ type: "write", requestId: `stop:${requestId}`, entry: { kind: UserEntry.kind, model: [message] } }, context);
	return queued > 0 ? `Stopped. ${queued} queued message(s) will continue.` : "Stopped.";
}

async function runCompact({ harness, root }: CommandScope, instructions: string, context: Context): Promise<string> {
	const task = await root.compact(instructions === "" ? undefined : instructions, context);
	const { outcome } = (await harness.waitForTask(task, context)).state;
	if (outcome.status === "aborted") return "Compaction cancelled.";
	if (outcome.status !== "completed") return "Compaction failed.";
	const memory = await harness.snapshot(MemoryReview, root.id, context);
	if (memory?.failure?.task === Number(task)) return `Compaction skipped: ${memory.failure.message}. Old context kept.`;
	const done = memory?.last?.task === Number(task)
		? `Compacted. Memory reviewed${memory.last.changed ? " and updated" : "; no changes needed"}.`
		: "Compacted.";
	if (outcome.result.entryId !== undefined) return done;
	if (outcome.result.submissionId === undefined) return "Nothing to compact.";
	const placed = await (await harness.submission(outcome.result.submissionId, context))?.wait(context);
	if (placed === undefined || placed.type !== "write") return "Compaction result unavailable.";
	if (placed.status === "done") return done;
	return placed.reason === "stale" ? "Compaction summary discarded: the context changed meanwhile." : "Compaction summary was not applied.";
}

async function runStatus({ harness, root, models, status }: CommandScope, context: Context): Promise<string> {
	const s = await status();
	const agent = await root.agent(context);
	const live = await harness.snapshot(LiveDoc, root.id, context);
	const tokens = estimateContextTokens((await root.context(context)).messages as Message[]).tokens;
	const window = agent.model ? models.getModel(agent.model.provider, agent.model.modelId)?.contextWindow : undefined;
	const percent = window ? ` (${Math.round((tokens / window) * 100)}%)` : "";
	const tool = live?.tools?.find((slot) => slot.status === "running")?.name;
	return [
		`June ${s.version}, up ${duration(Date.now() - Date.parse(s.startedAt))}`,
		`Model: ${s.model}, thinking ${s.thinkingLevel}`,
		`State: ${s.busy ? `working${tool ? ` (${tool})` : ""}` : "idle"}, queued: ${s.queued}`,
		`Context: ${formatTokens(tokens)}${window ? ` / ${formatTokens(window)}` : ""}${percent}`,
		`Spend: ${usage(await harness.snapshot(UsageDoc, root.id, context))}`,
		`Telegram: ${s.telegram}`,
		`Code: ${s.source}`,
	].join("\n");
}

function startOf(content: unknown): string {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content.flatMap((part) => (part?.type === "text" ? [String(part.text)] : [])).join(" ")
				: "";
	const flat = text.replace(/\s+/g, " ").trim();
	return flat === "" ? "[attachment]" : flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

function usage(state: Readonly<UsageState> | undefined): string {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const bucket of [state?.models ?? {}, state?.tools ?? {}]) {
		for (const u of Object.values(bucket) as unknown as Usage[]) {
			input += u.input + u.cacheRead + u.cacheWrite;
			output += u.output;
			cost += u.cost.total;
		}
	}
	return `in ${formatTokens(input)}, out ${formatTokens(output)}, $${cost.toFixed(2)}`;
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

function duration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
