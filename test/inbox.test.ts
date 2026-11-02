import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { expireInbox, MAX_FILE_BYTES, safeName, saveFiles } from "../src/inbox.ts";
import { Client } from "../src/protocol.ts";
import { attachView, openTestDaemon, tempDir, until } from "./helpers.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64");

/** Every file under `dir`, relative to it, skipping request records. */
async function filesUnder(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
		if (entry.isFile() && !entry.parentPath.endsWith(".requests")) out.push(join(entry.parentPath, entry.name).slice(dir.length + 1));
	}
	return out.sort();
}

async function onDaemon(t: { after(fn: () => unknown): void }, responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses(responses);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const inputs = async () => (await daemon.root.context(BG)).entries.filter((e) => e.kind === "june.input").map((e) => e.data as { text: string; files?: { name: string; size: number; path: string }[] });
	return { tmp, daemon, client, inputs, inbox: join(tmp.paths.state, "inbox") };
}

test("a file is saved privately in the inbox, June is told its name, type, size, and path, and the view shows it", async (t) => {
	let told = "";
	let prompt = "";
	const { tmp, client, inputs, inbox } = await onDaemon(t, [
		(ctx) => {
			const last = ctx.messages.at(-1)!;
			told = typeof last.content === "string" ? last.content : "";
			prompt = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
			return fauxAssistantMessage("Got the notes.");
		},
	]);
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());
	const reply = await client.request({ op: "submit", requestId: "r1", text: "", files: [{ name: "notes.txt", mimeType: "text/plain", data: b64("buy milk\n") }], source: "cli" });
	assert.equal(reply.type, "accepted");
	await until(() => told !== "");
	const [input] = await inputs();
	const path = input!.files![0]!.path;
	assert.match(path.slice(inbox.length), /^\/\d{4}-\d{2}-\d{2}\/\d{4}-notes\.txt$/);
	assert.equal(await readFile(path, "utf8"), "buy milk\n");
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal((await stat(join(path, ".."))).mode & 0o777, 0o700);
	assert.equal((await stat(inbox)).mode & 0o777, 0o700);
	assert.deepEqual(input!.files, [{ name: "notes.txt", size: 9, path }]);
	assert.equal(told, `[cli] [file notes.txt, text/plain, 9 B, saved at ${path}]`);
	assert.ok(prompt.includes(`your inbox, ${inbox} on `) && prompt.includes("deleted after 30 days"), "June knows where her inbox is");
	await until(() => view.items().some((i) => i.kind === "user" && i.files?.length === 1));
	const item = view.items().find((i) => i.kind === "user")!;
	assert.deepEqual(item.kind === "user" && item.files, [{ name: "notes.txt", size: 9, path }]);
});

test("a retried submit with the same request id saves its file once", async (t) => {
	const { client, inputs, inbox } = await onDaemon(t, [fauxAssistantMessage("Saved.")]);
	const request = { op: "submit" as const, requestId: "same", text: "keep this", files: [{ name: "a.pdf", mimeType: "application/pdf", data: b64("%PDF") }], source: "telegram" as const };
	const first = await client.request(request);
	const again = await client.request(request);
	assert.equal(first.type, "accepted");
	assert.deepEqual(again, first, "the same submission");
	await until(async () => (await inputs()).length === 1);
	assert.equal((await filesUnder(inbox)).length, 1);
	// Directly: a retry on another day still finds what the first attempt saved.
	const saved = await saveFiles(inbox, "x:1", [{ name: "b.txt", mimeType: "text/plain", data: b64("b") }], new Date(2026, 0, 1, 9, 5));
	assert.deepEqual(await saveFiles(inbox, "x:1", [{ name: "b.txt", mimeType: "text/plain", data: b64("b") }], new Date(2026, 0, 2, 9, 6)), saved);
	assert.equal((await filesUnder(inbox)).length, 2);
	const twice = await Promise.all([1, 2].map(() => saveFiles(inbox, "x:2", [{ name: "c.txt", mimeType: "text/plain", data: b64("c") }])));
	assert.deepEqual(twice[0], twice[1], "two at once share one save");
	assert.equal((await filesUnder(inbox)).length, 3);
});

test("path-like and hostile names stay inside the inbox as safe, unique basenames", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const inbox = join(tmp.dir, "inbox");
	const names = ["../../etc/passwd", "/abs/path/x.txt", "..", ".bashrc", "a\nb\u0000c.txt", "dir\\evil.txt", "x.txt", "x.txt", `${"long".repeat(100)}.pdf`, ""];
	const saved = await saveFiles(inbox, "hostile", names.map((name) => ({ name, mimeType: "nonsense", data: b64(name) })), new Date(2026, 4, 6, 7, 8));
	assert.deepEqual(
		saved.map((f) => f.path.slice(inbox.length + 1)),
		[
			"2026-05-06/0708-passwd",
			"2026-05-06/0708-x.txt",
			"2026-05-06/0708-file",
			"2026-05-06/0708-bashrc",
			"2026-05-06/0708-abc.txt",
			"2026-05-06/0708-evil.txt",
			"2026-05-06/0708-x-2.txt",
			"2026-05-06/0708-x-3.txt",
			`2026-05-06/0708-${"long".repeat(29)}.pdf`,
			"2026-05-06/0708-file-2",
		],
	);
	assert.ok(saved.every((f) => f.mimeType === "application/octet-stream"));
	assert.equal(await readFile(saved[0]!.path, "utf8"), "../../etc/passwd");
	assert.equal(safeName("  report final .pdf "), "report final .pdf");
});

test("a file over the limit, or too many, is refused and nothing is saved", async (t) => {
	const { client, inputs, inbox } = await onDaemon(t, []);
	const big = Buffer.alloc(MAX_FILE_BYTES + 1).toString("base64");
	const reply = await client.request({ op: "submit", requestId: "big", text: "here", files: [{ name: "big.bin", mimeType: "application/octet-stream", data: big }], source: "cli" });
	assert.deepEqual(reply, { type: "error", requestId: "big", message: "big.bin exceeds 20 MiB" });
	const many = Array.from({ length: 11 }, (_, i) => ({ name: `${i}.txt`, mimeType: "text/plain", data: b64("x") }));
	assert.equal((await client.request({ op: "submit", requestId: "many", text: "", files: many, source: "cli" })).type, "error");
	const bad = await client.request({ op: "submit", requestId: "bad", text: "", files: [{ name: "x", mimeType: "text/plain", data: "not base64!" }], source: "cli" });
	assert.equal(bad.type, "error");
	assert.deepEqual(await filesUnder(inbox), []);
	assert.equal((await inputs()).length, 0);
});

test("expiry removes files older than 30 days and their emptied day, and keeps recent ones", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const inbox = join(tmp.dir, "inbox");
	const now = Date.now();
	const day = 24 * 60 * 60_000;
	const old = await saveFiles(inbox, "old", [{ name: "old.txt", mimeType: "text/plain", data: b64("old") }], new Date(now - 31 * day));
	const recent = await saveFiles(inbox, "recent", [{ name: "new.txt", mimeType: "text/plain", data: b64("new") }], new Date(now - 2 * day));
	const record = (await readdir(join(inbox, ".requests"))).map((n) => join(inbox, ".requests", n));
	const aged = new Date(now - 31 * day);
	await utimes(old[0]!.path, aged, aged);
	for (const r of record) if ((await readFile(r, "utf8")).includes("old.txt")) await utimes(r, aged, aged);
	await mkdir(join(inbox, "notes"));
	await writeFile(join(inbox, "notes", "kept.txt"), "not a day directory");
	await utimes(join(inbox, "notes", "kept.txt"), aged, aged);

	assert.equal(await expireInbox(inbox, now), 2, "the old file and its request record");
	assert.deepEqual(await filesUnder(inbox), [recent[0]!.path.slice(inbox.length + 1), "notes/kept.txt"].sort());
	assert.equal((await readdir(join(inbox, ".requests"))).length, 1);
	assert.equal(await expireInbox(inbox, now), 0, "a second run changes nothing");
	assert.equal(await expireInbox(join(tmp.dir, "missing"), now), 0, "no inbox yet");
	// The old request's record is gone, so the same request id saves again rather than naming an expired file.
	assert.equal((await saveFiles(inbox, "old", [{ name: "old.txt", mimeType: "text/plain", data: b64("old") }])).length, 1);
});
