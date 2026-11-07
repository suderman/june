import assert from "node:assert/strict";
import { test } from "node:test";
import { Phones } from "../src/tools/phone.ts";

test("an action goes to the phone that offered its hands and waits for its answer", async () => {
	const phones = new Phones();
	await assert.rejects(phones.act({ action: "screen" }), /No phone is connected/);
	const sent: { requestId: string; action: string }[] = [];
	const withdraw = phones.offer("gem", (m) => sent.push(m));
	const answer = phones.act({ action: "global", text: "power_menu" });
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.action, "global");
	phones.answer(sent[0]!.requestId, true, "opened the power menu");
	assert.deepEqual(await answer, { text: "opened the power menu" });

	const refused = phones.act({ action: "tap", target: "Nowhere" });
	phones.answer(sent[1]!.requestId, false, "no control named Nowhere");
	await assert.rejects(refused, /no control named Nowhere/);

	const cut = phones.act({ action: "screen" });
	withdraw();
	await assert.rejects(cut, /disconnected/, "a closed connection fails what it left waiting");
	await assert.rejects(phones.act({ action: "screen" }), /No phone is connected/);
});

test("the newest connection from a phone acts, several phones need a name, and a silent phone times out", async () => {
	const phones = new Phones();
	const old: string[] = [];
	const fresh: string[] = [];
	phones.offer("gem", (m) => old.push(m.requestId));
	phones.offer("gem", (m) => fresh.push(m.requestId));
	void phones.act({ action: "screen" }, undefined, 50).catch(() => {});
	assert.deepEqual([old.length, fresh.length], [0, 1]);
	phones.offer("tab", () => {});
	await assert.rejects(phones.act({ action: "screen" }), /Name the phone: gem, tab/);
	await assert.rejects(phones.act({ action: "screen" }, "tab", 20), /tab did not answer/);
});

test("a capture brings back the picture it took, and anything but a JPEG or PNG is left out", async () => {
	const phones = new Phones();
	const sent: { requestId: string }[] = [];
	phones.offer("gem", (m) => sent.push(m));
	const shot = phones.act({ action: "capture" });
	phones.answer(sent[0]!.requestId, true, "captured the screen; in front: org.mozilla.fenix", { data: "AAAA", mimeType: "image/jpeg" });
	assert.deepEqual(await shot, { text: "captured the screen; in front: org.mozilla.fenix", image: { data: "AAAA", mimeType: "image/jpeg" } });
	const odd = phones.act({ action: "capture" });
	phones.answer(sent[1]!.requestId, true, "captured", { data: "AAAA", mimeType: "text/html" });
	assert.deepEqual(await odd, { text: "captured" });
});
