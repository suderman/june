// Pictures and files the user attaches on the desktop, as the phone's Outbox.kt does: what they paste (a screenshot, or
// files copied in a file manager), drop, or pick. QML reads neither the Wayland clipboard's pictures nor binary files,
// so attach.sh does (wl-paste, file, ImageMagick, base64, all on the desktop's PATH) and prints one line per thing; this
// module reads those lines and holds them to the daemon's limits (src/images.ts, src/inbox.ts), so nothing it would
// refuse is sent. Pictures shrink to at most 2000 px as JPEG, the most the model sees, under the daemon's 4.5 MiB.

export const MAX_PICTURES = 10;
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PICTURE_BASE64 = 4.5 * 1024 * 1024;
export const MAX_BASE64 = 30 * 1024 * 1024;

/** The command that reads `paths` into lines for `parse`; `script` is attach.sh's path. */
export function readCommand(script, paths) {
	return ["bash", script, "read", ...paths];
}

/** The command that reads the clipboard into lines for `parse`, or exits 1 for words to paste. */
export function pasteCommand(script) {
	return ["bash", script, "paste"];
}

/** The lines a command printed, as attachments ({ kind, name, mimeType, size, data }) and refusals in words. */
export function parse(output) {
	const items = [];
	const refused = [];
	for (const line of String(output).split("\n")) {
		const [kind, ...rest] = line.split("\t");
		if (kind === "picture" || kind === "file") {
			const [name, mimeType, size, data] = rest;
			if (data) items.push({ kind, name, mimeType, size: Number(size) || Math.floor((data.length * 3) / 4), data });
		} else if (kind === "big") refused.push(`${rest[0]}: over 20 MiB`);
		else if (kind === "gone") refused.push(`${rest[0]}: not found`);
	}
	return { items, refused };
}

/** `adding` let into `outbox` within the daemon's limits: the new outbox, and why any were left out. */
export function admit(outbox, adding) {
	const next = outbox.slice();
	const refused = [];
	const count = (kind) => next.filter((a) => a.kind === kind).length;
	const base64 = () => next.reduce((sum, a) => sum + a.data.length, 0);
	for (const item of adding) {
		if (item.kind === "picture" && count("picture") >= MAX_PICTURES) refused.push(`${item.name}: at most ${MAX_PICTURES} pictures a message`);
		else if (item.kind === "file" && count("file") >= MAX_FILES) refused.push(`${item.name}: at most ${MAX_FILES} files a message`);
		else if (item.kind === "picture" && item.data.length > MAX_PICTURE_BASE64) refused.push(`${item.name}: too large a picture even shrunk`);
		else if (base64() + item.data.length > MAX_BASE64) refused.push(`${item.name}: one message carries at most 30 MiB of attachments`);
		else next.push(item);
	}
	return { outbox: next, refused };
}

/** The submit's `images` and `files` for what the outbox holds. */
export function payload(outbox) {
	return {
		images: outbox.filter((a) => a.kind === "picture").map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType })),
		files: outbox.filter((a) => a.kind === "file").map((a) => ({ name: a.name, mimeType: a.mimeType || "application/octet-stream", data: a.data })),
	};
}
