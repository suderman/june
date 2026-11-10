// June's show tool: a file on her host, or a snippet she writes, put in front of the user beside her reply. It is saved
// to her inbox as the user's own files are, for the same 30 days, and her tool result names each one on a line of its
// own, `[shown {...}]`, which the view reads to draw it (a picture as a polaroid, anything else as a card) and the
// remote listener reads to serve it to the user's devices.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
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

const run = promisify(execFile);

/** A program's full path from PATH, for systemd-run, which does not search the caller's. */
function onPath(name: string): string {
	for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, name))) return join(dir, name);
	return name;
}

/**
 * Whether this process may never gain privileges (June's service sets NoNewPrivileges), which stops Chromium's sandbox;
 * then the browser runs in a transient unit of the user's own systemd instead, while June's service stays as it is.
 */
function noNewPrivileges(): boolean {
	try {
		return /^NoNewPrivs:\s*1$/m.test(readFileSync("/proc/self/status", "utf8"));
	} catch {
		return false;
	}
}

/** The last few lines a browser wrote that say something, for an error. */
const said = (stderr: unknown) =>
	String(stderr ?? "").split("\n").filter((line) => line.trim() && !/dbus|OID|Fontconfig/i.test(line)).slice(-3).join(" / ").slice(0, 400);

/**
 * A web page as headless Chromium draws it at a desktop window's size, as PNG bytes. A throwaway profile each time, so
 * no cookie or login of the user's browser is used, and a time limit for a page that never settles.
 */
async function pageShot(url: string): Promise<Buffer> {
	const dir = await mkdtemp(join(tmpdir(), "june-shot-"));
	try {
		const shot = join(dir, "page.png");
		const browser = [onPath("chromium"), "--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--window-size=1280,1600", `--user-data-dir=${join(dir, "profile")}`, `--screenshot=${shot}`, url];
		const [command, ...args] = noNewPrivileges() ? [onPath("systemd-run"), "--user", "--wait", "--collect", "--pipe", "--quiet", "--property=RuntimeMaxSec=50", ...browser] : browser;
		let stderr = "";
		try {
			stderr = (await run(command!, args, { timeout: 60_000 })).stderr;
		} catch (error) {
			throw new Error(`The browser failed: ${said((error as { stderr?: unknown }).stderr) || (error as Error).message}`);
		}
		return await readFile(shot).catch(() => {
			throw new Error(`The browser drew no picture${said(stderr) ? `: ${said(stderr)}` : ""}`);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

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
		description: `Show ${user()} something beside your reply, on the desktop and the phone: a file on ${host} (path), a snippet you write (text, with its language and a name if you like), or a web page as it looks (url, drawn by a browser on ${host}, which you see too). A picture shows as a polaroid, anything else as a card; a tap opens it in a preview with the rest of what you showed. Use it when they will want to look at the thing itself rather than read about it: a screenshot, a document, a page of a log, some code. Say in your reply what you showed and why.`,
		parameters: obj({
			path: opt(str({ description: `A file on ${host} to show, absolute or from ~` })),
			url: opt(str({ description: "An http or https page to show as it looks, as a picture" })),
			text: opt(str({ description: "A snippet to show instead, as written" })),
			language: opt(str({ description: "The snippet's language, such as sh, python, org or nix" })),
			name: opt(str({ description: "The snippet's file name, such as fix.nix; from its language by default" })),
		}),
		// A rerun after a restart finds what the first run saved, under the same call.
		replay: "safe",
		execute: async (args, api, context) => {
			// Existing workers can retain show in their saved configuration after an upgrade.
			const conversation = await api.commit(tx => tx.conversation(api.conversationId), context);
			if (conversation?.owner) throw new Error("show works only in the main conversation. Return file paths in your report so main June can show them beside her reply; nothing was shown here.");
			const path = args.path?.trim() ? args.path.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~") : undefined;
			const text = args.text ?? "";
			const url = args.url?.trim() || undefined;
			if (path === undefined && url === undefined && !text.trim()) throw new Error("Give a path to a file, a page's url, or the text of a snippet");
			let file: { name: string; mimeType: string; data: string };
			let language: string | undefined;
			if (url !== undefined) {
				let page: URL;
				try {
					page = new URL(url);
				} catch {
					throw new Error(`${url} is not a web address`);
				}
				if (page.protocol !== "https:" && page.protocol !== "http:") throw new Error("Only an http or https page can be shown");
				file = { name: `${page.hostname || "page"}.png`, mimeType: "image/png", data: (await pageShot(page.href)).toString("base64") };
			} else if (path !== undefined) {
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
			const said = { type: "text" as const, text: `Shown to ${user()} beside your reply: ${shown.name} (${shown.mimeType}, ${formatSize(shown.size)}).\n[shown ${JSON.stringify(shown)}]\n` };
			// A page she has not seen yet, so she sees what she showed.
			return { output: url !== undefined ? [said, { type: "image" as const, data: file.data, mimeType: file.mimeType }] : [said] };
		},
	});
	return defineExtension({ name: "june-show", tools: [show] });
}
