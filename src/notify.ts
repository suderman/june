// What June hears on her own initiative, such as a brief's report or news of a task she follows, is an ordinary input queued
// behind whatever she is doing. The commit that admits it also records where the user last spoke, as `surface` in its
// june.input data, so the view can alert that surface when she answers and the Telegram bridge knows to send it.
import type { ConversationHandle, ConversationId, SubmissionId, Tx } from "@earendil-works/pi-durable";
import { SOURCES } from "./protocol.ts";
import { sourceName, type Surface } from "./transcript.ts";

export type Notice = {
	readonly requestId: string;
	/** What June reads, starting with its tag, such as "[work] …". */
	readonly content: string;
	/** For the terminal: the june.input source and the short line it shows. */
	readonly source: string;
	readonly label: string;
};

/** Sources of the user's own messages; everything else in june.input is June's own. */
const CLIENTS = new Set<string>(SOURCES);
/** Tags of June's own inputs and the stop boundary, which say nothing about where the user is. */
const OWN = /^\[(\/stop|work|follow|reminder|heartbeat|watch)\b/;
/** How far back to look for the user's latest message before falling back to the terminal. */
const SCAN_LIMIT = 2000;
const PAGE = 200;

/**
 * Where a notice admitted now should alert: `telegram` when the user's latest own message came from Telegram, otherwise
 * `gui`, the terminal surface. Reads in `tx`, so call it before the commit's first table write.
 */
export async function surfaceFor(tx: Tx, conversationId: ConversationId): Promise<Surface> {
	let cursor: Parameters<Tx["scanEntries"]>[2];
	for (let seen = 0; seen < SCAN_LIMIT; ) {
		const page = await tx.scanEntries({ conversationId, order: "descending" }, PAGE, cursor);
		for (const entry of page.items) {
			const from = sourceOf(entry);
			if (from !== undefined) return from === "telegram" ? "telegram" : "gui";
		}
		seen += page.items.length;
		if (page.next === undefined || page.items.length === 0) break;
		cursor = page.next;
	}
	return "gui";
}

/** The client a user's own message came from, or undefined for anything else. */
function sourceOf(entry: { kind: string; data?: unknown; model?: readonly any[] }): string | undefined {
	if (entry.kind === "june.input") {
		const source = sourceName(String((entry.data as { source?: unknown } | undefined)?.source ?? ""));
		return CLIENTS.has(source) ? source : undefined;
	}
	if (entry.kind !== "pi.user") return undefined;
	// Before the bridge, Telegram messages were untagged pi.user entries.
	const content = entry.model?.[0]?.content;
	const text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((b: any) => (b?.type === "text" ? [b.text] : [])).join(" ") : "";
	if (OWN.test(text)) return undefined;
	const tag = /^\[(\w+)\]/.exec(text)?.[1];
	return tag !== undefined && CLIENTS.has(sourceName(tag)) ? sourceName(tag) : "telegram";
}

/**
 * Admit a notice inside the caller's commit, routed to the surface the user last used. Call it before the commit's first
 * table write. Its request id makes a rerun admit it once.
 */
export async function admitNotice(tx: Tx, conversation: Pick<ConversationHandle, "submit">, conversationId: ConversationId, notice: Notice): Promise<SubmissionId> {
	const surface = await surfaceFor(tx, conversationId);
	return conversation.submit(tx, {
		type: "input",
		requestId: notice.requestId,
		content: notice.content,
		whenBusy: "followUp",
		entry: { kind: "june.input", data: { source: notice.source, text: notice.label, surface } },
	});
}
