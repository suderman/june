import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { defineExtension } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createDispatchExtension, improveBody } from "../src/tools/dispatch.ts";
import { createFollowTask, decide, follow, FOLLOW_DEFAULTS, progressDue } from "../src/tools/follow.ts";
import { Herdr } from "../src/tools/herdr.ts";
import { createOrgExtension, Org } from "../src/tools/org.ts";
import { ask, openTestDaemon, tempDir, testConfig, until } from "./helpers.ts";

const input = { id: "abc12345", title: "Check docs", host: "kit", queuedAt: 0 };
const min = 60_000;

// Readers see either the old fixture or the new one, never writeFile's truncation gap.
async function replaceFile(file: string, text: string): Promise<void> {
	await writeFile(`${file}.tmp`, text);
	await rename(`${file}.tmp`, file);
}

test("follow reports each transition once and stays quiet otherwise", () => {
	const at = (state: string, last: string, now = 3 * min, agent?: string) =>
		decide(input, { state, missing: false, file: "todo.org", ...(agent ? { agent } : {}) }, last, now, FOLLOW_DEFAULTS);
	assert.equal(at("AUTO", "AUTO").say, undefined, "settling is silent");
	assert.match(at("AUTO", "AUTO", 8 * min).say ?? "", /has not launched 8 minutes/);
	assert.equal(at("AUTO", "stalled", 9 * min).say, undefined, "a stall is reported once");
	assert.equal(at("PROG", "AUTO").say, undefined, "working is silent");
	assert.match(at("PROG", "PROG", 3 * min, "blocked").say ?? "", /blocked, waiting for a person/);
	assert.equal(at("PROG", "blocked", 3 * min, "blocked").signal, "blocked", "still blocked is the same signal");
	assert.equal(at("HOLD", "PROG").done, false);
	assert.deepEqual([at("EVAL", "PROG").done, at("EVAL", "PROG").signal], [true, "EVAL"]);
	assert.deepEqual([at("TODO", "PROG").done, at("TODO", "PROG").say], [true, undefined], "taken back is silent");
	const gone = decide(input, { state: undefined, missing: true }, "PROG", min, FOLLOW_DEFAULTS);
	assert.equal(gone.done, true);
	assert.equal(decide(input, { state: "PROG", missing: false }, "PROG", 8 * 24 * 60 * min, FOLLOW_DEFAULTS).done, true, "follows expire");
});

test("a task scheduled ahead is followed quietly until its start, then on the usual launch clock", () => {
	const day = 24 * 60 * min;
	const at = (scheduledAt: number | undefined, now: number, last = "AUTO") =>
		decide(input, { state: "AUTO", missing: false, ...(scheduledAt !== undefined ? { scheduledAt } : {}) }, last, now, FOLLOW_DEFAULTS);
	assert.deepEqual([at(10 * day, 8 * min).signal, at(10 * day, 8 * min).say], ["scheduled", undefined], "held by SCHEDULED is not a stall");
	assert.equal(at(10 * day, 9 * day).done, false, "a start beyond the follow's lifetime does not expire it early");
	assert.equal(at(10 * day, 10 * day + 3 * min).say, undefined, "settling after the start is silent");
	assert.match(at(10 * day, 10 * day + 8 * min).say ?? "", /has not launched 8 minutes after its scheduled start/);
	assert.match(at(-day, 8 * min).say ?? "", /has not launched 8 minutes after queueing/, "a SCHEDULED already past when queued changes nothing");
	assert.equal(at(10 * day, 18 * day).done, true, "the follow still expires, counted from the start");
});

test("Org reads a task's SCHEDULED start as Calgary time", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	await mkdir(root);
	await writeFile(join(root, "todo.org"), "* AUTO Later\nSCHEDULED: <2026-11-07 Sat 09:30>\n:PROPERTIES:\n:ID: aaaaaaaa-0000-4000-8000-000000000001\n:END:\n* AUTO Summer\nDEADLINE: <2026-07-02 Thu> SCHEDULED: <2026-07-01 Wed>\n:PROPERTIES:\n:ID: aaaaaaaa-0000-4000-8000-000000000002\n:END:\n* AUTO Now\n:PROPERTIES:\n:ID: aaaaaaaa-0000-4000-8000-000000000003\n:END:\n** Child\nSCHEDULED: <2026-11-08 Sun>\n* AUTO Winter\nSCHEDULED: <2026-01-15 Thu 09:30>\n:PROPERTIES:\n:ID: aaaaaaaa-0000-4000-8000-000000000004\n:END:\n");
	const org = new Org(root);
	assert.equal((await org.byId("aaaaaaaa-0000-4000-8000-000000000001"))?.scheduledAt, Date.UTC(2026, 10, 7, 15, 30), "after Alberta's 2026 change, 09:30 stays UTC-6");
	assert.equal((await org.byId("aaaaaaaa-0000-4000-8000-000000000002"))?.scheduledAt, Date.UTC(2026, 6, 1, 6), "a date alone is midnight MDT");
	assert.equal((await org.byId("aaaaaaaa-0000-4000-8000-000000000003"))?.scheduledAt, undefined, "a child's date is not the task's");
	assert.equal((await org.byId("aaaaaaaa-0000-4000-8000-000000000004"))?.scheduledAt, Date.UTC(2026, 0, 15, 16, 30), "09:30 MST before the change is 16:30 UTC");
});

test("org_queue_task with scheduled writes the date with the task, does not start the dispatcher, and reports no stall before it", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "todo.org");
	await mkdir(root, { recursive: true });
	await writeFile(file, "#+TITLE: Todo\n");
	await writeFile(join(tmp.dir, "agenda"), `${file}\n`);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: join(tmp.dir, "agenda"), people: join(root, "people.org") }, dispatch: { hosts: ["kit"] } };
	const runs: string[][] = [];
	const extension = createDispatchExtension(config, new Org(root), new Herdr(config.herdr, async () => "{}"), "inst", async (args) => {
		runs.push([...args]);
		return args[0] === "org-edit" && args[1] === "date" ? "<2036-12-31 Wed 09:30>\n" : "";
	}, { intervalMs: 40, launchMs: 200, maxMs: 3_600_000 });
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("org_queue_task", { file: "todo.org", title: "Check docs", reason: "Alex asked.", scope: "Check docs.", checklist: ["Compare"], host: "kit", scheduled: "2036-12-31 9:30" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Queued for later."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, extensions: [extension] });
	t.after(() => daemon.close());
	await ask(tmp.paths.socket, "queue it for the 31st");
	assert.match(await readFile(file, "utf8"), /^\* AUTO Check docs\nSCHEDULED: <2036-12-31 Wed 09:30>\n:PROPERTIES:\n/m);
	assert.deepEqual(runs, [["org-edit", "date", "2036-12-31 9:30"]], "nothing starts the dispatcher for a task it would only skip");
	assert.match(JSON.stringify((await daemon.root.context(BG)).entries), /SCHEDULED for <2036-12-31 Wed 09:30>, Calgary time/, "the tool result tells June when it starts");
	await new Promise((r) => setTimeout(r, 600));
	assert.equal((await daemon.root.context(BG)).entries.filter((e) => (e.data as { source?: string })?.source === "follow").length, 0, "no stall report while it waits");
	assert.equal((await daemon.harness.inspect(BG)).tasks.filter((task) => task.record.kind === "june.follow").length, 1, "it is followed");
});

test("follow carries only the worker's own headline, verbatim in the model input and notice data", async (t) => {
	const session = "01234567-89ab-cdef-0123-456789abcdef";
	for (const [state, headline, agent, byHeading] of [
		["EVAL", "I checked it. Docs match!", "pi", false],
		["HOLD", "I'm stuck. Which copy do I keep?", "claude", false],
		["DONE", "Fixed it, checks pass. Your turn!", undefined, true],
		["EVAL", undefined, "pi", false],
		["PROG", "Old line, not a blocked-agent report.", "pi", false],
	] as const) {
		await t.test(`${state}, ${headline ? "headline" : "legacy"}${byHeading ? ", by heading" : ""}`, async (t) => {
			const tmp = await tempDir();
			t.after(tmp.cleanup);
			const root = join(tmp.dir, "org");
			await mkdir(root);
			const links = agent ? `** Sessions\n- [[herdr:kit/pi:${session}@p1][old pane]]\n- [[herdr:kit/${agent}:${session}][current, no pane]]\n- [[herdr:cog/pi:${session}@p2][other host]]\n` : "";
			await writeFile(join(root, "todo.org"), `* ${state} Check docs\nCLOSED: [2026-11-05 Thu 14:00]\n:PROPERTIES:\n${byHeading ? "" : `:ID: ${input.id}\n`}${headline ? `:HEADLINE: ${headline}\n:HEADLINE_STATE: ${state}\n:HEADLINE_AT: 101\n` : ""}:END:\n:LOGBOOK:\n- Old run\n  :HEADLINE: Not this old line.\n:END:\n\n${links}** Outcome\nThe report's evidence.\n*** Child task\n:PROPERTIES:\n:HEADLINE: Not this child's line.\n:END:\n`);
			const task = createFollowTask(new Org(root), new Herdr(testConfig(tmp.dir).herdr, async () => JSON.stringify({ result: { agent: { agent_status: "blocked" } } })), { intervalMs: 40, launchMs: 60_000, maxMs: 3_600_000 });
			const adopted = { ...input, queuedAt: Date.now(), ...(byHeading ? { file: "todo.org" } : {}) };
			const signal = state === "PROG" ? "blocked" : state;
			const news = headline && state !== "PROG" ? { title: input.title, signal, headline, ...(agent ? { agent, session } : {}) } : undefined;
			let heard: string | undefined;
			const faux = fauxProvider();
			faux.setResponses([(ctx) => {
				const last = ctx.messages.findLast((message) => message.role === "user")!;
				heard = typeof last.content === "string" ? last.content : last.content.filter((block) => block.type === "text").map((block) => block.text).join("");
				return fauxAssistantMessage("Heard the worker.");
			}]);
			const daemon = await openTestDaemon({ ...tmp, faux, extensions: [defineExtension({ name: "follow-headline-test", tasks: [task] })] });
			t.after(() => daemon.close());
			const say = decide(adopted, { state, missing: false, file: "todo.org", agent: "blocked" }, "AUTO", Date.now(), FOLLOW_DEFAULTS).say!;
			const label = say + (news ? `\nWorker headline${agent ? ` (${agent})` : ""}: ${headline}` : "");
			await daemon.harness.commit((tx) => follow(tx, task, adopted, Number(daemon.root.id)), BG);
			const reports = async () => (await daemon.root.context(BG)).entries.filter((entry) => entry.kind === "june.input" && (entry.data as { source?: string })?.source === "follow");
			await until(async () => (await reports()).length === 1 && faux.state.callCount === 1 && !(await daemon.status()).busy);
			assert.equal(heard, `[follow] ${label}`);
			assert.deepEqual((await reports())[0]!.data, { source: "follow", text: label, surface: "gui", ...(news ? { follow: news } : {}) });
		});
	}
});

test("a manually started worker finishes through org-edit and June hears its exact headline", async (t) => {
	const tmp = await tempDir();
	const root = join(tmp.dir, "org");
	await mkdir(root);
	const file = join(root, "manual.org");
	const id = "manual-task-0001";
	const session = "01234567-89ab-cdef-0123-456789abcdef";
	const headline = "I checked it.  Docs match!";
	await writeFile(file, `* PROG Manual check\n:PROPERTIES:\n:ID: ${id}\n:REVIEW: yes\n:DEPLOY: no\n:END:\n\n** Outcome\nChecked the docs against the source. They match.\n\n** Sessions\n- [[herdr:kit/claude:${session}][worker Jon started]]\n`);
	const org = new Org(root);
	const task = createFollowTask(org, new Herdr(testConfig(tmp.dir).herdr, async () => { throw new Error("No pane needed to report a completed worker"); }), { intervalMs: 40, launchMs: 60_000, maxMs: 3_600_000 });
	let heard = "";
	const faux = fauxProvider();
	faux.setResponses([(ctx) => { heard = JSON.stringify(ctx.messages.at(-1)); return fauxAssistantMessage("The docs match."); }]);
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [defineExtension({ name: "manual-headline-test", tasks: [task] })] });
	t.after(async () => { await daemon.close(); await tmp.cleanup(); });
	await daemon.harness.commit((tx) => follow(tx, task, { id, title: "Manual check", host: "kit", queuedAt: Date.now() }, Number(daemon.root.id)), BG);
	const at = Date.now() / 1000;
	const script = join(import.meta.dirname, "../org/edit/org-edit");
	const output = execFileSync("bash", [script, "todo", file, `id:${id}`, "EVAL", "--expect", "PROG", "--headline", headline], {
		encoding: "utf8",
		env: { ...process.env, ORG_EDIT_EL: join(import.meta.dirname, "../org/edit/org-edit.el"), ORG_DISPATCH_EL: join(import.meta.dirname, "../org/dispatch/org-dispatch.el") },
	});
	assert.match(output, /EVAL Manual check/);
	const finished = await org.byId(id);
	assert.equal(finished?.headline, headline);
	assert.ok(finished!.headlineAt! >= at);
	await until(async () => heard.includes(headline) && !(await daemon.status()).busy);
	const report = (await daemon.root.context(BG)).entries.find((entry) => entry.kind === "june.input" && (entry.data as { source?: string })?.source === "follow")!;
	assert.deepEqual((report.data as { follow: unknown }).follow, { title: "Manual check", signal: "EVAL", headline, agent: "claude", session });
	assert.match(await readFile(file, "utf8"), /:REVIEW: yes\n:DEPLOY: no/);
});

test("a task waiting on a prerequisite is silent, and its launch clock starts once it is ready", () => {
	const planned = { ...input, depends: ["pre12345"] };
	const seen = (waiting: boolean) => ({ state: "AUTO", missing: false, ...(waiting ? { waiting } : {}) });
	assert.deepEqual(decide(planned, seen(true), "AUTO", 60 * min, FOLLOW_DEFAULTS), { signal: "waiting", done: false, say: undefined });
	assert.equal(decide(planned, seen(false), "waiting", 62 * min, FOLLOW_DEFAULTS, 60 * min).say, undefined, "just ready is not stalled");
	assert.match(decide(planned, seen(false), "waiting", 68 * min, FOLLOW_DEFAULTS, 60 * min).say ?? "", /has not launched 8 minutes after its prerequisites finished/);
	const expired = decide(planned, seen(true), "waiting", 8 * 24 * 60 * min, FOLLOW_DEFAULTS);
	assert.equal(expired.done, true);
	assert.match(expired.say ?? "", /stopped following .* after 7 days; it is still AUTO, waiting on a prerequisite/);
	assert.equal(decide(input, seen(false), "AUTO", 8 * 24 * 60 * min, FOLLOW_DEFAULTS).say, undefined, "a lone task still expires quietly");
});

test("June queues a plan, follows every task, and closing the first after review lets the next start", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "work/studio/portal/portal.org");
	await mkdir(join(root, "work/studio/portal"), { recursive: true });
	await writeFile(file, "#+TITLE: Portal\n");
	await writeFile(join(tmp.dir, "agenda"), `${file}\n`);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: join(tmp.dir, "agenda"), people: join(root, "people.org") }, dispatch: { hosts: ["kit"] } };
	const runs: string[][] = [];
	let spec: { key: string; title: string; file: string; tasks: { key: string; title: string; body: string; host: string; agent: string; depends?: string[] }[] } | undefined;
	const ids: Record<string, string> = { api: "aaaaaaaa-0000-5000-a000-000000000001", site: "aaaaaaaa-0000-5000-a000-000000000002" };
	// Stands in for org-dispatch plan and org-edit, writing what they write.
	const extension = createDispatchExtension(config, new Org(root), new Herdr(config.herdr, async () => "{}"), "inst", async (args) => {
		runs.push([...args]);
		if (args[0] === "org-dispatch" && args[1] === "plan") {
			spec = JSON.parse(await readFile(args[2]!, "utf8"));
			const text = spec!.tasks.map((task) => [
				`* AUTO ${task.title}`, ":PROPERTIES:", `:ID: ${ids[task.key]}`, `:HOST: ${task.host}`, `:AGENT: ${task.agent}`, `:PLAN_REQUEST: ${spec!.key}`,
				...(task.depends ? [`:DEPENDS: ${task.depends.map((key) => `id:${ids[key]}`).join(" ")}`] : []), ":END:", task.body, "",
			].join("\n")).join("\n");
			await replaceFile(file, `#+TITLE: Portal\n\n* ${spec!.title}\n\n${text}`);
			return JSON.stringify(spec!.tasks.map((task) => ({ id: ids[task.key], file })));
		}
		if (args[0] === "org-edit") {
			const id = args[3]!.replace(/^id:/, "");
			const name = Object.keys(ids).find((key) => ids[key] === id)!;
			const title = spec!.tasks.find((task) => task.key === name)!.title;
			await replaceFile(file, (await readFile(file, "utf8")).replace(`* EVAL ${title}`, `* DONE ${title}`));
		}
		return "";
	}, { intervalMs: 40, launchMs: 300, maxMs: 3_600_000 });
	const faux = fauxProvider();
	const plan = {
		title: "Portal launch", file: "work/studio/portal/portal.org", reason: "Alex asked for the portal launch plan.",
		tasks: [
			{ key: "api", file: "work/studio/portal/portal.org", title: "Build the scores API", scope: "Serve scores.", checklist: ["Add the endpoint"], depends: [] as string[] },
			{ key: "site", file: "work/studio/portal/portal.org", title: "Show scores on the site", scope: "Use the API.", checklist: ["Call the endpoint"], depends: ["api"] },
		],
	};
	faux.setResponses(Array.from({ length: 20 }, () => (context: { messages: { role: string; content: unknown }[] }) => {
		const last = context.messages.findLast((m) => m.role !== "system")!;
		const text = JSON.stringify(last.content);
		if (last.role === "toolResult") return fauxAssistantMessage("Done.");
		if (text.includes("launch plan")) return fauxAssistantMessage([fauxToolCall("org_queue_plan", plan)], { stopReason: "toolUse" });
		const finished = /«(Build the scores API|Show scores on the site)».* is now EVAL/.exec(text);
		if (finished) return fauxAssistantMessage([fauxToolCall("org_complete_task", { file: "work/studio/portal/portal.org", heading: finished[1] })], { stopReason: "toolUse" });
		return fauxAssistantMessage("Noted.");
	}));
	const daemon = await openTestDaemon({ ...tmp, faux, config, extensions: [extension, createOrgExtension(config)] });
	t.after(() => daemon.close());
	const reports = async () => (await daemon.root.context(BG)).entries.filter((e) => (e.data as { source?: string })?.source === "follow").map((e) => JSON.stringify(e.data));
	const setState = async (title: string, from: string, to: string) => replaceFile(file, (await readFile(file, "utf8")).replace(`* ${from} ${title}`, `* ${to} ${title}`));

	await ask(tmp.paths.socket, "queue the portal launch plan");
	assert.ok(spec, "the plan went through org-dispatch plan");
	assert.match(spec!.key, /^june-inst-\d+$/);
	assert.deepEqual(spec!.tasks.map((task) => [task.key, task.depends]), [["api", undefined], ["site", ["api"]]]);
	assert.match(spec!.tasks[1]!.body, /^Queued by June: Alex asked for the portal launch plan\.\n\n\*\* Scope\nUse the API\.\n\n\*\* Checklist\n- \[ \] Call the endpoint$/);
	assert.ok(runs.some((args) => args[0] === "systemctl"), "this host's dispatcher is started");
	assert.equal((await daemon.harness.inspect(BG)).tasks.filter((task) => task.record.kind === "june.follow").length, 2, "every task is followed");

	// The first task runs and reaches EVAL while the second waits, well past the launch clock, without a stall report.
	await setState("Build the scores API", "AUTO", "PROG");
	await new Promise((r) => setTimeout(r, 500));
	assert.equal((await reports()).length, 0, "waiting on a prerequisite is silent");
	await setState("Build the scores API", "PROG", "EVAL");
	await until(async () => /^\* DONE Build the scores API/m.test(await readFile(file, "utf8")));
	assert.ok(runs.some((args) => args[0] === "org-edit" && args.includes(`id:${ids.api}`)), "June closed her reviewed plan task");

	// Now ready; the second task launches and finishes, and June closes it too.
	await setState("Show scores on the site", "AUTO", "PROG");
	await setState("Show scores on the site", "PROG", "EVAL");
	await until(async () => /^\* DONE Show scores on the site/m.test(await readFile(file, "utf8")));
	await until(async () => (await daemon.harness.inspect(BG)).tasks.filter((task) => task.record.kind === "june.follow").length === 0);
	const said = await reports();
	assert.equal(said.length, 2, "one report per finish");
	assert.ok(said.every((report) => !report.includes("has not launched")));
});

test("following a waiting task by hand reads its prerequisites", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "work.org");
	await mkdir(root, { recursive: true });
	await writeFile(file, "#+TITLE: Work\n\n* PROG Build the API\n:PROPERTIES:\n:ID: bbbbbbbb-0000-5000-a000-000000000001\n:END:\n\n* AUTO Show scores\n:PROPERTIES:\n:ID: bbbbbbbb-0000-5000-a000-000000000002\n:DEPENDS: id:bbbbbbbb-0000-5000-a000-000000000001\n:END:\n");
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: join(tmp.dir, "agenda"), people: join(root, "people.org") }, dispatch: { hosts: ["kit"] } };
	const extension = createDispatchExtension(config, new Org(root), new Herdr(config.herdr, async () => "{}"), "inst", async () => "", { intervalMs: 40, launchMs: 200, maxMs: 3_600_000 });
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("org_follow_task", { file: "work.org", heading: "Show scores", everyMinutes: 0 })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Following."),
		fauxAssistantMessage("It has not launched."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, extensions: [extension, createOrgExtension(config)] });
	t.after(() => daemon.close());
	const reports = async () => (await daemon.root.context(BG)).entries.filter((e) => (e.data as { source?: string })?.source === "follow").map((e) => JSON.stringify(e.data));
	await ask(tmp.paths.socket, "follow the scores task");
	await new Promise((r) => setTimeout(r, 400));
	assert.equal((await reports()).length, 0, "waiting is not a stall");
	await replaceFile(file, (await readFile(file, "utf8")).replace("* PROG Build the API", "* DONE Build the API"));
	await until(async () => (await reports()).length === 1);
	assert.match((await reports())[0]!, /has not launched \d+ minutes after its prerequisites finished/);
});

test("resuming with prerequisites passes them to org-edit and follows the task silently while it waits", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "work.org");
	await mkdir(root, { recursive: true });
	const pre = "cccccccc-0000-5000-a000-000000000001";
	const own = "cccccccc-0000-5000-a000-000000000002";
	await writeFile(join(tmp.dir, "agenda"), `${file}\n`);
	await writeFile(file, `#+TITLE: Work\n\n* PROG Align panels\n:PROPERTIES:\n:ID: ${pre}\n:END:\n\n* TODO Settled poses\n:PROPERTIES:\n:ID: ${own}\n:END:\n`);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: join(tmp.dir, "agenda"), people: join(root, "people.org") }, dispatch: { hosts: ["kit"], agents: ["pi", "claude"] } };
	const edits: string[][] = [];
	// Stands in for org-edit, writing the state and DEPENDS in one save as it does.
	const extension = createDispatchExtension(config, new Org(root), new Herdr(config.herdr, async () => "{}"), "inst", async (args) => {
		if (args[0] === "systemctl") return "";
		edits.push([...args]);
		const depends = args[args.indexOf("--depends") + 1]!;
		await replaceFile(file, (await readFile(file, "utf8")).replace("* TODO Settled poses", "* AUTO Settled poses").replace(`:ID: ${own}`, `:ID: ${own}\n:AGENT: claude\n:DEPENDS: ${depends}`));
		return JSON.stringify({ id: own, title: "Settled poses", host: "kit", depends: depends.split(" "), written: true });
	}, { intervalMs: 40, launchMs: 200, maxMs: 3_600_000 });
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("org_resume_task", {
			file: "work.org", heading: "Settled poses", expected: "TODO", host: "kit", agent: "claude", depends: [`id:${pre}`], note: "Alex asked for it to wait on the alignment.",
		})], { stopReason: "toolUse" }),
		fauxAssistantMessage("Resumed; it waits on the alignment."),
		fauxAssistantMessage("It has not launched."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, extensions: [extension, createOrgExtension(config)] });
	t.after(() => daemon.close());
	const reports = async () => (await daemon.root.context(BG)).entries.filter((e) => (e.data as { source?: string })?.source === "follow").map((e) => JSON.stringify(e.data));
	await ask(tmp.paths.socket, "make it wait on the alignment and give it to claude");
	assert.equal(edits.length, 1);
	assert.deepEqual(edits[0]!.slice(-6), ["--agent", "claude", "--depends", `id:${pre}`, "--note", "Alex asked for it to wait on the alignment."]);
	await new Promise((r) => setTimeout(r, 400));
	assert.equal((await reports()).length, 0, "waiting on the prerequisite is not a stall");
	await replaceFile(file, (await readFile(file, "utf8")).replace("* PROG Align panels", "* DONE Align panels"));
	await until(async () => (await reports()).length === 1);
	assert.match((await reports())[0]!, /has not launched \d+ minutes after its prerequisites finished/);
	assert.equal((await readFile(file, "utf8")).match(/^\* /gm)?.length, 2, "no task was created");
});

test("timed updates come only while a task is in PROG, on time, and until their end", () => {
	const timed = { ...input, everyMs: 5 * min, updatesUntil: 60 * min };
	assert.equal(progressDue(input, "PROG", 0, 30 * min), false, "no updates unless asked for");
	assert.equal(progressDue(timed, "PROG", 0, 4 * min), false);
	assert.equal(progressDue(timed, "PROG", 0, 5 * min), true);
	assert.equal(progressDue(timed, "HOLD", 0, 5 * min), false, "only while working");
	assert.equal(progressDue(timed, "blocked", 0, 5 * min), false, "a blocked agent is reported as such");
	assert.equal(progressDue(timed, "PROG", 58 * min, 63 * min), false, "updates end");
});

test("June follows a task she did not queue with timed updates until told to stop", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "work.org");
	await mkdir(root, { recursive: true });
	const session = "01a1875e-87d4-7096-b45c-2f3b924ffc06";
	await writeFile(file, `#+TITLE: Work\n\n* PROG Refresh content\n** Sessions\n- [[herdr:kit/pi:${session}@w5A:p1][pi@kit]]\n`);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: join(tmp.dir, "agenda"), people: join(root, "people.org") }, dispatch: { hosts: ["kit"] } };
	const panes: string[] = [];
	const herdr = new Herdr(config.herdr, async (args) => {
		panes.push(args.at(-1)!);
		return JSON.stringify({ result: { agent: { agent_status: "working" } } });
	});
	// A minute is 50 ms and checks are a second apart, so updates every two minutes arrive only by waking on time.
	const extension = createDispatchExtension(config, new Org(root), herdr, "inst", async () => "", { intervalMs: 1000, launchMs: 60_000, maxMs: 3_600_000, minuteMs: 50 });
	const faux = fauxProvider();
	const followIt = (everyMinutes: number) => fauxAssistantMessage([fauxToolCall("org_follow_task", { file: "work.org", heading: "Refresh content", everyMinutes })], { stopReason: "toolUse" });
	faux.setResponses(Array.from({ length: 80 }, () => (context: { messages: { role: string; content: unknown }[] }) => {
		const last = context.messages.findLast((m) => m.role !== "system")!;
		if (last.role === "toolResult") return fauxAssistantMessage("Done.");
		const text = JSON.stringify(last.content);
		if (text.includes("stop the updates")) return followIt(0);
		if (text.includes("updates every")) return followIt(2);
		return fauxAssistantMessage("Update.");
	}));
	const daemon = await openTestDaemon({ ...tmp, faux, config, extensions: [extension, createOrgExtension(config)] });
	t.after(() => daemon.close());
	const reports = async () =>
		(await daemon.root.context(BG)).entries.filter((e) => e.kind === "june.input" && (e.data as { source?: string })?.source === "follow").map((e) => JSON.stringify(e.data));

	await ask(tmp.paths.socket, "give me updates every 2 minutes on the refresh");
	await until(async () => (await reports()).length >= 2);
	assert.match((await reports())[0]!, /regular update .*«Refresh content» \(work.org\).*herdr_read_agent, sending it nothing/);
	assert.ok(panes.every((pane) => pane === "w5A:p1"), "reads the linked agent's status");

	await ask(tmp.paths.socket, "stop the updates");
	await until(async () => !(await daemon.status()).busy);
	const stopped = (await reports()).length;
	await new Promise((r) => setTimeout(r, 400));
	assert.equal((await reports()).length, stopped, "no updates after stopping");

	await replaceFile(file, (await readFile(file, "utf8")).replace("* PROG Refresh content", "* EVAL Refresh content"));
	await until(async () => (await reports()).length === stopped + 1, 5000);
	assert.match((await reports()).at(-1)!, /«Refresh content» \(work.org\) you are following is now EVAL/);
	await until(async () => (await daemon.harness.inspect(BG)).tasks.filter((task) => task.record.kind === "june.follow").length === 0);
	assert.doesNotMatch(await readFile(file, "utf8"), /:ID:/, "following writes nothing to Org");
});

test("june_improve writes the user's words, June's reading, and the transcript command, and follows the task", async (t) => {
	const body = improveBody("you can't do\n* updates every 5 minutes?", "I only have an hourly heartbeat.", new Date(Date.UTC(2026, 9, 30, 22, 30)), "kit");
	assert.doesNotMatch(body, /^\* /m, "the user's words cannot start a heading");
	assert.match(body, /In their words: «you can't do \* updates every 5 minutes\?»/);
	assert.match(body, /=june transcript --since 2026-10-30T22:30:00\.000Z --detail=/);

	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "june.org");
	await mkdir(root, { recursive: true });
	await writeFile(file, "#+TITLE: June\n");
	await writeFile(join(tmp.dir, "agenda"), `${file}\n`);
	const config = {
		...testConfig(tmp.dir),
		org: { root, agendaFiles: join(tmp.dir, "agenda"), people: join(root, "people.org") },
		dispatch: { hosts: ["kit"], agents: ["pi", "claude"], improve: { file: "june.org", agent: "claude" } },
	};
	const kicks: string[][] = [];
	const extension = createDispatchExtension(config, new Org(root), new Herdr(config.herdr, async () => "{}"), "inst", async (args) => {
		kicks.push([...args]);
		return "";
	}, { intervalMs: 40, launchMs: 60_000, maxMs: 3_600_000 });
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("june_improve", { title: "Let June give timed updates", complaint: "why can't you update me every 5 minutes?", gap: "No timer shorter than the hourly heartbeat.", minutes: 20 })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Queued a fix."),
		fauxAssistantMessage("The fix is ready for review."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, extensions: [extension] });
	t.after(() => daemon.close());
	const before = Date.now();
	assert.equal((await ask(tmp.paths.socket, "can you get that fixed?")).text, "Queued a fix.");
	const text = await readFile(file, "utf8");
	assert.match(text, /^\* AUTO Let June give timed updates\n:PROPERTIES:\n:ID: [0-9a-f-]{36}\n:AGENT: claude\n:HOST: kit\n:JUNE_REQUEST: inst:\d+\n:DIR: \/.+\n:END:\nQueued by June: /m);
	assert.doesNotMatch(text, /:REVIEW: no/, "review stays on");
	assert.match(text, /In their words: «why can't you update me every 5 minutes\?»/);
	const since = Date.parse(/--since (\S+) --detail/.exec(text)![1]!);
	assert.ok(Math.abs(since - (before - 20 * min)) < 5000, "the transcript starts where the exchange began");
	assert.ok(kicks.some((args) => args[0] === "systemctl"), "this host's dispatcher is started");

	await replaceFile(file, text.replace("* AUTO Let June", "* EVAL Let June"));
	await until(async () => (await daemon.root.context(BG)).entries.some((e) => (e.data as { source?: string })?.source === "follow"));
});

test("June reads and closes her own reviewed EVAL task before reporting through the daemon", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "todo.org");
	await mkdir(root, { recursive: true });
	await writeFile(file, "#+TITLE: Todo\n");
	await writeFile(join(tmp.dir, "agenda"), `${file}\n`);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: join(tmp.dir, "agenda"), people: join(root, "people.org") }, dispatch: { hosts: ["kit"] } };
	const herdr = new Herdr(config.herdr, async () => JSON.stringify({ result: { agent: { agent_status: "working" } } }));
	const edits: string[][] = [];
	const dispatch = createDispatchExtension(config, new Org(root), herdr, "inst", async (args) => {
		if (args[0] === "org-edit") {
			edits.push([...args]);
			await replaceFile(file, (await readFile(file, "utf8")).replace("* EVAL Check docs", "* DONE Check docs"));
		}
		return "";
	}, {
		intervalMs: 40,
		launchMs: 60_000,
		maxMs: 3_600_000,
	});

	const faux = fauxProvider();
	const queue = { file: "todo.org", title: "Check docs", reason: "Alex asked for a docs check.", scope: "Check the docs.", checklist: ["Compare docs and code"], host: "kit" };
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("org_queue_task", queue)], { stopReason: "toolUse" }),
		fauxAssistantMessage("Queued it; I'll tell you when it lands."),
		fauxAssistantMessage([fauxToolCall("org_read_task", { file: "todo.org", heading: "Check docs" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("org_complete_task", { file: "todo.org", heading: "Check docs" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Reviewed the docs check and closed it. Docs match the code."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, extensions: [dispatch, createOrgExtension(config)] });
	t.after(() => daemon.close());

	const asked = await ask(tmp.paths.socket, "queue a docs check");
	assert.equal(asked.text, "Queued it; I'll tell you when it lands.");
	const follows = async () =>
		(await daemon.root.context(BG)).entries.filter((e) => e.kind === "june.input" && (e.data as { source?: string })?.source === "follow");

	// The dispatcher launches it, then the agent finishes at EVAL.
	const text = await readFile(file, "utf8");
	await replaceFile(file, text.replace("* AUTO Check docs", "* PROG Check docs"));
	await new Promise((r) => setTimeout(r, 200));
	assert.equal((await follows()).length, 0, "launch and work are silent");
	assert.doesNotMatch(text, /^:REVIEW: no$/m, "review remains enabled by default");
	await replaceFile(file, (await readFile(file, "utf8")).replace("* PROG Check docs", "* EVAL Check docs") + "\n** Outcome\nDocs match the code. Verified by comparing the documented commands with their implementations.\n");
	await until(async () => (await follows()).length === 1);
	assert.match(JSON.stringify((await follows())[0]!.data), /is now EVAL/);
	await until(async () => !(await daemon.status()).busy && faux.state.callCount === 5);
	assert.equal(edits.length, 1);
	assert.deepEqual(edits[0]!.slice(4), ["DONE", "--expect", "EVAL"]);
	assert.match(await readFile(file, "utf8"), /^\* DONE Check docs/m);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal((await follows()).length, 1, "reported once; the follow task ended");
	const inspection = await daemon.harness.inspect(BG);
	assert.equal(inspection.tasks.filter((task) => task.record.kind === "june.follow").length, 0);
});

test("resuming after EVAL and HOLD follows each new run without duplicate reports", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "todo.org");
	await mkdir(root, { recursive: true });
	await writeFile(file, "#+TITLE: Todo\n");
	await writeFile(join(tmp.dir, "agenda"), `${file}\n`);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: join(tmp.dir, "agenda"), people: join(root, "people.org") }, dispatch: { hosts: ["kit"] } };
	let kicks = 0;
	const extension = createDispatchExtension(config, new Org(root), new Herdr(config.herdr, async () => "{}"), "inst", async (args) => {
		if (args[0] === "systemctl") { kicks++; return ""; }
		assert.equal(args[0], "org-edit");
		const text = await readFile(file, "utf8");
		const expected = args[args.indexOf("--expect") + 1]!;
		assert.ok(text.includes(`* ${expected} Check docs`));
		const key = args[args.indexOf("--request") + 1]!;
		await replaceFile(file, text.replace(`* ${expected} Check docs`, "* AUTO Check docs").replace(/:JUNE_REQUEST: .+/, `:JUNE_REQUEST: ${key}`));
		const id = /^:ID: (.+)$/m.exec(text)![1]!;
		return JSON.stringify({ id, title: "Check docs", host: "kit", written: true });
	}, { intervalMs: 40, launchMs: 60_000, maxMs: 3_600_000 });
	const faux = fauxProvider();
	const resume = (expected: "EVAL" | "HOLD") => fauxAssistantMessage([fauxToolCall("org_resume_task", {
		file: "todo.org", heading: "Check docs", expected, host: "kit", note: "Alex asked for another pass.",
	})], { stopReason: "toolUse" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("org_queue_task", { file: "todo.org", title: "Check docs", reason: "Alex asked.", scope: "Check docs.", checklist: ["Compare"], host: "kit" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Queued."), fauxAssistantMessage("Ready for review."),
		resume("EVAL"), fauxAssistantMessage("Resumed."), fauxAssistantMessage("The agent has a question."),
		resume("HOLD"), fauxAssistantMessage("Resumed again."), fauxAssistantMessage("Finished."),
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config, extensions: [extension] });
	t.after(() => daemon.close());
	const reports = async () => (await daemon.root.context(BG)).entries.filter((e) => (e.data as { source?: string })?.source === "follow");
	await ask(tmp.paths.socket, "queue it");
	const originalId = /^:ID: (.+)$/m.exec(await readFile(file, "utf8"))![1];
	for (const [index, state] of ["EVAL", "HOLD", "DONE"].entries()) {
		if (index > 0) await ask(tmp.paths.socket, "resume it");
		const headline = ["First pass checked, ready for review.", "I need a decision on the second pass.", "Third pass fixed it, checks pass!"][index]!;
		const current = (await readFile(file, "utf8")).replace(/^:HEADLINE(?:_STATE|_AT)?:.*\n/gm, "");
		await replaceFile(file, current.replace("* AUTO Check docs", `* ${state} Check docs`).replace(":END:", `:HEADLINE: ${headline}\n:HEADLINE_STATE: ${state}\n:HEADLINE_AT: ${Date.now() / 1000}\n:END:`));
		await until(async () => (await reports()).length === index + 1 && !(await daemon.status()).busy && faux.state.callCount === (index + 1) * 3);
		const data = (await reports()).at(-1)!.data as { text: string; follow: unknown };
		assert.deepEqual(data.follow, { title: "Check docs", signal: state, headline });
		assert.ok(data.text.endsWith(`\nWorker headline: ${headline}`), "each run reports its fresh line, never the prior run's");
	}
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal((await reports()).length, 3);
	assert.equal(kicks, 3, "each queue or resume nudges dispatcher");
	const final = await readFile(file, "utf8");
	assert.equal(/^:ID: (.+)$/m.exec(final)![1], originalId);
	assert.equal(final.match(/^\* /gm)?.length, 1, "resume never creates another task");
	const inspection = await daemon.harness.inspect(BG);
	assert.equal(inspection.tasks.filter((task) => task.record.kind === "june.follow").length, 0, "superseded HOLD watcher also ended");
});

test("following ignores isolated missing reads, resets after recovery or errors, and keeps HOLD deduplicated", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "todo.org");
	await mkdir(root, { recursive: true });
	const org = new Org(root);
	const byId = org.byId.bind(org);
	const states = ["", "PROG", "", "HOLD", "", "HOLD", "", new Error("read failed"), "", "DONE"];
	let reads = 0;
	t.mock.method(org, "byId", async (id: string) => {
		const state = states[reads++];
		if (state instanceof Error) throw state;
		assert.notEqual(state, undefined, "the follow ends at DONE");
		await replaceFile(file, state ? `* ${state} Check docs\n:PROPERTIES:\n:ID: ${input.id}\n:END:\n` : "");
		return byId(id);
	});
	const task = createFollowTask(org, new Herdr(testConfig(tmp.dir).herdr, async () => "{}"), { intervalMs: 40, launchMs: 60_000, maxMs: 3_600_000 });
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("On hold."), fauxAssistantMessage("Finished.")]);
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [defineExtension({ name: "follow-test", tasks: [task] })] });
	t.after(() => daemon.close());
	await daemon.harness.commit((tx) => follow(tx, task, { ...input, queuedAt: Date.now() }, Number(daemon.root.id)), BG);
	const reports = async () => (await daemon.root.context(BG)).entries.filter((e) => (e.data as { source?: string })?.source === "follow");
	await until(async () => (await reports()).length >= 1);
	assert.match(JSON.stringify((await reports())[0]!.data), /is on HOLD/, "an empty read does not end the follow");
	await until(async () => (await reports()).length >= 2);
	assert.match(JSON.stringify((await reports())[1]!.data), /is now DONE/);
	await until(async () => (await daemon.harness.inspect(BG)).tasks.filter((task) => task.record.kind === "june.follow").length === 0);
	assert.equal(reads, states.length);
	assert.equal((await reports()).length, 2, "recovery into the same HOLD stays silent");
});

test("following confirms persistent removal across a restart, including a heading followed without an ID", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	await mkdir(root, { recursive: true });
	const org = new Org(root);
	const byHeading = org.byHeading.bind(org);
	let reads = 0;
	t.mock.method(org, "byHeading", async (file: string, heading: string) => {
		reads++;
		return byHeading(file, heading);
	});
	const task = createFollowTask(org, new Herdr(testConfig(tmp.dir).herdr, async () => "{}"), { intervalMs: 1000, launchMs: 60_000, maxMs: 3_600_000 });
	const extensions = [defineExtension({ name: "follow-test", tasks: [task] })];
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("No longer following it.")]);
	let daemon = await openTestDaemon({ ...tmp, faux, extensions });
	t.after(() => daemon.close());
	await daemon.harness.commit((tx) => follow(tx, task, { ...input, file: "todo.org", adopted: true, queuedAt: Date.now() - 1000 }, Number(daemon.root.id)), BG);
	await until(async () => {
		const live = (await daemon.harness.inspect(BG)).tasks.find((task) => task.record.kind === "june.follow");
		assert.ok(live, "the first miss leaves the follow running");
		return (live.record.state.checkpoint as { checks: number }).checks === 1;
	});
	assert.equal(reads, 1);
	assert.equal(faux.state.callCount, 0, "the first miss stays silent");
	await daemon.close();
	daemon = await openTestDaemon({ ...tmp, faux, extensions });
	const reports = async () => (await daemon.root.context(BG)).entries.filter((e) => (e.data as { source?: string })?.source === "follow");
	await until(async () => (await reports()).length === 1);
	assert.match(JSON.stringify((await reports())[0]!.data), /is no longer in Org/);
	await until(async () => (await daemon.harness.inspect(BG)).tasks.filter((task) => task.record.kind === "june.follow").length === 0);
	assert.equal(reads, 2, "the second miss confirms removal, even after restarting");
	assert.equal((await reports()).length, 1);
});

test("org_following lists persisted subscriptions without replacing or polling them", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	await mkdir(root);
	const file = join(root, "todo.org");
	const contents = `* PROG Check docs\n:PROPERTIES:\n:ID: ${input.id}\n:END:\n`;
	await writeFile(file, contents);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: join(tmp.dir, "agenda"), people: join(root, "people.org") }, dispatch: { hosts: ["kit"] } };
	const extension = () => createDispatchExtension(config, new Org(root), new Herdr(config.herdr, async () => { throw new Error("listing must not read the agent"); }), "inst", async () => "", { ...FOLLOW_DEFAULTS, intervalMs: 60_000 });
	const list = () => fauxAssistantMessage([fauxToolCall("org_following", {})], { stopReason: "toolUse" });
	const before = fauxProvider();
	before.setResponses([
		list(),
		(ctx) => { assert.match(JSON.stringify(ctx.messages.at(-1)), /\[\]/); return fauxAssistantMessage("Not following anything."); },
		fauxAssistantMessage([fauxToolCall("org_follow_task", { file: "todo.org", heading: `id:${input.id}`, everyMinutes: 2 })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Following."),
	]);
	let daemon = await openTestDaemon({ ...tmp, faux: before, config, extensions: [extension()] });
	t.after(() => daemon.close());
	await ask(tmp.paths.socket, "what are you following?");
	await ask(tmp.paths.socket, "follow it");
	const saved = (await daemon.harness.inspect(BG)).tasks.find((task) => task.record.kind === "june.follow")!.record;
	await daemon.close();
	const after = fauxProvider();
	after.setResponses([
		list(),
		(ctx) => {
			const result = ctx.messages.at(-1)!;
			assert.equal(result.role, "toolResult");
			if (result.role === "toolResult") assert.deepEqual(JSON.parse(result.content.filter((b) => b.type === "text").map((b) => b.text).join("")), [{ title: "Check docs", signal: "AUTO" }]);
			return fauxAssistantMessage("Still following Check docs.");
		},
	]);
	daemon = await openTestDaemon({ ...tmp, faux: after, config, extensions: [extension()] });
	await ask(tmp.paths.socket, "did you keep following after the restart?");
	const restored = (await daemon.harness.inspect(BG)).tasks.filter((task) => task.record.kind === "june.follow");
	assert.equal(restored.length, 1);
	assert.equal(restored[0]!.record.id, saved.id, "same durable task, not a recreated subscription");
	assert.deepEqual(restored[0]!.record.input, saved.input, "cadence and expiry unchanged");
	assert.deepEqual(restored[0]!.record.state.checkpoint, saved.state.checkpoint, "listing neither polls nor resets the saved due time");
	assert.equal(await readFile(file, "utf8"), contents, "listing and recovery do not edit Org");
});

test("restart keeps reported HOLD and blocked signals, then reports an offline completion once", async (t) => {
	for (const state of ["HOLD", "blocked"]) await t.test(state, async (t) => {
		const tmp = await tempDir();
		t.after(tmp.cleanup);
		const root = join(tmp.dir, "org");
		const file = join(root, "todo.org");
		await mkdir(root);
		const session = "01234567-89ab-cdef-0123-456789abcdef";
		await writeFile(file, `* ${state === "blocked" ? "PROG" : state} Check docs\n:PROPERTIES:\n:ID: ${input.id}\n:END:\n** Sessions\n- [[herdr:kit/pi:${session}@w1:p1][worker]]\n`);
		const task = createFollowTask(new Org(root), new Herdr(testConfig(tmp.dir).herdr, async () => JSON.stringify({ result: { agent: { agent_status: "blocked" } } })), { ...FOLLOW_DEFAULTS, intervalMs: 150 });
		const extensions = [defineExtension({ name: "follow-restart-test", tasks: [task] })];
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("Needs an answer."), fauxAssistantMessage("Ready for review.")]);
		let daemon = await openTestDaemon({ ...tmp, faux, extensions });
		t.after(() => daemon.close());
		const id = await daemon.harness.commit((tx) => follow(tx, task, { ...input, queuedAt: Date.now() }, Number(daemon.root.id)), BG);
		const reports = async () => (await daemon.root.context(BG)).entries.filter((e) => (e.data as { source?: string })?.source === "follow");
		await until(async () => (await reports()).length === 1 && !(await daemon.status()).busy);
		await daemon.close();
		daemon = await openTestDaemon({ ...tmp, faux, extensions });
		await until(async () => {
			const live = (await daemon.harness.inspect(BG)).tasks.find((task) => Number(task.record.id) === id);
			return (live?.record.state.checkpoint as { checks: number }).checks >= 3;
		});
		assert.equal((await reports()).length, 1, "same signal after restart stays silent");
		await daemon.close();
		await replaceFile(file, (await readFile(file, "utf8")).replace(/^\* (HOLD|PROG)/, "* EVAL"));
		daemon = await openTestDaemon({ ...tmp, faux, extensions });
		await until(async () => (await reports()).length === 2 && !(await daemon.status()).busy);
		assert.match(JSON.stringify((await reports()).at(-1)!.data), /is now EVAL/);
		await daemon.close();
		daemon = await openTestDaemon({ ...tmp, faux, extensions });
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal((await reports()).length, 2, "terminal follow is not restored or reported again");
		assert.equal((await daemon.harness.inspect(BG)).tasks.filter((task) => task.record.kind === "june.follow").length, 0);
	});
});

test("overdue progress resumes once after restart and keeps its original expiry", async (t) => {
	for (const expired of [false, true]) await t.test(expired ? "expired" : "still due", async (t) => {
		const tmp = await tempDir();
		t.after(tmp.cleanup);
		const root = join(tmp.dir, "org");
		await mkdir(root);
		await writeFile(join(root, "todo.org"), `* PROG Check docs\n:PROPERTIES:\n:ID: ${input.id}\n:END:\n`);
		const task = createFollowTask(new Org(root), new Herdr(testConfig(tmp.dir).herdr, async () => "{}"), { ...FOLLOW_DEFAULTS, intervalMs: 50 });
		const extensions = [defineExtension({ name: "follow-timing-restart-test", tasks: [task] })];
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("Progress update.")]);
		let daemon = await openTestDaemon({ ...tmp, faux, extensions });
		t.after(() => daemon.close());
		const now = Date.now();
		await daemon.harness.commit((tx) => follow(tx, task, { ...input, queuedAt: now, everyMs: 500, updatesUntil: now + (expired ? 500 : 10_000) }, Number(daemon.root.id)), BG);
		const live = async () => (await daemon.harness.inspect(BG)).tasks.find((task) => task.record.kind === "june.follow")!.record;
		await until(async () => (await live()).state.status === "sleeping");
		await daemon.close();
		await new Promise((resolve) => setTimeout(resolve, 1100));
		daemon = await openTestDaemon({ ...tmp, faux, extensions });
		const reports = async () => (await daemon.root.context(BG)).entries.filter((e) => (e.data as { source?: string })?.source === "follow");
		await until(async () => ((await live()).state.checkpoint as { checks: number }).checks >= 1 && !(await daemon.status()).busy);
		assert.equal((await reports()).length, expired ? 0 : 1, "no catch-up flood or expired progress update");
		const saved = await live();
		await daemon.close();
		daemon = await openTestDaemon({ ...tmp, faux, extensions });
		await until(async () => ((await live()).state.checkpoint as { checks: number }).checks > (saved.state.checkpoint as { checks: number }).checks);
		assert.equal((await reports()).length, expired ? 0 : 1, "a second restart does not repeat the update");
		assert.deepEqual((await live()).input, saved.input, "recovery never extends the update window");
		assert.equal(((await live()).state.checkpoint as { reported: number }).reported, (saved.state.checkpoint as { reported: number }).reported, "last update time survives too");
	});
});

test("following survives a daemon restart", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const file = join(root, "todo.org");
	await mkdir(root, { recursive: true });
	await writeFile(file, "#+TITLE: Todo\n");
	await writeFile(join(tmp.dir, "agenda"), `${file}\n`);
	const config = { ...testConfig(tmp.dir), org: { root, agendaFiles: join(tmp.dir, "agenda"), people: join(root, "people.org") }, dispatch: { hosts: ["kit"] } };
	const extension = () =>
		createDispatchExtension(config, new Org(root), new Herdr(config.herdr, async () => "{}"), "inst", async () => "", {
			intervalMs: 40,
			launchMs: 60_000,
			maxMs: 3_600_000,
		});
	const queue = { file: "todo.org", title: "Check docs", reason: "Alex asked.", scope: "Check the docs.", checklist: ["Compare"], host: "kit" };
	const before = fauxProvider();
	before.setResponses([fauxAssistantMessage([fauxToolCall("org_queue_task", queue)], { stopReason: "toolUse" }), fauxAssistantMessage("Queued.")]);
	let daemon = await openTestDaemon({ ...tmp, faux: before, config, extensions: [extension()] });
	await ask(tmp.paths.socket, "queue it");
	await daemon.close();

	await replaceFile(file, (await readFile(file, "utf8")).replace("* AUTO Check docs", "* DONE Check docs"));
	const after = fauxProvider();
	after.setResponses([fauxAssistantMessage("It finished.")]);
	daemon = await openTestDaemon({ ...tmp, faux: after, config, extensions: [extension()] });
	t.after(() => daemon.close());
	await until(async () => after.state.callCount === 1, 5000);
	const reports = (await daemon.root.context(BG)).entries.filter((e) => (e.data as { source?: string })?.source === "follow");
	assert.equal(reports.length, 1);
	assert.match(JSON.stringify(reports[0]!.data), /is now DONE/);
});
