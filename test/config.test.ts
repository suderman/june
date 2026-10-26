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
	await writeFile(join(agents!, "config.json"), JSON.stringify({ model: { provider: "p", modelId: "m" }, skillDirs: ["/a", "/b"], herdr: { hosts: { cog: {} } } }));
	await writeFile(join(agents!, "AGENTS.md"), "rules");
	await writeFile(join(agents!, "SOUL.org"), "generic");
	await writeFile(join(profile!, "SOUL.org"), "june");
	await writeFile(join(machine!, "SOUL.md"), "old Markdown identity, no longer read");
	await writeFile(join(machine!, "config.json"), JSON.stringify({ model: { modelId: "local" }, skillDirs: ["/c"] }));
	const config = loadConfig({ ...tmp.paths, layers: [agents!, profile!, join(tmp.dir, "missing"), machine!] });
	assert.deepEqual(config.model, { thinkingLevel: "medium", provider: "p", modelId: "local" });
	assert.deepEqual(config.skillDirs, ["/c"], "arrays replace");
	assert.deepEqual(config.herdr.hosts, { cog: {} });
	assert.equal(config.soulFile, join(profile!, "SOUL.org"));
	assert.equal(config.memoryFile, join(profile!, "MEMORY.org"), "chosen even before it exists");
	assert.equal(config.instructionsFile, join(agents!, "AGENTS.md"));
	assert.throws(() => loadConfig({ ...tmp.paths, layers: [profile!] }), /No model configured/);
});
