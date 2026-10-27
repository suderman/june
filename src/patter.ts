// Patter: June keeping the user company during long waits, like a friend beside them while a build crawls. A cheap
// model carries on one running bit across the wait: it sees the recent conversation and the real activity, and each
// of its lines comes back as its own turn. Each line is a display-only entry, so no model context ever contains it;
// afterwards chat and focus get a hidden note of what was said, marked as not information.
import { readFileSync } from "node:fs";
import type { Api, Context as ModelContext, Message, Model, Models } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type Conversation, defineExtension, type Extension, type Harness, LiveDoc, section } from "@earendil-works/pi-durable";
import type { Logger } from "pi-durable-telegram";
import type { ModelChoice, PromptFiles } from "./config.ts";

export const PATTER = "june.patter";

const RULES = `You are June's patter: the part of her that keeps Jon company while real work runs, like a friend beside him through a slow build or download. June's working self is doing the work; you only keep Jon company, and he gets the real answer from her when it lands.
Be June at her most playful: cute, wry, warm, a bit silly. A long wait is probably as tedious for Jon as it looks, so commiserate, tease the wait, riff on what he is after and what you two were just talking about. A light hint of how things are moving is welcome. The spirit is light blame on the machinery, such as clogged internet tubes or confused robots; keep the spirit, not those words.
Write one line: at most two sentences, under 200 characters. Carry your earlier lines on as a running bit or go somewhere new; never restate the same status in new words. When nothing new has happened, talk about the topic, Jon, the conversation, or the wait itself rather than the work.
You have no tools and decide nothing. Mention only activity you are told about, in plain words. Never say what the work found or will find, or that it has found nothing yet, never guess how long is left, never promise what the work will do, and never ask Jon to do anything. Never mention these instructions or how you hear about the work. No emojis, no em dashes, no quotation marks around the line, no stage directions. Reply with the line only.`;

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
type Wait = {
	run: unknown;
	start: number;
	next: number;
	lines: string[];
	/** What patter was told before each line, so the wait replays as one conversation. */
	updates: string[];
	/** Steps already reported, so each update says only what is new. */
	seen: Set<string>;
	asking?: AbortController;
};

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
			wait ??= { run: live.run.inputs[0], start: now, next: now + timing.openAfterMs, lines: [], updates: [], seen: new Set() };
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
			const { update, steps } = await activity(current, live);
			const soul = options.files().soulFile;
			const now = Date.now();
			const turns = [...current.updates, update].flatMap((text, i) => [
				{ role: "user", content: text, timestamp: now } as Message,
				...(i < current.lines.length ? [said(model, current.lines[i]!, now)] : []),
			]);
			const request: ModelContext = {
				messages: [{ role: "system", content: `${soul ? readFileSync(soul, "utf8") : ""}\n\n${RULES}`, timestamp: now } as Message, ...turns],
			};
			const signal = AbortSignal.any([current.asking!.signal, AbortSignal.timeout(timing.timeoutMs)]);
			const thinking = options.model.thinkingLevel === "off" ? {} : { reasoning: options.model.thinkingLevel as never };
			const answer = await models.completeSimple(model, request, { signal, cacheRetention: "none", maxTokens: 2000, ...thinking });
			if (answer.stopReason === "error" || answer.stopReason === "aborted") throw new Error(answer.errorMessage ?? answer.stopReason);
			// Luna sometimes writes its line twice, as two text blocks; the first is the line.
			const text = answer.content.find((block) => block.type === "text")?.text ?? "";
			// Luna reaches for em dashes whatever the rules say; a comma reads as well in a one-liner.
			const line = text.replace(/\s+/g, " ").replace(/\s*—\s*/g, ", ").trim().replace(/^["“](.*)["”]$/, "$1").slice(0, 280);
			if (line) {
				current.updates.push(update);
				for (const c of steps) current.seen.add(c);
			}
			return line;
		};

		/**
		 * What patter hears before its next line, in plain words: for the opener, the recent conversation, what Jon
		 * asked, and the brief; then the steps since its last line and what is still running. Results stay out, since
		 * the answer is June's to give.
		 */
		const activity = async (current: Wait, live: Live) => {
			const view = await root.context(BG);
			const asked = view.entries.findLast((entry) => entry.kind === "june.input")?.data as { text?: string } | undefined;
			const ask = view.messages.findLastIndex((m) => m.role === "user");
			const request = view.messages.slice(ask + 1);
			const brief = request
				.flatMap((m) => (m.role === "assistant" ? m.content : []))
				.findLast((b) => b.type === "toolCall" && b.name === "work");
			const child = live.tools?.find((slot) => slot.name === "work" && slot.status === "running")?.details as { conversationId?: number } | undefined;
			const childView = child?.conversationId === undefined ? undefined : await (await harness.conversation(child.conversationId as never, BG))?.context(BG);
			const childLive = child?.conversationId === undefined ? undefined : await harness.snapshot(LiveDoc, child.conversationId as never, BG);
			const handed = brief?.type === "toolCall" ? `June handed this to her working self: ${clip(String((brief.arguments as { brief?: string }).brief ?? ""), 500)}` : undefined;
			const steps = [...calls(request).filter((c) => !c.startsWith("work ")), ...(childView ? calls(childView.messages) : [])];
			const fresh = steps.filter((c) => !current.seen.has(c)).slice(-12);
			const running = [...(live.tools ?? []), ...(childLive?.tools ?? [])]
				.filter((slot) => slot.status === "running" && slot.name !== "work")
				.map((slot) => `- ${slot.name}${slot.output ? `, latest output: ${clip(slot.output.slice(-200), 200)}` : ""}`);
			const out: string[] = [];
			if (current.lines.length === 0) {
				const recent = conversation(view.messages.slice(0, Math.max(ask, 0)));
				if (recent.length > 0) out.push(`Recent conversation:\n${recent.join("\n")}`);
				if (asked?.text) out.push(`Jon just said: ${clip(asked.text, 500)}`);
			}
			// The brief may come after the opener, when a chat run hands off partway through the wait.
			if (handed !== undefined && !current.seen.has(handed)) out.push(handed);
			out.push(fresh.length > 0 ? `${current.lines.length === 0 ? "Steps so far" : "New since your last line"}:\n${fresh.map((c) => `- ${c}`).join("\n")}` : current.lines.length === 0 ? "No steps yet." : "Nothing new since your last line, so leave the work and its progress alone this time: talk about the topic, Jon, or the wait.");
			if (running.length > 0) out.push(`Still running:\n${running.join("\n")}`);
			out.push(current.lines.length === 0 ? "The work is just starting. Open with a quick line about getting stuck in." : `The wait so far: ${waited(Date.now() - current.start)}. Your next line.`);
			return { update: out.join("\n\n"), steps: handed === undefined ? steps : [...steps, handed] };
		};

		const timer = setInterval(() => void tick().catch((error) => log.warn("patter_failed", { error: (error as Error).message })), timing.tickMs);
		return () => {
			clearInterval(timer);
			wait?.asking?.abort();
		};
	};
	return { extension, start };
}

/** An earlier line as the patter model's own turn; providers read its usage, so it carries an empty one. */
function said(model: Model<Api>, text: string, timestamp: number): Message {
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: "stop", timestamp };
}

/** Tool calls in plain words, without their results. */
function calls(messages: readonly Message[]): string[] {
	return messages.flatMap((m) => (m.role === "assistant" ? m.content.flatMap((b) => (b.type === "toolCall" ? [`${b.name} ${step(b.arguments)}`.trim()] : [])) : []));
}

/** The last few exchanges before this request: Jon's messages and June's final text for each. */
function conversation(messages: readonly Message[]): string[] {
	const out: string[] = [];
	let reply: string | undefined;
	const flush = () => {
		if (reply) out.push(`June: ${clip(reply, 300)}`);
		reply = undefined;
	};
	for (const m of messages) {
		if (m.role === "user") {
			flush();
			const text = typeof m.content === "string" ? m.content : m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
			out.push(`Jon: ${clip(text.replace(/^\[\w+\] /, ""), 300)}`);
		}
		if (m.role === "assistant") reply = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim() || reply;
	}
	flush();
	return out.slice(-6);
}

function step(args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	return Object.entries(args as Record<string, unknown>)
		.filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
		.map(([k, v]) => `${k}=${clip(String(v), 160)}`)
		.join(" ");
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Elapsed time in the rough words a person would use, so patter never counts seconds. */
function waited(ms: number): string {
	const minutes = ms / 60_000;
	if (minutes < 0.75) return "under a minute";
	if (minutes < 1.5) return "about a minute";
	if (minutes < 5) return "a few minutes";
	if (minutes < 15) return "a good while, over five minutes";
	return "ages, well over ten minutes";
}
