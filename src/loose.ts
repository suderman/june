// June's evening look for loose ends: once a day, from the configured time until the user's quiet hour, she looks over the
// day's conversation and her journal entries for a few things whose outcome she never heard, so the nightly reflection
// can close the day without gaps, and asks about them or stays quiet. It is a heartbeat-tagged input in the main
// conversation, so the view hides it and its quiet answer exactly as a heartbeat's, and its message goes where the user
// last spoke. A receipt in the state directory makes it once a day, across restarts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { type Conversation, type Harness, LiveDoc } from "@earendil-works/pi-durable";
import type { Config, PromptFiles } from "./config.ts";
import { within } from "./heartbeat.ts";
import { daySection, localStamp, read } from "./journal.ts";
import { admitNotice } from "./notify.ts";
import type { Logger } from "./runtime.ts";
import { isQuiet, QUIET } from "./transcript.ts";
import { User, user } from "./user.ts";

/** Own inputs June's tasks write; they say nothing about whether the user spoke today. */
const OWN = /^\[(\/stop|work|follow|reminder|heartbeat|watch)\b/;

export function createLooseEnds(options: {
	config: Config["looseEnds"];
	/** The rhythm's quiet hour, after which the look waits for tomorrow. */
	quiet: string;
	/** The heartbeat's chatting threshold, so a look while the user is chatting is just her next line. */
	chattingMinutes: number;
	files: () => PromptFiles;
	state: string;
	log: Logger;
	/** Tests run the clock and the loop faster. */
	now?: () => Date;
	tickMs?: number;
}): { start(harness: Harness, root: Conversation): () => void } {
	const { config, log } = options;
	const now = options.now ?? (() => new Date());
	const window = { start: config.at, end: options.quiet };
	const receipt = join(options.state, "loose-ends.json");
	const lastDay = (): string => {
		try {
			return String(JSON.parse(readFileSync(receipt, "utf8")).day ?? "");
		} catch {
			return "";
		}
	};
	let busy = false;

	const start = (harness: Harness, root: Conversation) => {
		const tick = async () => {
			const at = now();
			if (busy || !within(at, window)) return;
			const day = opened(at, config.at);
			if (lastDay() >= day) return;
			// Never queue behind a reply or a message waiting its turn; the next minute will do.
			if ((await harness.snapshot(LiveDoc, root.id, BG))?.run !== undefined) return;
			busy = true;
			try {
				const since = startOf(day);
				const { messages } = await root.context(BG);
				const spoke = messages.filter((m) => m.role === "user" && m.timestamp >= since && !OWN.test(text(m)));
				const { journalFile, heartbeatFile } = options.files();
				const found = journalFile === undefined ? undefined : daySection(read(journalFile), day);
				// The receipt first: a crash after it costs one evening; one before it would ask twice.
				mkdirSync(options.state, { recursive: true });
				writeFileSync(receipt, `${JSON.stringify({ day, at: at.getTime() })}\n`);
				// A day with nothing said and nothing written has no loose ends, so the model is not asked.
				if (spoke.length === 0 && found === undefined) return log.info("loose_ends_quiet", { day, reason: "nothing today" });
				const chatting = at.getTime() - (spoke.at(-1)?.timestamp ?? 0) < options.chattingMinutes * 60_000;
				const content = prompt({ day, chatting, journal: found?.text, instructions: standing(heartbeatFile) });
				const id = await root.commit((tx) => admitNotice(tx, root, root.id, { requestId: `loose-ends:${day}`, content, source: "heartbeat", label: "loose ends" }), BG);
				const settled = await (await harness.submission(id, BG))!.wait(BG);
				if (settled.status !== "done") return log.warn("loose_ends_unanswered", { day, status: settled.status });
				const answer = reply((await root.commit((tx) => tx.entry(settled.answer!), BG))?.model?.[0]);
				if (isQuiet(answer) || answer === "") return log.info("loose_ends_quiet", { day });
				log.info("loose_ends_asked", { day, chars: answer.length });
			} finally {
				busy = false;
			}
		};
		const timer = setInterval(() => void tick().catch((error) => log.warn("loose_ends_failed", { error: (error as Error).message })), options.tickMs ?? 60_000);
		return () => clearInterval(timer);
	};
	return { start };
}

export function prompt({ day, chatting, journal, instructions }: { day: string; chatting: boolean; journal: string | undefined; instructions: string }): string {
	return [
		`[heartbeat] Your evening look for loose ends, private like a heartbeat: ${User()} does not see this or anything you do for it, only a message you choose to send them. Tonight your reflection closes ${day} in your journal from its entries and the day's conversation. Look over today's conversation and your entries below for a few loose ends that would leave a gap in that account: something ${user()} or their family started or planned whose outcome you never heard. For example, ${user()} mentioned starting a conversation with a client, coworker, or friend without saying how it ended, or someone planned an outing and you do not know whether it happened or they got home.`,
		`This is not a task audit or an interrogation. Leave out task status and work tracking, anything already settled, anything small or routine, and anything ${user()} would rather not talk about. Pick at most three that would matter to the day's story, or none. Most evenings have none.`,
		chatting
			? `${User()} is chatting with you right now, so asking is simply your next line in the conversation.`
			: `${User()} is not chatting with you right now, so a message reaches them wherever they are; send one only if it is worth that.`,
		`Ask in one short, natural message, the way a friend who was paying attention would, without lists or numbering. They may answer or not: never press, guess, or ask again tonight. When they do answer, write what they told you in today's journal with the journal tool, as you would anything they share, so the reflection has it. Never record an outcome they did not give you.`,
		journal ? `Your journal for today so far:\n${journal}` : "You have no journal entries for today; look at the conversation.",
		instructions ? `${User()}'s standing instructions for what is worth a nudge, from HEARTBEAT.org, still apply:\n${instructions}` : "",
		`If nothing is worth asking, answer with exactly ${QUIET} and nothing else. Otherwise answer with only your message to ${user()}, in the markup of where they last spoke.`,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** The local date the window that holds `at` opened on: before `at`'s time of day it is yesterday's, past midnight. */
export function opened(at: Date, start: string): string {
	const from = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
	const day = new Date(at);
	if (at.getHours() * 60 + at.getMinutes() < from) day.setDate(day.getDate() - 1);
	return localStamp(day).date;
}

function startOf(date: string): number {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return new Date(y, m - 1, d).getTime();
}

function standing(file: string | undefined): string {
	if (file === undefined) return "";
	try {
		return readFileSync(file, "utf8").trim();
	} catch {
		return "";
	}
}

function text(m: Message): string {
	if (m.role !== "user") return "";
	return typeof m.content === "string" ? m.content : m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
}

function reply(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
}
