import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { Client } from "../src/protocol.ts";
import { Pushes } from "../src/push.ts";
import { createLogger } from "../src/runtime.ts";
import { openTestDaemon, tempDir } from "./helpers.ts";

/** Boards as far as pushes see them: a revision that moves, its listeners, and who watches the agenda. */
function fakeBoards() {
	let revision = "r1";
	const listeners = new Set<() => void>();
	const watch = { watching: 0, calls: 0 };
	return {
		watch,
		move(to: string) { revision = to; for (const l of listeners) l(); },
		boards: {
			revisions: () => ({ agenda: revision }),
			onChange: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
			watchAgenda: () => { watch.watching++; watch.calls++; return () => { watch.watching--; }; },
		},
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a phone's push address on the ntfy server is kept, and a moved agenda pushes once a burst settles", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const sent: string[] = [];
	const fake = fakeBoards();
	const file = join(tmp.dir, "push.json");
	const make = () => new Pushes({ file, origin: "https://ntfy.example", boards: fake.boards, log: createLogger({ sink: () => {} }), post: async (url) => { sent.push(url); return { ok: true, status: 200 }; }, debounceMs: 30 });
	const pushes = make();
	t.after(() => pushes.stop());
	fake.move("r2");
	await sleep(60);
	assert.deepEqual(sent, [], "no phone, no push");
	assert.equal(fake.watch.calls, 0, "and the agenda is not watched for nobody");
	assert.throws(() => pushes.register("gem", "https://evil.example/up1"), /must be on https:\/\/ntfy.example/);
	assert.throws(() => pushes.register("gem", "file:///etc/passwd"), /must be on/);
	pushes.register("gem", "https://ntfy.example/upAbc?up=1");
	assert.equal(fake.watch.watching, 1, "a phone that takes pushes keeps the agenda watched");
	fake.move("r3");
	fake.move("r4");
	fake.move("r5");
	await sleep(80);
	assert.deepEqual(sent, ["https://ntfy.example/upAbc?up=1"], "three quick changes, one push");
	fake.move("r5");
	await sleep(60);
	assert.equal(sent.length, 1, "an unmoved revision pushes nothing");
	// The address survives a restart.
	pushes.stop();
	const again = make();
	t.after(() => again.stop());
	assert.equal(fake.watch.watching, 1);
	fake.move("r6");
	await sleep(60);
	assert.equal(sent.length, 2);
	// Without ntfy configured, a phone is told so.
	const off = new Pushes({ file: join(tmp.dir, "off.json"), origin: undefined, boards: fake.boards, log: createLogger({ sink: () => {} }) });
	t.after(() => off.stop());
	assert.throws(() => off.register("gem", "https://ntfy.example/up1"), /ntfy.url/);
});

test("only a paired phone sets a push address", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	await openTestDaemon({ ...tmp, faux: fauxProvider() });
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	const reply = await client.request({ op: "push", requestId: randomUUID(), endpoint: "https://ntfy.example/up1" });
	assert.equal(reply.type, "error");
	assert.match(reply.type === "error" ? reply.message : "", /paired phone/);
});
