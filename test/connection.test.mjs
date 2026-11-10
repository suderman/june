// Exercise Qt's actual connection and panel menu offscreen, without opening a window on the user's desktop.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import zlib from "node:zlib";
import { test } from "node:test";
import { WebSocketServer } from "ws";

const qml = process.env.JUNE_TEST_QML;

test("Qt renders artifact beats in both looks, bounds previews and copies full literal text", { skip: !qml, timeout: 30000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "june-artifacts-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "ui"));
	for (const file of ["Artifact.qml", "ArtifactButton.qml", "ArtifactIcon.qml", "Preview.qml", "ConsolePanel.qml", "Panel.qml", "Balloon.qml", "Backdrop.qml", "Scenery.qml", "FileCard.qml", "Code.mjs", "console.mjs", "compose.mjs", "strip.mjs", "light.mjs", "live.mjs", "scenery.mjs"]) await copyFile(new URL(`../desktop/${file}`, import.meta.url), join(dir, "ui", file));
	const theme = (await readFile(new URL("../desktop/Theme.qml", import.meta.url), "utf8")).replace("import Quickshell\n", "").replace("Singleton {", "QtObject {");
	await writeFile(join(dir, "ui", "Theme.qml"), theme);
	await writeFile(join(dir, "ui", "qmldir"), "singleton Theme 1.0 Theme.qml\n");
	await writeFile(join(dir, "tst_artifacts.qml"), `
import QtQuick
import QtTest
import "ui"
import "ui/strip.mjs" as Strip
Item {
  id: root
  width: 900; height: 700
  property string raw: "  <b>literal</b> & “quoted”—\\t😀\\n\\n" + "a long line to wrap ".repeat(20000)
  property string copied: ""
  Artifact { id: card; content: ({ text: root.raw, language: "text", lines: null }); onPreview: item => modal.show(item); onCopyText: text => root.copied = text }
  Preview { id: modal; anchors.fill: parent; onCopyText: text => root.copied = text }
  ConsolePanel { id: consoleView; visible: false; width: 340; onCopyText: text => root.copied = text; json: JSON.stringify({ elements: [{kind: "june", id:"a#0", artifact:card.content, text:root.raw}] }) }
  Panel { id: comicView; visible: false; width: 340; onCopyText: text => root.copied = text; json: JSON.stringify({id:"a", side:"left", elements:[{kind:"june",id:"a#0",text:root.raw,artifact:card.content}]}) }
  TestCase {
    name: "Artifacts"
    when: windowShown
    function cleanup() { modal.close(); root.copied = ""; card.maxWidth = 400; card.content = {text:root.raw, language:"text", lines:null}; }
    function test_qml_engine_and_console() {
      const item = {kind: "assistant", id:"a", text:root.raw, parts:[{text:"Intro"}, {text:root.raw, artifact:true, language:"text"}], streaming:false};
      const panels = Strip.panels([item]);
      compare(panels.reduce((n,p) => n+p.elements.length,0), 2);
      const beat = panels.reduce((all,p) => all.concat(p.elements), []).find(e => e.artifact);
      compare(beat.artifact.text, root.raw);
      consoleView.visible = true;
      tryVerify(() => consoleView.height > 0 && consoleView.height < 300);
      findChild(consoleView,"copy").clicked(); compare(root.copied, root.raw); root.copied = "";
      consoleView.visible = false;
      comicView.visible = true;
      for (const width of [340,820]) {
        comicView.width = width;
        tryVerify(() => comicView.sizes.length === 1 && comicView.sizes[0].h > 0);
        verify(comicView.sizes[0].h <= 272);
        verify(comicView.sizes[0].w <= comicView.m.textWidth);
        const box = comicView.layout.elements[0];
        verify(box.x >= 0 && box.x+box.w <= width);
      }
      findChild(comicView,"copy").clicked(); compare(root.copied, root.raw);
      comicView.visible = false;
    }
    function test_bound_and_copy() {
      for (const width of [340,820]) {
        card.maxWidth = width;
        verify(card.w <= width); verify(card.h <= 272);
        verify(findChild(card,"excerpt").text.length <= 1600);
        const copy = findChild(card,"copy"); mouseClick(copy, copy.width/2, copy.height/2);
        compare(root.copied, root.raw);
        root.copied = "";
        verify(!modal.open, "copy does not open preview");
      }
    }
    function test_full_preview_and_keyboard() {
      const expand = findChild(card,"expand"); expand.forceActiveFocus(); keyClick(Qt.Key_Return);
      compare(modal.open,true); compare(modal.words,root.raw);
      compare(findChild(modal,"external").visible,false);
      const copy = findChild(modal,"copy"); copy.forceActiveFocus(); keyClick(Qt.Key_Space);
      compare(root.copied,root.raw);
      const close = findChild(modal,"close"); close.forceActiveFocus(); keyClick(Qt.Key_Return); compare(modal.open,false);
    }
    function test_card_header_and_overflow() {
      for (const text of ["", "Short draft", "One\\nTwo\\nThree"]) {
        card.content = {text, language:"text", lines:null};
        tryCompare(card, "overflow", false);
        verify(!findChild(card,"more").visible, "short and empty text have no footer");
        compare(findChild(card,"title").text, "Copy text");
      }
      const text = Array.from({length:13}, (_,i) => "line " + i).join("\\n");
      card.content = {text, language:"a-very-long-language-label-that-must-not-overlap-controls", lines:null};
      tryCompare(card, "overflow", true);
      compare(card.hiddenLines,5);
      compare(findChild(card,"more").label, "Show more (5 lines)");
      const more = findChild(card,"more"); more.forceActiveFocus(); keyClick(Qt.Key_Space);
      compare(modal.words,text); modal.close();
      const expand = findChild(card,"expand");
      verify(findChild(card,"title").x + findChild(card,"title").width < expand.x);
      expand.forceActiveFocus(); keyClick(Qt.Key_Return); compare(modal.words,text); modal.close();
      card.content = {text:"wrapped ".repeat(100), language:"text", lines:null};
      tryCompare(card, "overflow", true);
      compare(findChild(card,"more").label,"Show more");
    }
    function test_empty_and_replaced() {
      modal.show({kind:"artifact",text:"",name:"Empty"});
      compare(modal.words, ""); compare(findChild(modal,"status").visible,false);
      modal.show({kind:"artifact",text:"replacement",name:"New",lines:null});
      compare(modal.words, "replacement"); compare(modal.lit, null);
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
	assert.doesNotMatch(output, /TypeError|ReferenceError|Binding loop/);
});

test("Quickshell clipboard writes preserve NBSP, CRLF and Unicode separators without a text document", { skip: !process.env.JUNE_TEST_QS, timeout: 15000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "june-clipboard-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "shell.qml"), `
import QtQuick
import Quickshell
import ${JSON.stringify(new URL("../desktop", import.meta.url).href)}
ShellRoot {
  Item {
    id: root
    property string raw: "  a\\u00a0b\\r\\n“quoted”—\\u2028line\\u2029paragraph\\t<literal> & 😀\\n" + "x".repeat(200001)
    Artifact { id: card; content: ({text: root.raw, language:"text", lines:null}); onCopyText: text => Quickshell.clipboardText = text }
    Preview { id: modal; onCopyText: text => Quickshell.clipboardText = text }
    function button(item) { for (const child of item.children) if (child.objectName === "copy") return child; }
    Component.onCompleted: Qt.callLater(() => {
      button(card).clicked();
      if (Quickshell.clipboardText !== raw) { console.error("CARD_COPY_FAILED"); Qt.quit(); return; }
      Quickshell.clipboardText = "reset";
      modal.show({kind:"artifact", name:"Full", text:raw});
      // Preview's button belongs to its bottom row.
      for (const row of modal.children) for (const child of row.children) if (child.objectName === "copy") child.clicked();
      if (Quickshell.clipboardText !== raw) console.error("PREVIEW_COPY_FAILED");
      else console.log("CLIPBOARD_EXACT");
      Qt.quit();
    })
  }
}
`);
	// Keep Quickshell's runtime files private and let crashes exit instead of holding the test's pipes open.
	const child = spawn(process.env.JUNE_TEST_QS, ["-p", join(dir, "shell.qml")], { env: { ...process.env, XDG_RUNTIME_DIR: dir, QS_DISABLE_CRASH_HANDLER: "1", QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software", QT_QUICK_CONTROLS_STYLE: "Basic", QT_STYLE_OVERRIDE: "", QT_QPA_PLATFORMTHEME: "", QT_FORCE_STDERR_LOGGING: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
	const closed = once(child, "close");
	t.after(() => child.kill());
	const [code] = await closed;
	assert.equal(code, 0, output);
	assert.match(output, /CLIPBOARD_EXACT/);
	assert.doesNotMatch(output, /COPY_FAILED|TypeError|ReferenceError/);
});

test("Qt reconnects a silent socket, reattaches for a fresh view, and supports manual refresh", { skip: !qml, timeout: 15000 }, async (t) => {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await once(server, "listening");
	t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
	const dir = await mkdtemp(join(tmpdir(), "june-connection-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const source = new URL("../desktop", import.meta.url).href;
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
import ${JSON.stringify(new URL("../desktop", import.meta.url).href)}
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
	for (const file of ["TakeMenu.qml", "compose.mjs", "strip.mjs"]) await copyFile(new URL(`../desktop/${file}`, import.meta.url), join(dir, "ui", file));
	// Only Quickshell's singleton wrapper is replaced; use the actual palette and menu with Qt Quick Test.
	const theme = (await readFile(new URL("../desktop/Theme.qml", import.meta.url), "utf8")).replace("import Quickshell\n", "").replace("Singleton {", "QtObject {");
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
	await copyFile(new URL("../desktop/FileCard.qml", import.meta.url), join(dir, "ui", "FileCard.qml"));
	const theme = (await readFile(new URL("../desktop/Theme.qml", import.meta.url), "utf8")).replace("import Quickshell\n", "").replace("Singleton {", "QtObject {");
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

/** A 4x4 PNG of one colour. */
function solidPng(r, g, b) {
	const chunk = (type, data) => {
		const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13); header.writeUInt32BE(4, 0); header.writeUInt32BE(4, 4); header[8] = 8; header[9] = 2;
	const row = Buffer.from([0, ...Array(4).fill([r, g, b]).flat()]);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat([row, row, row, row]))), chunk("IEND", Buffer.alloc(0))]);
}

test("Qt's preview shows a picture over the strip, hands it to the desktop on request, and closes from its button or the ground", { skip: !qml, timeout: 15000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "june-preview-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "ui"));
	for (const file of ["Preview.qml", "Code.mjs"]) await copyFile(new URL(`../desktop/${file}`, import.meta.url), join(dir, "ui", file));
	const theme = (await readFile(new URL("../desktop/Theme.qml", import.meta.url), "utf8")).replace("import Quickshell\n", "").replace("Singleton {", "QtObject {");
	await writeFile(join(dir, "ui", "Theme.qml"), theme);
	await writeFile(join(dir, "ui", "qmldir"), "singleton Theme 1.0 Theme.qml\nPreview 1.0 Preview.qml\n");
	// A 2x2 PNG, served as a file url as the daemon serves an https one.
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC", "base64");
	await writeFile(join(dir, "picture.png"), png);
	// The daemon's routes for a PDF, as files: its page count, then its pages as pictures; and one it cannot read.
	await mkdir(join(dir, "doc", "page"), { recursive: true });
	await writeFile(join(dir, "doc", "pages"), JSON.stringify({ pages: 2 }));
	// Pages of a solid red, so the test can see that the page itself is drawn, not only the paper behind it.
	for (const n of [1, 2]) await writeFile(join(dir, "doc", "page", String(n)), solidPng(255, 0, 0));
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
      waitForRendering(preview);
      const shot = grabImage(preview);
      verify(Qt.colorEqual(shot.pixel(preview.width / 2, preview.height / 2), "#ff0000"), "the page shows, not only the paper: " + shot.pixel(preview.width / 2, preview.height / 2));
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
    function test_steps_through_what_a_message_brought() {
      compare(preview.stepping, false, "a lone picture has nothing to step to");
      compare(findChild(preview, "forward").visible, false);
      const set = [
        { kind: "picture", url: Qt.resolvedUrl("picture.png"), name: "picture" },
        { kind: "pdf", url: Qt.resolvedUrl("doc"), name: "two pages.pdf" },
        { kind: "text", url: Qt.resolvedUrl("notes.txt"), name: "notes.txt" },
      ];
      preview.show({ kind: "picture", url: set[0].url, name: "picture", set: set, at: 0 });
      verify(preview.stepping);
      const forward = findChild(preview, "forward");
      verify(forward.visible); verify(findChild(preview, "back").visible);
      mouseClick(forward, forward.width / 2, forward.height / 2);
      compare(preview.at, 1); compare(preview.kind, "pdf"); compare(preview.open, true, "the arrow does not close it");
      tryCompare(preview, "pages", 2);
      preview.next(); compare(preview.page, 2, "the arrow keys turn a PDF's pages first");
      preview.next(); compare(preview.kind, "text", "then go on past its last page");
      tryCompare(preview, "words", "buy milk\nwalk Lucy\n");
      preview.next(); compare(preview.at, 0, "and wrap round"); compare(preview.kind, "picture");
      preview.previous(); compare(preview.kind, "text");
      preview.close(); compare(preview.stepping, false);
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
	assert.match(output, /Totals: 11 passed, 0 failed/);
});
