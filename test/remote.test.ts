import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { Client, type Reply } from "../src/protocol.ts";
import { avatarFile, UNAUTHORIZED, UNSUPPORTED } from "../src/remote.ts";
import { applyChanges, type ViewItem } from "../src/transcript.ts";
import { ask, attachView, lines, openTestDaemon, tempDir, until } from "./helpers.ts";

type Closed = { code: number; reason: string };

/** A raw WebSocket client that keeps every reply and how it closed. */
async function connect(port: number, options: { autoPong?: boolean } = {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/`, options);
	const replies: Reply[] = [];
	ws.on("message", (data) => replies.push(JSON.parse(data.toString("utf8"))));
	const closed = new Promise<Closed>((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const send = (value: unknown) => ws.send(typeof value === "string" ? value : JSON.stringify(value));
	const reply = async (requestId: string, type?: Reply["type"]) => {
		await until(() => replies.some((r) => "requestId" in r && r.requestId === requestId && (type === undefined || r.type === type)));
		return replies.find((r) => "requestId" in r && r.requestId === requestId && (type === undefined || r.type === type))!;
	};
	return { ws, replies, closed, send, reply };
}

async function device(socket: string, action: "add" | "list" | "revoke", name?: string) {
	const client = await Client.open(socket);
	try {
		return await client.request({ op: "device", requestId: `d-${action}-${name}`, action, ...(name ? { name } : {}) });
	} finally {
		client.close();
	}
}

async function remoteDaemon(t: { after(fn: () => unknown): void }, responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = [], helloMs = 10_000, pingMs = 30_000) {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses(responses);
	const daemon = await openTestDaemon({ ...tmp, faux, config: { remote: { port: 0 } }, remoteTiming: { helloMs, pingMs } });
	t.after(() => daemon.close());
	const port = (await daemon.status()).remote!.port;
	return { tmp, faux, daemon, port };
}

test("the listener refuses a missing hello, a wrong token, another first frame, and an unknown protocol", async (t) => {
	const { tmp, port } = await remoteDaemon(t, [], 300);
	const added = await device(tmp.paths.socket, "add", "cog");
	assert.equal(added.type, "devices");
	const token = (added as Extract<Reply, { type: "devices" }>).token!;

	const silent = await connect(port);
	assert.deepEqual(await silent.closed, { code: UNAUTHORIZED, reason: "no hello" });

	const wrong = await connect(port);
	wrong.send({ op: "hello", requestId: "h", token: "not-a-token", protocol: 1 });
	assert.deepEqual(await wrong.closed, { code: UNAUTHORIZED, reason: "unknown device" });

	const empty = await connect(port);
	empty.send({ op: "hello", requestId: "h", protocol: 1 });
	assert.deepEqual(await empty.closed, { code: UNAUTHORIZED, reason: "unknown device" }, "no token");

	const rude = await connect(port);
	rude.send({ op: "status", requestId: "s" });
	assert.deepEqual(await rude.closed, { code: UNAUTHORIZED, reason: "hello first" }, "a request before hello");
	assert.deepEqual(rude.replies, [], "nothing answered before hello");

	const garbled = await connect(port);
	garbled.send("{not json");
	assert.deepEqual(await garbled.closed, { code: UNAUTHORIZED, reason: "hello first" });

	const future = await connect(port);
	future.send({ op: "hello", requestId: "h", token, protocol: 2 });
	assert.deepEqual(await future.closed, { code: UNSUPPORTED, reason: "protocol 1 only" });
});

test("a paired device attaches, sends, and a repeated submit is one message", async (t) => {
	const { tmp, faux, port } = await remoteDaemon(t, [fauxAssistantMessage("Hi from kit.")]);
	const token = ((await device(tmp.paths.socket, "add", "cog")) as Extract<Reply, { type: "devices" }>).token!;
	assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");

	const file = join(tmp.paths.state, "devices.json");
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	const stored = await readFile(file, "utf8");
	assert.ok(!stored.includes(token), "the token itself is never stored");
	assert.match(stored, /"sha256": "[0-9a-f]{64}"/);

	const c = await connect(port);
	t.after(() => c.ws.terminate());
	c.send({ op: "hello", requestId: "h1", token, protocol: 1 });
	const hello = (await c.reply("h1")) as Extract<Reply, { type: "hello" }>;
	assert.deepEqual({ ...hello, avatar: undefined, attached: undefined }, { type: "hello", requestId: "h1", device: "cog", protocol: 1, avatar: undefined, attached: undefined });
	assert.match(hello.attached ?? "", /^\/attached\/[\w-]{24}\/$/, "a path to the pictures messages brought, with the same key");
	assert.match(hello.avatar ?? "", /^\/avatar\/[\w-]{24}\/$/, "a path to the avatar set, with this device's key");

	let items: ViewItem[] = [];
	c.ws.on("message", (data) => {
		const reply = JSON.parse(data.toString("utf8")) as Reply;
		if (reply.type !== "view") return;
		items = "reset" in reply ? reply.items : applyChanges(items, reply.changes);
	});
	c.send({ op: "attach", requestId: "a1" });
	await c.reply("a1", "view");

	c.send({ op: "submit", requestId: "draft-1", text: "hello from the overlay", source: "gui" });
	const first = (await c.reply("draft-1", "accepted")) as Extract<Reply, { type: "accepted" }>;
	await until(() => lines(items).includes("june: Hi from kit."));
	assert.deepEqual(lines(items), ["alex: hello from the overlay", "june: Hi from kit."]);
	assert.equal(items[0]!.kind === "user" && items[0]!.source, "gui");

	// The same draft again, as after a dropped connection: on a new connection, the same submission.
	const again = await connect(port);
	t.after(() => again.ws.terminate());
	again.send({ op: "hello", requestId: "h2", token, protocol: 1 });
	await again.reply("h2", "hello");
	again.send({ op: "submit", requestId: "draft-1", text: "hello from the overlay", source: "gui" });
	const second = (await again.reply("draft-1", "accepted")) as Extract<Reply, { type: "accepted" }>;
	assert.equal(second.submissionId, first.submissionId);
	c.send({ op: "submit", requestId: "draft-1", text: "hello from the overlay", source: "gui" });
	await until(() => c.replies.filter((r) => r.type === "accepted").length === 2);
	assert.equal(faux.state.callCount, 1, "the repeats never reached the model");

	const listed = (await device(tmp.paths.socket, "list")) as Extract<Reply, { type: "devices" }>;
	assert.deepEqual(listed.devices.map((d) => [d.name, d.connections]), [["cog", 2]]);

	// The WebSocket may not manage devices, say hello twice, or send binary frames, and stays open.
	c.send({ op: "device", requestId: "d1", action: "list" });
	assert.deepEqual(await c.reply("d1"), { type: "error", requestId: "d1", message: "Devices are managed over the Unix socket" });
	c.send({ op: "hello", requestId: "h3", token, protocol: 1 });
	assert.equal((await c.reply("h3")).type, "error");
	c.ws.send(Buffer.from([1, 2, 3]));
	await until(() => c.replies.some((r) => r.type === "error" && /Binary/.test(r.message)));
	c.send({ op: "status", requestId: "s1" });
	assert.equal((await c.reply("s1")).type, "status");
});

test("revoking a device closes its connections at once and refuses its token", async (t) => {
	const { tmp, port } = await remoteDaemon(t);
	const cog = ((await device(tmp.paths.socket, "add", "cog")) as Extract<Reply, { type: "devices" }>).token!;
	const phone = ((await device(tmp.paths.socket, "add", "phone")) as Extract<Reply, { type: "devices" }>).token!;
	assert.equal((await device(tmp.paths.socket, "add", "cog")).type, "error", "a name is added once");
	assert.equal((await device(tmp.paths.socket, "add", "Bad Name")).type, "error");

	const a = await connect(port);
	a.send({ op: "hello", requestId: "h", token: cog, protocol: 1 });
	await a.reply("h", "hello");
	a.send({ op: "attach", requestId: "a" });
	await a.reply("a", "view");
	const b = await connect(port);
	t.after(() => b.ws.terminate());
	b.send({ op: "hello", requestId: "h", token: phone, protocol: 1 });
	await b.reply("h", "hello");

	const started = Date.now();
	const revoked = (await device(tmp.paths.socket, "revoke", "cog")) as Extract<Reply, { type: "devices" }>;
	assert.equal(revoked.closed, 1);
	assert.deepEqual(revoked.devices.map((d) => d.name), ["phone"]);
	assert.deepEqual(await a.closed, { code: UNAUTHORIZED, reason: "revoked" });
	assert.ok(Date.now() - started < 1000, "closed at once, not after a ping");

	const retry = await connect(port);
	retry.send({ op: "hello", requestId: "h", token: cog, protocol: 1 });
	assert.deepEqual(await retry.closed, { code: UNAUTHORIZED, reason: "unknown device" }, "the revoked token is refused");
	assert.equal((await device(tmp.paths.socket, "revoke", "cog")).type, "error", "nothing left to revoke");

	b.send({ op: "status", requestId: "s" });
	assert.equal((await b.reply("s")).type, "status", "the other device stays connected");
});

test("an unreadable device file refuses connections without stopping the daemon", async (t) => {
	const { tmp, port, daemon } = await remoteDaemon(t);
	const token = ((await device(tmp.paths.socket, "add", "cog")) as Extract<Reply, { type: "devices" }>).token!;
	await writeFile(join(tmp.paths.state, "devices.json"), "{broken");
	const c = await connect(port);
	c.send({ op: "hello", requestId: "h", token, protocol: 1 });
	assert.deepEqual(await c.closed, { code: UNAUTHORIZED, reason: "unknown device" });
	assert.equal((await device(tmp.paths.socket, "list")).type, "error");
	assert.equal((await daemon.status()).ok, true);
});

test("a connection that stops answering pings is dropped; one that answers stays", async (t) => {
	const { tmp, port, daemon } = await remoteDaemon(t, [], 10_000, 100);
	const token = ((await device(tmp.paths.socket, "add", "cog")) as Extract<Reply, { type: "devices" }>).token!;
	const deaf = await connect(port, { autoPong: false });
	deaf.send({ op: "hello", requestId: "h", token, protocol: 1 });
	await deaf.reply("h", "hello");
	const live = await connect(port);
	t.after(() => live.ws.terminate());
	live.send({ op: "hello", requestId: "h", token, protocol: 1 });
	await live.reply("h", "hello");
	await deaf.closed;
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(live.ws.readyState, WebSocket.OPEN);
	assert.equal((await daemon.status()).remote?.connections, 1);
});

test("devices can be managed with the listener off, and the listener listens only on loopback", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const daemon = await openTestDaemon({ ...tmp, faux: fauxProvider() });
	t.after(() => daemon.close());
	assert.equal((await daemon.status()).remote, undefined);
	assert.equal((await device(tmp.paths.socket, "add", "cog")).type, "devices");

	const { daemon: on, port } = await remoteDaemon(t);
	assert.equal((await on.status()).remote?.connections, 0);
	const tcp = await readFile("/proc/net/tcp", "utf8");
	const hex = port.toString(16).toUpperCase().padStart(4, "0");
	const listening = tcp.split("\n").filter((l) => l.split(/\s+/)[2]?.endsWith(`:${hex}`) && l.split(/\s+/)[4] === "0A");
	assert.deepEqual(listening.map((l) => l.trim().split(/\s+/)[1]), [`0100007F:${hex}`], "bound to 127.0.0.1 only");
});

test("a port that is taken leaves the daemon running and says so in status", async (t) => {
	const { port } = await remoteDaemon(t);
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const daemon = await openTestDaemon({ ...tmp, faux: fauxProvider(), config: { remote: { port } } });
	t.after(() => daemon.close());
	const status = await daemon.status();
	assert.equal(status.ok, true);
	assert.match(status.remote?.error ?? "", /EADDRINUSE/);
});

test("JUNE_REMOTE_PORT turns the listener on", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	await mkdir(tmp.paths.config, { recursive: true });
	await writeFile(join(tmp.paths.config, "config.json"), JSON.stringify({ model: { chat: { provider: "faux", modelId: "faux-1" } } }));
	assert.equal(loadConfig(tmp.paths, {}).remote, undefined);
	assert.deepEqual(loadConfig(tmp.paths, { JUNE_REMOTE_PORT: "7347" }).remote, { port: 7347 });
	for (const bad of ["0", "70000", "http"]) assert.throws(() => loadConfig(tmp.paths, { JUNE_REMOTE_PORT: bad }), /JUNE_REMOTE_PORT/);
});

test("a paired device loads the avatar set over HTTP under its key, and nothing else", async (t) => {
	const { tmp, port } = await remoteDaemon(t);
	const set = join(tmp.paths.data, "avatar");
	await mkdir(join(set, "poses"), { recursive: true });
	await writeFile(join(set, "manifest.json"), '{"version":1}');
	await writeFile(join(set, "poses", "idle.webp"), "RIFFwebp");
	await writeFile(join(set, "notes.txt"), "not art");
	await writeFile(join(tmp.paths.data, "secret.png"), "outside the set");
	await symlink(join(tmp.paths.data, "secret.png"), join(set, "escape.png"));
	const token = ((await device(tmp.paths.socket, "add", "cog")) as Extract<Reply, { type: "devices" }>).token!;
	const c = await connect(port);
	t.after(() => c.ws.terminate());
	c.send({ op: "hello", requestId: "h", token, protocol: 1 });
	const base = `http://127.0.0.1:${port}${((await c.reply("h")) as Extract<Reply, { type: "hello" }>).avatar}`;

	const manifest = await fetch(`${base}manifest.json`);
	assert.equal(manifest.status, 200);
	assert.equal(manifest.headers.get("content-type"), "application/json");
	assert.equal(await manifest.text(), '{"version":1}');
	const pose = await fetch(`${base}poses/idle.webp`);
	assert.equal(pose.status, 200);
	assert.equal(pose.headers.get("content-type"), "image/webp");
	const etag = pose.headers.get("etag")!;
	assert.equal((await fetch(`${base}poses/idle.webp`, { headers: { "if-none-match": etag } })).status, 304, "unchanged art is not sent again");

	for (const path of ["notes.txt", "escape.png", "..%2Fsecret.png", "poses%2F..%2F..%2Fsecret.png", "missing.png", "poses"]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
	// fetch itself resolves a literal "..", so the path rule is checked directly.
	for (const path of ["poses/../manifest.json", "./manifest.json", "poses//idle.webp", "/manifest.json"]) assert.equal(avatarFile(set, path), undefined, path);
	assert.equal(avatarFile(set, "poses/idle.webp")?.type, "image/webp");
	assert.equal((await fetch(`http://127.0.0.1:${port}/avatar/not-a-key/manifest.json`)).status, 404, "an unknown key");
	assert.equal((await fetch(`${base}manifest.json`, { method: "POST" })).status, 404, "read only");

	c.send({ op: "hello", requestId: "h2", token, protocol: 1 });
	await c.reply("h2", "error");
	const again = await connect(port);
	t.after(() => again.ws.terminate());
	again.send({ op: "hello", requestId: "h", token, protocol: 1 });
	assert.equal(`http://127.0.0.1:${port}${((await again.reply("h")) as Extract<Reply, { type: "hello" }>).avatar}`, base, "one key per device");

	await device(tmp.paths.socket, "revoke", "cog");
	assert.equal((await fetch(`${base}manifest.json`)).status, 404, "a revoked device's key stops working");
});

test("a paired device loads the picture a message brought, and only a user's own", async (t) => {
	const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC";
	const { tmp, port } = await remoteDaemon(t, [fauxAssistantMessage("a tiny square")]);
	const token = ((await device(tmp.paths.socket, "add", "gem")) as Extract<Reply, { type: "devices" }>).token!;
	const c = await connect(port);
	t.after(() => c.ws.terminate());
	c.send({ op: "hello", requestId: "h", token, protocol: 1 });
	const base = `http://127.0.0.1:${port}${((await c.reply("h")) as Extract<Reply, { type: "hello" }>).attached}`;
	c.send({ op: "submit", requestId: "s", text: "", images: [{ type: "image", mimeType: "image/png", data: PNG }], source: "apk", wait: true });
	await c.reply("s", "settled");
	c.send({ op: "attach", requestId: "a" });
	const view = (await c.reply("a", "view")) as Extract<Reply, { type: "view"; reset: true }>;
	const sent = view.items.find((i) => i.kind === "user" && i.imageCount === 1)!;
	assert.ok(sent, "the message is in the view, with its picture counted");

	const picture = await fetch(`${base}${sent.id}/0`);
	assert.equal(picture.status, 200);
	assert.equal(picture.headers.get("content-type"), "image/png");
	assert.match(picture.headers.get("cache-control") ?? "", /immutable/, "a message never changes");
	assert.equal(Buffer.from(await picture.arrayBuffer()).toString("base64"), PNG);
	assert.equal((await fetch(`${base}${sent.id}/1`)).status, 404, "only the pictures it brought");
	const reply = view.items.find((i) => i.kind === "assistant")!;
	assert.equal((await fetch(`${base}${reply.id.split("#")[0]}/0`)).status, 404, "nothing June said");
	assert.equal((await fetch(`${base}999999/0`)).status, 404, "no such message");
	assert.equal((await fetch(`http://127.0.0.1:${port}/attached/not-a-key/${sent.id}/0`)).status, 404, "an unknown key");
});

test("a WebSocket retake and another client's Back change only art, survive restart, and replay once", async (t) => {
	const tmp = await tempDir(); t.after(tmp.cleanup);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("the words stay put")]);
	const face = fauxProvider({ provider: "face", models: [{ id: "director" }] });
	face.setResponses([fauxAssistantMessage('{"expression":"smug"}'), fauxAssistantMessage('{"expression":"warm"}')]);
	const config = { remote: { port: 0 }, model: { chat: { provider: "faux", modelId: "faux-1", thinkingLevel: "off" as const }, expression: { provider: "face", modelId: "director", thinkingLevel: "off" as const } } };
	let daemon = await openTestDaemon({ ...tmp, faux, providers: [face], config });
	t.after(() => daemon.close());
	const token = ((await device(tmp.paths.socket, "add", "gem")) as Extract<Reply, { type: "devices" }>).token!;
	let desktop = await attachView(tmp.paths.socket); t.after(() => desktop.close());
	await ask(tmp.paths.socket, "keep this reply", "words", "gui");
	const current = () => desktop.items().findLast((i): i is Extract<ViewItem, { kind: "assistant" }> => i.kind === "assistant")!;
	await until(() => !!current()?.artVersion);
	const original = { ...current() };
	const dialogue = lines(desktop.items());
	let phone = await connect((await daemon.status()).remote!.port); t.after(() => phone.ws.terminate());
	const attachPhone = async () => {
		phone.send({ op: "hello", requestId: "hello", token, protocol: 1 }); await phone.reply("hello", "hello");
		phone.send({ op: "attach", requestId: "attach" }); await phone.reply("attach", "view");
	};
	await attachPhone();
	phone.send({ op: "retake", requestId: "take", reply: original.id, revision: original.artVersion });
	assert.equal((await phone.reply("take")).type, "reply");
	await until(() => current().take === 1);
	assert.equal(current().expression, "warm");
	assert.notEqual(current().pose, original.pose);
	assert.equal(current().at, original.at, "retake changes selection time, never the panel's lighting time");
	assert.deepEqual(lines(desktop.items()), dialogue);
	phone.send({ op: "retake", requestId: "take", reply: original.id, revision: original.artVersion });
	await until(() => phone.replies.filter((r) => r.type === "reply" && r.requestId === "take").length === 2);
	assert.equal(face.state.callCount, 2, "same request replays without a third model call");
	phone.send({ op: "retake", requestId: "stale", reply: original.id, revision: original.artVersion });
	assert.equal((await phone.reply("stale")).type, "error");
	phone.send({ op: "retake", requestId: "missing", reply: "99999999", revision: "" });
	assert.equal((await phone.reply("missing")).type, "error");
	desktop.close(); phone.ws.terminate(); await daemon.close();
	daemon = await openTestDaemon({ ...tmp, faux, providers: [face], config });
	desktop = await attachView(tmp.paths.socket);
	phone = await connect((await daemon.status()).remote!.port);
	await attachPhone();
	assert.equal(current().take, 1);
	const client = await Client.open(tmp.paths.socket); t.after(() => client.close());
	await client.request({ op: "attach", requestId: "desktop" });
	assert.equal((await client.request({ op: "restore", requestId: "back", reply: original.id, revision: current().artVersion! })).type, "reply");
	await until(() => current().take === 0);
	const restored = current();
	assert.deepEqual([restored.expression, restored.pose, restored.side, restored.expressionAt, restored.at], [original.expression, original.pose, original.side, original.expressionAt, original.at]);
	assert.equal(face.state.callCount, 2, "restart does not backfill, Back does not use a model");
	assert.deepEqual(lines(desktop.items()), dialogue);
	let phoneItems: ViewItem[] = [];
	for (const reply of phone.replies) if (reply.type === "view") phoneItems = "reset" in reply ? reply.items : applyChanges(phoneItems, reply.changes);
	await until(() => phone.replies.some((r) => r.type === "view" && "changes" in r && r.changes.some((c) => c.op === "put" && c.item.kind === "assistant" && c.item.take === 0)));
	phoneItems = [];
	for (const reply of phone.replies) if (reply.type === "view") phoneItems = "reset" in reply ? reply.items : applyChanges(phoneItems, reply.changes);
	assert.deepEqual(phoneItems, desktop.items(), "both clients see the same art and take history");
});
