// June's heartbeat: every so often between Jon's wake and quiet hours, she takes a private look at the moment in the
// main conversation, with her standing instructions from HEARTBEAT.org and what changed since her last look, and
// either says something to Jon or stays quiet. Jon never sees the heartbeat itself: the terminal hides it and its
// quiet answers, and on Telegram only a real message is sent. Like patter and the reflection, it is an in-memory loop
// with a receipt in the state directory, so a restart neither skips a beat for long nor repeats one.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { type Conversation, type Harness, LiveDoc } from "@earendil-works/pi-durable";
import { type Logger, splitForTelegram, type TelegramPort } from "pi-durable-telegram";
import type { Config, PromptFiles } from "./config.ts";
import { isQuiet, QUIET } from "./transcript.ts";

/** Own inputs June's tasks write; they say nothing about where Jon is or whether he is chatting. */
const OWN = /^\[(\/stop|work|follow|reminder|heartbeat)\b/;

type Receipt = { at: number; lines: string[] };

export function createHeartbeat(options: {
	config: Config["heartbeat"];
	/** From the rhythm's wake until its quiet. */
	window: { start: string; end: string };
	situation: { render(now?: Date): Promise<string> };
	files: () => PromptFiles;
	state: string;
	log: Logger;
	telegram?: { port: TelegramPort; chatId: number };
	/** Tests run the clock and the loop faster. */
	now?: () => Date;
	tickMs?: number;
}): { start(harness: Harness, root: Conversation): () => void } {
	const { config, log } = options;
	const now = options.now ?? (() => new Date());
	const receiptFile = join(options.state, "heartbeat.json");
	const last = (): Receipt => {
		try {
			return JSON.parse(readFileSync(receiptFile, "utf8")) as Receipt;
		} catch {
			return { at: 0, lines: [] };
		}
	};
	let busy = false;

	const start = (harness: Harness, root: Conversation) => {
		const tick = async () => {
			const at = now();
			if (busy || !within(at, options.window)) return;
			const before = last();
			if (at.getTime() - before.at < config.everyMinutes * 60_000) return;
			// Never queue behind a reply or a message waiting its turn; the next minute will do.
			if ((await harness.snapshot(LiveDoc, root.id, BG))?.run !== undefined) return;
			busy = true;
			try {
				const { messages } = await root.context(BG);
				const jon = messages.findLast((m) => m.role === "user" && !OWN.test(text(m)));
				const chatting = jon !== undefined && at.getTime() - jon.timestamp < config.chattingMinutes * 60_000;
				const lines = (await options.situation.render(at)).split("\n").slice(2);
				// The receipt first: a crash after it costs one beat; one before it would repeat the beat.
				mkdirSync(options.state, { recursive: true });
				writeFileSync(receiptFile, `${JSON.stringify({ at: at.getTime(), lines })}\n`);
				const content = prompt({ chatting, since: before, lines, instructions: instructions(options.files().heartbeatFile), at });
				const submission = await root.submit(
					{
						type: "input",
						requestId: `heartbeat:${at.getTime()}`,
						content,
						whenBusy: "followUp",
						entry: { kind: "june.input", data: { source: "heartbeat", text: "heartbeat" } },
					},
					BG,
				);
				const settled = await submission.wait(BG);
				if (settled.status !== "done") return log.warn("heartbeat_unanswered", { status: settled.status });
				const answer = reply((await root.commit((tx) => tx.entry(settled.answer!), BG))?.model?.[0]);
				if (isQuiet(answer) || answer.trim() === "") return log.info("heartbeat_quiet", {});
				log.info("heartbeat_spoke", { chars: answer.length });
				// The terminal shows her message in the transcript; Telegram needs it sent when that is where Jon is.
				if (options.telegram !== undefined && jon !== undefined && !/^\[(kitty|cli)\]/.test(text(jon))) {
					const { port, chatId } = options.telegram;
					for (const chunk of splitForTelegram(answer)) await port.sendMessage(chatId, chunk.html, { html: true });
				}
			} finally {
				busy = false;
			}
		};
		const timer = setInterval(() => void tick().catch((error) => log.warn("heartbeat_failed", { error: (error as Error).message })), options.tickMs ?? 60_000);
		return () => clearInterval(timer);
	};
	return { start };
}

function prompt({ chatting, since, lines, instructions, at }: { chatting: boolean; since: Receipt; lines: string[]; instructions: string; at: Date }): string {
	const earlier = new Set(since.lines);
	const changed = lines.filter((line) => !earlier.has(line));
	const first = since.at === 0 || new Date(since.at).toDateString() !== at.toDateString();
	return [
		"[heartbeat] A private heartbeat: Jon does not see this or anything you do for it, only a message you choose to send him. Look at the moment, in your now section and the conversation, against your standing instructions below, and decide whether anything is worth his attention now.",
		chatting
			? "Jon is chatting with you right now, so raising something is simply your next line in the conversation, even if it changes the subject."
			: "Jon is not chatting with you right now, so a message interrupts him wherever he is. Send one only when it is worth that, and only once: you can see what you already raised.",
		first ? "This is your first look today." : changed.length > 0 ? `Since your last look:\n${changed.map((l) => `- ${l}`).join("\n")}` : "Nothing in your now section changed since your last look.",
		instructions ? `Your standing instructions, from HEARTBEAT.org:\n${instructions}` : "You have no HEARTBEAT.org yet; use your judgment.",
		`If nothing is worth raising, answer with exactly ${QUIET} and nothing else. Otherwise answer with only your message to Jon, in the markup of where he last spoke, as you would write it to him unprompted.`,
	].join("\n\n");
}

function instructions(file: string | undefined): string {
	if (file === undefined) return "";
	try {
		return readFileSync(file, "utf8").trim();
	} catch {
		return "";
	}
}

/** Whether `at` falls in [start, end) local time; a window may cross midnight. */
export function within(at: Date, { start, end }: { start: string; end: string }): boolean {
	const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
	const [from, to, now] = [minutes(start), minutes(end), at.getHours() * 60 + at.getMinutes()];
	return from <= to ? now >= from && now < to : now >= from || now < to;
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
