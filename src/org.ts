// June writes Org in the terminal, where either would do and Jon prefers it; Telegram renders only Markdown. The
// terminal draws text with a Markdown component, so her Org replies pass through here first. Only Org's own syntax is
// converted: anything else, Markdown included, is left as written.

/** Org markup as the Markdown the terminal renders: headings, blocks, tables, links, and emphasis. */
export function orgToMarkdown(org: string): string {
	const out: string[] = [];
	let block: "src" | "quote" | undefined;
	for (const line of org.replace(/\r\n?/g, "\n").split("\n")) {
		const begin = /^\s*#\+begin_(src|example|quote)\b\s*(\S*)/i.exec(line);
		const end = /^\s*#\+end_(src|example|quote)\b/i.exec(line);
		if (block === undefined && begin) {
			block = begin[1]!.toLowerCase() === "quote" ? "quote" : "src";
			if (block === "src") out.push(`\`\`\`${begin[1]!.toLowerCase() === "src" ? begin[2] : ""}`);
		} else if (block !== undefined && end) {
			if (block === "src") out.push("```");
			block = undefined;
		} else if (block === "src") out.push(line);
		else if (block === "quote") out.push(`> ${inline(line)}`);
		else out.push(blockLine(line));
	}
	if (block === "src") out.push("```");
	return out.join("\n");
}

function blockLine(line: string): string {
	const heading = /^(\*+)\s+(.*)$/.exec(line);
	if (heading) return `${"#".repeat(Math.min(heading[1]!.length, 6))} ${inline(heading[2]!)}`;
	// A table rule, |---+---|, as Markdown's |---|---|.
	if (/^\s*\|[-+]+\|?\s*$/.test(line)) return line.replace(/[-]+/g, "---").replace(/\+/g, "|");
	if (/^\s*#\+\w+:/.test(line)) return "";
	return inline(line.replace(/^(\s*)\+ /, "$1- ").replace(/^(\s*\d+)\) /, "$1. "));
}

const PLACEHOLDER = "";
// Org's emphasis: a marker after a space or opening punctuation, no space just inside, and closing punctuation after.
const PRE = String.raw`(^|[\s('"{])`;
const POST = String.raw`(?=[\s\-.,:;!?'")}\[]|$)`;
const span = (marker: string, inner: string) => new RegExp(`${PRE}${marker}(${inner})${marker}${POST}`, "g");
const rules: [RegExp, (body: string) => string][] = [
	[span(String.raw`\*`, String.raw`[^\s*](?:[^*\n]*[^\s*])?`), (b) => `**${b}**`],
	// No slash inside, so a path such as /home/jon/ stays a path.
	[span("/", String.raw`[^\s/](?:[^/\n]*[^\s/])?`), (b) => `*${b}*`],
	[span(String.raw`\+`, String.raw`[^\s+](?:[^+\n]*[^\s+])?`), (b) => `~~${b}~~`],
];

function inline(line: string): string {
	const held: string[] = [];
	const hold = (text: string) => `${PLACEHOLDER}${held.push(text) - 1}${PLACEHOLDER}`;
	let text = line.replaceAll(PLACEHOLDER, "");
	// The content may start with the other marker, as in =~/org/x.org=, but not with its own or a space.
	text = text.replace(new RegExp(`${PRE}([=~])((?!\\2)[^\\s](?:[^\\n]*?[^\\s])??)\\2${POST}`, "g"), (_m, pre, _mark, code) => `${pre}${hold(`\`${code}\``)}`);
	text = text.replace(/\[\[([^\]\n]+)\](?:\[([^\]\n]+)\])?\]/g, (_m, url, label) => hold(`[${label ?? url}](${url})`));
	for (const [pattern, wrap] of rules) text = text.replace(pattern, (_m, pre, body) => `${pre}${wrap(body)}`);
	return text.replace(/(\d+)/g, (_m, i) => held[Number(i)] ?? "");
}
