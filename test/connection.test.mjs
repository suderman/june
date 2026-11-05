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
	for (const file of ["TakeMenu.qml", "compose.mjs"]) await copyFile(new URL(`../overlay/${file}`, import.meta.url), join(dir, "ui", file));
	// Only Quickshell's singleton wrapper is replaced; use the actual palette and menu with Qt Quick Test.
	const theme = (await readFile(new URL("../overlay/Theme.qml", import.meta.url), "utf8")).replace("import Quickshell\n", "").replace("Singleton {", "QtObject {");
	await writeFile(join(dir, "ui", "Theme.qml"), theme);
	await writeFile(join(dir, "ui", "qmldir"), "singleton Theme 1.0 Theme.qml\n");
	await writeFile(join(dir, "tst_take.qml"), `
import QtQuick
import QtTest
import "ui"
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
      area.panel = { elements: [{ kind: "june", replyId: "42", artVersion: "version-one", canRestore: true }] };
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
    function test_busy_and_offline() {
      area.taking = { "42": "request" }; open();
      compare(popup().itemAt(0).enabled, false); compare(popup().itemAt(1).enabled, false);
      popup().close(); area.taking = ({}); area.linked = false; open(); compare(popup().itemAt(0).enabled, false);
    }
    function test_no_back_before_a_retake_and_no_menu_while_live() {
      area.panel = { elements: [{ kind: "june", replyId: "42" }] }; open(); compare(popup().itemAt(1).visible, false);
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
