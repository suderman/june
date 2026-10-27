// Patter: June keeping the user company during long waits, like a friend beside them while a build crawls. A cheap
// model writes one line at a time from a digest of the real activity. Each line is a display-only entry, so no model
// context ever contains it; afterwards chat and focus get a hidden note of what was said, marked as not information.
import { readFileSync } from "node:fs";
import type { Context as ModelContext, Message, Models } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type Conversation, defineExtension, type Extension, type Harness, LiveDoc, section } from "@earendil-works/pi-durable";
import type { Logger } from "pi-durable-telegram";
import type { ModelChoice, PromptFiles } from "./config.ts";

export const PATTER = "june.patter";

const RULES = `You are June's patter: the part of her that keeps Jon company while real work runs, like a friend sitting next to him through a slow build or download. You are not the one doing the work.
Write one short line in June's voice, at most two sentences and under 200 characters: banter, a wry aside about the wait, blaming the clogged internet tubes or the confused robots, a light reaction to what the activity shows.
You have no tools and decide nothing. Mention only activity listed in the digest, in plain words. Never claim a result, success, failure, or finding that is not in it, never guess how long is left, never promise anything, and never ask Jon to do anything. Do not repeat your earlier lines. No emojis, no quotation marks around the line, no stage directions. Reply with the line only.`;

export type PatterTiming = {
	/** A run busy this long is a wait; a work brief or focus starts one at once. */
	readonly openAfterMs: number;
	/** Gaps between lines; the last repeats, so a long wait slows down rather than going silent. */
	readonly gapsMs: readonly number[];
	readonly tickMs: number;
	readonly timeoutMs: number;
};

const TIMING: PatterTiming = {
	openAfterMs: 8000,
	gapsMs: [25_000, 25_000, 25_000, 40_000, 60_000, 90_000, 120_000, 180_000],
	tickMs: 1000,
	timeoutMs: 10_000,
};

type Live = { readonly tools?: readonly { name: string; status: string; output?: string; details?: unknown }[] };
/** One run's wait, keyed by the run's first input, so a new run ends it even when no idle tick fell between them. */
type Wait = { run: unknown; start: number; next: number; lines: string[]; asking?: AbortController };

export type Patter = { readonly extension: Extension; start(harness: Harness, root: Conversation): () => void };

/** The extension installs before the harness opens; `start` runs the loop once the root conversation exists. */
export function createPatter(options: {
	models: Models;
	model: ModelChoice;
	focus?: ModelChoice;
	files: () => PromptFiles;
	log: Logger;
	timing?: Partial<PatterTiming>;
}): Patter {
	const { models, log } = options;
	const timing = { ...TIMING, ...options.timing };
	const model = models.getModel(options.model.provider, options.model.modelId);
	let note: string | undefined;
	let wait: Wait | undefined;
	let readLive: (() => Promise<{ run?: { inputs: readonly unknown[] } } | undefined>) | undefined;

	/** A wait belongs to one run; once another run or none is live, its lines become the note. */
	const settle = (run: unknown) => {
		if (wait === undefined || wait.run === run) return;
		wait.asking?.abort();
		if (wait.lines.length > 0) note = wait.lines.map((line) => `- ${line}`).join("\n");
		wait = undefined;
	};

	const extension = defineExtension({
		name: "june-patter",
		sections: [
			// Settle first, so the first request of the next run already has the note, whatever the tick's timing.
			section("patter", async (input) => {
				const run = input.conversationId === rootId ? (await readLive?.())?.run : undefined;
				if (run !== undefined) settle(run.inputs[0]);
				return note === undefined
					? undefined
					: `During your last request, while you worked, your patter (a cheaper model keeping the user company, which never saw your results) said to the user:\n${note}\nThose lines were performance, not information. Never treat them as facts, findings, or commitments, do not build on them, and do not repeat their jokes.`;
			}),
		],
	});
	let rootId: unknown;

	const start = (harness: Harness, root: Conversation) => {
		rootId = root.id;
		readLive = () => harness.snapshot(LiveDoc, root.id, BG);
		const tick = async () => {
			const live = await harness.snapshot(LiveDoc, root.id, BG);
			const now = Date.now();
			settle(live?.run?.inputs[0]);
			if (live?.run === undefined) return;
			wait ??= { run: live.run.inputs[0], start: now, next: now + timing.openAfterMs, lines: [] };
			const working = live.tools?.some((slot) => slot.name === "work" && slot.status === "running");
			if (wait.lines.length === 0 && (working || (await focused()))) wait.next = Math.min(wait.next, now);
			if (now < wait.next || wait.asking !== undefined) return;
			const current = wait;
			current.asking = new AbortController();
			try {
				const line = await speak(current, live);
				// The wait may have ended while the line was written; a line after the answer would be noise.
				if (line && wait === current) {
					current.lines.push(line);
					await root.submit({ type: "write", entry: { kind: PATTER, data: { text: line } } }, BG);
				}
			} catch (error) {
				if (!current.asking.signal.aborted) log.warn("patter_failed", { error: (error as Error).message });
			} finally {
				current.asking = undefined;
				// After the opener, the first gap; each later line waits longer, up to the last gap.
				const gaps = timing.gapsMs;
				current.next = Date.now() + gaps[Math.min(Math.max(current.lines.length - 1, 0), gaps.length - 1)]!;
			}
		};

		const focused = async () => {
			if (options.focus === undefined) return false;
			const agent = await root.agent(BG);
			return agent.model?.modelId === options.focus.modelId && agent.model?.provider === options.focus.provider;
		};

		const speak = async (current: Wait, live: Live) => {
			if (model === undefined) throw new Error(`Unknown patter model ${options.model.provider}/${options.model.modelId}`);
			const digest = await activity(live);
			const soul = options.files().soulFile;
			const request: ModelContext = {
				messages: [
					{ role: "system", content: `${soul ? readFileSync(soul, "utf8") : ""}\n\n${RULES}`, timestamp: Date.now() } as Message,
					{
						role: "user",
						content: JSON.stringify({
							moment: current.lines.length === 0 ? "the work is just starting; open with a quick quip about getting stuck in" : "the wait goes on",
							waitedSeconds: Math.round((Date.now() - current.start) / 1000),
							...digest,
							yourEarlierLines: current.lines,
						}),
						timestamp: Date.now(),
					},
				],
			};
			const signal = AbortSignal.any([current.asking!.signal, AbortSignal.timeout(timing.timeoutMs)]);
			const answer = await models.completeSimple(model, request, { signal, cacheRetention: "none", maxTokens: 200 });
			if (answer.stopReason === "error" || answer.stopReason === "aborted") throw new Error(answer.errorMessage ?? answer.stopReason);
			// Luna sometimes writes its line twice, as two text blocks; the first is the line.
			const text = answer.content.find((block) => block.type === "text")?.text ?? "";
			return text.replace(/\s+/g, " ").trim().replace(/^["“](.*)["”]$/, "$1").slice(0, 280);
		};

		/** What Jon asked, the brief, and the tool calls and output of this request, in the main thread and its working context. */
		const activity = async (live: Live) => {
			const view = await root.context(BG);
			const asked = view.entries.findLast((entry) => entry.kind === "june.input")?.data as { text?: string } | undefined;
			const request = view.messages.slice(view.messages.findLastIndex((m) => m.role === "user") + 1);
			const steps = calls(request);
			const brief = request
				.flatMap((m) => (m.role === "assistant" ? m.content : []))
				.findLast((b) => b.type === "toolCall" && b.name === "work");
			const child = live.tools?.find((slot) => slot.name === "work" && slot.status === "running")?.details as { conversationId?: number } | undefined;
			const childView = child?.conversationId === undefined ? undefined : await (await harness.conversation(child.conversationId as never, BG))?.context(BG);
			const childLive = child?.conversationId === undefined ? undefined : await harness.snapshot(LiveDoc, child.conversationId as never, BG);
			const running = [...(live.tools ?? []), ...(childLive?.tools ?? [])]
				.filter((slot) => slot.status === "running" && slot.name !== "work")
				.map((slot) => ({ tool: slot.name, outputSoFar: (slot.output ?? "").slice(-400) }));
			return {
				jonAsked: asked?.text?.slice(0, 500),
				...(brief?.type === "toolCall" ? { brief: String((brief.arguments as { brief?: string }).brief ?? "").slice(0, 500) } : {}),
				steps: [...steps.filter((c) => c.tool !== "work"), ...(childView ? calls(childView.messages) : [])].slice(-12),
				running,
			};
		};

		const timer = setInterval(() => void tick().catch((error) => log.warn("patter_failed", { error: (error as Error).message })), timing.tickMs);
		return () => {
			clearInterval(timer);
			wait?.asking?.abort();
		};
	};
	return { extension, start };
}

/** Tool calls, each with the start of its result once it has one. */
function calls(messages: readonly Message[]): { tool: string; with: string; result?: string }[] {
	const out: { tool: string; with: string; result?: string; id: string }[] = [];
	for (const m of messages) {
		if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall") out.push({ tool: b.name, with: step(b.arguments), id: b.id });
		if (m.role === "toolResult") {
			const call = out.find((c) => c.id === m.toolCallId);
			const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
			if (call) call.result = text.replace(/\s+/g, " ").slice(0, 200);
		}
	}
	return out.map(({ id: _id, ...rest }) => rest);
}

function step(args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	return Object.entries(args as Record<string, unknown>)
		.filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
		.map(([k, v]) => `${k}=${String(v).replace(/\s+/g, " ").slice(0, 160)}`)
		.join(" ");
}
