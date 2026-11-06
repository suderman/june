// Images a tool returns live as files beside the database, not in it. Durable keeps every entry forever, and June
// judging generated art read hundreds of megabytes of PNGs in a day. Before a tool result is committed, `afterTool`
// writes each image to `<state>/images/<sha256>` and leaves a one-line reference in its place; before every model
// request, `beforeRequest` puts the same bytes back, so June still sees the image and prompt caching still holds. A
// reference whose file is gone becomes a short note. Files expire 30 days after they were last written or sent.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";

export const IMAGE_DAYS = 30;
const DAY_MS = 86_400_000;
const REF = /^\[kept image ([0-9a-f]{64}) (image\/[a-z0-9.+-]+)\]$/;
export const GONE = "[An image was here; it is no longer kept.]";

const reference = (hash: string, mimeType: string) => `[kept image ${hash} ${mimeType}]`;

/** Write the image's bytes under their hash, once; a later write of the same image only renews its expiry. */
export function keepImage(dir: string, image: ImageContent): string {
	const bytes = Buffer.from(image.data, "base64");
	const hash = createHash("sha256").update(bytes).digest("hex");
	const file = join(dir, hash);
	const now = new Date();
	try {
		utimesSync(file, now, now);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const temp = `${file}.${randomUUID()}.tmp`;
		writeFileSync(temp, bytes, { mode: 0o600 });
		renameSync(temp, file);
	}
	return reference(hash, image.mimeType);
}

/** The image a reference names, or undefined when `text` is not a reference; GONE when its file is. */
export function restoreImage(dir: string, text: string): ImageContent | TextContent | undefined {
	const match = REF.exec(text);
	if (match === null) return undefined;
	const file = join(dir, match[1]!);
	try {
		const data = readFileSync(file).toString("base64");
		try {
			const now = new Date();
			utimesSync(file, now, now);
		} catch {}
		return { type: "image", data, mimeType: match[2]! };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { type: "text", text: GONE };
	}
}

/** Messages with every reference in a tool result swapped back for its image; the same array when there is none. */
export function restoreMessages(dir: string, messages: readonly Message[]): readonly Message[] {
	let changed = false;
	const out = messages.map((message) => {
		if (message.role !== "toolResult" || !message.content.some((block) => block.type === "text" && REF.test(block.text))) return message;
		changed = true;
		return { ...message, content: message.content.map((block) => (block.type === "text" ? (restoreImage(dir, block.text) ?? block) : block)) };
	});
	return changed ? out : messages;
}

export function createKeptImagesExtension(dir: string, onError: (error: Error) => void) {
	return defineExtension({
		name: "june-kept-images",
		hooks: [
			hook(ToolTask, {
				afterTool: (call, result) => {
					// A nested call's result goes to the program that made it, not to the conversation.
					if (call.parent !== undefined || !result.output?.some((block) => block.type === "image")) return undefined;
					try {
						const output = result.output.map((block) => (block.type === "image" ? { type: "text" as const, text: keepImage(dir, block) } : block));
						const structured = result.structuredOutput as { type?: unknown } | undefined;
						// read's programs get the image block itself; the reference is the string it may also return.
						const structuredOutput = structured?.type === "image" ? output.find((b) => b.type === "text" && REF.test(b.text))?.text : result.structuredOutput;
						return { ...result, output, ...(structuredOutput !== undefined ? { structuredOutput } : {}) };
					} catch (error) {
						// Keeping the image inline costs space, not correctness.
						onError(error as Error);
						return undefined;
					}
				},
			}),
			hook(GenerationTask, {
				beforeRequest: (request) => {
					const messages = restoreMessages(dir, request.messages);
					return messages === request.messages ? undefined : { messages };
				},
			}),
		],
	});
}

/** Delete kept images not written or sent for `days`, and temporary files a crash left. */
export async function expireImages(dir: string, now = Date.now(), days = IMAGE_DAYS): Promise<number> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
	let removed = 0;
	for (const name of names) {
		const temp = name.endsWith(".tmp");
		if (!temp && !/^[0-9a-f]{64}$/.test(name)) continue;
		const file = join(dir, name);
		const { mtimeMs } = await stat(file);
		if (now - mtimeMs > (temp ? DAY_MS : days * DAY_MS)) {
			await unlink(file).catch((error) => {
				if (error.code !== "ENOENT") throw error;
			});
			removed++;
		}
	}
	return removed;
}

export function startImageExpiry(dir: string, onError: (error: Error) => void, everyMs = DAY_MS): () => void {
	const run = () => void expireImages(dir).catch(onError);
	run();
	const timer = setInterval(run, everyMs);
	timer.unref();
	return () => clearInterval(timer);
}
