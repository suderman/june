// What June hears on her own initiative, such as a brief's report or news of a task she follows, goes where Jon last
// spoke to her. From Telegram, it goes through the channel's own delivery task, so her answer reaches his chat as a
// reminder's does; otherwise it is an ordinary input, which the terminal shows.
import type { Context } from "@earendil-works/chord";
import { type ConversationHandle, type ConversationId, defineDoc, type RegistrySnapshot, type Tx } from "@earendil-works/pi-durable";

// pi-durable-telegram keeps its chat → conversation map in these documents. June writes the same kinds so the user's
// private chat lands in the primary conversation instead of a new one. Keep in step with its src/channel/docs.ts.
export const ChatMap = defineDoc<{ chats: Record<string, number> }>({
	kind: "tg.chats",
	version: 1,
	scope: "session",
	initial: () => ({ chats: {} }),
});
export const ChatInfo = defineDoc<{ chatId: number }>({
	kind: "tg.chat",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ chatId: 0 }),
});

/** pi-durable-telegram's delivery task: it submits an input and sends the answer to the chat. */
const DELIVER = "tg.deliver";

export type Surface = "telegram" | "terminal";

/** Inputs June's own tasks write, which say nothing about where Jon is. */
const OWN = /^\[(\/stop|work|follow|reminder|heartbeat)\b/;

/**
 * Where a notice goes: Telegram when Jon last spoke to June there and the channel can deliver to his chat, otherwise
 * the terminal. Decide it inside a commit and keep it, so a restart cannot send one notice both ways.
 */
export async function noticeSurface(tx: Tx, registry: RegistrySnapshot, conversationId: ConversationId): Promise<Surface> {
	if (registry.task(DELIVER) === undefined || !(await tx.doc(ChatInfo, conversationId)).chatId) return "terminal";
	return lastSurface(tx, conversationId);
}

/**
 * Where Jon last spoke to June. The terminal and CLI tag their input as june.input; a Telegram message is a plain user
 * entry. Only the newest hundred entries are read: a quiet stretch longer than that falls back to the terminal.
 */
async function lastSurface(tx: Tx, conversationId: ConversationId): Promise<Surface> {
	for (const entry of (await tx.scanEntries({ conversationId, order: "descending" }, 100)).items) {
		if (entry.kind === "june.input") {
			const source = (entry.data as { source?: string } | undefined)?.source;
			if (source === "kitty" || source === "cli") return "terminal";
		} else if (entry.kind === "pi.user") {
			const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
			const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b?.text ?? "").join("") : "";
			if (!OWN.test(text)) return "telegram";
		}
	}
	return "terminal";
}

export type Notice = {
	readonly requestId: string;
	/** What June reads, starting with its tag, such as "[work] …". */
	readonly content: string;
	/** For the terminal: the june.input source and the short line it shows. */
	readonly source: string;
	readonly label: string;
};

/** Hand a notice bound for Telegram to its delivery inside the caller's commit, so it is created once with that commit. */
export async function deliverIn(tx: Tx, registry: RegistrySnapshot, conversationId: ConversationId, notice: Notice): Promise<void> {
	const chatId = (await tx.doc(ChatInfo, conversationId)).chatId;
	await tx.createTask(registry.task(DELIVER)! as never, { chatId, requestId: notice.requestId, content: notice.content }, {
		ownership: { kind: "conversation" },
		background: true,
		conversationId,
	});
}

/** The terminal's way: an input queued behind whatever June is doing; its request id makes a rerun submit it once. */
export async function submitNotice(conversation: ConversationHandle | undefined, notice: Notice, context: Context): Promise<void> {
	await conversation?.submit(
		{
			type: "input",
			requestId: notice.requestId,
			content: notice.content,
			whenBusy: "followUp",
			entry: { kind: "june.input", data: { source: notice.source, text: notice.label } },
		},
		context,
	);
}
