import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { panels } from "../overlay/strip.mjs";
import { lines as consoleLines } from "../overlay/console.mjs";
import { inboxFile } from "../src/daemon.ts";
import { shownFiles } from "../src/shown.ts";
import { ask, attachView, openTestDaemon, tempDir, until } from "./helpers.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC", "base64");

test("a show result names its files on lines of their own, and nothing else in it counts", () => {
	const text = 'Shown to Alex beside your reply: fix.nix (text/plain, 12 B).\n[shown {"name":"fix.nix","mimeType":"text/plain","size":12,"path":"/i/fix.nix","language":"nix"}]\n[shown {"name":1}]\n[shown not json]';
	assert.deepEqual(shownFiles(text), [{ name: "fix.nix", mimeType: "text/plain", size: 12, path: "/i/fix.nix", language: "nix" }]);
});

test("June shows a picture and a snippet beside her reply: the view draws them on her side and the devices can fetch them", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const picture = join(tmp.dir, "panel.png");
	await writeFile(picture, PNG);
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("show", { path: picture }), fauxToolCall("show", { text: "services.june.enable = true;\n", language: "nix" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Here is the panel, and the line to add."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());
	assert.equal((await ask(tmp.paths.socket, "show me", "s1", "gui")).text, "Here is the panel, and the line to add.");
	await until(() => view.items().filter((i) => i.kind === "shown").length === 2);

	// The two calls run at once, so either may finish first.
	const shown = view.items().filter((i) => i.kind === "shown").sort((a, b) => (a.kind === "shown" && b.kind === "shown" ? a.files[0]!.name.localeCompare(b.files[0]!.name) : 0));
	assert.deepEqual(
		shown.map((i) => i.kind === "shown" && i.files),
		[[{ name: "panel.png", size: PNG.length, mimeType: "image/png" }], [{ name: "snippet.nix", size: 29, mimeType: "text/plain", language: "nix" }]],
		"the view names each file, not where the inbox keeps it",
	);
	const inbox = join(tmp.paths.state, "inbox");
	const served = await Promise.all(shown.map((i) => inboxFile(daemon.root, inbox, i.id, 0)));
	assert.deepEqual(readFileSync(served[0]!.path), PNG, "the picture's copy in the inbox is served");
	assert.equal(served[0]!.mimeType, "image/png");
	assert.equal(readFileSync(served[1]!.path, "utf8"), "services.june.enable = true;\n");
	assert.equal(await inboxFile(daemon.root, inbox, shown[0]!.id, 1), undefined, "only what was shown");

	const panel = panels(view.items())[0];
	const card = panel.elements.filter((e) => e.kind === "shown");
	assert.equal(card.length, 1, "shows in a row make one card");
	assert.deepEqual(card[0].files.map((f) => [f.id, f.n, f.name, f.preview]).sort(), shown.map((i) => [i.id, 0, i.kind === "shown" ? i.files[0]!.name : "", i.kind === "shown" && i.files[0]!.mimeType === "image/png" ? "picture" : "text"]).sort(), "each file keeps the show it came from, for its address");
	assert.ok(consoleLines(panel).some((l) => l.text === "shown: snippet.nix (29 B)"), "the console says it in words");
});

test("a text file without a known extension shows as text, and a path that is not there fails plainly", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	await writeFile(join(tmp.dir, "flake.lock.nix"), "{ }\n");
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("show", { path: join(tmp.dir, "flake.lock.nix") }), fauxToolCall("show", { path: join(tmp.dir, "gone.txt") })], { stopReason: "toolUse" }),
		fauxAssistantMessage("One of them was there."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux });
	t.after(() => daemon.close());
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());
	await ask(tmp.paths.socket, "show both", "s2", "gui");
	await until(() => view.items().some((i) => i.kind === "shown"));
	assert.deepEqual(view.items().filter((i) => i.kind === "shown").map((i) => i.kind === "shown" && i.files[0]!.mimeType), ["text/plain"]);
	assert.ok(view.items().some((i) => i.kind === "tool" && i.name === "show" && i.status === "error"), "the missing file is the tool's error");
});
