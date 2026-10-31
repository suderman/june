// June's conversation as text for a reader outside the terminal, such as a worker looking into a gap the user hit:
// `june transcript`. The plain view is what the terminal shows; detail adds her thinking in full, tool arguments and
// output, and her private looks (heartbeat, watch, work, follow), marked private.
import { clip, isQuiet, PRIVATE, summarize, textOf } from "./transcript.ts";

/** Tool output and private prompts in detail are cut to this many characters, keeping their line breaks. */
const DETAIL_CHARS = 2000;

const cut = (text: string) => (text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS - 1)}…` : text);

/** Each entry's time: its message's, or for entries without one, such as patter, the time of the entry before. */
export function entryTimes(entries: readonly any[]): number[] {
	let last = 0;
	return entries.map((entry) => (last = typeof entry.model?.[0]?.timestamp === "number" ? entry.model[0].timestamp : last));
}

/** A --since value as epoch milliseconds: 30m, 2h, or 1d ago; HH:MM, the last time the clock read it; or a date. */
export function parseSince(text: string, now = new Date()): number | undefined {
	const ago = /^(\d+)([mhd])$/.exec(text);
	if (ago) return now.getTime() - Number(ago[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[ago[2] as "m" | "h" | "d"];
	const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
	if (clock) {
		const at = new Date(now);
		at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
		if (at > now) at.setDate(at.getDate() - 1);
		return at.getTime();
	}
	const date = Date.parse(text);
	return Number.isNaN(date) ? undefined : date;
}

export function renderHistory(entries: readonly any[], options: { detail?: boolean; user?: string; omitted?: number } = {}): string {
	const { detail = false, user = "user" } = options;
	const times = entryTimes(entries);
	const lines: string[] = options.omitted ? [`(${options.omitted} earlier entries not shown)`] : [];
	let day = "";
	/** Inside a private look, which the plain view shows only as her message to the user, if she sent one. */
	let looking = false;
	entries.forEach((entry, index) => {
		const when = new Date(times[index]!);
		const date = when.toLocaleDateString("en-CA");
		if (times[index] && date !== day) lines.push(`== ${(day = date)}`);
		const say = (who: string, text: string) => lines.push(`${when.toTimeString().slice(0, 5)} ${who}: ${text.trim().replace(/\n/g, "\n      ").replace(/ +$/gm, "")}`);
		const message = entry.model?.[0];
		const mark = looking ? " (private)" : "";
		switch (entry.kind) {
			case "june.input": {
				const source = String(entry.data?.source ?? "?");
				looking = PRIVATE.has(source);
				if (!looking) say(`${user} (${source})`, `${entry.data?.text ?? ""}${entry.data?.imageCount ? ` [${entry.data.imageCount} image(s)]` : ""}`);
				else if (detail) say(`[${source}] (private)`, cut(textOf(message?.content)));
				return;
			}
			case "pi.user": {
				const text = textOf(message?.content);
				const tag = /^\[(\/?\w+)\]/.exec(text)?.[1] ?? "";
				looking = PRIVATE.has(tag);
				if (tag === "/stop") say("--", "stopped");
				else if (!looking) say(tag ? `[${tag}]` : `${user} (telegram)`, text);
				else if (detail) say(`[${tag}] (private)`, cut(text));
				return;
			}
			case "pi.assistant": {
				const blocks: any[] = message?.content ?? [];
				if (looking && !detail) {
					const words = textOf(blocks.filter((b) => b.type === "text"));
					if (words.trim() !== "" && !isQuiet(words)) say("June", words);
					return;
				}
				for (const block of blocks) {
					if (block.type === "thinking" && block.thinking?.trim()) say(`June thinking${mark}`, detail ? block.thinking : clip(block.thinking, 120));
					// Her words in a look reach the user, unless they are the quiet answer.
					else if (block.type === "text" && block.text?.trim()) say(`June${looking && isQuiet(block.text) ? mark : ""}`, block.text);
					else if (block.type === "toolCall") say(`  -> ${block.name}${mark}`, detail ? JSON.stringify(block.arguments ?? {}) : summarize(block.arguments));
				}
				if (message?.stopReason === "error" || message?.stopReason === "aborted") say(`June ${message.stopReason}`, message.errorMessage ?? "");
				return;
			}
			case "pi.tool-result": {
				if (looking && !detail) return;
				const output = textOf(message?.content);
				if (detail) say(`  <- ${message?.toolName ?? "tool"}${message?.isError ? " failed" : ""}${mark}`, cut(output).trim() || "(no output)");
				else if (message?.isError) say(`  <- ${message?.toolName ?? "tool"} failed`, clip(output, 200));
				return;
			}
			case "june.patter":
				say("June (patter)", entry.data?.text ?? "");
				return;
			case "june.work":
				if (detail) say("--", `background work ${entry.data?.state ?? "?"}: ${clip(String(entry.data?.brief ?? ""), 200)}`);
				return;
			case "pi.reset":
				say("--", "new context");
				return;
			case "pi.compaction":
				say("--", "earlier conversation compacted");
				return;
		}
	});
	return lines.join("\n");
}
