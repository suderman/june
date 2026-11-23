// The roster (ROSTER.org beside SOUL.org): named agents, one heading each, whose properties fix the host they work on,
// the harness, model and effort, and an avatar, and whose text is the instructions added to the harness's own. An agent
// works one task at a time: it is busy while a live herdr terminal carries its june.agent label. Accounts are not on the
// card; the harness's plain name picks one from quota on the agent's host (src/accounts.ts).
import { HARNESSES, type HarnessName } from "./accounts.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Card = {
	name: string;
	/** The name as commands and labels write it: lowercase letters, digits and hyphens. */
	slug: string;
	host?: string;
	harness?: HarnessName;
	model?: string;
	effort?: string;
	avatar?: string;
	instructions: string;
	/** What keeps the card from launching; empty for a usable card. */
	problems: string[];
};

export const slugOf = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/** Every first-level heading of ROSTER.org as a card. Child headings belong to the card's instructions. */
export function parseRoster(text: string): Card[] {
	const cards: Card[] = [];
	const sections = text.split(/^(?=\* )/m).filter((s) => s.startsWith("* "));
	for (const section of sections) {
		const [heading, ...rest] = section.split("\n");
		const name = heading!.slice(2).replace(/\s+:[\w@#%:]+:\s*$/, "").trim();
		let body = rest.join("\n");
		const props: Record<string, string> = {};
		const drawer = /^\s*:PROPERTIES:\s*\n([\s\S]*?)^\s*:END:\s*$\n?/m.exec(body);
		if (drawer && body.slice(0, drawer.index).trim() === "") {
			for (const line of drawer[1]!.split("\n")) {
				const m = /^\s*:([A-Za-z_-]+):\s*(.*?)\s*$/.exec(line);
				if (m) props[m[1]!.toUpperCase()] = m[2]!;
			}
			body = body.slice(drawer.index + drawer[0].length);
		}
		const problems: string[] = [];
		const slug = slugOf(name);
		if (!slug) problems.push("no name");
		const harness = props.HARNESS?.toLowerCase();
		if (!harness) problems.push("no :HARNESS:");
		else if (!(harness in HARNESSES)) problems.push(`:HARNESS: ${harness} is not one of ${Object.keys(HARNESSES).join(", ")}`);
		if (!props.HOST) problems.push("no :HOST:");
		const effort = props.EFFORT?.toLowerCase();
		if (effort && !(EFFORTS as readonly string[]).includes(effort)) problems.push(`:EFFORT: ${effort} is not one of ${EFFORTS.join(", ")}`);
		if (cards.some((c) => c.slug === slug)) problems.push(`another agent is also called ${slug}`);
		cards.push({
			name,
			slug,
			...(props.HOST ? { host: props.HOST } : {}),
			...(harness && harness in HARNESSES ? { harness: harness as HarnessName } : {}),
			...(props.MODEL ? { model: props.MODEL } : {}),
			...(effort ? { effort } : {}),
			...(props.AVATAR ? { avatar: props.AVATAR } : {}),
			instructions: body.trim(),
			problems,
		});
	}
	return cards;
}

/** The card named NAME, by its name or slug, ignoring case. */
export const findCard = (cards: readonly Card[], name: string) => cards.find((c) => c.slug === slugOf(name));

/**
 * The arguments that start `card`'s harness as the card says, with PROMPT as its first message. Antigravity takes no
 * instructions flag, so its instructions lead the prompt, and an interactive start without a prompt goes without them.
 */
export function launchArgs(card: Card, prompt?: string): string[] {
	const { model, effort, instructions: text } = card;
	switch (card.harness) {
		case "claude":
			return [
				...(model ? ["--model", model] : []),
				...(effort ? ["--effort", effort] : []),
				...(text ? ["--append-system-prompt", text] : []),
				"--name",
				card.name,
				...(prompt ? [prompt] : []),
			];
		case "codex":
			return [
				...(model ? ["--model", model] : []),
				...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort === "max" ? "xhigh" : effort)}`] : []),
				...(text ? ["-c", `developer_instructions=${JSON.stringify(text)}`] : []),
				...(prompt ? [prompt] : []),
			];
		case "pi":
			return [
				// An account folder's default provider is its ChatGPT login; a bare model ID means that provider.
				...(model ? ["--model", model.includes("/") ? model : `openai-codex/${model}`] : []),
				...(effort ? ["--thinking", effort] : []),
				...(text ? ["--append-system-prompt", text] : []),
				"--name",
				card.name,
				...(prompt ? [prompt] : []),
			];
		case "agy":
			return [
				...(model ? ["--model", model] : []),
				...(effort ? ["--effort", effort] : []),
				...(prompt ? ["--prompt-interactive", text ? `${text}\n\n${prompt}` : prompt] : []),
			];
		default:
			throw new Error(`${card.name} has no harness`);
	}
}
