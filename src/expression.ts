// June's expression: after each reply settles, a short model call picks the face she shows for it, from the vocabulary
// in avatar.ts and, optionally, a pose from the avatar set. The pick is a display-only `june.expression` entry naming the
// reply, so no model context, compaction, or memory review ever sees it; the folded view carries it to clients on the
// reply's item and as `state.expression`. The trial behind this is "Test patter choosing June's expressions" in the
// project's Org record: a separate pass beat a tool in June's own turn, which would carry her whole context each reply.
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Context as ModelContext, Message, Models } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { EXPRESSIONS, type Manifest, parseManifest } from "./avatar.ts";
import type { ModelChoice, PromptFiles } from "./config.ts";
import type { Reply } from "./protocol.ts";
import type { Logger } from "./runtime.ts";
import { applyArt, type ArtTake, type ArtContext, type ViewItem, type ViewState } from "./transcript.ts";
import { user } from "./user.ts";

export const EXPRESSION = "june.expression";

export type FacePick = { expression: keyof typeof EXPRESSIONS; pose?: string };

/** The instructions for one pick: the vocabulary with how often each face should appear, the poses, and the rules. */
export function expressionRules(manifest: Manifest | undefined): string {
	const vocabulary = Object.entries(EXPRESSIONS)
		.map(([name, e]) => `- ${name} (${e.frequency}): ${e.meaning}`)
		.join("\n");
	const poses = Object.entries(manifest?.poses ?? {})
		.filter(([, p]) => p.activity === undefined)
		.map(([name, p]) => `- ${name} (${p.expression}): ${p.description ?? ""}`)
		.join("\n");
	return `You choose June's face for one panel of a comic strip of her conversation with ${user()}. June is the character described above. Read ${user()}'s message and June's reply, and pick how she comes across in that reply.

Expressions, with how often each should appear:
${vocabulary}
${poses ? `\nPoses, each with its expression:\n${poses}\n` : ""}
Rules:
- Pick the expression that fits her reply as a whole, not a single word in it.
- Common faces are the default. Occasional ones need a clear reason in the reply. Rare ones only when the reply plainly earns it: a real win, a real compliment, a theatrical huff. Most replies are idle, warm, wry, curious, serious, or gentle.
- Pout is for when ${user()} wins a joke or an argument, not when June does.
- When her reply drops the teasing (bad news, worry, serious or family matters), choose serious or gentle, never wry, smug, or pout.
${poses ? "- Optionally pick one pose whose expression matches; null when none fits well.\n" : ""}Reply with JSON only: {"expression": "<name>"${poses ? ', "pose": "<name>" or null' : ""}}`;
}

/** The model's answer as a pick: a known expression, and a pose only when the set has it. Null for anything else. */
export function parsePick(text: string, manifest: Manifest | undefined): FacePick | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) return null;
	let data: { expression?: unknown; pose?: unknown };
	try {
		data = JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof data.expression !== "string" || !Object.hasOwn(EXPRESSIONS, data.expression)) return null;
	const pose = typeof data.pose === "string" && manifest?.poses?.[data.pose] && manifest.poses[data.pose]!.activity === undefined ? data.pose : undefined;
	return { expression: data.expression as FacePick["expression"], ...(pose ? { pose } : {}) };
}

type Assistant = Extract<ViewItem, { kind: "assistant" }>;
/** An earlier exchange the pass sees for context: what the user said, and June's settled reply. */
export type Exchange = { said: string; replied: string };

// How many earlier exchanges the pass sees, and how much of each, so a running joke or a mood carries over cheaply.
const EARLIER = 2;
const CLIP = 400;
const clip = (text: string) => (text.length <= CLIP ? text : `${text.slice(0, CLIP - 1).trimEnd()}…`);

/**
 * The reply that needs a face now: the newest visible reply, settled, with words and no error or face yet, once the run
 * has ended, with the user's message before it and up to two exchanges before that. Null while she is still working or
 * when there is nothing new.
 */
export function replyToPick(items: readonly ViewItem[], state: Pick<ViewState, "running" | "compacting">, done: ReadonlySet<string>): { reply: Assistant; said: string; earlier: Exchange[] } | null {
	if (state.running || state.compacting) return null;
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]!;
		if (item.kind === "user" && !item.private) return null;
		if (item.kind !== "assistant" || item.private || item.streaming || item.error || !item.text.trim()) continue;
		if (item.expression !== undefined || done.has(item.id)) return null;
		let said = "";
		let j = i - 1;
		for (; j >= 0; j--) {
			const before = items[j]!;
			if (before.kind === "user" && !before.private) {
				said = before.text;
				break;
			}
		}
		return { reply: item, said, earlier: exchangesBefore(items, j, EARLIER) };
	}
	return null;
}

/** Up to `count` exchanges before index `end`, oldest first: each user message with June's last settled reply to it. */
function exchangesBefore(items: readonly ViewItem[], end: number, count: number): Exchange[] {
	const out: Exchange[] = [];
	let replied = "";
	for (let k = end - 1; k >= 0 && out.length < count; k--) {
		const item = items[k]!;
		if (item.kind === "assistant" && !item.private && !item.error && item.text.trim() && !replied) replied = item.text;
		else if (item.kind === "user" && !item.private) {
			if (replied) out.unshift({ said: clip(item.text), replied: clip(replied) });
			replied = "";
		}
	}
	return out;
}

/** The words of one pick request: the earlier exchanges for context, then the message and the reply to read. */
export function pickRequest(said: string, reply: string, earlier: readonly Exchange[]): string {
	const before = earlier.map((e) => `${user()}: ${e.said}\nJune: ${e.replied}`).join("\n\n");
	return `${before ? `Earlier, for context only:\n${before}\n\nNow, the reply to choose for.\n` : ""}${user()} wrote:\n${said || "(nothing: June spoke first)"}\n\nJune replied:\n${reply}`;
}

/** The same merged inventory the clients see: the personal set wins names and the base fills the rest. */
export function loadManifest(paths: readonly string[], log: Logger): Manifest | undefined {
	const sets: Manifest[] = [];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try { sets.push(parseManifest(JSON.parse(readFileSync(path, "utf8")))); }
		catch (error) { log.warn("expression_manifest", { path, error: (error as Error).message }); }
	}
	if (!sets.length) return undefined;
	return { ...sets[0]!, poses: Object.assign({}, ...sets.toReversed().map((s) => s.poses ?? {})) };
}

/** Resolve variety once, when a choice is written, never while rendering. Explicit valid poses win. */
export function resolvePick(pick: FacePick, manifest: Manifest | undefined, previous?: Assistant, selectedAt = Date.now(), random = Math.random): FacePick & { side: "left" | "right"; selectedAt: number } {
	const poses = Object.entries(manifest?.poses ?? {}).filter(([, p]) => !p.activity && (p.added === undefined || Date.parse(p.added) <= selectedAt));
	let named = poses.find(([id]) => id === pick.pose);
	let expression: string | undefined = pick.expression;
	while (!named && expression) {
		const fitting = poses.filter(([, p]) => p.expression === expression);
		const fresh = fitting.filter(([id]) => id !== previous?.pose);
		const pool = fresh.length ? fresh : fitting;
		if (pool.length) named = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
		expression = (EXPRESSIONS[expression as keyof typeof EXPRESSIONS] as { fallback?: string }).fallback;
	}
	let side: "left" | "right" = previous?.side === "left" ? "right" : "left";
	if (named?.[1].mirror === false && named[1].facing !== "front") side = named[1].facing === "right" ? "left" : "right";
	return { expression: pick.expression, ...(named ? { pose: named[0] } : {}), side, selectedAt };
}

type Attach = (send: (reply: Reply) => void) => Promise<{ stop(): Promise<unknown> }>;

/**
 * Pick a face for each reply that settles from now on. `attach` opens a view of the root conversation, as a client's;
 * replies already there when it starts keep no face, so a restart never backfills.
 */
export function startExpressions(options: {
	root: Pick<Conversation, "submit">;
	models: Models;
	model: ModelChoice;
	files: () => PromptFiles;
	manifest: () => Manifest | undefined;
	attach: Attach;
	log: Logger;
	timeoutMs?: number;
}): { stop(): Promise<void>; change(op: "retake" | "restore" | "advance", reply: string, revision: string, requestId: string): Promise<void> } {
	const { models, log } = options;
	const done = new Set<string>();
	let items: ViewItem[] = [];
	let state: ViewState | undefined;
	let asking = false;
	let stopped = false;
	const busy = new Set<string>();
	const pending = new Map<string, Promise<void>>();
	const target = (id: string) => items.find((i): i is Assistant => i.kind === "assistant" && i.id === id && !i.private && !i.streaming && !i.error && Boolean(i.text.trim()));
	const contextFor = (reply: Assistant): ArtContext => {
		if (reply.artContext) return reply.artContext;
		let j = items.indexOf(reply) - 1;
		for (; j >= 0; j--) { const item = items[j]!; if (item.kind === "user" && !item.private) break; }
		return { said: j >= 0 ? (items[j] as Extract<ViewItem, { kind: "user" }>).text : "", earlier: exchangesBefore(items, j, EARLIER) };
	};
	const write = async (reply: Assistant, choice: ArtTake, context: ArtContext, requestId?: string) => {
		const data = { for: reply.id, ...choice, context, revision: randomUUID(), ...(requestId ? { requestId } : {}) };
		await options.root.submit({ type: "write", ...(requestId ? { requestId: `art:${reply.id}:${requestId}` } : {}), entry: { kind: EXPRESSION, data } }, BG);
		applyArt(reply, data, data.revision);
	};

	const pick = async (said: string, reply: string, earlier: readonly Exchange[], prior: readonly ArtTake[] = []): Promise<FacePick | null> => {
		const model = models.getModel(options.model.provider, options.model.modelId);
		if (model === undefined) throw new Error(`Unknown expression model ${options.model.provider}/${options.model.modelId}`);
		const soul = options.files().soulFile;
		const manifest = options.manifest();
		const now = Date.now();
		const request: ModelContext = {
			messages: [
				{ role: "system", content: `${soul && existsSync(soul) ? readFileSync(soul, "utf8") : ""}\n\n${expressionRules(manifest)}`, timestamp: now } as Message,
				{ role: "user", content: pickRequest(said, reply, earlier) + (prior.length ? `\n\nEarlier takes were not right. Read the reply again and choose a better performance, rather than rerolling blindly:\n${JSON.stringify(prior.map(({ expression, pose }) => ({ expression, pose })))}` : ""), timestamp: now } as Message,
			],
		};
		const thinking = options.model.thinkingLevel === "off" ? {} : { reasoning: options.model.thinkingLevel as never };
		// The system prompt (her soul and the rules) is the same every time, so a short cache saves resending it.
		const answer = await models.completeSimple(model, request, { signal: AbortSignal.timeout(options.timeoutMs ?? 20_000), cacheRetention: "short", maxTokens: 2000, ...thinking });
		if (answer.stopReason === "error" || answer.stopReason === "aborted") throw new Error(answer.errorMessage ?? answer.stopReason);
		const text = answer.content.find((block) => block.type === "text")?.text ?? "";
		return parsePick(text, manifest);
	};

	const consider = async () => {
		if (asking || stopped || state === undefined) return;
		const next = replyToPick(items, state, done);
		if (next === null || busy.has(next.reply.id)) return;
		asking = true;
		busy.add(next.reply.id);
		done.add(next.reply.id);
		const started = Date.now();
		try {
			const chosen = await pick(next.said, next.reply.text, next.earlier);
			if (chosen === null) log.warn("expression_unparsed", { reply: next.reply.id });
			else if (!stopped && target(next.reply.id)?.artVersion === next.reply.artVersion && target(next.reply.id)?.text === next.reply.text) {
				const previous = items.slice(0, items.indexOf(next.reply)).findLast((i): i is Assistant => i.kind === "assistant" && !!i.pose);
				await write(target(next.reply.id)!, { ...resolvePick(chosen, options.manifest(), previous), take: 0 }, { said: next.said, earlier: next.earlier });
				log.info("expression", { reply: next.reply.id, expression: chosen.expression, ...(chosen.pose ? { pose: chosen.pose } : {}), ms: Date.now() - started });
			}
		} catch (error) {
			log.warn("expression_failed", { reply: next.reply.id, error: (error as Error).message });
		} finally {
			asking = false;
			busy.delete(next.reply.id);
			// Another reply may have settled while this one was picked.
			void consider();
		}
	};

	const view = options.attach((reply) => {
		if (reply.type !== "view") return;
		if ("reset" in reply && reply.reset) {
			items = [...reply.items];
			// What is already there when the watch starts keeps no face: a restart never backfills.
			if (state === undefined) for (const item of items) if (item.kind === "assistant") done.add(item.id);
			state = reply.state;
		} else if ("changes" in reply) {
			for (const change of reply.changes) {
				if (change.op === "drop") {
					items = items.filter((item) => item.id !== change.id);
					continue;
				}
				items = items.filter((item) => item.id !== change.item.id);
				const after = change.after === null ? -1 : items.findIndex((item) => item.id === change.after);
				items.splice(after + 1, 0, change.item);
			}
			if (reply.state) state = reply.state;
		}
		void consider();
	});

	return {
		change(op, id, revision, requestId) {
			const key = `${op}:${id}:${requestId}`;
			if (pending.has(key)) return pending.get(key)!;
			const reply = target(id);
			if (reply?.artRequests?.includes(requestId)) return Promise.resolve();
			if (!reply || stopped) return Promise.reject(new Error("That panel is no longer available"));
			if (typeof revision !== "string" || revision !== (reply.artVersion ?? "")) return Promise.reject(new Error("The panel changed; try again"));
			if (busy.has(id)) return Promise.reject(new Error("June is already choosing that face"));
			busy.add(id);
			const run = (async () => {
				const context = contextFor(reply);
				let original: ArtTake | undefined;
				if (!reply.takes?.length) {
					// Preserve an unpicked legacy reply as unpicked: Back restores the shared renderer's exact stand-in.
					original = { take: 0, ...(reply.expression ? { expression: reply.expression } : {}), ...(reply.pose ? { pose: reply.pose } : {}), ...(reply.side ? { side: reply.side } : {}), ...(reply.expressionAt !== undefined || reply.at !== undefined ? { selectedAt: reply.expressionAt ?? reply.at } : {}) };
				}
				const takes = reply.takes ?? [original!];
				const current = takes.find((t) => t.take === (reply.take ?? 0))!;
				let choice: ArtTake;
				if (op === "restore" || op === "advance") {
					const ordered = takes.toSorted((a, b) => a.take - b.take);
					const adjacent = op === "restore" ? ordered.findLast((t) => t.take < current.take) : ordered.find((t) => t.take > current.take);
					if (!adjacent) throw new Error(op === "restore" ? "No earlier take for this panel" : "No later take for this panel");
					choice = adjacent;
				} else {
					const picked = await pick(context.said, reply.text, context.earlier, takes);
					if (!picked) throw new Error("June could not choose another face");
					choice = { ...resolvePick(picked, options.manifest(), reply), take: Math.max(...takes.map((t) => t.take)) + 1, previous: current.take };
				}
				const live = target(id);
				if (stopped || !live || (live.artVersion ?? "") !== revision || live.text !== reply.text) throw new Error("That panel changed while June chose its face");
				if (original) await write(live, original, context);
				await write(live, choice, context, requestId);
			})().finally(() => { busy.delete(id); pending.delete(key); void consider(); });
			pending.set(key, run);
			return run;
		},
		async stop() {
			stopped = true;
			await (await view).stop();
		},
	};
}
