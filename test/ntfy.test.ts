import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createLogger } from "../src/runtime.ts";
import { createNtfy, notificationText, OPEN_APP } from "../src/ntfy.ts";
import type { ViewItem } from "../src/transcript.ts";
import { tempDir } from "./helpers.ts";

const reply = (id: number, text: string, alert?: "apk" | "gui" | "telegram", streaming = false): ViewItem =>
	({ kind: "assistant", id: String(id), text, streaming, answers: "apk", ...(alert ? { alert } : {}) }) as ViewItem;
const state = { running: false, background: 0, queued: 0, model: "", compacting: false, expression: "idle" } as never;

test("a finished reply meant for the phone is pushed once, never while the app shows it, and never again after a restart", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
	let viewing = false;
	const make = () =>
		createNtfy({
			url: "https://ntfy.example/june",
			state: join(tmp.dir, "state", "ntfy.json"),
			viewing: () => viewing,
			log: createLogger({ sink: () => {} }),
			post: async (url, init) => (posts.push({ url, body: String(init.body), headers: init.headers as Record<string, string> }), { ok: true, status: 200 }),
		});
	let ntfy = make();
	ntfy.onView({ type: "view", reset: true, items: [reply(1, "Old news.", "apk")], state, earlier: false });
	assert.equal(posts.length, 0, "a first start sends nothing it finds");

	ntfy.onView({ type: "view", changes: [{ op: "put", item: reply(2, "Your *build* is green, see [[https://ci.example/1][the run]].", "apk"), after: "1" }] });
	assert.deepEqual(posts.map((p) => [p.url, p.body, p.headers.Click]), [["https://ntfy.example/june", "Your build is green, see the run.", OPEN_APP]]);

	ntfy.onView({ type: "view", changes: [{ op: "put", item: reply(3, "On the desk.", "gui"), after: "2" }, { op: "put", item: reply(4, "Quiet.", undefined), after: "3" }] });
	viewing = true;
	ntfy.onView({ type: "view", changes: [{ op: "put", item: reply(5, "Already on screen.", "apk"), after: "4" }] });
	assert.equal(posts.length, 1, "nothing for other surfaces, and nothing while the app is open");

	viewing = false;
	ntfy = make();
	ntfy.onView({ type: "view", reset: true, items: [reply(2, "Your build is green.", "apk"), reply(5, "Already on screen.", "apk"), reply(6, "New since.", "apk")], state, earlier: false });
	assert.deepEqual(posts.map((p) => p.body), ["Your build is green, see the run.", "New since."], "after a restart only what is new");
});

test("a notification says the reply as plain words, cut short, or its error", () => {
	assert.equal(notificationText(reply(1, "=~/org/x.org= is *done*.") as never), "~/org/x.org is done.");
	assert.equal(notificationText(reply(1, "x".repeat(500)) as never).length, 400);
	assert.equal(notificationText({ ...(reply(1, "") as object), error: "model error: overloaded" } as never), "⚠ model error: overloaded");
});
