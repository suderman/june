// Terminal attachments: clipboard images and pasted file paths become inline model content, not paths for June to read.
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { extname } from "node:path";
import { promisify } from "node:util";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp" };
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 10;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
let processor: ReturnType<typeof createNodePhotonImages> | undefined;

async function prepare(bytes: Uint8Array, mimeType: string): Promise<ImageContent> {
	if (bytes.length > MAX_FILE_BYTES) throw new Error("Image exceeds 20 MiB; use a smaller file");
	// Photon transfers a sliced Uint8Array to its worker; Buffer.slice() would keep Node's non-transferable pool.
	const image = await (await (processor ??= createNodePhotonImages())).prepare(new Uint8Array(bytes), mimeType, DEFAULT_IMAGE_LIMITS);
	if (image === undefined) throw new Error("Image cannot be decoded or made small enough for the model");
	return { type: "image", data: image.data, mimeType: image.mimeType };
}

async function fromFile(path: string): Promise<ImageContent> {
	const file = await open(path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path, "r");
	try {
		const info = await file.stat();
		if (!info.isFile()) throw new Error(`${path} is not an image file`);
		if (info.size > MAX_FILE_BYTES) throw new Error(`${path} exceeds 20 MiB; use a smaller file`);
		return await prepare(await file.readFile(), MIME[extname(path).toLowerCase()]!);
	} finally {
		await file.close();
	}
}

/** Resolve explicit image paths and clipboard markers. No file is removed, and a failure sends nothing. */
export async function imageInput(text: string, pasted: ReadonlyMap<string, ImageContent> = new Map()): Promise<{ text: string; images: ImageContent[] }> {
	// A path is one shell-style token, quoted or with backslash-escaped spaces. URLs and prose are left alone.
	const tokens = /\[image \d+\]|(?<!\S)(?:'[^'\n]+\.(?:png|jpe?g|webp|gif|bmp)'|"[^"\n]+\.(?:png|jpe?g|webp|gif|bmp)"|(?:\\[^\n]|[^\s'"\\])+\.(?:png|jpe?g|webp|gif|bmp))(?=\s|$)/gi;
	const images: ImageContent[] = [];
	let body = "";
	let end = 0;
	for (const match of text.matchAll(tokens)) {
		const token = match[0];
		const marker = /^\[image \d+\]$/.test(token);
		const path = /^['"]/.test(token) ? token.slice(1, -1) : token.replace(/\\(.)/g, "$1");
		if (!marker && /^[a-z][a-z\d+.-]*:\/\//i.test(path)) continue;
		if (images.length === MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per message`);
		const image = marker ? pasted.get(token) : await fromFile(path);
		if (image === undefined) throw new Error(`${token} is no longer attached; paste the image again`);
		images.push(image);
		body += text.slice(end, match.index);
		end = match.index + token.length;
	}
	body += text.slice(end);
	validateImages(images);
	return { text: images.length ? body.trim() : text, images };
}

/** The socket accepts inline image content only, never a file path supplied by another process. */
export function validateImages(value: unknown): asserts value is ImageContent[] {
	if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new Error(`Expected at most ${MAX_IMAGES} images`);
	let total = 0;
	for (const image of value) {
		if (image?.type !== "image" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType) ||
			typeof image.data !== "string" || !image.data.length || image.data.length > DEFAULT_IMAGE_LIMITS.maxBytes ||
			Buffer.from(image.data, "base64").toString("base64") !== image.data) {
			throw new Error("Invalid image attachment (supported formats: PNG, JPEG, WebP, GIF)");
		}
		total += image.data.length;
	}
	if (total > MAX_TOTAL_BYTES) throw new Error("Image attachments exceed 20 MiB; send fewer images");
}

const exec = promisify(execFile);
const clipboardCommand = async (args: readonly string[]) => (await exec("wl-paste", [...args], { encoding: "buffer", timeout: 3000, maxBuffer: MAX_FILE_BYTES })).stdout;

/** Read only Wayland's current clipboard. Do not fall back to a potentially stale X11 selection. */
export async function clipboardInput(run: (args: readonly string[]) => Promise<Buffer> = clipboardCommand): Promise<{ text: string } | { image: ImageContent }> {
	const types = (await run(["--list-types"])).toString("utf8").split(/\r?\n/);
	const mime = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"].find((type) => types.includes(type));
	if (mime !== undefined) return { image: await prepare(await run(["--type", mime, "--no-newline"]), mime) };
	if (types.some((type) => type.startsWith("text/plain"))) return { text: (await run(["--type", "text", "--no-newline"])).toString("utf8") };
	throw new Error("Clipboard has no image or text; paste an image file path instead");
}
