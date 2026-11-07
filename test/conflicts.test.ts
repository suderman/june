import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import { ORG_CONFLICT, parseSweep, prompt } from "../src/conflicts.ts";
import { attachView, lines, openTestDaemon, tempDir, until } from "./helpers.ts";

const exec = promisify(execFile);
const tool = async (...args: string[]) => (await exec(ORG_CONFLICT, args)).stdout;
const stamp = ".sync-conflict-20261107-075724-U3OH2WI";

/** An Org tree with one copy of each kind; returns the copies by name. */
async function tree(root: string) {
	await mkdir(join(root, "work", ".stversions"), { recursive: true });
	await mkdir(join(root, ".Trash-1000"), { recursive: true });
	const put = (rel: string, text: string | Buffer) => writeFile(join(root, rel), text);
	await put("work/same.org", "* TODO a\n- one\n");
	await put(`work/same${stamp}.org`, "* TODO a\n- one\n");
	await put("work/inside.org", "* TODO a\n- one\n\n* DONE b\n");
	await put(`work/inside${stamp}.org`, "* TODO a\n\n- one\n");
	await put("work/both.org", "* DONE a\n- [X] one\n- two\n");
	await put(`work/both${stamp}.org`, "* PROG a\n- [ ] one\n- three\n");
	await put(`work/gone${stamp}.org`, "* TODO lost\n");
	await put("work/song.mp3", Buffer.from([0, 1]));
	await put(`work/song${stamp}.mp3`, Buffer.from([0, 2]));
	await put("work/page.html", "<p>new</p>\n");
	await put(`work/page${stamp}.html`, "<p>old</p>\n");
	await put(`work/.~lock.book${stamp}.odt#`, "lock");
	await put(`work/.stversions/kept${stamp}.org`, "");
	await put(`.Trash-1000/trashed${stamp}.org`, "");
	return { same: join(root, `work/same${stamp}.org`), both: join(root, `work/both${stamp}.org`), gone: join(root, `work/gone${stamp}.org`) };
}

test("org-conflict sorts copies, retires only those that add nothing, and leaves non-Org files alone", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const copies = await tree(root);
	const listed = (await tool("list", root))
		.trim()
		.split("\n")
		.map((line) => line.split("\t").slice(0, 2).join(" ").replace(`${root}/`, ""));
	assert.deepEqual(listed, [
		`junk work/.~lock.book${stamp}.odt#`,
		`diverged work/both${stamp}.org`,
		`orphan work/gone${stamp}.org`,
		`contained work/inside${stamp}.org`,
		`other work/page${stamp}.html`,
		`identical work/same${stamp}.org`,
		`other work/song${stamp}.mp3`,
	], "Syncthing's own folders and the trash are skipped");

	const check = await tool("check", copies.both);
	assert.match(check, /^status: diverged\n/);
	assert.match(check, /\n1:\* PROG a\n2:- \[ \] one\n3:- three\n$/, "the lines only the copy has, numbered as in the copy");
	await assert.rejects(tool("retire", join(root, "work/both.org")), /not a conflict copy/, "never a live file");

	const swept = parseSweep(await tool("sweep", root));
	assert.equal(swept.retired, 3);
	assert.deepEqual(
		swept.left.map((each) => `${each.status} ${each.copy.replace(`${root}/`, "")}`),
		[`diverged work/both${stamp}.org`, `orphan work/gone${stamp}.org`, `other work/page${stamp}.html`, `other work/song${stamp}.mp3`],
	);
	assert.equal(existsSync(copies.same), false);
	assert.equal(readFileSync(join(root, "work/same.org"), "utf8"), "* TODO a\n- one\n", "the live file is untouched");
	assert.equal(existsSync(join(root, `work/.stversions/kept${stamp}.org`)), true);
});

test("the nightly look lists the Org copies to judge and asks for the skill, privately", () => {
	const text = prompt({ retired: 2, judge: [{ status: "diverged", copy: "/o/a.sync-conflict-x.org" }] });
	assert.match(text, /^\[heartbeat\] Your nightly Syncthing check, private like a heartbeat/);
	assert.match(text, /already retired 2 conflict copies that added nothing/);
	assert.match(text, /\n- diverged: \/o\/a\.sync-conflict-x\.org\n/);
	assert.match(text, /org-conflicts skill with skill_read/);
	assert.match(text, /hand it to a working context with work/);
	assert.match(text, /answer with exactly QUIET/);
	assert.doesNotMatch(prompt({ retired: 0, judge: [] }), /already retired/);
});

test("at 00:30 the sweep runs once, and only Org copies that need judgment reach June", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const root = join(tmp.dir, "org");
	const copies = await tree(root);
	const now = new Date();
	let clock = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 29);
	const asked: string[] = [];
	const faux = fauxProvider();
	faux.setResponses([
		(ctx: TranscriptContext) => {
			const last = ctx.messages.findLast((m) => m.role === "user")!;
			asked.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
			return fauxAssistantMessage("QUIET");
		},
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, config: { conflicts: { enabled: true, at: "00:30" } }, conflictsClock: { now: () => clock, tickMs: 50 } });
	t.after(() => daemon.close());
	const view = await attachView(tmp.paths.socket);
	t.after(() => view.close());

	await new Promise((r) => setTimeout(r, 300));
	assert.equal(existsSync(copies.same), true, "nothing before 00:30");
	clock = new Date(clock.getTime() + 60_000);
	await until(() => asked.length === 1, 10_000);
	assert.equal(existsSync(copies.same), false, "the sweep retired the identical copy");
	assert.match(asked[0]!, /already retired 3 conflict copies/);
	assert.match(asked[0]!, new RegExp(`- diverged: ${copies.both.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.match(asked[0]!, /- orphan: .*gone\.sync-conflict/);
	assert.doesNotMatch(asked[0]!, /page\.sync-conflict|song\.sync-conflict/, "non-Org copies are not hers to judge");
	await until(() => existsSync(join(tmp.paths.state, "conflicts.json")));

	clock = new Date(clock.getTime() + 3 * 3_600_000);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(faux.state.callCount, 1, "once a night");
	assert.deepEqual(lines(view.items()), [], "a quiet look shows nothing");
});
