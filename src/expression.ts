// June's expression: after each reply settles, a short model call picks the face she shows for it, from the vocabulary
// in avatar.ts and, optionally, a pose from the avatar set. The pick is a display-only `june.expression` entry naming the
// reply, so no model context, compaction, or memory review ever sees it; the folded view carries it to clients on the
// reply's item and as `state.expression`. The trial behind this is "Test patter choosing June's expressions" in the
// project's Org record: a separate pass beat a tool in June's own turn, which would carry her whole context each reply.
import { existsSync, readFileSync } from "node:fs";
import type { Context as ModelContext, Message, Models } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { EXPRESSIONS, type Manifest, parseManifest } from "./avatar.ts";
import type { ModelChoice, PromptFiles } from "./config.ts";
import type { Reply } from "./protocol.ts";
import type { Logger } from "./runtime.ts";
import type { ViewItem, ViewState } from "./transcript.ts";
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

/**
 * The reply that needs a face now: the newest visible reply, settled, with words and no error or face yet, once the run
 * has ended, with the user's message before it. Null while she is still working or when there is nothing new.
 */
export function replyToPick(items: readonly ViewItem[], state: Pick<ViewState, "running" | "compacting">, done: ReadonlySet<string>): { reply: Assistant; said: string } | null {
	if (state.running || state.compacting) return null;
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]!;
		if (item.kind === "user" && !item.private) return null;
		if (item.kind !== "assistant" || item.private || item.streaming || item.error || !item.text.trim()) continue;
		if (item.expression !== undefined || done.has(item.id)) return null;
		let said = "";
		for (let j = i - 1; j >= 0; j--) {
			const before = items[j]!;
			if (before.kind === "user" && !before.private) {
				said = before.text;
				break;
			}
		}
		return { reply: item, said };
	}
	return null;
}

/** The avatar set whose poses June may name: the user's own in the data directory, else the base set. */
export function loadManifest(paths: readonly string[], log: Logger): Manifest | undefined {
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			return parseManifest(JSON.parse(readFileSync(path, "utf8")));
		} catch (error) {
			log.warn("expression_manifest", { path, error: (error as Error).message });
		}
	}
	return undefined;
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
}): { stop(): Promise<void> } {
	const { models, log } = options;
	const done = new Set<string>();
	let items: ViewItem[] = [];
	let state: ViewState | undefined;
	let asking = false;
	let stopped = false;

	const pick = async (said: string, reply: string): Promise<FacePick | null> => {
		const model = models.getModel(options.model.provider, options.model.modelId);
		if (model === undefined) throw new Error(`Unknown expression model ${options.model.provider}/${options.model.modelId}`);
		const soul = options.files().soulFile;
		const manifest = options.manifest();
		const now = Date.now();
		const request: ModelContext = {
			messages: [
				{ role: "system", content: `${soul && existsSync(soul) ? readFileSync(soul, "utf8") : ""}\n\n${expressionRules(manifest)}`, timestamp: now } as Message,
				{ role: "user", content: `${user()} wrote:\n${said || "(nothing: June spoke first)"}\n\nJune replied:\n${reply}`, timestamp: now } as Message,
			],
		};
		const thinking = options.model.thinkingLevel === "off" ? {} : { reasoning: options.model.thinkingLevel as never };
		const answer = await models.completeSimple(model, request, { signal: AbortSignal.timeout(options.timeoutMs ?? 20_000), cacheRetention: "none", maxTokens: 2000, ...thinking });
		if (answer.stopReason === "error" || answer.stopReason === "aborted") throw new Error(answer.errorMessage ?? answer.stopReason);
		const text = answer.content.find((block) => block.type === "text")?.text ?? "";
		return parsePick(text, manifest);
	};

	const consider = async () => {
		if (asking || stopped || state === undefined) return;
		const next = replyToPick(items, state, done);
		if (next === null) return;
		asking = true;
		done.add(next.reply.id);
		const started = Date.now();
		try {
			const chosen = await pick(next.said, next.reply.text);
			if (chosen === null) log.warn("expression_unparsed", { reply: next.reply.id });
			else if (!stopped) {
				await options.root.submit({ type: "write", entry: { kind: EXPRESSION, data: { for: next.reply.id, ...chosen } } }, BG);
				log.info("expression", { reply: next.reply.id, expression: chosen.expression, ...(chosen.pose ? { pose: chosen.pose } : {}), ms: Date.now() - started });
			}
		} catch (error) {
			log.warn("expression_failed", { reply: next.reply.id, error: (error as Error).message });
		} finally {
			asking = false;
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
		async stop() {
			stopped = true;
			await (await view).stop();
		},
	};
}
