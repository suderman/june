import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { exportArgv, loadAgenda, type Task } from "../src/board.ts";
import { TaskEdits } from "../src/board-edit.ts";
import { OrgEditError, OrgWorker, OrgWorkerDown } from "../src/org-worker.ts";
import { createLogger } from "../src/runtime.ts";
import { runProcess } from "../src/tools/herdr.ts";
import { tempDir, testConfig } from "./helpers.ts";

let hasEmacs = false;
try { execFileSync("emacs", ["--version"], { stdio: "ignore" }); hasEmacs = true; } catch { /* These tests need Emacs. */ }

/** A fixture Org tree with its own HOME, lock and dispatcher state, never the live ones. */
async function fixture() {
	const tmp = await tempDir();
	const root = join(tmp.dir, "org");
	await mkdir(join(root, "work", "demo"), { recursive: true });
	await mkdir(join(tmp.dir, "run"));
	const file = join(root, "work", "demo", "demo.org");
	await writeFile(file, "#+TITLE: Demo\n\n* TODO Plan the party\nSCHEDULED: <2026-11-21 Sat 09:00>\n:PROPERTIES:\n:ID: 7d2e8f90-1111-4222-8333-444455556666\n:END:\n\n* TODO Davy’s cake\n");
	const list = join(tmp.dir, "agenda-files");
	await writeFile(list, `${file}\n`);
	const env: NodeJS.ProcessEnv = { HOME: tmp.dir, XDG_RUNTIME_DIR: join(tmp.dir, "run"), XDG_STATE_HOME: join(tmp.dir, "state"), ORG_DISPATCH_ROOT: join(root, "work"), ORG_DISPATCH_EMACS_INIT: join(tmp.dir, "none"), JUNE_CONFIG_DIR: join(tmp.dir, "june"), HC_TERMINAL_ID: "", CLAUDECODE: "", PI_SESSION_ID: "" };
	const clean = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([k, v]) => v !== "" || !["HC_TERMINAL_ID", "CLAUDECODE", "PI_SESSION_ID"].includes(k))) as NodeJS.ProcessEnv;
	for (const k of ["HC_TERMINAL_ID", "CLAUDECODE", "PI_SESSION_ID"]) delete clean[k];
	const worker = new OrgWorker({ log: createLogger({ sink: () => {} }), env: clean, timeoutMs: 20_000 });
	const run = (argv: readonly string[], ms: number) => runProcess(["env", "-u", "HC_TERMINAL_ID", "-u", "CLAUDECODE", "-u", "PI_SESSION_ID", ...Object.entries(env).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`), ...argv], ms);
	return { tmp, root, file, list, worker, run, clean, cleanup: async () => { worker.stop(); await tmp.cleanup(); } };
}

test("the long-running Emacs reads the agenda as the one-off export does, and sees files changed behind its back", { skip: !hasEmacs }, async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const once = JSON.parse((await f.run(exportArgv(f.list), 60_000)).trimEnd().split("\n").pop()!);
	const warm = JSON.parse((await f.worker.agenda(f.list, 14)).trimEnd().split("\n").pop()!);
	assert.deepEqual(warm.days, once.days);
	assert.deepEqual(Object.keys(warm.tasks).sort(), Object.keys(once.tasks).sort());
	// Another writer changes the file; the next read has it, and Emacs never stops to ask.
	await writeFile(f.file, (await readFile(f.file, "utf8")).replace("* TODO Plan the party", "* PROG Plan the party"));
	const after = await loadAgenda(f.list, f.root, f.run, undefined, Date.now(), f.worker);
	assert.equal(after.tasks["id:7d2e8f90-1111-4222-8333-444455556666"]?.state, "PROG");
	assert.ok(Object.values(after.tasks).some((task) => task.title === "Davy’s cake"), "UTF-8 survives the round trip");
});

test("the long-running Emacs edits under the dispatcher's lock, waits for it, and says when it was held too long", { skip: !hasEmacs }, async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	assert.match(await f.worker.edit(["todo", f.file, "Davy’s cake", "PROG", "--expect", "TODO"], 5), /^\* PROG Davy’s cake/);
	await assert.rejects(f.worker.edit(["todo", f.file, "Davy’s cake", "DONE", "--expect", "TODO"], 5), (e: Error) => e instanceof OrgEditError && /expected TODO, found PROG/.test(e.message));
	assert.match(await f.worker.edit(["date", "mon 9am"], 5), /^<\d{4}-\d{2}-\d{2} Mon 09:00>/);
	// The dispatcher holds the lock for a moment: the edit waits its turn.
	const lock = join(f.tmp.dir, "run", "org-dispatch.lock");
	const holder = spawn("flock", [lock, "sleep", "1.5"]);
	await new Promise((r) => setTimeout(r, 200));
	const started = Date.now();
	assert.match(await f.worker.edit(["todo", f.file, "Davy’s cake", "TODO", "--expect", "PROG"], 10), /^\* TODO Davy’s cake/);
	assert.ok(Date.now() - started > 900, "it waited for the lock");
	if (holder.exitCode === null) await new Promise((r) => holder.on("exit", r));
	// Held past the wait: refused as busy, with the wrapper's exit code.
	const long = spawn("flock", [lock, "sleep", "3"]);
	await new Promise((r) => setTimeout(r, 200));
	await assert.rejects(f.worker.edit(["todo", f.file, "Davy’s cake", "PROG"], 1), (e: Error) => e instanceof OrgEditError && e.exitCode === 75);
	long.kill();
	assert.match(await readFile(f.file, "utf8"), /^\* TODO Davy’s cake$/m);
});

test("a dead worker is replaced on the next request, and board edits fall back to the one-off command when it cannot start", { skip: !hasEmacs }, async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	assert.match(await f.worker.edit(["date", "fri"], 5), /Fri>/);
	// Kill it under a request: that one fails as down, the next starts a new Emacs.
	const slow = f.worker.agenda(f.list, 14);
	process.kill(f.worker.pid!);
	await slow.then(() => {}, (e: Error) => assert.ok(e instanceof OrgWorkerDown, e.message));
	assert.match(await f.worker.edit(["date", "fri"], 5), /Fri>/);
	// No Emacs at all: TaskEdits still edits, through the wrapper.
	const broken = new OrgWorker({ log: createLogger({ sink: () => {} }), env: f.clean, argv: ["/nonexistent/emacs"] });
	t.after(() => broken.stop());
	const config = testConfig(f.tmp.dir, { org: { root: f.root, agendaFiles: f.list, people: join(f.root, "people.org") } });
	const edits = new TaskEdits(config, f.run, broken);
	// An ASCII title: the one-off command reads its arguments in the locale, and the Nix sandbox has no UTF-8 one.
	const party: Task = { key: "id:7d2e8f90-1111-4222-8333-444455556666", id: "7d2e8f90-1111-4222-8333-444455556666", file: "work/demo/demo.org", line: 3, level: 1, title: "Plan the party", state: "TODO", tags: [], path: [], project: "Demo", sessions: [] };
	await edits.apply(party, { action: "state", state: "HOLD" }, "r1");
	assert.match(await readFile(f.file, "utf8"), /^\* HOLD Plan the party$/m);
});
