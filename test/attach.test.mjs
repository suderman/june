import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { admit, MAX_PICTURE_BASE64, parse, payload, readCommand } from "../overlay/attach.mjs";

const run = promisify(execFile);
const script = new URL("../overlay/attach.sh", import.meta.url).pathname;
// A 2x2 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC", "base64");
const tools = await run("bash", ["-c", "command -v magick file wl-paste"]).then(() => true, () => false);

test("attach.sh reads a picture as a small JPEG, any other file as itself, and says which it could not", { skip: !tools }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "june-attach-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "shot one.png"), PNG);
	await writeFile(join(dir, "notes.txt"), "buy milk\n");
	const [cmd, ...args] = readCommand(script, [join(dir, "shot one.png"), join(dir, "notes.txt"), join(dir, "gone.pdf")]);
	const { items, refused } = parse((await run(cmd, args, { maxBuffer: 64 * 1024 * 1024 })).stdout);
	assert.deepEqual(items.map((i) => [i.kind, i.name, i.mimeType]), [["picture", "shot one.jpg", "image/jpeg"], ["file", "notes.txt", "text/plain"]]);
	assert.equal(Buffer.from(items[0].data, "base64").subarray(0, 2).toString("hex"), "ffd8", "the picture is a JPEG now");
	assert.equal(Buffer.from(items[1].data, "base64").toString(), "buy milk\n");
	assert.deepEqual(refused, [`${join(dir, "gone.pdf")}: not found`]);
});

test("lines become attachments; a file too big is refused in words", () => {
	const { items, refused } = parse("picture\tscreenshot.jpg\timage/jpeg\t0\tAAAA\nfile\ta.pdf\tapplication/pdf\t3\tAAAA\nbig\thuge.iso\tapplication/octet-stream\t99999999\nnoise\n");
	assert.deepEqual(items.map((i) => [i.kind, i.name, i.size]), [["picture", "screenshot.jpg", 3], ["file", "a.pdf", 3]]);
	assert.deepEqual(refused, ["huge.iso: over 20 MiB"]);
});

test("the outbox keeps to the daemon's limits, and sends pictures as images and the rest as files", () => {
	const picture = (n) => ({ kind: "picture", name: `p${n}.jpg`, mimeType: "image/jpeg", size: 3, data: "AAAA" });
	const ten = Array.from({ length: 10 }, (_, n) => picture(n));
	const full = admit([], ten).outbox;
	const more = admit(full, [picture(10)]);
	assert.equal(more.outbox.length, 10);
	assert.deepEqual(more.refused, ["p10.jpg: at most 10 pictures a message"]);
	const huge = admit([], [{ kind: "picture", name: "huge.jpg", mimeType: "image/jpeg", size: 0, data: "A".repeat(MAX_PICTURE_BASE64 + 4) }]);
	assert.deepEqual(huge.refused, ["huge.jpg: too large a picture even shrunk"]);
	const mixed = admit([], [picture(0), { kind: "file", name: "a.pdf", mimeType: "application/pdf", size: 3, data: "AAAA" }]).outbox;
	assert.deepEqual(payload(mixed), {
		images: [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }],
		files: [{ name: "a.pdf", mimeType: "application/pdf", data: "AAAA" }],
	});
});
