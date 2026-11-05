// Folds a Pi Durable conversation view into the display items every client renders. The daemon runs it, one fold per
// connection, over `Conversation.watch()` and a `ConversationTranscript`; clients only render. It is a pure function of
// the view, so a reconnect, a reset, and a live update all show the same thing.
import type { Sky } from "./situation.ts";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { orgToMarkdown } from "./org.ts";
import { plain } from "./plain.ts";

/** A heartbeat's whole answer when nothing is worth raising; the view shows nothing for it. */
export const QUIET = "QUIET";
export const isQuiet = (text: string) => /^\s*QUIET\.?\s*$/i.test(text);

/** June's own looks, by their june.input source or [tag]: only a real message to the user shows, never the prompt or her tools. */
export const PRIVATE = new Set(["heartbeat", "watch", "work", "follow"]);

/** June's own inputs whose answer goes where the notice was routed, recorded as `surface` in its june.input data. */
const NOTICES = new Set(["work", "follow", "watch", "reminder", "heartbeat"]);
/** Surfaces a reply can alert: graphical clients, and Telegram for notices routed there. */
const SURFACES = new Set(["gui", "apk", "telegram"]);
export type Surface = "gui" | "apk" | "telegram";

/** A client source as stored: the terminal client was `kitty` before it was `tui`. */
export const sourceName = (source: string) => (source === "kitty" ? "tui" : source);

/** An absent expression restores a legacy panel's original, deterministic stand-in. */
export type ArtTake = { take: number; previous?: number; expression?: string; pose?: string; side?: "left" | "right"; selectedAt?: number };
export type ArtContext = { said: string; earlier: { said: string; replied: string }[] };

export type ViewItem =
	/** `private` marks June's own look, shown only in detail. */
	/** `files` are those the message brought to June's inbox, with where they were saved. */
	/** `at`, on a user or assistant item, is when its message was written, in epoch milliseconds, when the log has it. */
	| { kind: "user"; id: string; source: string; text: string; imageCount?: number; files?: { name: string; size: number; path: string }[]; private?: true; at?: number }
	/**
	 * `text` is Markdown. `thinking` holds one flattened line per thinking block, or in detail the full text. `answers` is
	 * the source of the input the reply follows, empty when that input is before the transcript. `alert` names the client
	 * kind that should interrupt the user, on a finished reply only.
	 */
	| { kind: "assistant"; id: string; text: string; streaming: boolean; answers: string; alert?: Surface; error?: string; thinking?: string; private?: true; expression?: string; pose?: string; side?: "left" | "right"; expressionAt?: number; artVersion?: string; take?: number; takes?: ArtTake[]; artRequests?: string[]; artContext?: ArtContext; at?: number }
	/** `error` is the first line of a failed call's output; `output`, in detail only, is all of what the call kept. */
	| { kind: "tool"; id: string; name: string; summary: string; status: "running" | "done" | "error"; error?: string; output?: string; private?: true }
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
	/** The face June shows for her newest reply that has one (see expression.ts), "idle" when none in the view has. */
	expression: string;
	/** Where home is and the weather now, from Home Assistant (see situation.ts); added by the daemon, not the fold. */
	sky?: Sky;
	/** How many dispatched tasks June is following and that are still going; added by the daemon, not the fold. */
	following?: number;
	/** Those tasks by title, with each follow's last signal (see listFollowing); present while any is. */
	follows?: { title: string; signal: string }[];
	/**
	 * What June is doing, the first that holds: thinking (a run is busy or compacting), working (briefs in the
	 * background), watching (following tasks). Absent when none does. Clients add their own offline and voice states
	 * (see "Activities" in docs/interfaces.org). Added by the daemon, not the fold.
	 */
	activity?: "thinking" | "working" | "watching";
};

export type Change = { op: "put"; item: ViewItem; after: string | null } | { op: "drop"; id: string };

/** Apply a display-only choice. Navigation reuses saved takes; new takes keep their creation provenance. */
export function applyArt(reply: Extract<ViewItem, { kind: "assistant" }>, data: Partial<ArtTake> & { revision?: string; requestId?: string; context?: ArtContext }, id: string): void {
	delete reply.expression;
	if (typeof data.expression === "string") reply.expression = data.expression;
	delete reply.pose;
	delete reply.side;
	delete reply.expressionAt;
	if (typeof data.pose === "string") reply.pose = data.pose;
	if (data.side === "left" || data.side === "right") reply.side = data.side;
	if (typeof data.selectedAt === "number" && Number.isFinite(data.selectedAt)) reply.expressionAt = data.selectedAt;
	reply.artVersion = data.revision ?? id;
	if (data.context) reply.artContext = data.context;
	if (Number.isInteger(data.take)) {
		const take: ArtTake = { take: data.take!, expression: data.expression, ...(data.pose ? { pose: data.pose } : {}), ...(data.side ? { side: data.side } : {}), ...(data.selectedAt !== undefined ? { selectedAt: data.selectedAt } : {}), ...(data.previous !== undefined ? { previous: data.previous } : {}) };
		if (!reply.takes?.some((t) => t.take === take.take)) reply.takes = [...(reply.takes ?? []), take];
		reply.take = take.take;
	}
	if (data.requestId) reply.artRequests = [...(reply.artRequests ?? []), data.requestId];
}

/** One value of the view as a client sees it: the transcript the client holds, then the conversation's documents. */
export type Folded = { items: ViewItem[]; state: ViewState; earlier: boolean };

/** `detail` is the complete view: full thinking, tool output, and June's private looks, marked private. */
export type FoldOptions = { readonly detail?: boolean };

type Entry = { readonly id: unknown; readonly kind: string; readonly data?: any; readonly model?: readonly any[] };
type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown; id?: string };

/**
 * Fold the entries a client holds and the view's documents into items. Inside one of June's private looks (a heartbeat,
 * a watch or work report, a followed task) only her final words show, and only when they are a message rather than the
 * quiet answer; her tools, thinking, and streaming reply stay out, unless `detail` asks for them, marked private.
 */
export function fold(entries: readonly Entry[], docs: Readonly<Record<string, unknown>>, earlier = false, options: FoldOptions = {}): Folded {
	const detail = options.detail === true;
	const items: ViewItem[] = [];
	const tools = new Map<string, Extract<ViewItem, { kind: "tool" }>>();
	const background = new Set<string>();
	let hidden = false;
	/** The reply follows a Telegram message, already Markdown; anything else June answers in Org. */
	let markdown = false;
	/** The source of the input being answered, and where a notice was routed. */
	let answering = "";
	let surface: Surface | undefined;
	const mark = (shown: boolean) => (shown ? {} : { private: true as const });
	const text = (raw: string) => (markdown ? plain(raw) : orgToMarkdown(plain(raw)));
	const alert = (): Surface | undefined => (answering === "gui" || answering === "apk" ? answering : NOTICES.has(answering) ? surface : undefined);
	/**
	 * An assistant item. A finished one that ends its turn alerts; one in the middle of a tool round does not, nor does a
	 * private one. In a look, only real words are a message to the user; the rest is private.
	 */
	const assistant = (id: string, content: readonly Block[], options: { streaming?: boolean; error?: string; final?: boolean; shown?: boolean; at?: number } = {}) => {
		const { streaming = false, error, final = true, at } = options;
		const words = content.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("\n\n");
		const blocks = content.filter((b) => b.type === "thinking" && b.thinking?.trim());
		const thinking = detail ? blocks.map((b) => b.thinking!.trim()).join("\n\n") : blocks.map((b) => flatten(b.thinking!)).join("\n");
		const shown = options.shown ?? (!hidden || (words.trim() !== "" && !isQuiet(words)));
		if (!shown && !detail) return;
		if (words === "" && thinking === "" && !error && !streaming) return;
		const notify = shown && !streaming && final && (words.trim() !== "" || error !== undefined) ? alert() : undefined;
		items.push({
			kind: "assistant",
			id,
			text: text(words),
			streaming,
			answers: answering,
			...(notify ? { alert: notify } : {}),
			...(error ? { error } : {}),
			...(thinking ? { thinking } : {}),
			...mark(shown),
			...(at !== undefined ? { at } : {}),
		});
	};

	for (const entry of entries) {
		const id = String(entry.id);
		const message = entry.model?.[0];
		const at = typeof message?.timestamp === "number" ? { at: message.timestamp as number } : {};
		switch (entry.kind) {
			case "june.input": {
				const source = sourceName(String(entry.data?.source ?? "?"));
				hidden = PRIVATE.has(source);
				answering = source;
				surface = SURFACES.has(entry.data?.surface) ? entry.data.surface : undefined;
				// A private look is answered in the markup of where the user last spoke, so it leaves the markup alone.
				if (!hidden) markdown = source === "telegram";
				const said = hidden ? textOf(message?.content) || (entry.data?.text ?? "") : (entry.data?.text ?? "");
				if (!hidden || detail) items.push({ kind: "user", id, source, text: said, ...(entry.data?.imageCount ? { imageCount: entry.data.imageCount } : {}), ...(Array.isArray(entry.data?.files) && entry.data.files.length ? { files: entry.data.files } : {}), ...mark(!hidden), ...at });
				break;
			}
			case "june.patter":
				items.push({ kind: "patter", id, text: entry.data?.text ?? "" });
				break;
			case "june.expression": {
				// The face picked for a reply, after it settled; it rides on the reply's item.
				const reply = items.findLast((item) => item.kind === "assistant" && item.id === String(entry.data?.for));
				if (reply?.kind === "assistant" && (typeof entry.data?.expression === "string" || Number.isInteger(entry.data?.take))) applyArt(reply, entry.data, id);
				break;
			}
			case "june.work":
				if (entry.data?.state === "started") background.add(String(entry.data.id));
				else background.delete(String(entry.data?.id));
				break;
			case "pi.user": {
				const words = textOf(message?.content);
				const tag = /^\[(\w+)\]/.exec(words)?.[1] ?? "";
				// /stop, from either surface, writes this boundary so queued messages can be placed.
				if (words.startsWith("[/stop]")) {
					hidden = false;
					items.push({ kind: "note", id, text: "stopped" });
					break;
				}
				hidden = PRIVATE.has(tag);
				surface = undefined;
				if (hidden) {
					answering = tag;
					if (detail) items.push({ kind: "user", id, source: tag, text: words, private: true });
					break;
				}
				// Untagged user entries came from Telegram before the bridge, and so did notices relayed there.
				const own = /^\[(work|follow|reminder)[\] ]\s*/.exec(words);
				answering = own ? own[1]! : "telegram";
				items.push({ kind: "user", id, source: answering, text: own ? clip(words.slice(own[0].length), 80) : words, ...at });
				markdown = true;
				break;
			}
			case "pi.assistant": {
				const content: readonly Block[] = message?.content ?? [];
				const error = message?.stopReason === "error" || message?.stopReason === "aborted" ? String(message.errorMessage ?? message.stopReason) : undefined;
				if (hidden && !detail) {
					assistant(id, content.filter((b) => b.type === "text"), { final: message?.stopReason !== "toolUse", ...at });
					break;
				}
				assistant(id, content, { ...(error ? { error } : {}), final: message?.stopReason !== "toolUse", ...at });
				for (const b of content) {
					if (b.type !== "toolCall" || !b.id) continue;
					// Prefixed, so a provider's call id never collides with an entry's; a repeated one also takes the entry's.
					const item: Extract<ViewItem, { kind: "tool" }> = { kind: "tool", id: tools.has(b.id) ? `call:${id}:${b.id}` : `call:${b.id}`, name: b.name ?? "tool", summary: summarize(b.arguments), status: "running", ...mark(!hidden) };
					tools.set(b.id, item);
					items.push(item);
				}
				break;
			}
			case "pi.tool-result": {
				if (hidden && !detail) break;
				const callId = String(message?.toolCallId ?? id);
				const status = message?.isError ? ("error" as const) : ("done" as const);
				const output = textOf(message?.content);
				const error = message?.isError ? output.split("\n")[0] : undefined;
				const done = { status, ...(error ? { error } : {}), ...(detail ? { output } : {}) };
				const known = tools.get(callId);
				if (known !== undefined) Object.assign(known, done);
				// The call itself is before the transcript the client holds.
				else items.push({ kind: "tool", id: `call:${callId}`, name: message?.toolName ?? "tool", summary: "", ...done, ...mark(!hidden) });
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
	if (!hidden || detail) {
		const message = live.generation?.message as { content?: Block[] } | undefined;
		// A look's reply is private until it is committed and shows whether it is a message.
		if (message !== undefined) assistant("live", message.content ?? [], { streaming: true, shown: !hidden });
		for (const slot of live.tools ?? []) {
			const known = tools.get(slot.callId);
			if (detail && known !== undefined && slot.status !== "done" && slot.output !== undefined) known.output = slot.output;
			if (slot.status === "done" || known !== undefined) continue;
			items.push({ kind: "tool", id: `call:${slot.callId}`, name: slot.name, summary: "", status: "running", ...(detail && slot.output !== undefined ? { output: slot.output } : {}), ...mark(!hidden) });
		}
		// A run that ended without an answer says why, unless the user stopped it or started afresh.
		const failure = live.runFailure;
		if (!running && failure !== undefined && !["aborted", "reset", "nothing_to_answer"].includes(failure.reason)) {
			const last = items.at(-1);
			// In a look, a failure is never a message to the user.
			if (!(last?.kind === "assistant" && last.error))
				assistant(`failure:${String(failure.taskId)}`, [], { error: [failure.reason.replace(/_/g, " "), failure.detail].filter(Boolean).join(": "), shown: !hidden });
		}
	}
	// A call without a result once its run has ended was cut off.
	if (!running)
		for (const tool of tools.values())
			if (tool.status === "running") Object.assign(tool, { status: "error", error: "interrupted" });

	const agent = docs["pi.agent"] as { model?: { modelId?: string }; thinkingLevel?: string } | undefined;
	const retry = live.generation?.retry;
	// Retaking an older panel must not put its face on live June instead of the newest reply's.
	const face = items.findLast((item): item is Extract<ViewItem, { kind: "assistant" }> => item.kind === "assistant" && !item.private && !!item.expression);
	const state: ViewState = {
		running,
		background: background.size,
		queued: ((docs["pi.inbox"] as { items?: unknown[] } | undefined)?.items ?? []).length,
		model: agent?.model?.modelId ? `${agent.model.modelId}${agent.thinkingLevel ? `:${agent.thinkingLevel}` : ""}` : "",
		compacting: (live.compactions?.length ?? 0) > 0,
		expression: face?.expression ?? "idle",
		...(retry ? { notice: `retrying: ${retry.error}` } : live.compactionFailure ? { notice: `compaction failed: ${live.compactionFailure.error}` } : {}),
	};
	return { items, state, earlier };
}

/** The items of a view the daemon holds through a `ConversationTranscript`: its entries, in order, and whether more precede them. */
export function foldView(view: Omit<ConversationView, "entries" | "before"> & { readonly items: readonly { kind: string; entry?: unknown }[] }, options: FoldOptions = {}): Folded {
	const entries = view.items.flatMap((item) => (item.kind === "entry" ? [item.entry as Entry] : []));
	return fold(entries, view.docs, view.items[0]?.kind === "earlier", options);
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
