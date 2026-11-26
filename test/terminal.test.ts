// Terminal streams (src/terminal.ts and /terminal in src/remote.ts) against a fake herdr-core speaking the framed
// protocol over a fake `hc connect`, so no real terminal is touched.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { WebSocket } from "ws";
import { Devices } from "../src/devices.ts";
import { startRemote } from "../src/remote.ts";
import { findAgent, openTerminal, type TerminalOptions, type TerminalSocket } from "../src/terminal.ts";
import type { AgentSummary } from "../src/tools/herdr.ts";
import { tempDir, until } from "./helpers.ts";

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as TerminalOptions["log"];
const SESSION = "0123abcd-0000-4000-8000-000000000001";
const pi: AgentSummary = { host: "kit", terminal: "t7", agent: "pi", status: "idle", cwd: "/", session: SESSION, herdrLink: `herdr:kit/pi:${SESSION}@t7` };
const claude: AgentSummary = { host: "cog", terminal: "t3", agent: "claude", status: "working", cwd: "/" };

function frame(ch: number, kind: number, payload: Buffer = Buffer.alloc(0)) {
	const head = Buffer.alloc(9);
	head.writeUInt32LE(ch, 0);
	head.writeUInt8(kind, 4);
	head.writeUInt32LE(payload.length, 5);
	return Buffer.concat([head, payload]);
}

type Frame = { ch: number; kind: number; payload: Buffer };

/** A fake core behind `hc connect`: answers hello and attach as configured, records what the daemon sends. */
function fakeCore(options: { features?: string[]; methods?: string[]; attach?: (params: any) => any } = {}) {
	const argv: string[][] = [];
	const frames: Frame[] = [];
	const attaches: any[] = [];
	const puts: any[] = [];
	const kills: any[] = [];
	const rms: any[] = [];
	let stdout!: PassThrough;
	let child!: ChildProcess;
	const spawn = (a: string[]) => {
		argv.push(a);
		const stdin = new PassThrough();
		stdout = new PassThrough();
		child = Object.assign(new EventEmitter(), { stdin, stdout, kill: () => true }) as unknown as ChildProcess;
		let framed = false;
		let buffer = Buffer.alloc(0);
		stdin.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (!framed) {
				const nl = buffer.indexOf(10);
				if (nl < 0) return;
				const hello = JSON.parse(buffer.subarray(0, nl).toString());
				buffer = buffer.subarray(nl + 1);
				framed = true;
				const features = options.features ?? ["framed", "attach", "automatic_input"];
				stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: hello.id, result: { generation: 1, version: "0.1.22", core: { id: "x", name: "kit" }, framed: true, methods: options.methods ?? ["hello", "terminal.attach", "terminal.put", "terminal.kill", "terminal.rm"], features } })}\n`);
			}
			while (buffer.length >= 9) {
				const len = buffer.readUInt32LE(5);
				if (buffer.length < 9 + len) break;
				const f = { ch: buffer.readUInt32LE(0), kind: buffer.readUInt8(4), payload: Buffer.from(buffer.subarray(9, 9 + len)) };
				buffer = buffer.subarray(9 + len);
				if (f.ch === 0 && f.kind === 0) {
					const m = JSON.parse(f.payload.toString());
					if (m.method === "terminal.attach") {
						attaches.push(m.params);
						const answer = options.attach?.(m.params) ?? { result: { channel: 5, terminal: { cols: m.params.cols, rows: m.params.rows }, resize_notifications: false, automatic_input: true } };
						stdout.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...answer }))));
						if (answer.result) stdout.write(frame(5, 0, Buffer.from("\x18\x1b[!pfirst paint")));
					} else if (m.method === "terminal.put") {
						puts.push(m.params);
						const bytes = Buffer.from(m.params.data, "base64").length;
						const answer = m.params.name === "gone.png" ? { error: { code: -32000, message: "finished", data: { kind: "finished" } } } : { result: { path: `/core/files/${m.params.terminal}/${m.params.name}`, bytes } };
						stdout.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...answer }))));
					} else if (m.method === "terminal.kill") {
						kills.push(m.params);
						stdout.write(frame(5, 2, Buffer.from(JSON.stringify({ reason: "killed" }))));
						stdout.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true } }))));
					} else if (m.method === "terminal.rm") {
						rms.push(m.params);
						stdout.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true } }))));
					}
				} else frames.push(f);
			}
		});
		return child;
	};
	return { spawn, argv, frames, attaches, puts, kills, rms, core: () => stdout, exit: () => child.emit("exit", 0) };
}

function client() {
	const texts: any[] = [];
	const binaries: Buffer[] = [];
	let ended: { code: number; reason: string } | undefined;
	const socket: TerminalSocket = { text: (v) => texts.push(v), binary: (d) => binaries.push(d), end: (code, reason) => (ended ??= { code, reason }) };
	return { socket, texts, binaries, ended: () => ended };
}

function options(spawn: TerminalOptions["spawn"], agents: AgentSummary[] = [pi, claude]): TerminalOptions {
	return { log, host: "kit", ssh: { lux: "lux.local" }, spawn, agents: async (host) => agents.filter((a) => a.host === host), native: async (host) => host === "kit" || host === "cog" };
}

test("only an agent the boards list can be opened, by address or by session link", async () => {
	const o = options(undefined);
	assert.equal(((await findAgent({ host: "kit", terminal: "t7" }, o)) as AgentSummary).terminal, "t7");
	assert.equal(((await findAgent({ link: `herdr:kit/pi:${SESSION}@t2` }, o)) as AgentSummary).terminal, "t7");
	assert.equal(await findAgent({ link: "herdr:kit/pi:0123abcd-0000-4000-8000-00000000ffff" }, o), "not running");
	assert.equal(await findAgent({ host: "kit", terminal: "t1" }, o), "not an agent terminal");
	assert.equal(await findAgent({ host: "mars", terminal: "t1" }, o), "unknown host");
	assert.equal(await findAgent({ host: "kit", terminal: "t7; rm -rf /" }, o), "no terminal named");
	assert.equal(await findAgent({ link: "herdr:kit/pi:../../etc" }, o), "not a session link");
});

test("a stream attaches through hc connect and maps frames both ways", async () => {
	const core = fakeCore();
	const c = client();
	const stream = openTerminal({ host: "cog", terminal: "t3", cols: 56, rows: 29, history: 2000, display: { bg: "#1e1e2e" } }, "gem", c.socket, options(core.spawn));
	await until(() => c.texts.some((t) => t.type === "attached"));
	assert.deepEqual(core.argv, [["hc", "connect"]]);
	assert.deepEqual(core.attaches[0], { terminal: "cog/t3", cols: 56, rows: 29, history: 2000, resumed: false, display: { bg: "#1e1e2e" } });
	assert.deepEqual(c.texts[0], { type: "attached", host: "cog", terminal: "t3", agent: "claude", session: undefined, cols: 56, rows: 29, automaticInput: true });
	await until(() => c.binaries.length > 0);
	assert.equal(c.binaries[0]![0], 0);
	assert.equal(c.binaries[0]!.subarray(1).toString(), "\x18\x1b[!pfirst paint");

	stream.message(Buffer.from([0, 0x68, 0x69]), true);
	stream.message(Buffer.from([6, 0x1b, 0x5b]), true);
	stream.message(Buffer.from(JSON.stringify({ op: "resize", cols: 40, rows: 12 })), false);
	stream.message(Buffer.from(JSON.stringify({ op: "focus", on: true })), false);
	stream.message(Buffer.from(JSON.stringify({ op: "credit", bytes: 300 })), false);
	stream.message(Buffer.from([9, 1]), true);
	stream.message(Buffer.from(JSON.stringify({ op: "exec", argv: ["sh"] })), false);
	await until(() => core.frames.length >= 5);
	assert.deepEqual(core.frames.map((f) => [f.ch, f.kind]), [[5, 0], [5, 6], [5, 3], [5, 4], [5, 1]]);
	assert.equal(core.frames[0]!.payload.toString(), "hi");
	assert.deepEqual([core.frames[2]!.payload.readUInt16LE(0), core.frames[2]!.payload.readUInt16LE(2)], [40, 12]);
	assert.equal(core.frames[4]!.payload.readUInt32LE(0), 300);

	core.core().write(frame(5, 2, Buffer.from(JSON.stringify({ reason: "exited", exit_code: 0, signal: null }))));
	await until(() => c.ended() !== undefined);
	assert.deepEqual(c.texts.at(-1), { type: "closed", reason: "exited", exitCode: 0, signal: null });
	assert.equal(c.ended()!.code, 1000);
});

test("a local terminal and a session link attach by the local address; a host hc has not added goes over ssh", async () => {
	const local = fakeCore();
	const c = client();
	openTerminal({ link: `herdr:kit/pi:${SESSION}@t2`, cols: 80, rows: 24 }, "gem", c.socket, options(local.spawn));
	await until(() => local.attaches.length === 1);
	assert.equal(local.attaches[0].terminal, "t7");

	const remote = fakeCore();
	const lux: AgentSummary = { host: "lux", terminal: "t9", agent: "pi", status: "idle", cwd: "/" };
	openTerminal({ host: "lux", terminal: "t9", cols: 80, rows: 24 }, "gem", client().socket, options(remote.spawn, [lux]));
	await until(() => remote.attaches.length === 1);
	assert.deepEqual(remote.argv[0], ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "lux.local", "hc", "connect"]);
	assert.equal(remote.attaches[0].terminal, "t9");
});

test("input waiting for the attach goes out once it is attached, and automatic replies fall back to DATA without the feature", async () => {
	const core = fakeCore({ features: ["framed", "attach"] });
	const c = client();
	const stream = openTerminal({ host: "kit", terminal: "t7", cols: 80, rows: 24 }, "gem", c.socket, options(core.spawn));
	stream.message(Buffer.from([0, 0x61]), true);
	await until(() => c.texts.some((t) => t.type === "attached"));
	assert.equal(c.texts[0].automaticInput, false);
	stream.message(Buffer.from([6, 0x62]), true);
	await until(() => core.frames.length >= 2);
	assert.deepEqual(core.frames.map((f) => [f.ch, f.kind, f.payload.toString()]), [[5, 0, "a"], [5, 0, "b"]]);
});

test("refusals: no attach feature, an unknown terminal, a terminal between programs, and a lost connection", async () => {
	const old = fakeCore({ features: ["framed"] });
	const a = client();
	openTerminal({ host: "kit", terminal: "t7", cols: 80, rows: 24 }, "gem", a.socket, options(old.spawn));
	await until(() => a.ended() !== undefined);
	assert.equal(a.ended()!.code, 4409);

	const gone = fakeCore({ attach: () => ({ error: { code: -32000, message: "no terminal t7", data: { kind: "not_found" } } }) });
	const b = client();
	openTerminal({ host: "kit", terminal: "t7", cols: 80, rows: 24 }, "gem", b.socket, options(gone.spawn));
	await until(() => b.ended() !== undefined);
	assert.deepEqual(b.ended(), { code: 4404, reason: "no terminal t7" });

	const lost = fakeCore({ attach: () => ({ error: { code: -32000, message: "lost, waiting for its new shell", data: { kind: "unavailable" } } }) });
	const d = client();
	openTerminal({ host: "kit", terminal: "t7", cols: 80, rows: 24 }, "gem", d.socket, options(lost.spawn));
	await until(() => d.ended() !== undefined);
	assert.equal(d.ended()!.code, 4409);

	const unlisted = client();
	openTerminal({ host: "kit", terminal: "t1", cols: 80, rows: 24 }, "gem", unlisted.socket, options(fakeCore().spawn));
	await until(() => unlisted.ended() !== undefined);
	assert.deepEqual(unlisted.ended(), { code: 4404, reason: "not an agent terminal" });

	const drop = fakeCore();
	const e = client();
	openTerminal({ host: "kit", terminal: "t7", cols: 80, rows: 24 }, "gem", e.socket, options(drop.spawn));
	await until(() => e.texts.length > 0);
	drop.exit();
	await until(() => e.ended() !== undefined);
	assert.equal(e.ended()!.code, 4409);
});

test("/terminal takes the same hello and token, counts streams per device, and closes them on revoke", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const devices = new Devices(`${tmp.dir}/devices.json`);
	const { token } = devices.add("gem");
	const opened: string[] = [];
	const closed: string[] = [];
	const remote = await startRemote({
		port: 0, devices, log,
		session: () => ({ handle() {}, close() {} }),
		terminal: (hello, device, socket) => {
			opened.push(`${device}:${hello.terminal}`);
			socket.text({ type: "attached" });
			return { message: (data, binary) => binary && socket.binary(Buffer.concat([Buffer.from([0]), data.subarray(1)])), close: () => closed.push(String(hello.terminal)) };
		},
	});
	t.after(() => remote.close());
	const open = async (hello: object) => {
		const ws = new WebSocket(`ws://127.0.0.1:${remote.port}/terminal`);
		const got: (string | Buffer)[] = [];
		ws.on("message", (data, binary) => got.push(binary ? data : data.toString()));
		const shut = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
		await new Promise<void>((resolve) => ws.once("open", () => resolve()));
		ws.send(JSON.stringify({ op: "hello", protocol: 1, ...hello }));
		return { ws, got, shut };
	};
	const wrong = await open({ token: "nope", host: "kit", terminal: "t1" });
	assert.equal(await wrong.shut, 4401);

	const streams: Awaited<ReturnType<typeof open>>[] = [];
	for (const n of [1, 2, 3, 4]) streams.push(await open({ token, host: "kit", terminal: `t${n}` }));
	await until(() => opened.length === 4);
	const fifth = await open({ token, host: "kit", terminal: "t5" });
	assert.equal(await fifth.shut, 4429);

	streams[0]!.ws.send(Buffer.from([0, 0x7a]));
	await until(() => streams[0]!.got.some((g) => Buffer.isBuffer(g)));
	assert.deepEqual([...(streams[0]!.got.find((g) => Buffer.isBuffer(g)) as Buffer)], [0, 0x7a]);

	assert.equal(remote.revoke("gem"), 4);
	assert.deepEqual(await Promise.all(streams.map((s) => s.shut)), [4401, 4401, 4401, 4401]);
	assert.deepEqual(closed.sort(), ["t1", "t2", "t3", "t4"]);
});

test("a file from the client lands beside the stream's own terminal, and the client hears where", async () => {
	const core = fakeCore();
	const c = client();
	const stream = openTerminal({ host: "cog", terminal: "t3", cols: 56, rows: 29 }, "gem", c.socket, options(core.spawn));
	const put = (op: object) => stream.message(Buffer.from(JSON.stringify({ op: "put", ...op })), false);
	put({ id: "early", name: "a.png", data: "aGk=" });
	await until(() => c.texts.some((t) => t.type === "attached"));
	put({ id: "a", name: "../../shot.png", data: Buffer.from("png bytes").toString("base64"), terminal: "t1" });
	put({ id: "b", name: "gone.png", data: "aGk=" });
	put({ id: "c", name: "", data: "aGk=" });
	put({ id: "d", name: "big.png", data: "A".repeat(10_666_680) });
	await until(() => c.texts.filter((t) => t.type === "put").length === 5);
	const answers = Object.fromEntries(c.texts.filter((t) => t.type === "put").map((t) => [t.id, t]));
	assert.deepEqual(answers.early, { type: "put", id: "early", error: "not attached yet" });
	assert.deepEqual(answers.a, { type: "put", id: "a", path: "/core/files/cog/t3/shot.png", bytes: 9 });
	assert.deepEqual(core.puts[0], { terminal: "cog/t3", name: "shot.png", data: Buffer.from("png bytes").toString("base64") });
	assert.equal(answers.b.error, "finished");
	assert.equal(answers.c.error, "no file name");
	assert.equal(answers.d.error, "files go up to 8 MB");
	assert.equal(core.puts.length, 2);

	const old = fakeCore({ methods: ["hello", "terminal.attach"] });
	const o = client();
	const s2 = openTerminal({ host: "kit", terminal: "t7", cols: 80, rows: 24 }, "gem", o.socket, options(old.spawn));
	await until(() => o.texts.some((t) => t.type === "attached"));
	s2.message(Buffer.from(JSON.stringify({ op: "put", id: 1, name: "x.png", data: "aGk=" })), false);
	await until(() => o.texts.some((t) => t.type === "put"));
	assert.deepEqual(o.texts.at(-1), { type: "put", id: 1, error: "this herdr-core cannot take files" });
	assert.equal(old.puts.length, 0);
});

test("kill ends and removes only the stream's own terminal, waiting past channel CLOSE", async () => {
	const core = fakeCore();
	const c = client();
	const stream = openTerminal({ host: "cog", terminal: "t3", cols: 56, rows: 29 }, "gem", c.socket, options(core.spawn));
	stream.message(Buffer.from(JSON.stringify({ op: "kill" })), false);
	await until(() => c.texts.some((t) => t.type === "attached"));
	assert.deepEqual(c.texts[0], { type: "killed", error: "not attached yet" });
	stream.message(Buffer.from(JSON.stringify({ op: "kill", terminal: "t1" })), false);
	await until(() => c.ended() !== undefined);
	assert.deepEqual(core.kills, [{ terminal: "cog/t3" }]);
	assert.deepEqual(core.rms, [{ terminal: "cog/t3" }]);
	assert.deepEqual(c.texts.at(-1), { type: "killed", ok: true });
	assert.deepEqual(c.ended(), { code: 1000, reason: "killed" });

	const old = fakeCore({ methods: ["hello", "terminal.attach"] });
	const o = client();
	const s2 = openTerminal({ host: "kit", terminal: "t7", cols: 80, rows: 24 }, "gem", o.socket, options(old.spawn));
	await until(() => o.texts.some((t) => t.type === "attached"));
	s2.message(Buffer.from(JSON.stringify({ op: "kill" })), false);
	await until(() => o.texts.some((t) => t.type === "killed"));
	assert.deepEqual(o.texts.at(-1), { type: "killed", error: "this herdr-core cannot close terminals" });
	assert.equal(old.kills.length, 0);
});
