import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { promptFiles } from "../src/config.ts";
import { Client } from "../src/protocol.ts";
import { createCodingExtension } from "../src/tools/coding.ts";
import { ask, openTestDaemon, tempDir, until } from "./helpers.ts";

const last = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.at(-1));
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const prompt = (ctx: TranscriptContext) => JSON.stringify(Object.assign({}, ...ctx.messages.filter((m) => m.role === "system").map((m) => m.sections)));
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("June runs a host check herself and reads and edits a file, with failures reported", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const file = join(tmp.dir, "notes.txt");
	await writeFile(file, "alpha\nbeta\n");
	const faux = fauxProvider();
	faux.setResponses([
		call("bash", { command: "hostname; pwd" }),
		(ctx) => {
			assert.ok(last(ctx).includes(process.env.HOME!), "commands start in the home directory");
			return call("read", { path: file });
		},
		(ctx) => {
			assert.match(last(ctx), /alpha/);
			return call("edit", { path: file, edits: [{ oldText: "beta", newText: "gamma" }] });
		},
		// A second edit from the same, now stale, reading fails instead of overwriting.
		() => call("edit", { path: file, edits: [{ oldText: "beta", newText: "delta" }] }),
		(ctx) => {
			assert.match(last(ctx), /"isError":true/);
			return call("bash", { command: "echo oops >&2; exit 3" });
		},
		(ctx) => {
			assert.match(last(ctx), /oops/);
			assert.match(last(ctx), /exited with code 3/);
			return call("bash", { command: "sleep 5", timeout: 0.2 });
		},
		(ctx) => {
			assert.match(last(ctx), /timed out after 0.2 seconds/);
			return fauxAssistantMessage("Checked.");
		},
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	const answer = await ask(tmp.paths.socket, "check the host and fix my notes");
	assert.equal(answer.text, "Checked.");
	assert.equal(await readFile(file, "utf8"), "alpha\ngamma\n");
	assert.deepEqual((await daemon.status()).tools.filter((n) => ["bash", "read", "edit", "write"].includes(n)).sort(), ["bash", "edit", "read", "write"]);
});

test("/stop kills a running command, and a restart reports an interrupted one instead of running it again", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const pidFile = join(tmp.dir, "pid");
	const log = join(tmp.dir, "log");
	const done = join(tmp.dir, "done");
	const slow = (tag: string) => `echo $$ > ${pidFile}; echo ${tag} >> ${log}; sleep 30; touch ${done}`;
	const faux = fauxProvider();
	faux.setResponses([call("bash", { command: slow("stop") }), fauxAssistantMessage("Stopped it.")]);
	let daemon = await openTestDaemon({ ...tmp, faux, extensions: [createCodingExtension()] });
	const client = await Client.open(tmp.paths.socket);
	await client.request({ op: "submit", requestId: "a", text: "run it", source: "kitty" });
	await until(() => existsSync(pidFile));
	const first = Number(await readFile(pidFile, "utf8"));
	await client.request({ op: "command", requestId: "s", name: "stop" });
	await until(() => !alive(first));
	await until(async () => !(await daemon.status()).busy);

	faux.setResponses([call("bash", { command: slow("restart") })]);
	await client.request({ op: "submit", requestId: "b", text: "run it again", source: "kitty" });
	await until(async () => (await readFile(log, "utf8").catch(() => "")).includes("restart"));
	const second = Number(await readFile(pidFile, "utf8"));
	await daemon.close();
	client.close();
	await until(() => !alive(second));

	const next = fauxProvider();
	next.setResponses([
		(ctx) => {
			assert.match(last(ctx), /interrupted/i);
			return fauxAssistantMessage("It was interrupted; I'll check before rerunning.");
		},
	]);
	daemon = await openTestDaemon({ ...tmp, faux: next, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	const resumed = await ask(tmp.paths.socket, "run it again", "b", "kitty");
	assert.equal(resumed.text, "It was interrupted; I'll check before rerunning.");
	assert.equal(await readFile(log, "utf8"), "stop\nrestart\n", "neither command ran twice");
	assert.equal(existsSync(done), false, "neither command finished");
});

test("June remembers, corrects, and keeps her memory across a restart", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const personal = join(tmp.dir, "personal");
	await mkdir(personal);
	await writeFile(join(personal, "SOUL.org"), "* June\nYou are June.");
	const memory = join(personal, "MEMORY.org");
	const dirs = { ...tmp.paths, data: personal };
	const open = (faux: ReturnType<typeof fauxProvider>) =>
		openTestDaemon({ ...tmp, paths: dirs, faux, config: promptFiles(dirs), extensions: [createCodingExtension()] });

	const faux = fauxProvider();
	faux.setResponses([
		(ctx) => {
			assert.ok(prompt(ctx).includes(memory));
			return call("write", { path: memory, content: "* Preferences\n- Jon said: briefings at 8:00.\n" });
		},
		fauxAssistantMessage("Noted."),
		(ctx) => {
			assert.match(prompt(ctx), /briefings at 8:00/, "the edit is in the prompt on the next turn without /reload");
			return call("edit", { path: memory, edits: [{ oldText: "briefings at 8:00", newText: "briefings at 7:30 (corrected 2026-10-26)" }] });
		},
		fauxAssistantMessage("Corrected."),
	]);
	let daemon = await open(faux);
	assert.equal((await ask(tmp.paths.socket, "brief me at 8")).text, "Noted.");
	assert.equal((await ask(tmp.paths.socket, "actually 7:30")).text, "Corrected.");
	await daemon.close();

	const next = fauxProvider();
	next.setResponses([
		(ctx) => {
			assert.match(prompt(ctx), /briefings at 7:30 \(corrected 2026-10-26\)/);
			assert.doesNotMatch(prompt(ctx), /8:00/);
			return fauxAssistantMessage("7:30.");
		},
	]);
	daemon = await open(next);
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "when is my briefing?")).text, "7:30.");
});
