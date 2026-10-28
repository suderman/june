import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { tempDir } from "./helpers.ts";

test("config layers merge, and SOUL.org and AGENTS.md come from the most specific layer, with MEMORY.org beside SOUL.org", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const [agents, profile, machine] = ["agents", "profile", "machine"].map((name) => join(tmp.dir, name));
	for (const dir of [agents!, profile!, machine!]) await mkdir(dir);
	await writeFile(join(agents!, "config.json"), JSON.stringify({ model: { chat: { provider: "p", modelId: "m" } }, skillDirs: ["/a", "/b"], herdr: { hosts: { cog: {} } } }));
	await writeFile(join(agents!, "AGENTS.md"), "rules");
	await writeFile(join(agents!, "SOUL.org"), "generic");
	await writeFile(join(profile!, "SOUL.org"), "june");
	await writeFile(join(machine!, "SOUL.md"), "old Markdown identity, no longer read");
	await writeFile(join(machine!, "config.json"), JSON.stringify({ model: { chat: { modelId: "local" } }, skillDirs: ["/c"] }));
	const config = loadConfig({ ...tmp.paths, layers: [agents!, profile!, join(tmp.dir, "missing"), machine!] });
	assert.deepEqual(config.model, { chat: { thinkingLevel: "medium", provider: "p", modelId: "local" } }, "chat merges across layers");
	assert.deepEqual(config.skillDirs, ["/c"], "arrays replace");
	assert.deepEqual(config.herdr.hosts, { cog: {} });
	assert.equal(config.soulFile, join(profile!, "SOUL.org"));
	assert.equal(config.memoryFile, join(profile!, "MEMORY.org"), "chosen even before it exists");
	assert.equal(config.instructionsFile, join(agents!, "AGENTS.md"));
	assert.throws(() => loadConfig({ ...tmp.paths, layers: [profile!] }), /No model\.chat configured/);
	await writeFile(join(machine!, "config.json"), JSON.stringify({ model: { focus: { modelId: "careful" } } }));
	const focused = loadConfig({ ...tmp.paths, layers: [agents!, machine!] });
	assert.deepEqual(focused.model.focus, { provider: "p", thinkingLevel: "medium", modelId: "careful" }, "focus inherits what it leaves out");
	assert.equal(config.model.focus, undefined, "no focus unless configured");
	await writeFile(join(machine!, "config.json"), JSON.stringify({ model: { patter: { modelId: "chatty" } } }));
	assert.deepEqual(loadConfig({ ...tmp.paths, layers: [agents!, machine!] }).model.patter, { provider: "p", thinkingLevel: "medium", modelId: "chatty" }, "patter thinks a little unless told");
});

test("the reflection window and patter timing have defaults, take overrides, and refuse nonsense", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const chat = { model: { chat: { provider: "p", modelId: "m" } } };
	const layer = async (name: string, extra: object) => {
		const dir = join(tmp.dir, name);
		await mkdir(dir);
		await writeFile(join(dir, "config.json"), JSON.stringify({ ...chat, ...extra }));
		return dir;
	};
	const plain = loadConfig({ ...tmp.paths, layers: [await layer("plain", {})] });
	assert.deepEqual(plain.reflection, { enabled: true, start: "03:00", end: "06:00", quietMinutes: 60 });
	assert.equal(plain.patter.openAfterSeconds, 8);
	const tuned = loadConfig({ ...tmp.paths, layers: [await layer("tuned", { reflection: { start: "02:30" }, patter: { openAfterSeconds: 15 } })] });
	assert.deepEqual(tuned.reflection, { enabled: true, start: "02:30", end: "06:00", quietMinutes: 60 }, "an override keeps the other defaults");
	assert.equal(tuned.patter.openAfterSeconds, 15);
	const late = await layer("late", { reflection: { start: "3am" } });
	assert.throws(() => loadConfig({ ...tmp.paths, layers: [late] }), /reflection\.start must be HH:MM/);
	const silent = await layer("silent", { patter: { gapsSeconds: [] } });
	assert.throws(() => loadConfig({ ...tmp.paths, layers: [silent] }), /patter\.gapsSeconds/);
});
