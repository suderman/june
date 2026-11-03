// The day's greeting: people greet each other the first time they speak in a day, and not again after. Until the user and
// June have spoken today, her main conversation's prompt asks her to open with a greeting for the time of day, whoever
// speaks first. The day starts at the rhythm's wake, so a chat that runs past midnight is still the same day.
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { type Conversation, defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { isQuiet } from "./transcript.ts";
import { user, User } from "./user.ts";

/** Inputs June's own tasks write, rather than the user. */
const OWN = /^\[(\/stop|work|follow|reminder|heartbeat|watch)\b/;

const text = (m: Message) =>
	typeof m.content === "string" ? m.content : m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");

/** The most recent wake ("HH:MM", local) at or before `now`. */
export function dayStart(now: Date, wake: string): Date {
	const [h, m] = wake.split(":").map(Number);
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
	if (start > now) start.setDate(start.getDate() - 1);
	return start;
}

/**
 * The section's text while the user and June have not spoken since the day began, before the input being answered: a
 * message the user wrote, or a finished message June sent that was not a quiet heartbeat. Undefined once they have.
 */
export function greeting(messages: readonly Message[], now: Date, wake: string): string | undefined {
	const since = dayStart(now, wake).getTime();
	const ask = messages.findLastIndex((m) => m.role === "user");
	const before = ask < 0 ? messages : messages.slice(0, ask);
	const spoken = before.some((m) => {
		if (m.timestamp < since) return false;
		if (m.role === "user") return !OWN.test(text(m));
		if (m.role !== "assistant" || m.stopReason === "toolUse" || m.stopReason === "error" || m.stopReason === "aborted") return false;
		const words = text(m).trim();
		return words !== "" && !isQuiet(words);
	});
	if (spoken) return undefined;
	return `You and ${user()} have not spoken yet today. Whatever you say to ${user()} first today opens with a greeting for the time of day, as people do: good morning or a variant of it before lunch, and after lunch something that fits the afternoon or evening instead. If ${user()} greeted you, answer in kind; if they did not, greet them anyway, briefly, then carry on. ${User()} and you greet once a day, so once you have spoken today this note goes away. A greeting is never a reason to send a message: if you would otherwise stay quiet, stay quiet.`;
}

/** The extension installs before the harness opens; `start` gives it the root conversation, the only one that talks to the user. */
export function createGreeting(options: { wake: string }): { extension: Extension; start(root: Conversation): void } {
	let root: Conversation | undefined;
	const extension = defineExtension({
		name: "june-greeting",
		sections: [
			section("greeting", async ({ conversationId }) => {
				if (root === undefined || conversationId !== root.id) return undefined;
				return greeting((await root.context(BG)).messages, new Date(), options.wake);
			}),
		],
	});
	return { extension, start: (r) => void (root = r) };
}
