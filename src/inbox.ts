// June's inbox: files a client sends arrive inline, and the daemon alone writes them under its state directory, where they
// expire after 30 days. See "Inbox" in docs/architecture.org.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

/** A file as a client sends it: `data` is base64. */
export type FileAttachment = { name: string; mimeType: string; data: string };
/** A file as saved, which June is told about and the view shows. */
export type SavedFile = { name: string; mimeType: string; size: number; path: string };

export const MAX_FILES = 10;
/** Telegram's bot download limit. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Base64 of files and images together, leaving room in a 32 MiB WebSocket message for the rest of the request. */
export const MAX_ATTACHED_BASE64 = 30 * 1024 * 1024;
export const INBOX_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
const MAX_NAME = 120;

/** The socket takes files inline only; the daemon writes them itself, never a path another process names. */
export function validateFiles(value: unknown, imageBase64 = 0): asserts value is FileAttachment[] {
	if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error(`Expected at most ${MAX_FILES} files`);
	let total = imageBase64;
	for (const file of value) {
		if (typeof file?.name !== "string" || typeof file.mimeType !== "string" || typeof file.data !== "string")
			throw new Error("Invalid file attachment: expected name, mimeType, and base64 data");
		// The decoded size, counted without decoding.
		if (file.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || Buffer.byteLength(file.data, "base64") > MAX_FILE_BYTES)
			throw new Error(`${safeName(file.name)} exceeds 20 MiB`);
		if (Buffer.from(file.data, "base64").toString("base64") !== file.data) throw new Error(`${safeName(file.name)} is not valid base64`);
		total += file.data.length;
	}
	if (total > MAX_ATTACHED_BASE64) throw new Error("Attachments exceed what one message can carry; send fewer or smaller files");
}

/** A file name reduced to a safe basename: no directories, control characters, leading dots, or more than 120 bytes. */
export function safeName(name: string): string {
	let base = (name.split(/[/\\]/).pop() ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+/, "");
	if (Buffer.byteLength(base) > MAX_NAME) {
		const ext = extname(base).slice(0, 16);
		let stem = base.slice(0, base.length - ext.length);
		while (Buffer.byteLength(stem + ext) > MAX_NAME) stem = stem.slice(0, -1);
		base = stem + ext;
	}
	return base || "file";
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Save a request's files to `inbox/YYYY-MM-DD/HHMM-<name>` (directories 0700, files 0600), each name made unique. A
 * request already saved returns the files it saved, so a retried submit saves nothing twice: `key` is the request's
 * deduplication key, and a record of what it saved sits in `inbox/.requests`.
 */
export function saveFiles(inbox: string, key: string, files: readonly FileAttachment[], now = new Date()): Promise<SavedFile[]> {
	if (files.length === 0) return Promise.resolve([]);
	// The same request arriving twice at once, on two connections, shares one save.
	const id = `${inbox}\0${key}`;
	const running = saving.get(id) ?? save(inbox, key, files, now).finally(() => saving.delete(id));
	saving.set(id, running);
	return running;
}

const saving = new Map<string, Promise<SavedFile[]>>();

async function save(inbox: string, key: string, files: readonly FileAttachment[], now: Date): Promise<SavedFile[]> {
	const requests = join(inbox, ".requests");
	await mkdir(requests, { recursive: true, mode: 0o700 });
	const record = join(requests, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
	const earlier = await readFile(record, "utf8").then((text) => JSON.parse(text) as SavedFile[], () => undefined);
	if (earlier !== undefined) return earlier;

	const day = join(inbox, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
	await mkdir(day, { recursive: true, mode: 0o700 });
	const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}`;
	const saved: SavedFile[] = [];
	for (const file of files) {
		const name = safeName(file.name);
		const bytes = Buffer.from(file.data, "base64");
		const ext = extname(name);
		const stem = name.slice(0, name.length - ext.length);
		for (let n = 1; ; n++) {
			const path = join(day, `${stamp}-${n === 1 ? name : `${stem}-${n}${ext}`}`);
			// wx never follows or replaces what is there, a link included.
			const handle = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "EEXIST") return undefined;
				throw error;
			});
			if (handle === undefined) continue;
			try {
				await handle.writeFile(bytes);
			} finally {
				await handle.close();
			}
			saved.push({ name, mimeType: MIME.test(file.mimeType) ? file.mimeType.toLowerCase() : "application/octet-stream", size: bytes.length, path });
			break;
		}
	}
	const temp = `${record}.${process.pid}.tmp`;
	await writeFile(temp, JSON.stringify(saved), { mode: 0o600 });
	await rename(temp, record);
	return saved;
}

/** One line per file for the model's text. */
export function describeFiles(files: readonly SavedFile[]): string {
	return files.map((f) => `[file ${f.name}, ${f.mimeType}, ${formatSize(f.size)}, saved at ${f.path}]`).join("\n");
}

// What a file's name says it is, for messages saved before their type was kept.
const TYPES: Record<string, string> = {
	".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".org": "text/plain", ".csv": "text/csv",
	".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".zip": "application/zip", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
};
export function typeOf(name: string): string {
	return TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** How many pages a PDF has, from poppler's pdfinfo; 0 when it cannot tell, as without poppler or for a broken file. */
export function pdfPages(path: string): Promise<number> {
	return new Promise((resolve) => {
		execFile("pdfinfo", [path], { timeout: 20_000 }, (error, stdout) => {
			const pages = error ? undefined : /^Pages:\s+(\d+)$/m.exec(stdout)?.[1];
			resolve(pages === undefined ? 0 : Number(pages));
		});
	});
}

/** One page of a PDF, from 1, as a PNG at most 1600 px on its longer side, from poppler's pdftoppm; undefined past its last page or without poppler. */
export function pdfPage(path: string, page: number): Promise<Buffer | undefined> {
	return new Promise((resolve) => {
		execFile("pdftoppm", ["-png", "-f", String(page), "-l", String(page), "-singlefile", "-scale-to", "1600", path], { encoding: "buffer", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
			resolve(error || stdout.length === 0 ? undefined : stdout);
		});
	});
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * Delete inbox files and request records last changed more than `days` ago, then day directories left empty. Anything
 * else in the inbox is left alone. Returns how many files went.
 */
export async function expireInbox(inbox: string, now = Date.now(), days = INBOX_DAYS): Promise<number> {
	const cutoff = now - days * DAY_MS;
	let removed = 0;
	const sweep = async (dir: string, keepEmpty: boolean) => {
		const names = await readdir(dir).catch(() => [] as string[]);
		for (const name of names) {
			const path = join(dir, name);
			const info = await stat(path).catch(() => undefined);
			if (info?.isFile() && info.mtimeMs < cutoff) {
				await rm(path, { force: true });
				removed++;
			}
		}
		if (!keepEmpty) await rmdir(dir).catch(() => {});
	};
	for (const name of await readdir(inbox).catch(() => [] as string[])) {
		if (/^\d{4}-\d{2}-\d{2}$/.test(name)) await sweep(join(inbox, name), false);
		else if (name === ".requests") await sweep(join(inbox, name), true);
	}
	return removed;
}

/** Expire the inbox now and about daily until stopped. */
export function startInboxExpiry(inbox: string, onError: (error: Error) => void, everyMs = DAY_MS): () => void {
	const run = () => void expireInbox(inbox).catch(onError);
	run();
	const timer = setInterval(run, everyMs);
	timer.unref();
	return () => clearInterval(timer);
}
