// Code as lines of tokens for the previews to colour: highlight.js reads it, and its HTML is flattened here into
// [scope, text] pairs, the scope its innermost class without the hljs- prefix ("" for plain text), so each client
// paints with its own palette and no client needs a highlighter. Only a known language is highlighted; anything else
// stays the plain words the preview already shows.
import hljs from "highlight.js";

export type Token = [scope: string, text: string];
export type Highlighted = { language: string; lines: Token[][] };

/** Names June or a file's extension may use for a language highlight.js knows by another. */
const ALIASES: Record<string, string> = { el: "lisp", elisp: "lisp", "emacs-lisp": "lisp", sh: "bash", zsh: "bash", shell: "bash", yml: "yaml", kt: "kotlin", rs: "rust", md: "markdown", ts: "typescript", js: "javascript", py: "python" };

/** The highlight.js language for a name or extension, or undefined when it knows none. */
export function languageOf(hint: string | undefined): string | undefined {
	const name = (hint ?? "").toLowerCase().replace(/^\./, "");
	if (!name) return undefined;
	const known = ALIASES[name] ?? name;
	return hljs.getLanguage(known) ? known : undefined;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

export function highlight(text: string, hint: string | undefined): Highlighted | undefined {
	const language = languageOf(hint);
	if (language === undefined) return undefined;
	const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
	const lines: Token[][] = [[]];
	const scopes: string[] = [];
	for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
		if (part.startsWith("<span")) scopes.push(/class="hljs-([\w.-]+)/.exec(part)?.[1]?.split(".")[0] ?? scopes.at(-1) ?? "");
		else if (part === "</span>") scopes.pop();
		else if (part) {
			const words = part.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e] ?? e).split("\n");
			for (const [i, piece] of words.entries()) {
				if (i > 0) lines.push([]);
				if (piece) lines.at(-1)!.push([scopes.at(-1) ?? "", piece]);
			}
		}
	}
	return { language, lines };
}
