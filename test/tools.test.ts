import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Client } from "../src/protocol.ts";
import { createHerdrExtension, Herdr } from "../src/tools/herdr.ts";
import { Org, outline, parseHeading } from "../src/tools/org.ts";
import { ask, openTestDaemon, tempDir, testConfig, until } from "./helpers.ts";

const PROJECT = `#+TITLE: Portal
#+CATEGORY: portal

* PROG Fix duplicate webhook delivery :kit:
:PROPERTIES:
:ID: 1111-aaaa
:END:
** Scope
Prevent retries from applying the same delivery twice.

** Sessions
- [[herdr:kit/pi:01a1176c-3aa6-7717-a4c6-eaa0aa0a0833@w9:p1][pi@kit/2026-10-12T0910]]

* EVAL Review the selector change
Webhook docs need a look.

* TODO Fix duplicate webhook delivery
`;

async function orgFixture() {
	const tmp = await tempDir();
	const root = join(tmp.dir, "org");
	await mkdir(join(root, "work/studio/portal"), { recursive: true });
	await mkdir(join(root, "work/studio/archive"), { recursive: true });
	await writeFile(join(root, "work/studio/portal/portal.org"), PROJECT);
	await writeFile(join(root, "work/studio/archive.org"), "* DONE Old webhook work\n");
	await writeFile(join(tmp.dir, "secret.org"), "* TODO outside\n");
	return { ...tmp, root, org: new Org(root) };
}

test("headings parse with state, title, and tags", () => {
	assert.deepEqual(parseHeading("** AUTO Check mail :kit:", 3), { line: 3, level: 2, state: "AUTO", title: "Check mail", tags: ["kit"] });
	assert.deepEqual(parseHeading("* Plain [#A] heading", 1), { line: 1, level: 1, title: "Plain [#A] heading", tags: [] });
	assert.equal(parseHeading("not a heading", 1), undefined);
	const lines = PROJECT.split("\n");
	assert.deepEqual(outline(lines, 9).map((h) => h.title), ["Fix duplicate webhook delivery", "Scope"]);
});

test("org search groups matches by heading and skips archives", async (t) => {
	const { org, cleanup } = await orgFixture();
	t.after(cleanup);
	const results = await org.search("webhook", "all", 10);
	assert.deepEqual(
		results.map((r) => [r.file, r.heading, r.state]),
		[
			["work/studio/portal/portal.org", "Fix duplicate webhook delivery", "PROG"],
			["work/studio/portal/portal.org", "Review the selector change", "EVAL"],
			["work/studio/portal/portal.org", "Fix duplicate webhook delivery", "TODO"],
		],
	);
	assert.deepEqual(await org.search("no such words", "all", 10), []);
	const active = await org.tasks(["PROG", "EVAL"], "work", 10);
	assert.deepEqual(active.map((t) => t.state), ["PROG", "EVAL"]);
});

test("project discovery uses preambles, repository links, and task headings, archived ones too, best match first", async (t) => {
	const { org, root, cleanup } = await orgFixture();
	t.after(cleanup);
	const file = "work/studio/portal/portal.org";
	await writeFile(join(root, file), PROJECT.replace("#+CATEGORY: portal", "#+CATEGORY: portal\n\nRepositories:\n- secondary: [[https://github.com/elsewhere/secondary][GitHub]]"));
	await mkdir(join(root, "work/studio/portal/2026-10-26-notes"));
	await writeFile(join(root, "work/studio/portal/2026-10-26-notes/notes.org"), "#+TITLE: Not a project");
	await writeFile(join(root, "work/studio/client.org"), "#+TITLE: Client");
	await writeFile(join(root, "work/studio/archive/archive.org"), "#+TITLE: Old project");
	const all = await org.projects();
	assert.equal(all.total, 1);
	assert.equal(all.projects[0]!.file, file);
	assert.match(all.projects[0]!.preamble, /secondary/);
	assert.doesNotMatch(all.projects[0]!.preamble, /Fix duplicate/);
	assert.deepEqual(await org.projects("ELSEWHERE/secondary"), all);
	assert.deepEqual((await org.projects("webhook")).projects.map((p) => p.headings), [["Fix duplicate webhook delivery"]], "a topic finds the project by its headings");
	assert.deepEqual(await org.projects("retries"), { projects: [], total: 0 }, "task text is searched with org_search instead");
	assert.deepEqual(await org.projects("", 0), { projects: [], total: 1 });
	await mkdir(join(root, "work/studio/hooks"));
	await writeFile(join(root, "work/studio/hooks/hooks.org"), "#+TITLE: Hooks\n\n* TODO Tidy\n");
	await writeFile(join(root, "work/studio/hooks/archive.org"), "* DONE Retry webhook delivery\n* DONE Webhook signatures\n");
	assert.deepEqual(
		(await org.projects("webhook")).projects.map((p) => [p.file, p.headings]),
		[
			["work/studio/hooks/hooks.org", ["Retry webhook delivery (archived)", "Webhook signatures (archived)"]],
			[file, ["Fix duplicate webhook delivery"]],
		],
		"more history ranks first",
	);
	assert.equal((await org.projects("hooks webhook")).projects[0]!.file, "work/studio/hooks/hooks.org", "a name match outranks headings");
});

test("org read returns the subtree and its Herdr sessions without touching the file", async (t) => {
	const { org, root, cleanup } = await orgFixture();
	t.after(cleanup);
	const file = "work/studio/portal/portal.org";
	const before = await readFile(join(root, file), "utf8");
	const task = await org.read(file, "id:1111-aaaa");
	assert.equal(task.line, 4);
	assert.match(task.text, /^\* PROG Fix duplicate webhook delivery :kit:\n/);
	assert.doesNotMatch(task.text, /Review the selector/);
	assert.deepEqual(task.herdrSessions, [
		{ link: "herdr:kit/pi:01a1176c-3aa6-7717-a4c6-eaa0aa0a0833@w9:p1", host: "kit", agent: "pi", session: "01a1176c-3aa6-7717-a4c6-eaa0aa0a0833", pane: "w9:p1" },
	]);
	await assert.rejects(org.read(file, "Fix duplicate webhook delivery"), /matches 2 headings/);
	assert.equal((await org.read(file, "review the selector change")).line, 14);
	assert.deepEqual(await org.sessionTasks("01a1176c-3aa6-7717-a4c6-eaa0aa0a0833"), [
		{ file, line: 12, task: "Fix duplicate webhook delivery", state: "PROG" },
	]);
	assert.equal(await readFile(join(root, file), "utf8"), before);
});

test("org revisions cover full Unicode subtrees even when displayed text is truncated", async (t) => {
	const { org, root, cleanup } = await orgFixture();
	t.after(cleanup);
	const file = "work/studio/portal/portal.org";
	const text = `* AUTO Café 🌲\n:PROPERTIES:\n:ID: large-task\n:END:\n${"scope ".repeat(6000)}\n** Dialog\n- Jon: Keep waiting.\n`;
	await writeFile(join(root, file), text);
	const first = await org.read(file, "id:large-task");
	assert.match(first.revision, /^[0-9a-f]{64}$/);
	assert.match(first.text, /\[truncated; \d+ lines\]$/);
	assert.equal((await org.read(file, "id:large-task")).revision, first.revision);
	await writeFile(join(root, file), text.replace("Keep waiting.", "Lift this specific gate."));
	const second = await org.read(file, "id:large-task");
	assert.equal(second.text, first.text, "the changed Dialog is beyond the displayed slice");
	assert.notEqual(second.revision, first.revision, "the revision still detects its change");
});

test("org paths cannot leave the Org root", async (t) => {
	const { org, cleanup } = await orgFixture();
	t.after(cleanup);
	await assert.rejects(org.read("../secret.org", 1), /not an Org file under/);
	await assert.rejects(org.read("/etc/passwd", 1), /not an Org file under/);
});

const config = { host: "kit", hosts: { cog: {}, lux: {} }, allowPrompt: false };

/** An hc failure as the CLI reports it: nonzero exit with a JSON error on stderr. */
const hcError = (kind: string, message: string) =>
	Object.assign(new Error(`hc: ${message}`), { stderr: JSON.stringify({ error: { kind, message } }) });

test("herdr runs hc argv without a shell and summarizes agents from their labels", async () => {
	const calls: string[][] = [];
	const herdr = new Herdr(config, async (argv) => {
		calls.push([...argv]);
		if (argv[1] === "machine") return JSON.stringify({ machines: [{ name: "lux", state: "connected" }, { name: "cog", state: "needs_login" }] });
		if (argv.includes("ls")) return JSON.stringify({
			terminals: [
				{ address: "t2", agent: "pi", state: "live", status: "blocked", cwd: "/src/june", where: "june / 2" },
				{ address: "t3", agent: "zsh", state: "live", cwd: "/home" },
				{ address: "t4", agent: "claude-code", state: "live", cwd: "/src/x" },
				// June's own terminal client reports itself; she does not list herself.
				{ address: "t5", agent: "june", state: "live", status: "done", cwd: "/home" },
				{ address: "lux/t1", agent: "pi", state: "live", status: "idle", cwd: "/srv" },
			],
		});
		const address = argv[argv.indexOf("get") + 1];
		return JSON.stringify(address === "t2"
			? { address: "t2", state: "live", status: { state: "blocked" }, title: "π - june", foreground: { cwd: "/src/june/sub" },
				labels: { "org.agent": "pi", "org.session": "01a1176c-3aa6-7717-a4c6-eaa0aa0a0833", "org.task": "task-1" } }
			: { address, state: "live", status: null, labels: {} });
	});
	assert.deepEqual(await herdr.agents("kit"), [
		{
			host: "kit", terminal: "t2", agent: "pi", status: "blocked", where: "june / 2", cwd: "/src/june/sub",
			session: "01a1176c-3aa6-7717-a4c6-eaa0aa0a0833",
			herdrLink: "herdr:kit/pi:01a1176c-3aa6-7717-a4c6-eaa0aa0a0833@t2",
			task: "task-1", title: "π - june",
		},
		// A live agent that reports no status is unknown, never idle.
		{ host: "kit", terminal: "t4", agent: "claude", status: "unknown", cwd: "/src/x" },
	]);
	assert.deepEqual(calls[0], ["hc", "ls", "--json"]);
	// An added, connected machine is read natively through this core's hc, by its HOST/t address.
	calls.length = 0;
	const lux = await herdr.agents("lux");
	assert.deepEqual(lux.map((a) => [a.host, a.terminal, a.status]), [["lux", "t1", "idle"]]);
	assert.ok(calls.every((argv) => argv[0] === "hc"));
	assert.ok(calls.some((argv) => argv.join(" ") === "hc get lux/t1 --json"));
	// A machine this core cannot reach goes over SSH, with its own hc.
	calls.length = 0;
	await herdr.agents("cog");
	assert.deepEqual(calls.find((argv) => argv[0] === "ssh")!.slice(0, 8), ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "cog", "hc", "ls"]);
});

test("herdr finds a session's terminal by label and refuses ambiguity", async () => {
	let rows = [{ address: "t5", state: "live" }];
	const herdr = new Herdr(config, async (argv) => {
		if (argv.includes("ls")) {
			assert.deepEqual(argv, ["hc", "ls", "--json", "--label", "org.session=01a1176c-3aa6-7717-a4c6-eaa0aa0a0833"]);
			return JSON.stringify({ terminals: rows });
		}
		return JSON.stringify({ address: argv[2], state: "live", status: { state: "working" }, labels: {} });
	});
	assert.equal((await herdr.session("kit", "01a1176c-3aa6-7717-a4c6-eaa0aa0a0833"))?.address, "t5");
	rows = [];
	assert.equal(await herdr.session("kit", "01a1176c-3aa6-7717-a4c6-eaa0aa0a0833"), undefined);
	rows = [{ address: "t5", state: "live" }, { address: "t6", state: "live" }];
	await assert.rejects(herdr.session("kit", "01a1176c-3aa6-7717-a4c6-eaa0aa0a0833"), /runs in 2 terminals/);
});

test("herdr status is unknown without a report and undefined once the terminal is gone", async () => {
	let record: unknown = { address: "t1", state: "live", status: null };
	const herdr = new Herdr(config, async () => {
		if (record === undefined) throw hcError("not_found", "no terminal t1");
		return JSON.stringify(record);
	});
	assert.equal(await herdr.status("kit", "t1"), "unknown");
	record = { address: "t1", state: "live", status: { state: "done" } };
	assert.equal(await herdr.status("kit", "t1"), "done");
	record = { address: "t1", state: "finished", status: null };
	assert.equal(await herdr.status("kit", "t1"), undefined);
	record = undefined;
	assert.equal(await herdr.status("kit", "t1"), undefined);
});

test("herdr submits a follow-up as one local argument and propagates blocked errors without retrying", async () => {
	const calls: string[][] = [];
	let blocked = false;
	let app = "pi";
	const herdr = new Herdr(config, async (argv) => {
		calls.push([...argv]);
		if (argv[1] === "get") return JSON.stringify({ address: argv[2], state: "live", status: { state: "idle", app }, labels: {} });
		if (blocked) throw hcError("blocked", "t2 is blocked (permission)");
		return JSON.stringify({ started: true, status: "working", turn: 3 });
	});
	const text = "--leave deployment out\nKeep the user's helper; $(touch /tmp/nope)";
	assert.deepEqual(await herdr.prompt("t2", text), { started: true, status: "working", turn: 3 });
	assert.deepEqual(calls, [["hc", "get", "t2", "--json"], ["hc", "send", "t2", text, "--json"]]);
	blocked = true;
	await assert.rejects(herdr.prompt("t2", "continue"), /blocked.*permission/);
	assert.equal(calls.filter((argv) => argv[1] === "send").length, 2, "one attempt, no fallback to terminal keys");
	calls.length = 0;
	await assert.rejects(herdr.prompt("-bad-target", text), /Invalid hc terminal/);
	assert.equal(calls.length, 0, "invalid targets never reach hc");
	// June's own terminal client reports app june; she never types into it.
	app = "june";
	await assert.rejects(herdr.prompt("t2", "continue"), /June's own terminal client/);
	assert.ok(!calls.some((argv) => argv[1] === "send"));
});

test("the follow-up tool is optional, returns submission only, and lets June read the worker's response", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const cfg = testConfig(tmp.dir, { herdr: { ...config, allowPrompt: true } });
	const calls: string[][] = [];
	const herdr = new Herdr(cfg.herdr, async (argv) => {
		calls.push([...argv]);
		if (argv[1] === "get") return JSON.stringify({ address: "t2", state: "live", status: { state: "idle", app: "pi" }, labels: {} });
		return argv.includes("send") ? JSON.stringify({ started: true }) : "I'll leave deployment out.";
	});
	const extension = createHerdrExtension(cfg, herdr);
	assert.equal(createHerdrExtension({ ...cfg, herdr: config }, herdr).tools!.some((tool) => tool.name === "herdr_prompt_agent"), false);
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("herdr_prompt_agent", { target: "t2", text: "Leave deployment out." })], { stopReason: "toolUse" }),
		(ctx) => {
			assert.match(JSON.stringify(ctx.messages.at(-1)), /started/);
			return fauxAssistantMessage([fauxToolCall("herdr_read_agent", { target: "t2" })], { stopReason: "toolUse" });
		},
		(ctx) => {
			assert.match(JSON.stringify(ctx.messages.at(-1)), /leave deployment out/);
			return fauxAssistantMessage("The worker agreed to leave deployment out.");
		},
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config: cfg, extensions: [extension] });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "Tell the worker to leave deployment out.")).text, "The worker agreed to leave deployment out.");
	assert.equal(calls.filter((argv) => argv.includes("send")).length, 1);
	assert.equal(calls.filter((argv) => argv.includes("read")).length, 1);
});

test("an hc prompt interrupted after submission is not sent again on restart", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const cfg = testConfig(tmp.dir, { herdr: { ...config, allowPrompt: true } });
	let submissions = 0;
	const extension = () => createHerdrExtension(cfg, new Herdr(cfg.herdr, async (argv) => {
		if (argv[1] === "get") return JSON.stringify({ address: "t2", state: "live", status: { state: "idle", app: "pi" }, labels: {} });
		submissions++;
		await new Promise((resolve) => setTimeout(resolve, 100));
		throw new Error("hc connection lost after submission");
	}));
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxToolCall("herdr_prompt_agent", { target: "t2", text: "Leave deployment out." })], { stopReason: "toolUse" })]);
	let daemon = await openTestDaemon({ ...tmp, faux, config: cfg, extensions: [extension()] });
	t.after(() => daemon.close());
	const client = await Client.open(tmp.paths.socket);
	t.after(() => client.close());
	await client.request({ op: "submit", requestId: "proxy", text: "Tell the worker to leave deployment out.", source: "kitty" });
	await until(() => submissions === 1);
	await daemon.close();
	client.close();
	const next = fauxProvider();
	next.setResponses([(ctx) => {
		assert.match(JSON.stringify(ctx.messages.at(-1)), /interrupted/i);
		return fauxAssistantMessage("Delivery is uncertain; I'll inspect the worker before retrying.");
	}]);
	daemon = await openTestDaemon({ ...tmp, faux: next, config: cfg, extensions: [extension()] });
	assert.match((await ask(tmp.paths.socket, "Tell the worker to leave deployment out.", "proxy", "kitty")).text!, /inspect the worker/);
	assert.equal(submissions, 1);
});

test("herdr rejects bad targets, unknown hosts, and reports hc errors", async () => {
	const herdr = new Herdr(config, async (argv) => {
		if (argv[1] === "machine") return JSON.stringify({ machines: [] });
		throw hcError("unavailable", "no core is running");
	});
	await assert.rejects(herdr.agents("kit"), /hc on kit: unavailable: no core is running/);
	await assert.rejects(herdr.read("kit", "t1; rm -rf ~", 10), /Invalid hc terminal/);
	await assert.rejects(herdr.agents("nowhere"), /Unknown host/);
});
