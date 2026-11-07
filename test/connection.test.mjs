// Exercise Qt's actual connection and panel menu offscreen, without opening a window on the user's desktop.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocketServer } from "ws";

const qml = process.env.JUNE_TEST_QML;

test("Qt reconnects a silent socket, reattaches for a fresh view, and supports manual refresh", { skip: !qml, timeout: 15000 }, async (t) => {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await once(server, "listening");
	t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
	const dir = await mkdtemp(join(tmpdir(), "june-connection-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const source = new URL("../overlay", import.meta.url).href;
	await writeFile(join(dir, "main.qml"), `
import QtQuick
import ${JSON.stringify(source)}
Item {
  Connection {
    id: link
    url: "ws://127.0.0.1:${server.address().port}"
    token: () => "test-token"
    probeMs: 50
    timeoutMs: 250
    retryMs: 50
    onLinkedChanged: console.log("LINK " + linked)
    onReceived: reply => {
      if (reply.type === "view") console.log("VIEW " + reply.generation);
      if (reply.type === "refresh-test") link.refresh();
    }
  }
}
`);
	let attempts = 0;
	let probes = 0;
	let latest;
	server.on("connection", (ws) => {
		const generation = ++attempts;
		latest = ws;
		ws.on("message", (data) => {
			const request = JSON.parse(data.toString());
			if (request.op === "hello") {
				assert.equal(request.token, "test-token");
				ws.send(JSON.stringify({ type: "hello", requestId: request.requestId, protocol: 1 }));
			} else if (request.op === "attach") {
				ws.send(JSON.stringify({ type: "view", reset: true, items: [], generation }));
			} else if (request.op === "status") {
				probes += 1;
				// Generation one stays open but never replies, like a dead proxy connection after suspend.
				if (generation > 1) ws.send(JSON.stringify({ type: "status", requestId: request.requestId, status: {} }));
			} else assert.fail(`unexpected request ${request.op}`);
		});
	});
	const child = spawn(qml, ["-f", join(dir, "main.qml")], { env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software", QT_STYLE_OVERRIDE: "", QT_QPA_PLATFORMTHEME: "", QT_FORCE_STDERR_LOGGING: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	const closed = once(child, "close");
	t.after(async () => { child.kill(); await closed; });
	let output = "";
	const waiters = new Set();
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; for (const check of waiters) check(); });
	child.on("error", (error) => { output += error.message; for (const check of waiters) check(); });
	const waitFor = (text) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`missing ${text}:\n${output}`)); }, 4000);
		const check = () => { if (output.includes(text)) { clearTimeout(timer); waiters.delete(check); resolve(); } };
		waiters.add(check);
		check();
	});
	await waitFor("VIEW 1");
	await waitFor("VIEW 2");
	assert.ok(probes > 0, "quiet connections are probed without submitting a message");
	assert.match(output, /LINK false/, "a dead link stops claiming to be connected");
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(attempts, 2, "status replies keep an idle connection alive");
	latest.send(JSON.stringify({ type: "refresh-test" }));
	await waitFor("VIEW 3");
});

test("Qt retries a socket that opens but never answers hello", { skip: !qml, timeout: 10000 }, async (t) => {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await once(server, "listening");
	t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
	const dir = await mkdtemp(join(tmpdir(), "june-hello-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "main.qml"), `
import QtQuick
import ${JSON.stringify(new URL("../overlay", import.meta.url).href)}
Item {
  Connection {
    url: "ws://127.0.0.1:${server.address().port}"
    token: () => "test-token"
    timeoutMs: 250
    retryMs: 50
  }
}
`);
	let attempts = 0;
	let retry;
	const retried = new Promise((resolve) => { retry = resolve; });
	server.on("connection", () => { if (++attempts === 2) retry(); });
	const child = spawn(qml, ["-f", join(dir, "main.qml")], { env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software", QT_STYLE_OVERRIDE: "", QT_QPA_PLATFORMTHEME: "", QT_FORCE_STDERR_LOGGING: "1" }, stdio: "ignore" });
	const closed = once(child, "close");
	t.after(async () => { child.kill(); await closed; });
	await Promise.race([retried, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("hello never timed out")), 4000); retried.finally(() => clearTimeout(timer)); })]);
});

test("Qt's right-click take menu preserves left selection, targets the reply, and disables overlapping requests", { skip: !qml, timeout: 15000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "june-menu-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "ui"));
	for (const file of ["TakeMenu.qml", "compose.mjs", "strip.mjs"]) await copyFile(new URL(`../overlay/${file}`, import.meta.url), join(dir, "ui", file));
	// Only Quickshell's singleton wrapper is replaced; use the actual palette and menu with Qt Quick Test.
	const theme = (await readFile(new URL("../overlay/Theme.qml", import.meta.url), "utf8")).replace("import Quickshell\n", "").replace("Singleton {", "QtObject {");
	await writeFile(join(dir, "ui", "Theme.qml"), theme);
	await writeFile(join(dir, "ui", "qmldir"), "singleton Theme 1.0 Theme.qml\n");
	await writeFile(join(dir, "tst_take.qml"), `
import QtQuick
import QtTest
import "ui"
import "ui/strip.mjs" as Strip
Item {
  id: root
  width: 500; height: 240
  property var chosen: null
  TextEdit { id: words; width: 500; height: 100; text: "June's words remain selectable with the left button"; selectByMouse: true; readOnly: true; font.pixelSize: 18 }
  TakeMenu { id: area; anchors.fill: parent; panel: ({ elements: [] }); onChosen: choice => root.chosen = choice }
  TestCase {
    name: "PanelTakeMenu"
    when: windowShown
    function popup() { return findChild(area, "takeMenu"); }
    function init() {
      area.panel = { elements: [{ kind: "june", replyId: "42", artVersion: "version-one", canRestore: true, canAdvance: true }] };
      area.linked = true; area.taking = ({}); root.chosen = null;
    }
    function cleanup() { popup().close(); }
    function open() { mouseClick(area, 260, 50, Qt.RightButton); tryCompare(popup(), "opened", true); waitForRendering(popup().contentItem); }
    function test_select_and_retake() {
      mousePress(words, 2, 10, Qt.LeftButton);
      mouseMove(words, 220, 10, 100);
      mouseRelease(words, 220, 10, Qt.LeftButton);
      verify(words.selectedText.length > 0, "left-button selection passes through");
      const selected = words.selectedText;
      open();
      compare(words.selectedText, selected);
      compare(popup().itemAt(0).text, "Another take");
      const item = popup().itemAt(0);
      mouseClick(item, item.width / 2, item.height / 2);
      tryVerify(() => root.chosen !== null);
      compare(root.chosen.op, "retake"); compare(root.chosen.reply, "42"); compare(root.chosen.revision, "version-one");
    }
    function test_back() {
      open(); compare(popup().itemAt(1).text, "Back");
      const item = popup().itemAt(1);
      mouseClick(item, item.width / 2, item.height / 2); tryVerify(() => root.chosen !== null); compare(root.chosen.op, "restore");
    }
    function test_forward() {
      open(); compare(popup().itemAt(2).text, "Forward");
      const item = popup().itemAt(2);
      mouseClick(item, item.width / 2, item.height / 2); tryVerify(() => root.chosen !== null);
      compare(root.chosen.op, "advance"); compare(root.chosen.reply, "42"); compare(root.chosen.revision, "version-one");
    }
    function test_forward_without_back() {
      area.panel = { elements: [{ kind: "june", replyId: "42", canAdvance: true }] };
      open(); compare(popup().itemAt(1).text, "Forward"); compare(popup().itemAt(2).visible, false);
      const item = popup().itemAt(1);
      mouseClick(item, item.width / 2, item.height / 2); tryVerify(() => root.chosen !== null); compare(root.chosen.op, "advance");
    }
    function test_older_reply_after_new_words() {
      const items = [
        { kind: "assistant", id: "42", text: "An earlier reply", streaming: false, artVersion: "saved", take: 1, takes: [{ take: 0 }, { take: 1 }, { take: 2 }] },
        { kind: "assistant", id: "43", text: "A later update", streaming: false }
      ];
      const panels = Strip.panels(items);
      compare(panels.length, 2);
      area.panel = panels[0];
      open(); compare(popup().itemAt(1).text, "Back"); compare(popup().itemAt(2).text, "Forward");
      const item = popup().itemAt(1);
      mouseClick(item, item.width / 2, item.height / 2); tryVerify(() => root.chosen !== null);
      compare(root.chosen.op, "restore"); compare(root.chosen.reply, "42"); compare(root.chosen.revision, "saved");
    }
    function test_busy_and_offline() {
      area.taking = { "42": "request" }; open();
      for (let i = 0; i < 3; i++) compare(popup().itemAt(i).enabled, false);
      popup().close(); area.taking = ({}); area.linked = false; open();
      for (let i = 0; i < 3; i++) compare(popup().itemAt(i).enabled, false);
    }
    function test_no_back_before_a_retake_and_no_menu_while_live() {
      area.panel = { elements: [{ kind: "june", replyId: "42" }] }; open(); compare(popup().itemAt(1).visible, false); compare(popup().itemAt(2).visible, false);
      popup().close(); area.panel = { live: true, elements: [] }; compare(area.enabled, false);
    }
  }
}
`);
	const child = spawn(join(dirname(qml), "qmltestrunner"), ["-input", dir], { env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software", QT_QUICK_CONTROLS_STYLE: "Basic", QT_STYLE_OVERRIDE: "", QT_QPA_PLATFORMTHEME: "", QT_FORCE_STDERR_LOGGING: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
	const closed = once(child, "close");
	t.after(() => child.kill());
	const [code] = await closed;
	assert.equal(code, 0, output);
	assert.match(output, /test_select_and_retake.*PASS|PASS.*test_select_and_retake/);
});

test("Qt's file card shows the file's name and size, asks to open it by its url, and stays closed once expired", { skip: !qml, timeout: 15000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "june-file-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "ui"));
	await copyFile(new URL("../overlay/FileCard.qml", import.meta.url), join(dir, "ui", "FileCard.qml"));
	const theme = (await readFile(new URL("../overlay/Theme.qml", import.meta.url), "utf8")).replace("import Quickshell\n", "").replace("Singleton {", "QtObject {");
	await writeFile(join(dir, "ui", "Theme.qml"), theme);
	await writeFile(join(dir, "ui", "qmldir"), "singleton Theme 1.0 Theme.qml\nFileCard 1.0 FileCard.qml\n");
	await writeFile(join(dir, "tst_file.qml"), `
import QtQuick
import QtTest
import "ui"
Item {
  id: root
  width: 320; height: 80
  property string opened: ""
  FileCard { id: card; x: 10; y: 10; width: 280; onChosen: url => root.opened = url }
  TestCase {
    name: "FileCard"
    when: windowShown
    function init() { root.opened = ""; card.url = "https://june.kit/attached/key/42/file/0"; card.file = { n: 0, name: "Report.pdf", size: "3.2 MB", expired: false }; }
    function test_open() {
      compare(findChild(card, "name").text, "Report.pdf");
      compare(findChild(card, "size").text, "3.2 MB");
      mouseClick(card, card.width / 2, card.height / 2);
      compare(root.opened, "https://june.kit/attached/key/42/file/0");
    }
    function test_expired() {
      card.file = { n: 1, name: "Report.pdf", size: "3.2 MB", expired: true };
      compare(findChild(card, "size").text, "expired");
      compare(card.opacity, 0.5);
      mouseClick(card, card.width / 2, card.height / 2);
      compare(root.opened, "");
    }
    function test_no_url_before_hello() {
      card.url = "";
      mouseClick(card, card.width / 2, card.height / 2);
      compare(root.opened, "");
    }
  }
}
`);
	const child = spawn(join(dirname(qml), "qmltestrunner"), ["-input", dir], { env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software", QT_STYLE_OVERRIDE: "", QT_QPA_PLATFORMTHEME: "", QT_FORCE_STDERR_LOGGING: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
	const closed = once(child, "close");
	t.after(() => child.kill());
	const [code] = await closed;
	assert.equal(code, 0, output);
	assert.match(output, /Totals: 5 passed, 0 failed/);
});

test("Qt's preview shows a picture over the strip, hands it to the desktop on request, and closes from its button or the ground", { skip: !qml, timeout: 15000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "june-preview-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "ui"));
	await copyFile(new URL("../overlay/Preview.qml", import.meta.url), join(dir, "ui", "Preview.qml"));
	const theme = (await readFile(new URL("../overlay/Theme.qml", import.meta.url), "utf8")).replace("import Quickshell\n", "").replace("Singleton {", "QtObject {");
	await writeFile(join(dir, "ui", "Theme.qml"), theme);
	await writeFile(join(dir, "ui", "qmldir"), "singleton Theme 1.0 Theme.qml\nPreview 1.0 Preview.qml\n");
	// A 2x2 PNG, served as a file url as the daemon serves an https one.
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC", "base64");
	await writeFile(join(dir, "picture.png"), png);
	// The daemon's routes for a PDF, as files: its page count, then its pages as pictures; and one it cannot read.
	await mkdir(join(dir, "doc", "page"), { recursive: true });
	await writeFile(join(dir, "doc", "pages"), JSON.stringify({ pages: 2 }));
	for (const n of [1, 2]) await writeFile(join(dir, "doc", "page", String(n)), png);
	await mkdir(join(dir, "broken"));
	await writeFile(join(dir, "broken", "pages"), JSON.stringify({ pages: 0 }));
	await writeFile(join(dir, "notes.txt"), "buy milk\nwalk Lucy\n");
	await writeFile(join(dir, "tst_preview.qml"), `
import QtQuick
import QtTest
import "ui"
Item {
  id: root
  width: 600; height: 400
  property string external: ""
  Preview { id: preview; anchors.fill: parent; onExternal: url => root.external = url }
  TestCase {
    name: "Preview"
    when: windowShown
    function init() { root.external = ""; preview.show({ url: Qt.resolvedUrl("picture.png"), name: "picture 1 of 2" }); }
    function test_shows_and_opens_externally() {
      verify(preview.visible);
      const picture = findChild(preview, "picture");
      tryCompare(picture, "status", Image.Ready);
      compare(findChild(preview, "status").visible, false);
      const external = findChild(preview, "external");
      mouseClick(external, external.width / 2, external.height / 2);
      compare(root.external, String(Qt.resolvedUrl("picture.png")));
    }
    function test_close_button() {
      const close = findChild(preview, "close");
      mouseClick(close, close.width / 2, close.height / 2);
      compare(preview.open, false); compare(preview.visible, false);
    }
    function test_ground_closes_but_picture_does_not() {
      tryCompare(findChild(preview, "picture"), "status", Image.Ready);
      mouseClick(preview, preview.width / 2, preview.height / 2);
      compare(preview.open, true, "a click on the picture keeps it open");
      mouseClick(preview, 8, preview.height - 8);
      compare(preview.open, false, "a click on the ground closes it");
    }
    function test_missing_picture_says_so() {
      preview.show({ url: Qt.resolvedUrl("gone.png"), name: "gone" });
      tryCompare(findChild(preview, "picture"), "status", Image.Error);
      verify(findChild(preview, "status").text.indexOf("could not be loaded") >= 0);
    }
    function test_pdf_pages() {
      preview.show({ kind: "pdf", url: Qt.resolvedUrl("doc"), name: "two pages.pdf" });
      tryCompare(preview, "pages", 2);
      const picture = findChild(preview, "picture");
      verify(String(picture.source).endsWith("doc/page/1"));
      tryCompare(picture, "status", Image.Ready);
      verify(preview.paging);
      const next = findChild(preview, "next");
      mouseClick(next, next.width / 2, next.height / 2);
      compare(preview.page, 2);
      verify(String(picture.source).endsWith("doc/page/2"));
      preview.next(); compare(preview.page, 2, "not past the last page");
      preview.previous(); compare(preview.page, 1);
      const external = findChild(preview, "external");
      mouseClick(external, external.width / 2, external.height / 2);
      compare(root.external, String(Qt.resolvedUrl("doc")), "the browser gets the file, not a page");
    }
    function test_pdf_without_pages() {
      preview.show({ kind: "pdf", url: Qt.resolvedUrl("broken"), name: "broken.pdf" });
      tryCompare(preview, "pages", 0);
      verify(findChild(preview, "status").text.indexOf("could not be read") >= 0);
      compare(preview.paging, false);
    }
    function test_text() {
      preview.show({ kind: "text", url: Qt.resolvedUrl("notes.txt"), name: "notes.txt" });
      tryCompare(preview, "words", "buy milk\nwalk Lucy\n");
      verify(findChild(preview, "words").visible);
      compare(findChild(preview, "status").visible, false);
    }
    function test_other_file() {
      preview.show({ kind: "file", url: Qt.resolvedUrl("archive.zip"), name: "archive.zip" });
      compare(findChild(preview, "status").visible, false);
      const external = findChild(preview, "external");
      mouseClick(external, external.width / 2, external.height / 2);
      compare(root.external, String(Qt.resolvedUrl("archive.zip")));
    }
  }
}
`);
	const child = spawn(join(dirname(qml), "qmltestrunner"), ["-input", dir], { env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software", QT_STYLE_OVERRIDE: "", QT_QPA_PLATFORMTHEME: "", QT_FORCE_STDERR_LOGGING: "1", QML_XHR_ALLOW_FILE_READ: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
	const closed = once(child, "close");
	t.after(() => child.kill());
	const [code] = await closed;
	assert.equal(code, 0, output);
	assert.match(output, /Totals: 10 passed, 0 failed/);
});
