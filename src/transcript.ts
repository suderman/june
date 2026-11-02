// Folds a Pi Durable conversation view into the display items every client renders. The daemon runs it, one fold per
// connection, over `Conversation.watch()` and a `ConversationTranscript`; clients only render. It is a pure function of
// the view, so a reconnect, a reset, and a live update all show the same thing.
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { orgToMarkdown } from "./org.ts";
import { plain } from "./plain.ts";

/** A heartbeat's whole answer when nothing is worth raising; the view shows nothing for it. */
export const QUIET = "QUIET";
export const isQuiet = (text: string) => /^\s*QUIET\.?\s*$/i.test(text);

/** June's own looks, by their june.input source or [tag]: only a real message to the user shows, never the prompt or her tools. */
export const PRIVATE = new Set(["heartbeat", "watch", "work", "follow"]);

export type ViewItem =
	| { kind: "user"; id: string; source: string; text: string; imageCount?: number }
	/** `text` is Markdown. `thinking` holds one flattened line per thinking block. */
	| { kind: "assistant"; id: string; text: string; streaming: boolean; error?: string; thinking?: string }
	/** `error` is the first line of a failed call's output. */
	| { kind: "tool"; id: string; name: string; summary: string; status: "running" | "done" | "error"; error?: string }
	| { kind: "note"; id: string; text: string }
	| { kind: "patter"; id: string; text: string };

export type ViewState = {
	running: boolean;
	/** Briefs running in June's working context in the background. */
	background: number;
	queued: number;
	model: string;
	notice?: string;
	compacting: boolean;
};

export type Change = { op: "put"; item: ViewItem; after: string | null } | { op: "drop"; id: string };

/** One value of the view as a client sees it: the transcript the client holds, then the conversation's documents. */
export type Folded = { items: ViewItem[]; state: ViewState; earlier: boolean };

type Entry = { readonly id: unknown; readonly kind: string; readonly data?: any; readonly model?: readonly any[] };
type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown; id?: string };

/**
 * Fold the entries a client holds and the view's documents into items. Inside one of June's private looks (a heartbeat,
 * a watch or work report, a followed task) only her final words show, and only when they are a message rather than the
 * quiet answer; her tools, thinking, and streaming reply stay out.
 */
export function fold(entries: readonly Entry[], docs: Readonly<Record<string, unknown>>, earlier = false): Folded {
	const items: ViewItem[] = [];
	const tools = new Map<string, Extract<ViewItem, { kind: "tool" }>>();
	const background = new Set<string>();
	let hidden = false;
	/** The reply follows a Telegram message, already Markdown; anything else June answers in Org. */
	let markdown = false;
	const text = (raw: string) => (markdown ? plain(raw) : orgToMarkdown(plain(raw)));
	const assistant = (id: string, content: readonly Block[], streaming: boolean, error?: string) => {
		const words = content.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("\n\n");
		const thinking = content.filter((b) => b.type === "thinking" && b.thinking?.trim()).map((b) => flatten(b.thinking!));
		if (words === "" && thinking.length === 0 && !error && !streaming) return;
		items.push({ kind: "assistant", id, text: text(words), streaming, ...(thinking.length ? { thinking: thinking.join("\n") } : {}), ...(error ? { error } : {}) });
	};

	for (const entry of entries) {
		const id = String(entry.id);
		const message = entry.model?.[0];
		switch (entry.kind) {
			case "june.input": {
				const source = String(entry.data?.source ?? "?");
				hidden = PRIVATE.has(source);
				// A private look is answered in the markup of where the user last spoke, so it leaves the markup alone.
				if (!hidden) markdown = false;
				if (!hidden) items.push({ kind: "user", id, source, text: entry.data?.text ?? "", ...(entry.data?.imageCount ? { imageCount: entry.data.imageCount } : {}) });
				break;
			}
			case "june.patter":
				items.push({ kind: "patter", id, text: entry.data?.text ?? "" });
				break;
			case "june.work":
				if (entry.data?.state === "started") background.add(String(entry.data.id));
				else background.delete(String(entry.data?.id));
				break;
			case "pi.user": {
				const words = textOf(message?.content);
				hidden = PRIVATE.has(/^\[(\w+)\]/.exec(words)?.[1] ?? "");
				if (hidden) break;
				// Untagged user entries came from Telegram, and so did notices relayed there before the bridge.
				const own = /^\[(work|follow|reminder)[\] ]\s*/.exec(words);
				// /stop, from either surface, writes this boundary so queued messages can be placed.
				if (words.startsWith("[/stop]")) items.push({ kind: "note", id, text: "stopped" });
				else if (own) items.push({ kind: "user", id, source: own[1]!, text: clip(words.slice(own[0].length), 80) });
				else items.push({ kind: "user", id, source: "telegram", text: words });
				if (!words.startsWith("[/stop]")) markdown = true;
				break;
			}
			case "pi.assistant": {
				const content: readonly Block[] = message?.content ?? [];
				if (hidden) {
					const words = textOf(content.filter((b) => b.type === "text"));
					if (words.trim() !== "" && !isQuiet(words)) items.push({ kind: "assistant", id, text: text(words), streaming: false });
					break;
				}
				const error = message?.stopReason === "error" || message?.stopReason === "aborted" ? String(message.errorMessage ?? message.stopReason) : undefined;
				assistant(id, content, false, error);
				for (const b of content) {
					if (b.type !== "toolCall" || !b.id) continue;
					// Prefixed, so a provider's call id never collides with an entry's; a repeated one also takes the entry's.
					const item = { kind: "tool" as const, id: tools.has(b.id) ? `call:${id}:${b.id}` : `call:${b.id}`, name: b.name ?? "tool", summary: summarize(b.arguments), status: "running" as const };
					tools.set(b.id, item);
					items.push(item);
				}
				break;
			}
			case "pi.tool-result": {
				if (hidden) break;
				const callId = String(message?.toolCallId ?? id);
				const status = message?.isError ? ("error" as const) : ("done" as const);
				const error = message?.isError ? textOf(message.content).split("\n")[0] : undefined;
				const done = { status, ...(error ? { error } : {}) };
				const known = tools.get(callId);
				if (known !== undefined) Object.assign(known, done);
				// The call itself is before the transcript the client holds.
				else items.push({ kind: "tool", id: `call:${callId}`, name: message?.toolName ?? "tool", summary: "", ...done });
				break;
			}
			case "pi.reset":
				items.push({ kind: "note", id, text: "new context" });
				break;
			case "pi.compaction":
				items.push({ kind: "note", id, text: "earlier conversation compacted" });
				break;
		}
	}

	const live = (docs["pi.live"] ?? {}) as LiveState;
	const running = live.run !== undefined;
	if (!hidden) {
		const message = live.generation?.message as { content?: Block[] } | undefined;
		if (message !== undefined) assistant("live", message.content ?? [], true);
		for (const slot of live.tools ?? []) {
			if (slot.status === "done") continue;
			const known = tools.get(slot.callId);
			if (known === undefined) items.push({ kind: "tool", id: `call:${slot.callId}`, name: slot.name, summary: "", status: "running" });
		}
		// A run that ended without an answer says why, unless the user stopped it or started afresh.
		const failure = live.runFailure;
		if (!running && failure !== undefined && !["aborted", "reset", "nothing_to_answer"].includes(failure.reason)) {
			const last = items.at(-1);
			if (!(last?.kind === "assistant" && last.error))
				items.push({ kind: "assistant", id: `failure:${String(failure.taskId)}`, text: "", streaming: false, error: [failure.reason.replace(/_/g, " "), failure.detail].filter(Boolean).join(": ") });
		}
	}
	// A call without a result once its run has ended was cut off.
	if (!running)
		for (const tool of tools.values())
			if (tool.status === "running") Object.assign(tool, { status: "error", error: "interrupted" });

	const agent = docs["pi.agent"] as { model?: { modelId?: string }; thinkingLevel?: string } | undefined;
	const retry = live.generation?.retry;
	const state: ViewState = {
		running,
		background: background.size,
		queued: ((docs["pi.inbox"] as { items?: unknown[] } | undefined)?.items ?? []).length,
		model: agent?.model?.modelId ? `${agent.model.modelId}${agent.thinkingLevel ? `:${agent.thinkingLevel}` : ""}` : "",
		compacting: (live.compactions?.length ?? 0) > 0,
		...(retry ? { notice: `retrying: ${retry.error}` } : live.compactionFailure ? { notice: `compaction failed: ${live.compactionFailure.error}` } : {}),
	};
	return { items, state, earlier };
}

/** The items of a view the daemon holds through a `ConversationTranscript`: its entries, in order, and whether more precede them. */
export function foldView(view: Omit<ConversationView, "entries" | "before"> & { readonly items: readonly { kind: string; entry?: unknown }[] }): Folded {
	const entries = view.items.flatMap((item) => (item.kind === "entry" ? [item.entry as Entry] : []));
	return fold(entries, view.docs, view.items[0]?.kind === "earlier");
}

/**
 * The changes that turn `before` into `after`: a drop for each item gone, then a put for each item that is new, changed,
 * or now follows a different item, in order. Applied in order with `applyChanges`, they give `after` exactly.
 */
export function diff(before: readonly ViewItem[], after: readonly ViewItem[], sent: Map<string, string>): Change[] {
	const changes: Change[] = [];
	const ids = new Set(after.map((item) => item.id));
	const previous = new Map<string, string | null>();
	before.forEach((item, i) => previous.set(item.id, i === 0 ? null : before[i - 1]!.id));
	for (const item of before) if (!ids.has(item.id)) {
		changes.push({ op: "drop", id: item.id });
		sent.delete(item.id);
	}
	after.forEach((item, i) => {
		const placed = i === 0 ? null : after[i - 1]!.id;
		const json = JSON.stringify(item);
		if (sent.get(item.id) === json && previous.get(item.id) === placed) return;
		sent.set(item.id, json);
		changes.push({ op: "put", item, after: placed });
	});
	return changes;
}

/** A client's side of `diff`: apply drops and puts to the items it holds. */
export function applyChanges(items: ViewItem[], changes: readonly Change[]): ViewItem[] {
	let next = items;
	for (const change of changes) {
		next = next.filter((item) => item.id !== (change.op === "drop" ? change.id : change.item.id));
		if (change.op === "put") {
			const at = change.after === null ? 0 : next.findIndex((item) => item.id === change.after) + 1;
			next.splice(at === 0 && change.after !== null ? next.length : at, 0, change.item);
		}
	}
	return next;
}

/** One line per thinking block, with Markdown emphasis removed, so a reasoning summary reads "Finding project heading". */
function flatten(thinking: string): string {
	return thinking.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : "")).join("");
}

export function summarize(args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	const values = Object.entries(args as Record<string, unknown>)
		.filter(([, v]) => typeof v === "string" || typeof v === "number")
		.map(([k, v]) => `${k}=${String(v).replace(/\s+/g, " ").slice(0, 60)}`);
	return values.join(" ");
}

export function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
