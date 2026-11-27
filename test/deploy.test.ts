import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { deploy, deployDir } from "../src/deploy.ts";
import { Herdr } from "../src/tools/herdr.ts";
import { tempDir } from "./helpers.ts";

/** A fake hc: cog is an added machine, lux only over SSH. RUNS records each hc run; LIVE lists terminals per host. */
function fakeHc(live: Record<string, any[]> = {}) {
	const runs: string[][] = [];
	const herdr = new Herdr({ host: "kit", hosts: { cog: {}, lux: {} }, allowPrompt: false }, async (argv) => {
		if (argv[1] === "machine") return JSON.stringify({ machines: [{ name: "cog", state: "connected" }] });
		if (argv[1] === "run") {
			runs.push([...argv]);
			const on = argv.indexOf("--on");
			const host = on >= 0 ? argv[on + 1]! : "kit";
			const name = argv[argv.indexOf("--name") + 1]!;
			const address = `${host === "kit" ? "" : host + "/"}t9`;
			const labels: Record<string, string> = { name };
			argv.forEach((a, i) => { if (a === "--label") { const [k, v] = argv[i + 1]!.split("="); labels[k!] = v!; } });
			(live[host] ??= []).push({ address, state: "live", agent: argv.at(-1) === "start" || argv.at(-2) === "start" ? "claude" : argv.at(-1), status: { state: "idle" }, labels });
			return JSON.stringify({ address });
		}
		if (argv[1] === "ls") {
			const all = Object.values(live).flat();
			const label = argv.indexOf("--label") >= 0 ? argv[argv.indexOf("--label") + 1]!.split("=") : undefined;
			return JSON.stringify({ terminals: label ? all.filter((t) => t.labels?.[label[0]!] === label[1]) : all });
		}
		if (argv[1] === "get") return JSON.stringify(Object.values(live).flat().find((t) => t.address === argv[2]) ?? {});
		return "";
	});
	return { herdr, runs };
}

test("a deploy folder is the host's home, a path under it, or an absolute path", () => {
	assert.equal(deployDir("", "/home/j"), undefined);
	assert.equal(deployDir(" ~ ", "/home/j"), undefined);
	assert.equal(deployDir("~/src/suderman/june", "/home/j"), "/home/j/src/suderman/june");
	assert.equal(deployDir("/srv/x", "/home/j"), "/srv/x");
	assert.throws(() => deployDir("src/x", "/home/j"), /must start with/);
	assert.throws(() => deployDir("/x\n/y", "/home/j"), /one line/);
});

/** Terminals the Herdr app shows: cog's june space, and kit's main one. */
const shown = () => ({
	cog: [{ address: "cog/t1", state: "live", agent: "zsh", where: "june / 1", labels: { "herdr.space": "spJune" } }],
	kit: [{ address: "t2", state: "live", agent: "zsh", where: "[2] main / 1", labels: { "herdr.space": "spMain" } }],
});

test("a raw harness starts on its host as typed, in the folder, labelled, and waits until hc lists it", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const { herdr, runs } = fakeHc();
	const now = new Date(2026, 10, 26, 17, 5, 9);
	assert.deepEqual(await deploy(herdr, tmp.dir, { host: "cog", harness: "codex", dir: "~/src/x" }, { now, home: "/home/j", waitMs: 0 }), { host: "cog", terminal: "t9", listed: true });
	assert.deepEqual(runs[0], ["hc", "run", "--json", "--bg", "--no-parent", "--name", "codex-170509", "--on", "cog", "--cwd", "/home/j/src/x", "--label", "june.deploy=codex", "--", "codex"]);
	await deploy(herdr, tmp.dir, { host: "kit", harness: "pi" }, { now, waitMs: 0 });
	assert.deepEqual(runs[1], ["hc", "run", "--json", "--bg", "--no-parent", "--name", "pi-170509", "--label", "june.deploy=pi", "--", "pi"], "here, at home: no --on, no --cwd");
	await assert.rejects(deploy(herdr, tmp.dir, { host: "lux", harness: "pi" }, { waitMs: 0 }), /has not added lux/);
	await assert.rejects(deploy(herdr, tmp.dir, { host: "cog", harness: "gemini" }, { waitMs: 0 }), /Harness must be one of/);
	await assert.rejects(deploy(herdr, tmp.dir, { host: "mars", harness: "pi" }, { waitMs: 0 }), /Host must be one of/);
});

test("a clanker starts with june start on its own host, and one at work is visited instead", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	await mkdir(join(tmp.dir, "clankers", "cid"), { recursive: true });
	await writeFile(join(tmp.dir, "clankers", "cid", "CARD.org"), "* cid\n:PROPERTIES:\n:HOST: cog\n:HARNESS: claude\n:END:\nWrites code.\n");
	const { herdr, runs } = fakeHc();
	const now = new Date(2026, 10, 26, 9, 0, 0);
	assert.deepEqual(await deploy(herdr, tmp.dir, { clanker: "cid", host: "kit" }, { now, waitMs: 0 }), { host: "cog", terminal: "t9", listed: true });
	assert.deepEqual(runs[0], ["hc", "run", "--json", "--bg", "--no-parent", "--name", "cid-090000", "--on", "cog", "--label", "june.agent=cid", "--label", "june.deploy=cid", "--", "june", "start", "cid"], "its own host, not the one asked");
	const again = await deploy(herdr, tmp.dir, { clanker: "cid" }, { now, waitMs: 0 });
	assert.deepEqual(again, { host: "cog", terminal: "t9", existing: true, listed: true });
	assert.equal(runs.length, 1, "nothing new starts for a clanker at work");
	await assert.rejects(deploy(herdr, tmp.dir, { clanker: "nobody" }, { waitMs: 0 }), /No clanker called nobody/);
});

test("a session that ends at once is an error with its last words", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const herdr = new Herdr({ host: "kit", hosts: {}, allowPrompt: false }, async (argv) => {
		if (argv[1] === "run") return JSON.stringify({ address: "t4" });
		if (argv[1] === "ls") return JSON.stringify({ terminals: [] });
		if (argv[1] === "get") return JSON.stringify({ address: "t4", state: "finished" });
		if (argv[1] === "read") return "hc: no such directory: /nope\n";
		return "";
	});
	await assert.rejects(deploy(herdr, tmp.dir, { host: "kit", harness: "pi", dir: "/nope" }, { waitMs: 0 }), /ended at once: hc: no such directory: \/nope/);
});

test("a program hc cannot start, as in a folder that is not there, is said plainly with where", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const herdr = new Herdr({ host: "kit", hosts: {}, allowPrompt: false }, async (argv) => {
		if (argv[1] === "run") throw new Error('hc run --json --bg: {"error":{"hint":"check the program name and cwd","kind":"spawn_failed","message":"cannot start \\"pi\\": No such file or directory (os error 2)"}}');
		return "";
	});
	await assert.rejects(deploy(herdr, tmp.dir, { host: "kit", harness: "pi", dir: "/nope" }, { waitMs: 0 }), /^Error: Could not start pi on kit in \/nope: No such file or directory \(os error 2\)$/);
});

test("a deploy joins the Herdr app space named after its folder, else the host's main one, else none", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const { herdr, runs } = fakeHc(shown());
	const now = new Date(2026, 10, 26, 18, 0, 0);
	await deploy(herdr, tmp.dir, { host: "cog", harness: "pi", dir: "~/src/suderman/june" }, { now, home: "/home/j", waitMs: 0 });
	await deploy(herdr, tmp.dir, { host: "kit", harness: "pi", dir: "~" }, { now, home: "/home/j", waitMs: 0 });
	await deploy(herdr, tmp.dir, { host: "cog", harness: "pi", dir: "~/notes" }, { now, home: "/home/j", waitMs: 0 });
	const space = (argv: string[]) => argv.find((a, i) => argv[i - 1] === "--label" && a.startsWith("herdr.space="));
	assert.deepEqual(runs.map(space), ["herdr.space=spJune", "herdr.space=spMain", undefined], "june's folder, kit's home in main, and cog with no main stays hidden");
});

test("a host without a main space gets one made through the Herdr app when a deploy needs it", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const asked: string[][] = [];
	const started: string[][] = [];
	const live: any[] = [];
	const herdr = new Herdr({ host: "kit", hosts: { lux: {} }, allowPrompt: false }, async (argv) => {
		if (argv[0] === "herdr-app") { asked.push([...argv]); return JSON.stringify({ space: "lux/spNew", tab: "lux/tb1" }); }
		if (argv[1] === "machine") return JSON.stringify({ machines: [{ name: "lux", state: "connected" }] });
		if (argv[1] === "run") { started.push([...argv]); live.push({ address: "lux/t3", state: "live", agent: "pi" }); return JSON.stringify({ address: "lux/t3" }); }
		if (argv[1] === "ls") return JSON.stringify({ terminals: live });
		return "{}";
	});
	await deploy(herdr, tmp.dir, { host: "lux", harness: "pi", dir: "~" }, { home: "/home/j", waitMs: 0 });
	assert.deepEqual(asked, [["herdr-app", "do", "space.new", "--name", "main", "--folder", "/home/j", "--machine", "lux", "--focus", "false"]]);
	assert.ok(started[0]!.includes("herdr.space=spNew"), "the session joins the space just made, its machine prefix dropped");
	const none = new Herdr({ host: "kit", hosts: {}, allowPrompt: false }, async (argv) => {
		if (argv[0] === "herdr-app") throw new Error("herdr-app: no window");
		if (argv[1] === "run") { assert.ok(!argv.some((a) => a.startsWith("herdr.space=")), "no app to ask: no space"); return JSON.stringify({ address: "t5" }); }
		if (argv[1] === "ls") return JSON.stringify({ terminals: [{ address: "t5", state: "live", agent: "pi" }] });
		return "{}";
	});
	assert.equal((await deploy(none, tmp.dir, { host: "kit", harness: "pi" }, { waitMs: 0 })).terminal, "t5");
});
