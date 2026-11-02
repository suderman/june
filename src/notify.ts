// What June hears on her own initiative, such as a brief's report or news of a task she follows, is an ordinary input queued
// behind whatever she is doing, which the terminal shows. Choosing a surface for it returns with the Telegram bridge.
import type { Context } from "@earendil-works/chord";
import type { ConversationHandle } from "@earendil-works/pi-durable";

export type Notice = {
	readonly requestId: string;
	/** What June reads, starting with its tag, such as "[work] …". */
	readonly content: string;
	/** For the terminal: the june.input source and the short line it shows. */
	readonly source: string;
	readonly label: string;
};

/** Submit a notice; its request id makes a rerun submit it once. */
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
