import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Dispatch, insertAfterPreamble, taskBody } from "../src/tools/dispatch.ts";
import { Herdr } from "../src/tools/herdr.ts";
import { Org } from "../src/tools/org.ts";
import { tempDir, testConfig } from "./helpers.ts";

const PROJECT = `#+TITLE: Portal
#+CATEGORY: portal

Repositories:
- portal: [[file:~/src/studio/portal/][local]]

* PROG Existing thread
Body.
`;

async function fixture() {
	const tmp = await tempDir();
	const root = join(tmp.dir, "org");
	const project = join(root, "work/studio/portal/portal.org");
	await mkdir(join(root, "work/studio/portal"), { recursive: true });
	await writeFile(project, PROJECT);
	await writeFile(join(root, "asana.org"), "* TODO mirrored\n");
	await writeFile(join(root, "other.org"), "* TODO not on the agenda\n");
	const agenda = join(tmp.dir, "agenda");
	await writeFile(agenda, `${project}\n${join(root, "asana.org")}\n`);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: agenda }, dispatch: { hosts: ["kit", "cog"] } };
	const runs: string[][] = [];
	const dispatch = new Dispatch(new Org(root), config, async (argv) => {
		runs.push([...argv]);
		if (argv[0] === "org-edit") return JSON.stringify({ id: "resume123", title: "Existing thread", host: "kit", written: true });
		return "Queued task\t~/src/studio/portal\tsettling\n";
	});
	return { ...tmp, root, project, dispatch, runs, config };
}

const request = { file: "work/studio/portal/portal.org", title: "Investigate the flaky login test", host: "kit", review: true, key: "inst:7" };
const body = "June queued this because Jon asked for it.\n\n** Scope\nFind why login fails one run in ten.";

test("a queued task is a new first heading with one host tag, written once per key", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const first = await f.dispatch.queue({ ...request, body });
	assert.equal(first.written, true);
	const again = await f.dispatch.queue({ ...request, body });
	assert.equal(again.written, false, "a replay finds the heading it wrote");
	assert.equal(again.id, first.id);
	const text = await readFile(f.project, "utf8");
	assert.equal(text.match(/^\* AUTO /gm)?.length, 1);
	assert.match(
		text,
		/Repositories:\n- portal: \[\[file:~\/src\/studio\/portal\/\]\[local\]\]\n\n\* AUTO Investigate the flaky login test :kit:\n:PROPERTIES:\n:ID: [0-9a-f-]{36}\n:JUNE_REQUEST: inst:7\n:END:\nJune queued this because Jon asked for it.\n\n\*\* Scope\nFind why login fails one run in ten.\n\n\* PROG Existing thread\n/,
	);
});

test("queueing refuses files and requests the dispatcher should not get", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await assert.rejects(f.dispatch.queue({ ...request, body, file: "asana.org" }), /does not write asana.org/);
	await assert.rejects(f.dispatch.queue({ ...request, body, file: "other.org" }), /not an agenda file/);
	await assert.rejects(f.dispatch.queue({ ...request, body, host: "lux" }), /only for kit, cog/);
	await assert.rejects(f.dispatch.queue({ ...request, body: "* Sneaky\nsplit" }), /first-level heading/);
	await assert.rejects(f.dispatch.queue({ ...request, body, title: "Fix it :cog:" }), /keyword or tags/);
	await writeFile(join(f.root, "work/studio/portal/portal.sync-conflict-20261025-ABC.org"), "");
	await assert.rejects(f.dispatch.queue({ ...request, body }), /conflict copy/);
	assert.equal(await readFile(f.project, "utf8"), PROJECT);
});

test("resume uses the shared org-edit command with an expected state and request key", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await writeFile(f.project, PROJECT.replace("* PROG Existing thread", "* HOLD Existing thread"));
	const herdr = new Herdr(f.config.herdr, async () => "{}");
	const result = await f.dispatch.resume({ file: request.file, heading: "Existing thread", expected: "HOLD", host: "kit", note: "Jon chose option A.", key: "inst:8" }, herdr);
	assert.equal(result.id, "resume123");
	assert.deepEqual(f.runs.at(-1), ["org-edit", "todo", f.project, "Existing thread", "AUTO", "--expect", "HOLD", "--request", "inst:8", "--host", "kit", "--note", "Jon chose option A."]);
	assert.equal((await readFile(f.project, "utf8")).match(/^\* /gm)?.length, 1, "no duplicate heading written by June");
	await assert.rejects(f.dispatch.resume({ file: request.file, heading: "Existing thread", expected: "TODO", host: "lux", note: "Jon asked.", key: "inst:9" }, herdr), /No allowed dispatcher/);
	await assert.rejects(f.dispatch.resume({ file: "asana.org", heading: "mirrored", expected: "TODO", host: "kit", note: "Jon asked.", key: "inst:9" }, herdr), /does not write/);
});

test("resume refuses a working or blocked linked agent, but allows idle and a replay", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const session = "12345678-abcd-abcd-abcd-123456789abc";
	await writeFile(f.project, `* HOLD Existing thread\n:PROPERTIES:\n:ID: resume123\n:END:\n\n** Sessions\n- [[herdr:kit/pi:${session}@w1:p1][worker]]\n`);
	const resume = { file: request.file, heading: "id:resume123", expected: "HOLD" as const, host: "kit", note: "Jon answered.", key: "inst:8" };
	let status = "working";
	const herdr = new Herdr(f.config.herdr, async (args) => args.includes("agent")
		? JSON.stringify({ result: { agents: [{ agent: "pi", agent_status: status, pane_id: "w1:p1", agent_session: { value: `${session}.jsonl` } }] } })
		: "{}");
	await assert.rejects(f.dispatch.resume(resume, herdr), /active agent/);
	status = "blocked";
	await assert.rejects(f.dispatch.resume(resume, herdr), /active agent/);
	assert.equal(f.runs.length, 0, "no edit while an agent needs attention");
	status = "idle";
	await f.dispatch.resume(resume, herdr);
	assert.equal(f.runs.length, 1);
	status = "working";
	await writeFile(f.project, (await readFile(f.project, "utf8")).replace(":ID: resume123", ":ID: resume123\n:JUNE_REQUEST: inst:8"));
	await f.dispatch.resume(resume, herdr);
	assert.equal(f.runs.length, 2, "a replay still reaches org-edit to recover its saved result");
});

test("the nudge starts the dispatcher unit and reports its scan", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	assert.match(await f.dispatch.nudge(), /settling/);
	assert.deepEqual(f.runs[0], ["systemctl", "--user", "start", "org-dispatch.service"]);
	await f.dispatch.kick();
	assert.deepEqual(f.runs.at(-1), ["systemctl", "--user", "start", "--no-block", "org-dispatch.service"], "queueing does not wait for the launch");
});

test("the body always has the same shape, whatever the model sends", () => {
	assert.equal(
		taskBody({ reason: "Jon asked for a docs check.", scope: "Check the docs.\n\n\n\nReport only.", checklist: ["Compare docs", "- [ ] Report findings", "- Leave files alone"] }),
		"Queued by June: Jon asked for a docs check.\n\n** Scope\nCheck the docs.\n\nReport only.\n\n** Checklist\n- [ ] Compare docs\n- [ ] Report findings\n- [ ] Leave files alone",
	);
	assert.throws(() => taskBody({ reason: "two\nlines", scope: "x", checklist: ["a"] }), /reason is one non-empty line/);
	assert.throws(() => taskBody({ reason: "r", scope: "x", checklist: [] }), /at least one item/);
});

test("queueing refuses a working directory that does not exist", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await assert.rejects(f.dispatch.queue({ ...request, body, dir: join(f.dir, "nope") }), /not a directory/);
	assert.equal((await f.dispatch.queue({ ...request, body, dir: f.dir })).written, true);
});

test("insertion keeps a file without headings and one that starts with a heading valid", () => {
	assert.equal(insertAfterPreamble("#+TITLE: X\n", "* AUTO A :kit:\n"), "#+TITLE: X\n\n* AUTO A :kit:\n");
	assert.equal(insertAfterPreamble("* TODO B\n", "* AUTO A :kit:\n"), "* AUTO A :kit:\n\n* TODO B\n");
});

const hasDispatcher = (() => {
	try {
		execFileSync("sh", ["-c", "command -v org-dispatch"]);
		return true;
	} catch {
		return false;
	}
})();

test("org-dispatch itself sees the task June wrote", { skip: !hasDispatcher && "org-dispatch is not installed" }, async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await f.dispatch.queue({ ...request, body });
	const out = execFileSync("org-dispatch", ["scan"], {
		encoding: "utf8",
		env: {
			...process.env,
			ORG_DISPATCH_HOST: "kit",
			ORG_DISPATCH_ROOT: join(f.root, "work"),
			ORG_DISPATCH_EMACS_INIT: join(f.dir, "no-init.el"),
			XDG_STATE_HOME: join(f.dir, "state"),
		},
	});
	assert.match(out, /^Investigate the flaky login test\t.*\tnew$/m, "June's complete request skips settling");
});
