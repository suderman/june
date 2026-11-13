import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { immichFrom, scan, seenNote, watchImmich } from "../src/immich.ts";
import { TimelineFold } from "../src/timeline.ts";

const image = { type: "image" as const, data: Buffer.from("jpeg bytes").toString("base64"), mimeType: "image/jpeg" };
const immich = { url: "https://photos.test", key: "secret" };

/** A stand-in Immich: `faces` answers each poll in turn, the last one repeating. */
function server(faces: unknown[][], options: { upload?: number; poll?: number } = {}) {
	const calls: { method: string; path: string; key: string | null; body?: unknown }[] = [];
	let poll = 0;
	const fake = (async (input: string, init: RequestInit) => {
		const url = new URL(input);
		const method = init.method ?? "GET";
		calls.push({ method, path: url.pathname + url.search, key: new Headers(init.headers).get("x-api-key"), body: init.body });
		const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
		if (method === "POST" && url.pathname === "/api/assets") return options.upload ? json(options.upload, { message: "no" }) : json(201, { id: "a1", status: "created" });
		if (method === "GET" && url.pathname === "/api/faces") return options.poll ? json(options.poll, {}) : json(200, faces[Math.min(poll++, faces.length - 1)]);
		if (method === "DELETE" && url.pathname === "/api/assets") return json(204, undefined);
		return json(404, {});
	}) as unknown as typeof fetch;
	return { calls, fetch: fake };
}

test("immich is configured only with both its address and key", () => {
	assert.deepEqual(immichFrom({ IMMICH_URL: "https://photos.test/", IMMICH_API_KEY: " k " }), { url: "https://photos.test", key: "k" });
	assert.equal(immichFrom({ IMMICH_URL: "https://photos.test" }), undefined);
	assert.equal(immichFrom({ IMMICH_API_KEY: "k" }), undefined);
});

test("a scan uploads an archived asset, waits for every face to be named, reads them left to right, and deletes it", async () => {
	const named = (name: string | null, x: number) => ({ person: name === null ? null : { name }, boundingBoxX1: x });
	const fake = server([[], [named("Nathan", 900), named(null, 400)], [named("Nathan", 900), named("Sam", 400), named("Mum", 650)]]);
	const seen = await scan(immich, image, { fetch: fake.fetch, pollMs: 1 });
	assert.deepEqual(seen, { names: ["Sam", "Mum", "Nathan"], unknown: 0 });
	assert.ok(fake.calls.every((call) => call.key === "secret"), "every call carries the key");
	const upload = fake.calls[0]!;
	assert.equal(upload.method, "POST");
	assert.equal((upload.body as FormData).get("visibility"), "archive", "kept out of the timeline while it exists");
	assert.equal(fake.calls.filter((call) => call.path.startsWith("/api/faces")).length, 3, "it waits through detection and recognition");
	const last = fake.calls.at(-1)!;
	assert.equal(last.method, "DELETE");
	assert.deepEqual(JSON.parse(String(last.body)), { ids: ["a1"], force: true }, "and deletes the asset for good");
});

test("a face Immich cannot name is counted once the wait runs out", async () => {
	const fake = server([[{ person: { name: "Sam" }, boundingBoxX1: 10 }, { person: null, boundingBoxX1: 50 }]]);
	assert.deepEqual(await scan(immich, image, { fetch: fake.fetch, pollMs: 1, waitMs: 20 }), { names: ["Sam"], unknown: 1 });
	assert.equal(fake.calls.at(-1)!.method, "DELETE");
});

test("a failed scan says nothing and still deletes what it uploaded", async () => {
	const warnings: string[] = [];
	const refused = server([[]], { upload: 401 });
	assert.equal(await scan(immich, image, { fetch: refused.fetch, warn: (error) => warnings.push(error.message) }), undefined);
	assert.ok(!refused.calls.some((call) => call.method === "DELETE"), "nothing was uploaded, so nothing to delete");
	const broken = server([[]], { poll: 500 });
	assert.equal(await scan(immich, image, { fetch: broken.fetch, pollMs: 1, warn: (error) => warnings.push(error.message) }), undefined);
	assert.equal(broken.calls.at(-1)!.method, "DELETE", "an uploaded asset is deleted even when polling fails");
	assert.deepEqual(warnings, ["Immich POST /assets: HTTP 401", "Immich GET /faces: HTTP 500"]);
});

test("the note names who the library recognized, and says nothing for a failed or empty scan", () => {
	assert.equal(seenNote({ names: ["Sam"], unknown: 0 }, "Alex"), "[Alex's photo library recognized in this photo: Sam.]");
	assert.equal(seenNote({ names: ["Sam", "Mum", "Nathan"], unknown: 1 }, "Alex", 2), "[Alex's photo library recognized in photo 2: Sam, Mum and Nathan, left to right, plus one face it does not know.]");
	assert.equal(seenNote({ names: [], unknown: 2 }, "Alex"), "[Alex's photo library found 2 faces in this photo that it does not know.]");
	assert.equal(seenNote({ names: [], unknown: 0 }, "Alex"), undefined);
	assert.equal(seenNote(undefined, "Alex"), undefined);
});

test("the timeline shows who the library recognized in a photo", () => {
	const fold = new TimelineFold();
	const [item] = fold.push({ id: 7, kind: "june.input", model: [{ timestamp: 1 }], data: { source: "apk", text: "storytime", imageCount: 1, imagePeople: ["Sam", "Mum"] } });
	assert.equal(item!.text, "storytime [1 image: Sam, Mum]");
});

test("the watch counts Immich down until a ping answers, records each check, and a failed scan marks it down", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "june-immich-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "immich.json");
	let answer: "pong" | "refused" = "pong";
	const pinged: string[] = [];
	const fake = (async (input: string) => {
		pinged.push(input);
		if (answer === "refused") throw new Error("connect ECONNREFUSED");
		return new Response(JSON.stringify({ res: "pong" }), { status: 200 });
	}) as unknown as typeof fetch;
	const watch = watchImmich(immich, { file, everyMs: 20, fetch: fake });
	t.after(() => watch.stop());
	assert.equal(watch.up(), false, "down until the first ping answers");
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(watch.up(), true);
	assert.equal(pinged[0], "https://photos.test/api/server/ping", "the ping needs no key");
	assert.equal(JSON.parse(await readFile(file, "utf8")).up, true);
	watch.down(new Error("a scan failed"));
	assert.equal(watch.up(), false, "a failed scan marks it down at once");
	assert.deepEqual((({ up, error }) => ({ up, error }))(JSON.parse(await readFile(file, "utf8"))), { up: false, error: "a scan failed" });
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(watch.up(), true, "and the next ping brings it back");
	answer = "refused";
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(watch.up(), false);
	assert.match(JSON.parse(await readFile(file, "utf8")).error, /ECONNREFUSED/);
});
