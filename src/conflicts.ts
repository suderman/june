// June's nightly Syncthing check: once a day from the configured time, the org-conflicts skill's own command retires
// every conflict copy under the Org root that adds nothing, and any Org copy left for judgment goes to June as a private,
// heartbeat-tagged look, so she reconciles it with the same skill coding agents use. A receipt in the state directory
// makes it once a day, across restarts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type Conversation, type Harness, LiveDoc } from "@earendil-works/pi-durable";
import type { Config } from "./config.ts";
import { within } from "./heartbeat.ts";
import { opened } from "./loose.ts";
import { admitNotice } from "./notify.ts";
import type { Logger } from "./runtime.ts";
import { type Run, runProcess } from "./tools/herdr.ts";
import { isQuiet, QUIET } from "./transcript.ts";
import { User, user } from "./user.ts";

/** The command the org-conflicts skill ships, shared with every agent through the skill's directory. */
export const ORG_CONFLICT = join(dirname(import.meta.dirname), "skills", "org-conflicts", "org-conflict");

/** A copy the sweep left, with its status from org-conflict. */
export type Left = { status: string; copy: string };

/** Sweep output: "retired STATUS<TAB>COPY" and "left STATUS<TAB>COPY<TAB>LIVE" lines. */
export function parseSweep(output: string): { retired: number; left: Left[] } {
	let retired = 0;
	const left: Left[] = [];
	for (const line of output.split("\n")) {
		const match = /^(retired|left) (\S+)\t([^\t]+)/.exec(line);
		if (match?.[1] === "retired") retired++;
		else if (match) left.push({ status: match[2]!, copy: match[3]! });
	}
	return { retired, left };
}

export function createConflicts(options: {
	config: Config["conflicts"];
	/** The rhythm's quiet hour; a check missed until then waits for tomorrow. */
	quiet: string;
	root: string;
	state: string;
	log: Logger;
	run?: Run;
	/** Tests run the clock and the loop faster. */
	now?: () => Date;
	tickMs?: number;
}): { start(harness: Harness, root: Conversation): () => void } {
	const { config, log } = options;
	const now = options.now ?? (() => new Date());
	const run = options.run ?? runProcess;
	const window = { start: config.at, end: options.quiet };
	const receipt = join(options.state, "conflicts.json");
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
				// The receipt first: a crash after it costs one night; one before it could ask twice.
				mkdirSync(options.state, { recursive: true });
				writeFileSync(receipt, `${JSON.stringify({ day, at: at.getTime() })}\n`);
				const { retired, left } = parseSweep(await run([ORG_CONFLICT, "sweep", options.root], 120_000));
				const judge = left.filter((each) => each.status === "diverged" || each.status === "orphan");
				log.info("conflicts_swept", { day, retired, left: left.length, judge: judge.length });
				if (judge.length === 0) return;
				const content = prompt({ retired, judge });
				const id = await root.commit((tx) => admitNotice(tx, root, root.id, { requestId: `conflicts:${day}`, content, source: "heartbeat", label: "sync conflicts" }), BG);
				const settled = await (await harness.submission(id, BG))!.wait(BG);
				if (settled.status !== "done") return log.warn("conflicts_unanswered", { day, status: settled.status });
				const answer = reply((await root.commit((tx) => tx.entry(settled.answer!), BG))?.model?.[0]);
				log.info(isQuiet(answer) || answer === "" ? "conflicts_quiet" : "conflicts_told", { day });
			} finally {
				busy = false;
			}
		};
		const timer = setInterval(() => void tick().catch((error) => log.warn("conflicts_failed", { error: (error as Error).message })), options.tickMs ?? 60_000);
		return () => clearInterval(timer);
	};
	return { start };
}

export function prompt({ retired, judge }: { retired: number; judge: readonly Left[] }): string {
	return [
		`[heartbeat] Your nightly Syncthing check, private like a heartbeat: ${User()} does not see this or anything you do for it, only a message you choose to send them.${retired > 0 ? ` The sweep already retired ${retired} conflict ${retired === 1 ? "copy" : "copies"} that added nothing.` : ""} These Org conflict copies need your judgment:`,
		judge.map((each) => `- ${each.status}: ${each.copy}`).join("\n"),
		`Read the org-conflicts skill with skill_read and resolve each one now: merge what a copy alone holds into its live file, then retire the copy. For a long or tangled one, hand it to a working context with work, naming the skill and the copy, rather than reading long diffs here. ${User()} keeps backups and wants these handled without being asked.`,
		`When you are done, answer with exactly ${QUIET} and nothing else, unless something truly needs ${user()}; then answer with only a short message for them.`,
	].join("\n\n");
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
