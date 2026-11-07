// June's show tool: a file on her host, or a snippet she writes, put in front of the user beside her reply. It is saved
// to her inbox as the user's own files are, for the same 30 days, and her tool result names each one on a line of its
// own, `[shown {...}]`, which the view reads to draw it (a picture as a polaroid, anything else as a card) and the
// remote listener reads to serve it to the user's devices.
import { open, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { formatSize, MAX_FILE_BYTES, saveFiles, typeOf } from "../inbox.ts";
import { type Shown } from "../shown.ts";
import { user } from "../user.ts";

/** The file name a snippet gets from its language when June gives none. */
const EXTENSIONS: Record<string, string> = {
	bash: "sh", sh: "sh", shell: "sh", zsh: "sh", python: "py", py: "py", typescript: "ts", ts: "ts", javascript: "js", js: "js",
	json: "json", org: "org", nix: "nix", elisp: "el", "emacs-lisp": "el", lisp: "el", markdown: "md", md: "md", yaml: "yaml", yml: "yaml",
	html: "html", css: "css", sql: "sql", kotlin: "kt", qml: "qml", rust: "rs", go: "go", toml: "toml", diff: "diff", text: "txt",
};

/** A file whose first bytes hold no NUL reads as text, whatever its extension says. */
async function looksLikeText(path: string): Promise<boolean> {
	const handle = await open(path, "r");
	try {
		const { buffer, bytesRead } = await handle.read(Buffer.alloc(8192), 0, 8192, 0);
		return !buffer.subarray(0, bytesRead).includes(0);
	} finally {
		await handle.close();
	}
}

export function createShowExtension(inbox: string, host: string) {
	const show = defineTool({
		name: "show",
		description: `Show ${user()} something beside your reply, on the desktop and the phone: a file on ${host} (path), or a snippet you write (text, with its language and a name if you like). A picture shows as a polaroid, anything else as a card; a tap opens it in a preview with the rest of what you showed. Use it when they will want to look at the thing itself rather than read about it: a screenshot, a document, a page of a log, some code. Say in your reply what you showed and why.`,
		parameters: obj({
			path: opt(str({ description: `A file on ${host} to show, absolute or from ~` })),
			text: opt(str({ description: "A snippet to show instead, as written" })),
			language: opt(str({ description: "The snippet's language, such as sh, python, org or nix" })),
			name: opt(str({ description: "The snippet's file name, such as fix.nix; from its language by default" })),
		}),
		// A rerun after a restart finds what the first run saved, under the same call.
		replay: "safe",
		execute: async (args, api) => {
			const path = args.path?.trim() ? args.path.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~") : undefined;
			const text = args.text ?? "";
			if (path === undefined && !text.trim()) throw new Error("Give a path to a file, or the text of a snippet");
			let file: { name: string; mimeType: string; data: string };
			let language: string | undefined;
			if (path !== undefined) {
				const bytes = await readFile(path);
				if (bytes.length > MAX_FILE_BYTES) throw new Error(`${basename(path)} is over 20 MiB`);
				const known = typeOf(path);
				const mimeType = known === "application/octet-stream" && (await looksLikeText(path)) ? "text/plain" : known;
				file = { name: basename(path), mimeType, data: bytes.toString("base64") };
			} else {
				language = args.language?.trim().toLowerCase() || undefined;
				const name = args.name?.trim() || `snippet.${EXTENSIONS[language ?? ""] ?? language ?? "txt"}`;
				file = { name: extname(name) ? name : `${name}.txt`, mimeType: "text/plain", data: Buffer.from(text).toString("base64") };
			}
			const [saved] = await saveFiles(inbox, `show:${String(api.taskId)}`, [file]);
			if (saved === undefined) throw new Error("Nothing was saved");
			const shown: Shown = { ...saved, ...(language !== undefined ? { language } : {}) };
			return {
				output: [{ type: "text", text: `Shown to ${user()} beside your reply: ${shown.name} (${shown.mimeType}, ${formatSize(shown.size)}).\n[shown ${JSON.stringify(shown)}]` }],
			};
		},
	});
	return defineExtension({ name: "june-show", tools: [show] });
}
