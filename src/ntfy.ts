// June's replies reach the phone through ntfy when the app is not open: a reply meant for the phone (its view item
// alerts `apk`, as one answering a phone message or a notice routed there does) is posted to the user's ntfy topic,
// once, unless the June app has the conversation open, where it already shows. A tap opens the app on it. The watcher
// reads the same folded view clients do; a receipt of the newest entry it has seen keeps a restart from sending again.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { orgToMarkdown } from "./org.ts";
import type { Reply } from "./protocol.ts";
import type { Logger } from "./runtime.ts";
import { applyChanges, type ViewItem } from "./transcript.ts";

/** What a tap on the notification opens: June's app, on the conversation (its ConversationActivity takes june://). */
export const OPEN_APP = "june://conversation";
const LIMIT = 400;

/** A finished reply meant for the phone, with words or an error to say. */
export function pushable(item: ViewItem): item is Extract<ViewItem, { kind: "assistant" }> {
	return item.kind === "assistant" && !item.streaming && item.alert === "apk" && (item.text.trim() !== "" || item.error !== undefined);
}

/** A reply's words for a notification: her Org as plain text, links as their labels, cut short. */
export function notificationText(item: Extract<ViewItem, { kind: "assistant" }>): string {
	const words = orgToMarkdown(item.text.trim())
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\*\*|~~|`/g, "")
		.replace(/(^|[\s(])\*([^*\s](?:[^*]*[^*\s])?)\*(?=[\s.,;:!?)]|$)/g, "$1$2")
		.replace(/^#+\s*/gm, "")
		.trim();
	const said = words || `⚠ ${item.error ?? ""}`;
	return said.length > LIMIT ? `${said.slice(0, LIMIT - 1)}…` : said;
}

export function createNtfy(options: {
	url: string;
	/** Where the receipt of the newest entry seen is kept. */
	state: string;
	/** Whether the June app has the conversation open on a phone, where the reply already shows. */
	viewing: () => boolean;
	log: Logger;
	post?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
}): { onView(reply: Reply): void } {
	const post = options.post ?? ((url, init) => fetch(url, init));
	let seen: number | undefined;
	try {
		seen = Number(JSON.parse(readFileSync(options.state, "utf8")).seen) || undefined;
	} catch {}
	let items: ViewItem[] = [];
	const save = () => {
		mkdirSync(dirname(options.state), { recursive: true });
		writeFileSync(options.state, `${JSON.stringify({ seen })}\n`);
	};
	const send = (item: Extract<ViewItem, { kind: "assistant" }>) =>
		post(options.url, { method: "POST", body: notificationText(item), headers: { Title: "June", Click: OPEN_APP, Tags: "speech_balloon" } }).then(
			(r) => (r.ok ? options.log.info("ntfy_sent", { item: item.id }) : options.log.warn("ntfy_refused", { item: item.id, status: r.status })),
			(error: Error) => options.log.warn("ntfy_failed", { item: item.id, error: error.message }),
		);
	return {
		onView(reply) {
			if (reply.type !== "view") return;
			items = "reset" in reply ? reply.items : applyChanges(items, reply.changes);
			const numbered = items.filter((item) => /^\d+$/.test(item.id));
			// A first start sends nothing it finds, as the Telegram bridge does.
			if (seen === undefined) {
				seen = Math.max(0, ...numbered.map((item) => Number(item.id)));
				return save();
			}
			for (const item of numbered) {
				const entry = Number(item.id);
				if (entry <= seen) continue;
				// A streaming reply is not past yet: it is looked at again when it finishes.
				if (item.kind === "assistant" && item.streaming) break;
				seen = entry;
				if (pushable(item) && !options.viewing()) void send(item);
			}
			save();
		},
	};
}
