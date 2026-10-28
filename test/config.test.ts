import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, paths } from "../src/config.ts";
import { init } from "../src/init.ts";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ask, openTestDaemon, tempDir } from "./helpers.ts";

test("config.json and AGENTS.md come from the config directory, SOUL.org and her files from the data directory, and machine settings from the environment", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const [config, data] = ["config", "data"].map((name) => join(tmp.dir, name)) as [string, string];
	for (const dir of [config, data]) await mkdir(dir);
	const dirs = { ...tmp.paths, config, data };
	await writeFile(join(config, "config.json"), JSON.stringify({ model: { chat: { provider: "p", modelId: "m" } }, skillDirs: ["/a"], herdr: { hosts: { cog: {} } } }));
	await writeFile(join(config, "AGENTS.md"), "rules");
	const bare = loadConfig(dirs, {});
	assert.equal(bare.soulFile, undefined, "no identity until SOUL.org exists");
	assert.equal(bare.daemonHost, undefined);
	assert.equal(bare.telegram, undefined, "Telegram is off unless the module names its users");
	await writeFile(join(data, "SOUL.org"), "june");
	const loaded = loadConfig(dirs, { JUNE_DAEMON_HOST: "kit", TELEGRAM_ALLOWED_USERS: "42, 7" });
	assert.deepEqual(loaded.model, { chat: { thinkingLevel: "medium", provider: "p", modelId: "m" } });
	assert.deepEqual(loaded.skillDirs, ["/a"]);
	assert.deepEqual(loaded.herdr.hosts, { cog: {} });
	assert.equal(loaded.soulFile, join(data, "SOUL.org"));
	assert.equal(loaded.memoryFile, join(data, "MEMORY.org"), "chosen even before it exists");
	assert.equal(loaded.journalFile, join(data, "JOURNAL.org"));
	assert.equal(loaded.instructionsFile, join(config, "AGENTS.md"));
	assert.equal(loaded.daemonHost, "kit");
	assert.deepEqual(loaded.telegram, { tokenEnv: "TELEGRAM_BOT_TOKEN", allowedUserIds: [42, 7] });
	assert.throws(() => loadConfig(dirs, { TELEGRAM_ALLOWED_USERS: "jon" }), /TELEGRAM_ALLOWED_USERS must be numeric/);
	assert.throws(() => loadConfig({ ...dirs, config: data }, {}), /No model\.chat configured/);
	await writeFile(join(config, "config.json"), JSON.stringify({ model: { chat: { provider: "p", modelId: "m" } }, daemonHost: "kit" }));
	assert.throws(() => loadConfig(dirs, {}), /daemonHost now comes from the NixOS module/, "an old personal setting is refused, not ignored");
	await writeFile(join(config, "config.json"), JSON.stringify({ model: { chat: { provider: "p", modelId: "m" }, focus: { modelId: "careful" }, patter: { modelId: "chatty" } } }));
	const modes = loadConfig(dirs, {}).model;
	assert.deepEqual(modes.focus, { provider: "p", thinkingLevel: "medium", modelId: "careful" }, "focus inherits what it leaves out");
	assert.deepEqual(modes.patter, { provider: "p", thinkingLevel: "medium", modelId: "chatty" }, "patter thinks a little unless told");
	assert.equal(loaded.model.focus, undefined, "no focus unless configured");
});

test("the rhythm, reflection, heartbeat, and patter timing have defaults, take overrides, and refuse nonsense", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const chat = { model: { chat: { provider: "p", modelId: "m" } } };
	const layer = async (name: string, extra: object) => {
		const dir = join(tmp.dir, name);
		await mkdir(dir);
		await writeFile(join(dir, "config.json"), JSON.stringify({ ...chat, ...extra }));
		return dir;
	};
	const plain = loadConfig({ ...tmp.paths, config: await layer("plain", {}) });
	assert.deepEqual(plain.rhythm, { wake: "05:00", quiet: "22:00", sleep: "01:00" });
	assert.deepEqual(plain.reflection, { enabled: true, quietMinutes: 60, recentDays: 3 });
	assert.deepEqual(plain.heartbeat, { enabled: false, everyMinutes: 60, chattingMinutes: 15 }, "off unless configured");
	assert.equal(plain.patter.openAfterSeconds, 8);
	const tuned = loadConfig({ ...tmp.paths, config: await layer("tuned", { rhythm: { sleep: "00:30" }, heartbeat: { enabled: true, everyMinutes: 30 }, patter: { openAfterSeconds: 15 } }) });
	assert.deepEqual(tuned.rhythm, { wake: "05:00", quiet: "22:00", sleep: "00:30" }, "an override keeps the other defaults");
	assert.deepEqual(tuned.heartbeat, { enabled: true, everyMinutes: 30, chattingMinutes: 15 });
	assert.equal(tuned.patter.openAfterSeconds, 15);
	const late = await layer("late", { rhythm: { quiet: "10pm" } });
	assert.throws(() => loadConfig({ ...tmp.paths, config: late }), /rhythm\.quiet must be HH:MM/);
	const old = await layer("old", { reflection: { start: "03:00" } });
	assert.throws(() => loadConfig({ ...tmp.paths, config: old }), /runs from rhythm\.sleep to rhythm\.wake/);
	const eager = await layer("eager", { heartbeat: { everyMinutes: 1 } });
	assert.throws(() => loadConfig({ ...tmp.paths, config: eager }), /heartbeat\.everyMinutes/);
	const forgetful = await layer("forgetful", { reflection: { recentDays: -1 } });
	assert.throws(() => loadConfig({ ...tmp.paths, config: forgetful }), /reflection\.recentDays/);
	assert.deepEqual(plain.situation, { calendars: [], homeAssistant: { people: [], pollSeconds: 300 } });
	const placed = loadConfig({ ...tmp.paths, config: await layer("placed", { situation: { calendars: ["~/org/calendar/family.org"], homeAssistant: { people: ["person.jon"] } } }) });
	assert.equal(placed.situation.calendars[0], join(process.env.HOME!, "org/calendar/family.org"), "calendar paths expand ~");
	assert.deepEqual(placed.situation.homeAssistant, { people: ["person.jon"], pollSeconds: 300 });
	const nobody = await layer("nobody", { situation: { homeAssistant: { people: ["jon"] } } });
	assert.throws(() => loadConfig({ ...tmp.paths, config: nobody }), /person\.\* entity ids/);
	const silent = await layer("silent", { patter: { gapsSeconds: [] } });
	assert.throws(() => loadConfig({ ...tmp.paths, config: silent }), /patter\.gapsSeconds/);
});

test("the templates load: the example config is valid, and the identity files are where June looks for them", () => {
	const templates = join(import.meta.dirname, "..", "templates");
	const config = loadConfig({ ...paths({}), config: templates, data: templates }, {});
	assert.equal(config.heartbeat.enabled, true);
	assert.equal(config.soulFile, join(templates, "SOUL.org"));
	assert.equal(config.heartbeatFile, join(templates, "HEARTBEAT.org"));
	for (const file of ["SOUL.org", "MEMORY.org", "HEARTBEAT.org"]) assert.match(readFileSync(join(templates, file), "utf8"), /^#\+TITLE: /);
});

test("June's prompts and tools name the configured user, and the code names nobody", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	await writeFile(join(tmp.dir, "SOUL.org"), "* June\n");
	let request = "";
	const faux = fauxProvider();
	faux.setResponses([
		(ctx) => {
			request = JSON.stringify(ctx);
			return fauxAssistantMessage("hi");
		},
	]);
	const daemon = await openTestDaemon({
		...tmp,
		faux,
		config: { user: { name: "Robin" }, soulFile: join(tmp.dir, "SOUL.org"), memoryFile: join(tmp.dir, "MEMORY.org"), journalFile: join(tmp.dir, "JOURNAL.org"), heartbeatFile: join(tmp.dir, "HEARTBEAT.org"), dispatch: { hosts: ["kit"] } },
	});
	t.after(() => daemon.close());
	await ask(tmp.paths.socket, "hello");
	assert.match(request, /Robin's/, "the name reaches her prompt");
	assert.doesNotMatch(request, /\$\{\s*[uU]ser\(\)\s*\}/, "no placeholder left uninterpolated");
	assert.doesNotMatch(request, /\bJon\b/, "nobody's real name in the code's own text");
	for (const file of ["SOUL.org", "MEMORY.org", "HEARTBEAT.org", "config.json"])
		assert.doesNotMatch(readFileSync(join(import.meta.dirname, "..", "templates", file), "utf8"), /\bJon\b/, `templates/${file} names nobody`);
});

test("june init creates missing personal files from the templates with the name filled in, and keeps existing ones", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const dirs = { config: join(tmp.dir, "config"), data: join(tmp.dir, "data") };
	await mkdir(dirs.data);
	await writeFile(join(dirs.data, "MEMORY.org"), "mine\n");
	const results = init(dirs, "Robin");
	assert.deepEqual(
		results.map((r) => [r.path.slice(tmp.dir.length + 1), r.created]),
		[["data/SOUL.org", true], ["data/MEMORY.org", false], ["data/HEARTBEAT.org", true], ["config/config.json", true]],
	);
	const soul = readFileSync(join(dirs.data, "SOUL.org"), "utf8");
	assert.match(soul, /^You are June, Robin's personal assistant/m);
	assert.doesNotMatch(soul, /\{\{name\}\}/, "every placeholder filled");
	assert.equal(readFileSync(join(dirs.data, "MEMORY.org"), "utf8"), "mine\n", "an existing file is never touched");
	assert.equal(JSON.parse(readFileSync(join(dirs.config, "config.json"), "utf8")).user.name, "Robin");
	assert.throws(() => init(dirs, " "), /a name is needed/);
});
