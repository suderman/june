import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Herdr } from "../src/tools/herdr.ts";
import { Org, outline, parseHeading } from "../src/tools/org.ts";
import { tempDir } from "./helpers.ts";

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

test("org paths cannot leave the Org root", async (t) => {
	const { org, cleanup } = await orgFixture();
	t.after(cleanup);
	await assert.rejects(org.read("../secret.org", 1), /not an Org file under/);
	await assert.rejects(org.read("/etc/passwd", 1), /not an Org file under/);
});

const config = { session: "default", host: "kit", hosts: { cog: {} }, allowPrompt: false };

test("herdr runs argv without a shell and summarizes agents", async () => {
	const calls: string[][] = [];
	const herdr = new Herdr(config, async (argv) => {
		calls.push([...argv]);
		if (argv.includes("workspace")) return JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "[1] june" }] } });
		return JSON.stringify({
			result: {
				agents: [
					{
						agent: "pi",
						agent_status: "blocked",
						pane_id: "w1:p2",
						workspace_id: "w1",
						cwd: "/src/june",
						agent_session: { value: "/x/2026_01a1176c-3aa6-7717-a4c6-eaa0aa0a0833.jsonl" },
					},
				],
			},
		});
	});
	assert.deepEqual(await herdr.agents("kit"), [
		{
			host: "kit",
			pane: "w1:p2",
			agent: "pi",
			status: "blocked",
			workspace: "[1] june",
			cwd: "/src/june",
			session: "01a1176c-3aa6-7717-a4c6-eaa0aa0a0833",
			herdrLink: "herdr:kit/pi:01a1176c-3aa6-7717-a4c6-eaa0aa0a0833",
			focused: false,
		},
	]);
	assert.deepEqual(calls[0], ["herdr", "--session", "default", "agent", "list"]);
	await herdr.agents("cog");
	assert.deepEqual(calls[2]!.slice(0, 6), ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "cog"]);
});

test("herdr rejects bad targets, unknown hosts, and reports Herdr errors", async () => {
	const herdr = new Herdr(config, async () =>
		JSON.stringify({ error: { code: "server_not_running", message: "no herdr server" } }),
	);
	await assert.rejects(herdr.agents("kit"), /server_not_running/);
	await assert.rejects(herdr.read("kit", "w1:p1; rm -rf ~", 10), /Invalid Herdr target/);
	await assert.rejects(herdr.agents("nowhere"), /Unknown host/);
});
