// june: the daemon (`serve`) and its clients (`june`, `ask`, `status`, `doctor`).
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createLogger } from "./runtime.ts";
import { daemonHost, loadConfig, paths, readConfigFile, readEnvFiles, shortHostname } from "./config.ts";
import { startDaemon } from "./daemon.ts";
import { parseSince, renderHistory } from "./history.ts";
import { formatSize } from "./inbox.ts";
import { KINDS, parseRange, renderTimeline } from "./timeline.ts";
import { createJuneModels, providerFromPiModels } from "./models.ts";
import { findSkills } from "./prompt.ts";
import { Client, DaemonUnavailable, parseCommand, type Reply, type Status } from "./protocol.ts";
import type { Agenda, AgendaEntry, Agents } from "./board.ts";
import { runProcess } from "./tools/herdr.ts";

const USAGE = `usage:
  june                    open the terminal client
  june ask [--json] TEXT  send one message and print the answer ("-" or no text reads stdin)
  june status [--json]    daemon, model, and conversation state, without a model call
  june agenda [--json]    overdue, today and this week from the Org agenda, as June's clients see it
  june org-work [--clean] [--keep PATH]... [--record FILE] [--after-days N] [--json]
                          this host's org-work folders and what the tidy rules make of them; --clean removes those due
  june agents [--json]    the agents at work, what needs you, what is queued, and what finished today
  june transcript [--last N] [--since WHEN] [--detail] [--json]
                          the recent conversation as text: the last N entries (200 by default), or those since
                          WHEN (30m, 2h, 1d, 16:20, or a date); --detail adds thinking, tool output, and private looks
  june transcript --search WORDS [--since WHEN] [--until WHEN] [--kinds K,K] [--last N] [--oldest] [--json]
                          search the whole timeline, newest first (--oldest: oldest first): every word must appear, "a phrase" as it is;
                          kinds are user, june, patter, action, note
  june transcript --around ID [--before N] [--after N] [--json]
                          the timeline around entry ID, from a search result
  june usage [--since WHEN] [--json]
                          what June uses (tools, skills, her journal) and the director's art picks, since WHEN (7 days
                          by default), with where more art would help
  june transcript --hide ID[-ID] | --unhide ID[-ID] | --hidden
                          leave entries out of the timeline, transcripts, and views (they stay in the database)
  june accounts [--json]  this host's numbered logins (claude1, codex2, ...): present, as whom, and any problem
  june accounts apply [--json]
                          make the account folders and wrappers that config.json's accounts names, and give each
                          Claude folder its trust, MCP servers and first-run answers (agents apply)
  june accounts login [NAME]
                          sign in each login this host lacks, or NAME, as the person ACCOUNTS.org names
  june quota [NAME] [--refresh] [--json]
                          each provider account's remaining quota, read with a login on this host (NAME: codex2,
                          openai2, ...); reads within two minutes reuse the last one unless --refresh
  june device add NAME    allow a device on the WebSocket and print its token, once
  june device list        devices, when each was added, and live connections
  june device revoke NAME remove a device and close its connections
  june doctor             check configuration and dependencies
  june init [NAME]        create missing personal files from the templates, for NAME or user.name
  june serve              run the daemon
  june telegram           run the Telegram bridge, a client of the daemon`;

// Exit codes: 0 ok, 1 failed or unanswered, 2 usage, 3 daemon unavailable.
async function main(argv: string[]): Promise<number> {
	const [command = "tui", ...rest] = argv;
	const json = rest.includes("--json");
	const args = rest.filter((a) => a !== "--json");
	const p = paths();
	if (["tui", "ask", "status", "agenda", "agents", "transcript", "device", "usage"].includes(command)) {
		const remote = remoteHost(p);
		if (remote !== undefined) return overSsh(remote, command, argv);
	}
	switch (command) {
		case "tui": {
			const { runTui } = await import("./tui.ts");
			await runTui(p.socket);
			return 0;
		}
		case "serve":
			return serve();
		case "telegram": {
			const { runTelegram } = await import("./telegram.ts");
			return runTelegram();
		}
		case "ask":
			return ask(p.socket, args, json);
		case "status":
			return status(p.socket, json);
		case "agenda":
		case "agents":
			return board(p.socket, command, json);
		case "org-work":
			return orgWorkCommand(args, json);
		case "transcript":
			return transcript(p, args, json);
		case "usage":
			return usageReport(p, args, json);
		case "device":
			return device(p.socket, args, json);
		case "accounts":
			return accountsCommand(p, args, json);
		case "quota":
			return quotaCommand(p, args, json);
		case "doctor":
			return doctor();
		case "init": {
			const { init } = await import("./init.ts");
			const name = args.join(" ") || String(readConfigFile(p).user?.name ?? "");
			for (const { path, created } of init(p, name)) console.log(`${created ? "created" : "kept   "} ${path}`);
			return 0;
		}
		case "help":
		case "--help":
		case "-h":
			console.log(USAGE);
			return 0;
		default:
			console.error(USAGE);
			return 2;
	}
}

/** The daemon host when it is another machine and no daemon answers here; undefined to run locally. */
function remoteHost(p: ReturnType<typeof paths>): string | undefined {
	if (process.env.JUNE_LOCAL === "1" || existsSync(p.socket)) return undefined;
	const host = daemonHost();
	return host !== undefined && host !== shortHostname() ? host : undefined;
}

/** Run the same june command on `host`. Arguments are quoted for the remote shell; stdin and the terminal pass through. */
function overSsh(host: string, command: string, argv: readonly string[]): Promise<number> {
	const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
	const tty = command === "tui" ? ["-t"] : [];
	const child = spawn("ssh", [...tty, "-o", "ConnectTimeout=10", host, "JUNE_LOCAL=1", "june", ...argv.map(quote)], {
		stdio: "inherit",
	});
	return new Promise((resolve) => {
		child.once("error", (error) => {
			console.error(`ssh ${host}: ${error.message}`);
			resolve(3);
		});
		child.once("exit", (code) => resolve(code === 255 ? 3 : (code ?? 1)));
	});
}

async function serve(): Promise<number> {
	const p = paths();
	const config = loadConfig(p);
	const secrets = readEnvFiles(config.envFiles);
	const models = createJuneModels(secrets);
	models.setProvider(providerFromPiModels(config.providersFile, config.model.chat.provider));
	const log = createLogger({ level: (process.env.JUNE_LOG_LEVEL as never) ?? "info" });
	const daemon = await startDaemon({ config, paths: p, models, secrets, log });
	await new Promise<void>((resolve) => {
		process.once("SIGTERM", resolve);
		process.once("SIGINT", resolve);
	});
	await daemon.close();
	return 0;
}

async function connect(socket: string): Promise<Client | undefined> {
	try {
		return await Client.open(socket);
	} catch (error) {
		console.error(error instanceof DaemonUnavailable ? error.message : String(error));
		return undefined;
	}
}

async function ask(socket: string, args: string[], json: boolean): Promise<number> {
	const text = args.length === 0 || (args.length === 1 && args[0] === "-") ? readFileSync(0, "utf8") : args.join(" ");
	if (!text.trim()) {
		console.error(USAGE);
		return 2;
	}
	const client = await connect(socket);
	if (client === undefined) return 3;
	const requestId = randomUUID();
	const command = parseCommand(text);
	if (command !== undefined) {
		const reply = await client.request({ op: "command", requestId, ...command });
		client.close();
		if (reply.type !== "reply") {
			console.error(reply.type === "error" ? reply.message : "unexpected reply");
			return 1;
		}
		console.log(json ? JSON.stringify({ requestId, command: command.name, text: reply.text }) : reply.text);
		return 0;
	}
	const settled = new Promise<Extract<Reply, { type: "settled" }>>((resolve) =>
		client.on((reply) => {
			if (reply.type === "settled" && reply.requestId === requestId) resolve(reply);
		}),
	);
	const accepted = await client.request({ op: "submit", requestId, text, source: "cli", wait: true });
	if (accepted.type === "error") {
		console.error(accepted.message);
		client.close();
		return 1;
	}
	const result = await Promise.race([settled, client.closed.then(() => undefined)]);
	client.close();
	if (result === undefined) {
		console.error("June closed the connection before answering; the request is still queued.");
		return 1;
	}
	if (json) console.log(JSON.stringify({ requestId, status: result.status, text: result.text, reason: result.reason }));
	else if (result.status === "done") console.log(result.text ?? "");
	else console.error(`unanswered: ${result.reason}`);
	return result.status === "done" ? 0 : 1;
}

/** What June uses (tools, skills, journal) and the director's art picks, since WHEN (7 days by default). */
async function usageReport(p: ReturnType<typeof paths>, args: string[], json: boolean): Promise<number> {
	const at = args.indexOf("--since");
	const since = at >= 0 ? parseSince(args[at + 1] ?? "") : Date.now() - 7 * 24 * 60 * 60_000;
	if (since === undefined) {
		console.error("--since takes 30m, 2h, 3d, 16:20, or a date");
		return 2;
	}
	const { readRows, renderUsage, summarize } = await import("./usage.ts");
	const { loadManifest } = await import("./expression.ts");
	const { TEMPLATES } = await import("./init.ts");
	// Her tools and her conversation from the daemon when it runs; the report still reads without them.
	const client = await Client.open(p.socket).catch(() => undefined);
	const reply = client ? await client.request({ op: "status", requestId: randomUUID() }).catch(() => undefined) : undefined;
	client?.close();
	const status = reply?.type === "status" ? (reply.status as { tools?: string[]; conversation?: number }) : undefined;
	const pool = loadManifest([`${p.data}/avatar/manifest.json`, `${TEMPLATES}avatar/manifest.json`], createLogger({ sink: () => {} }));
	const report = summarize(readRows(p.database), since, status?.tools ?? [], pool, status?.conversation ?? 1);
	console.log(json ? JSON.stringify(report) : renderUsage(report));
	return 0;
}

async function transcript(p: ReturnType<typeof paths>, args: string[], json: boolean): Promise<number> {
	let limit: number | undefined;
	let since: number | undefined;
	let until: number | undefined;
	let detail = false;
	let search: string | undefined;
	let around: number | undefined;
	let before: number | undefined;
	let after: number | undefined;
	let kinds: string[] | undefined;
	let oldest = false;
	let hide: { action: "add" | "remove" | "list"; range?: [number, number] } | undefined;
	const count = (text: string | undefined) => (/^\d+$/.test(text ?? "") ? Number(text) : undefined);
	for (let i = 0; i < args.length; i++) {
		const next = args[i + 1];
		if (args[i] === "--detail") detail = true;
		else if (args[i] === "--oldest") oldest = true;
		else if (args[i] === "--last" && /^[1-9]\d*$/.test(next ?? "")) limit = Number(args[++i]);
		else if (args[i] === "--since" && (since = parseSince(next ?? "")) !== undefined) i++;
		else if (args[i] === "--until" && (until = parseSince(next ?? "")) !== undefined) i++;
		else if (args[i] === "--search" && next?.trim()) search = args[++i];
		else if (args[i] === "--around" && (around = count(next)) !== undefined) i++;
		else if (args[i] === "--before" && (before = count(next)) !== undefined) i++;
		else if (args[i] === "--after" && (after = count(next)) !== undefined) i++;
		else if (args[i] === "--kinds" && next?.split(",").every((k) => (KINDS as readonly string[]).includes(k))) kinds = args[++i]!.split(",");
		else if ((args[i] === "--hide" || args[i] === "--unhide") && parseRange(next ?? "")) hide = { action: args[i] === "--hide" ? "add" : "remove", range: parseRange(args[++i]!)! };
		else if (args[i] === "--hidden") hide = { action: "list" };
		else {
			console.error(USAGE);
			return 2;
		}
	}
	const user = String(readConfigFile(p).user?.name ?? "") || "user";
	if (hide || search !== undefined || around !== undefined || until !== undefined || kinds !== undefined) {
		const client = await connect(p.socket);
		if (client === undefined) return 3;
		const reply = hide
			? await client.request({ op: "hide", requestId: randomUUID(), action: hide.action, ...(hide.range ? { from: hide.range[0], to: hide.range[1] } : {}) })
			: await client.request({
					op: "timeline",
					requestId: randomUUID(),
					...(around !== undefined ? { around, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) } : { query: search ?? "", ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}), ...(kinds ? { kinds } : {}), ...(limit ? { limit } : {}), ...(oldest ? { oldest: true } : {}) }),
				});
		client.close();
		if (reply.type === "hidden") {
			if (json) console.log(JSON.stringify({ ranges: reply.ranges }));
			else console.log(reply.ranges.length ? reply.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join("\n") : "nothing hidden");
			return 0;
		}
		if (reply.type !== "timeline") {
			console.error(reply.type === "error" ? reply.message : "unexpected reply");
			return 1;
		}
		if (json) console.log(JSON.stringify({ more: reply.more, items: reply.items }));
		else if (reply.items.length === 0) console.log("nothing found");
		else console.log(`${renderTimeline(reply.items, { user, ...(search && around === undefined ? { query: search } : {}), ...(around !== undefined ? { mark: around } : {}) })}${reply.more ? "\n(more not shown)" : ""}`);
		return 0;
	}
	const client = await connect(p.socket);
	if (client === undefined) return 3;
	const reply = await client.request({ op: "history", requestId: randomUUID(), ...(limit ? { limit } : {}), ...(since !== undefined ? { since } : {}) });
	client.close();
	if (reply.type !== "history") {
		console.error(reply.type === "error" ? reply.message : "unexpected reply");
		return 1;
	}
	if (json) console.log(JSON.stringify({ earlier: reply.earlier, entries: reply.entries }));
	else console.log(renderHistory(reply.entries, { detail, user, earlier: reply.earlier }));
	return 0;
}

async function device(socket: string, args: string[], json: boolean): Promise<number> {
	const [action, name, ...extra] = args;
	if (!((action === "list" && name === undefined) || ((action === "add" || action === "revoke") && name !== undefined)) || extra.length > 0) {
		console.error(USAGE);
		return 2;
	}
	const client = await connect(socket);
	if (client === undefined) return 3;
	const reply = await client.request({ op: "device", requestId: randomUUID(), action, ...(name ? { name } : {}) });
	client.close();
	if (reply.type !== "devices") {
		console.error(reply.type === "error" ? reply.message : "unexpected reply");
		return 1;
	}
	if (json) console.log(JSON.stringify({ devices: reply.devices, ...(reply.token ? { token: reply.token } : {}), ...(reply.closed !== undefined ? { closed: reply.closed } : {}) }));
	else if (action === "add") console.log(`${name}: ${reply.token}\nShown once; paste it into the device. Revoke with: june device revoke ${name}`);
	else if (action === "revoke") console.log(`revoked ${name}${reply.closed ? `, closed ${reply.closed} connection${reply.closed === 1 ? "" : "s"}` : ""}`);
	else if (reply.devices.length === 0) console.log("no devices");
	else for (const d of reply.devices) console.log(`${d.name}\tadded ${d.createdAt}${d.connections ? `\t${d.connections} connected` : ""}`);
	return 0;
}

async function status(socket: string, json: boolean): Promise<number> {
	const client = await Client.open(socket).catch(() => undefined);
	if (client === undefined) {
		if (json) console.log(JSON.stringify({ ok: false, socket, error: "daemon unavailable" }));
		else console.error(`June is not running (${socket})`);
		return 3;
	}
	const reply = await client.request({ op: "status", requestId: randomUUID() });
	client.close();
	if (reply.type !== "status") {
		console.error(reply.type === "error" ? reply.message : "unexpected reply");
		return 1;
	}
	if (json) console.log(JSON.stringify(reply.status));
	else console.log(formatStatus(reply.status));
	return 0;
}

/** Print one of the boards (see board.ts) the way the clients get it, or as plain lines. */
async function board(socket: string, which: "agenda" | "agents", json: boolean): Promise<number> {
	const client = await Client.open(socket).catch(() => undefined);
	if (client === undefined) {
		console.error(`June is not running (${socket})`);
		return 3;
	}
	const reply = await client.request({ op: which, requestId: randomUUID() });
	client.close();
	if (reply.type === "agenda") console.log(json ? JSON.stringify(reply.agenda) : formatAgenda(reply.agenda));
	else if (reply.type === "agents") console.log(json ? JSON.stringify(reply.agents) : formatAgents(reply.agents));
	else {
		console.error(reply.type === "error" ? reply.message : "unexpected reply");
		return 1;
	}
	return 0;
}

function formatAgenda(a: Agenda): string {
	const row = (e: AgendaEntry) => {
		const t = a.tasks[e.task];
		return `  ${(e.time ?? "").padEnd(5)} ${(t?.state ?? "").padEnd(4)} ${t?.title ?? e.task}${e.extra ? `  (${e.extra.replace(/\s+/g, " ")})` : ""}  · ${t?.project ?? ""}`;
	};
	const lines = [`Agenda for ${a.today}`];
	if (a.overdue.length > 0) lines.push("Overdue", ...a.overdue.map(row));
	for (const [i, day] of a.days.entries()) if (i === 0 || day.entries.length > 0) lines.push(i === 0 ? "Today" : day.date, ...day.entries.map(row));
	lines.push(`By state: ${Object.entries(a.counts).map(([s, n]) => `${s} ${n}`).join(", ")}`);
	return lines.join("\n");
}

function formatAgents(a: Agents): string {
	const title = (key?: string) => (key ? (a.tasks[key]?.title ?? key) : "no task");
	const kinds = { blocked: "blocked on a prompt", asks: "asks you", review: "ready for you to evaluate" };
	const lines: string[] = [];
	const down = a.hosts.filter((h) => !h.ok);
	if (down.length > 0) lines.push(`Unreachable: ${down.map((h) => `${h.host} (${h.error})`).join(", ")}`);
	lines.push(`Needs you: ${a.needs.length === 0 ? "nothing" : ""}`);
	for (const n of a.needs) lines.push(`  ${n.level} ${kinds[n.kind]}: ${title(n.task)}${n.worker ? ` · ${n.worker.host}/${n.worker.terminal}` : ""}`);
	lines.push(`Workers: ${a.workers.length === 0 ? "none" : ""}`);
	for (const w of a.workers) lines.push(`  ${w.agent}@${w.host}/${w.terminal} ${w.status}: ${w.taskKey ? title(w.taskKey) : (w.title ?? w.cwd)}`);
	if (a.queued.length > 0) lines.push("Queued:");
	for (const k of a.queued) {
		const t = a.tasks[k]!;
		lines.push(`  ${t.title} · ${t.agent ?? "?"} on ${t.host ?? "?"}${t.scheduled ? ` · ${t.scheduled}` : ""}${t.dependency && t.dependency.kind !== "ready" ? ` · ${t.dependency.kind}: ${t.dependency.reason}` : ""}`);
	}
	if (a.reviewing.length > 0) lines.push("In agent review:");
	for (const k of a.reviewing) lines.push(`  ${a.tasks[k]!.title}${a.tasks[k]!.reviewParent ? " (the review)" : ""}`);
	if (a.recent.length > 0) lines.push("Reported today:");
	for (const k of a.recent) {
		const t = a.tasks[k]!;
		lines.push(`  ${t.state} ${t.title}: ${t.headline?.text ?? ""}`);
	}
	return lines.join("\n");
}

function formatStatus(s: Status): string {
	return [
		`June ${s.version}, pid ${s.pid}, up since ${s.startedAt}`,
		`code ${s.source}`,
		`model ${s.model} (${s.thinkingLevel})`,
		`conversation ${s.conversation}: ${s.entries} entries, ${s.busy ? "working" : "idle"}${s.background ? `, ${s.background} in the background` : ""}${s.queued ? `, ${s.queued} queued` : ""}`,
		...(s.databaseBytes !== undefined ? [`database ${formatSize(s.databaseBytes)}`] : []),
		`tools ${s.tools.join(", ")}`,
		...(s.remote ? [`remote 127.0.0.1:${s.remote.port}: ${s.remote.error ? `not listening, ${s.remote.error}` : `${s.remote.connections} connected`}`] : []),
	].join("\n");
}

async function doctor(): Promise<number> {
	const checks: [string, () => string | Promise<string>][] = [];
	const p = paths();
	let config: ReturnType<typeof loadConfig> | undefined;
	const check = (name: string, run: () => string | Promise<string>) => checks.push([name, run]);
	check("config", () => {
		config = loadConfig(p);
		return `${p.config}/config.json${config.daemonHost ? `, daemon on ${config.daemonHost}` : ""}`;
	});
	check("identity", () => {
		if (config!.soulFile === undefined) throw new Error(`no SOUL.org in ${p.data}; june init creates it from the templates`);
		accessSync(config!.soulFile, constants.R_OK);
		const memory = existsSync(config!.memoryFile!) ? config!.memoryFile : `${config!.memoryFile} (not yet created)`;
		return `${config!.soulFile}; memory ${memory}; instructions ${config!.instructionsFile ?? "none"}`;
	});
	check("model", async () => {
		const secrets = readEnvFiles(config!.envFiles);
		const models = createJuneModels(secrets);
		models.setProvider(providerFromPiModels(config!.providersFile, config!.model.chat.provider));
		const { provider, modelId } = config!.model.chat;
		if (models.getModel(provider, modelId) === undefined) throw new Error(`${provider}/${modelId} is not in ${config!.providersFile}`);
		const { focus, patter, expression } = config!.model;
		for (const [name, mode] of Object.entries({ focus, patter, expression })) {
			if (mode === undefined) continue;
			if (mode.provider !== provider) models.setProvider(providerFromPiModels(config!.providersFile, mode.provider));
			if (models.getModel(mode.provider, mode.modelId) === undefined) throw new Error(`${name} model ${mode.provider}/${mode.modelId} is not in ${config!.providersFile}`);
		}
		const auth = await models.getAuth(provider);
		// The service reads keys from its EnvironmentFile, which an ordinary shell does not have.
		const modes = Object.entries({ focus, patter, expression }).flatMap(([name, m]) => (m ? [`${name} ${m.provider}/${m.modelId} ${m.thinkingLevel}`] : []));
		const both = [`chat ${provider}/${modelId} ${config!.model.chat.thinkingLevel}`, ...modes].join(", ");
		if (auth === undefined) return `${both}; no key in this shell, the service has its own`;
		return `${both}, key from ${auth.source ?? "?"}`;
	});
	check("daemon", async () => {
		const client = await Client.open(p.socket);
		const reply = await client.request({ op: "status", requestId: randomUUID() });
		client.close();
		if (reply.type !== "status") throw new Error("bad status reply");
		return `pid ${reply.status.pid}`;
	});
	check("hc", async () => {
		const status = JSON.parse(await runProcess(["hc", "server", "status", "--json"], 5000));
		const machines = JSON.parse(await runProcess(["hc", "machine", "ls", "--json"], 5000)).machines ?? [];
		const others = machines.map((m: { name: string; state?: string }) => `${m.name} ${m.state ?? "?"}`).join(", ");
		return `core ${status.core?.name ?? "?"} ${status.version ?? "?"}, ${status.live ?? 0} live terminals${others ? `; machines: ${others}` : ""}`;
	});
	check("org", async () => {
		accessSync(config!.org.root, constants.R_OK);
		await runProcess(["rg", "--version"], 5000);
		return config!.org.root;
	});
	check("org-dispatch", async () => {
		await runProcess(["sh", "-c", "command -v org-dispatch"], 5000);
		return "on PATH";
	});
	check("skills", async () => `${(await findSkills(config!.skillDirs)).length} in ${config!.skillDirs.join(", ")}`);

	let failed = 0;
	for (const [name, run] of checks) {
		try {
			console.log(`ok    ${name}: ${await run()}`);
		} catch (error) {
			failed++;
			console.log(`FAIL  ${name}: ${(error as Error).message}`);
			if (name === "config") break;
		}
	}
	return failed === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	},
);

/**
 * `june org-work`: this host's runtime folders by verdict; `--clean` removes those the rules let go (src/org-work.ts).
 * Each host where agents work runs it weekly from its own timer (programs.june.orgWork in nix/home/org.nix), passing
 * --keep PATH (repeatable), --record FILE and --after-days N; --root and --org override ~/.local/state/org-work and ~/org.
 */
async function orgWorkCommand(args: string[], json: boolean): Promise<number> {
	const { survey, clean } = await import("./org-work.ts");
	const { expandHome } = await import("./config.ts");
	const { createLogger } = await import("./runtime.ts");
	const values = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]!] : []));
	const one = (flag: string) => values(flag).at(-1);
	const known = new Set(["--clean", "--keep", "--record", "--after-days", "--root", "--org"]);
	for (let i = 0; i < args.length; i++) {
		if (!known.has(args[i]!)) { console.error(`june org-work: unknown argument ${args[i]}`); return 2; }
		if (args[i] !== "--clean") i++;
	}
	const afterDays = Number(one("--after-days") ?? 14);
	if (!Number.isInteger(afterDays) || afterDays < 1) { console.error("june org-work: --after-days must be a whole number, 1 or more"); return 2; }
	const now = new Date();
	const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const options = { root: expandHome(one("--root") ?? "~/.local/state/org-work"), org: expandHome(one("--org") ?? "~/org"), afterDays, keep: values("--keep").map(expandHome), today };
	const record = one("--record");
	if (args.includes("--clean")) {
		const result = await clean({ ...options, ...(record ? { record: expandHome(record) } : {}), log: createLogger() });
		if (json) console.log(JSON.stringify(result));
		else console.log(`removed ${result.deleted.length}, could not remove ${result.failed.length}, waiting for you ${result.waiting.length}`);
		return result.failed.length ? 1 : 0;
	}
	const folders = await survey(options);
	if (json) { console.log(JSON.stringify(folders)); return 0; }
	const gb = (n: number) => (n / 1e9).toFixed(2);
	for (const verdict of ["delete", "unsaved", "unlinked", "keep", "open", "recent"] as const) {
		const these = folders.filter((f) => f.verdict === verdict);
		if (!these.length) continue;
		console.log(`${verdict}: ${these.length} folders, ${gb(these.reduce((n, f) => n + f.bytes, 0))} GB`);
		for (const f of these) console.log(`  ${gb(f.bytes).padStart(6)} GB  ${f.dir}${f.why ? `  (${f.why})` : ""}`);
	}
	return 0;
}

/** `june accounts [apply]`: this host's numbered logins, from config.json's accounts and the private ACCOUNTS.org (src/accounts.ts). */
async function accountsCommand(p: ReturnType<typeof paths>, args: string[], json: boolean): Promise<number> {
	const a = await import("./accounts.ts");
	const config = a.accountsConfig(readConfigFile(p).accounts);
	if (!Object.keys(config.harnesses).length) {
		console.error("june accounts: config.json names no accounts");
		return 1;
	}
	if (args[0] === "apply" && args.length === 1) {
		const result = a.apply(config);
		const deployed = config.harnesses.claude ? claudeState() : undefined;
		if (deployed) result.problems.push(deployed);
		if (json) console.log(JSON.stringify(result));
		else {
			for (const f of result.folders) console.log(`made    ${f}`);
			if (result.links) console.log(`linked  ${result.links} shared entries`);
			for (const w of result.wrappers) console.log(`wrote   ${w}`);
			for (const r of result.removed) console.log(`removed ${r}`);
			if (config.harnesses.claude && !deployed) console.log("agents  Claude trust, MCP servers and onboarding in each Claude account folder");
			for (const problem of result.problems) console.log(`problem ${problem}`);
		}
		return result.problems.length ? 1 : 0;
	}
	if (args[0] === "login" && args.length <= 2) return accountsLogin(a, config, p, args[1]);
	if (args.length) {
		console.error(USAGE);
		return 2;
	}
	const rows = await a.status(config, people(p, a.parseAccountsOrg));
	if (json) {
		console.log(JSON.stringify(rows));
		return 0;
	}
	for (const r of rows) {
		const who = r.email ?? (r.loggedIn ? "logged in" : "not logged in");
		console.log(`${r.name.padEnd(8)} ${(r.label ?? "").padEnd(9)} ${who}${r.expected && r.email !== r.expected ? `  (expects ${r.expected})` : ""}`);
		for (const problem of r.problems) console.log(`         ${problem}`);
	}
	return rows.some((r) => r.problems.length) ? 1 : 0;
}

/**
 * `agents apply` for Claude alone, which writes workspace trust, MCP servers and the first-run answers into each Claude
 * account folder's own .claude.json, so a new login opens like the others. A problem line, or undefined when it worked.
 */
function claudeState(): string | undefined {
	const env: NodeJS.ProcessEnv = { ...process.env, AGENTS_HARNESSES: "claude" };
	// Set, it would limit agents apply to that one folder.
	delete env.CLAUDE_CONFIG_DIR;
	const run = spawnSync("agents", ["apply"], { env, encoding: "utf8" });
	if (run.error) return `agents apply: ${run.error.message}; Claude account folders lack trust, MCP servers and onboarding`;
	if (run.status !== 0) return `agents apply failed: ${(run.stderr || run.stdout).trim().split("\n").at(-1)}`;
	return undefined;
}

/** `june accounts login [NAME]`: sign in each login this host lacks, or NAME, as the person ACCOUNTS.org names. */
async function accountsLogin(a: typeof import("./accounts.ts"), config: import("./accounts.ts").AccountsConfig, p: ReturnType<typeof paths>, name?: string): Promise<number> {
	const who = people(p, a.parseAccountsOrg);
	const rows = await a.status(config, who);
	const chosen = name ? rows.filter((r) => r.name === name) : rows.filter((r) => !r.loggedIn);
	if (name && !chosen.length) {
		console.error(`june accounts login: ${name} is not one of ${rows.map((r) => r.name).join(", ")}`);
		return 2;
	}
	if (!chosen.length) {
		console.log("Every login on this host is signed in.");
		return 0;
	}
	let failed = 0;
	for (const slot of chosen) {
		const person = [slot.expected, slot.label && `(${slot.label})`].filter(Boolean).join(" ") || "the right person";
		console.log(`\n${slot.name}: sign in to ${a.PROVIDERS[slot.provider]} as ${person}. Use a private browser window, or sign out first.`);
		if (slot.harness === "agy") console.log("Antigravity starts; sign in there, then quit it.");
		const command = a.loginCommand(slot, slot.expected);
		const run = spawnSync(command[0]!, command.slice(1), { stdio: "inherit" });
		const now = (await a.status(config, who)).find((r) => r.name === slot.name)!;
		if (run.status !== 0 && !now.loggedIn) {
			console.log(`${slot.name}: not signed in.`);
			failed++;
		} else if (now.problems.length) {
			for (const problem of now.problems) console.log(`${slot.name}: ${problem}`);
			failed++;
		} else console.log(`${slot.name}: signed in as ${now.email ?? "an account June cannot name"}.`);
	}
	if (chosen.some((s) => s.harness === "claude")) {
		const deployed = claudeState();
		if (deployed) console.log(deployed);
	}
	return failed ? 1 : 0;
}

/** ACCOUNTS.org beside SOUL.org; empty when it does not exist. */
function people<T>(p: ReturnType<typeof paths>, parse: (text: string) => T): T {
	const file = `${p.data}/ACCOUNTS.org`;
	return parse(existsSync(file) ? readFileSync(file, "utf8") : "");
}

/** `june quota [NAME] [--refresh]`: remaining quota per provider account, cached for two minutes in the state directory. */
async function quotaCommand(p: ReturnType<typeof paths>, args: string[], json: boolean): Promise<number> {
	const a = await import("./accounts.ts");
	const refresh = args.includes("--refresh");
	const names = args.filter((x) => x !== "--refresh");
	if (names.length > 1) {
		console.error(USAGE);
		return 2;
	}
	const config = a.accountsConfig(readConfigFile(p).accounts);
	const name = names[0];
	let only: ((q: { provider: string; number: number }) => boolean) | undefined;
	if (name) {
		const m = /^([a-z]+)(\d)$/.exec(name);
		const provider = m && (m[1]! in a.HARNESSES ? a.HARNESSES[m[1] as keyof typeof a.HARNESSES].provider : m[1] in a.PROVIDERS ? m[1] : undefined);
		if (!m || !provider) {
			console.error(`june quota: ${name} is not an account such as codex2 or openai2`);
			return 2;
		}
		only = (q) => q.provider === provider && q.number === Number(m[2]);
	}
	const file = `${p.state}/quota.json`;
	let rows = refresh ? undefined : a.cached(file, 120);
	if (!rows) {
		rows = await a.quotas(config, people(p, a.parseAccountsOrg));
		a.save(file, rows);
	}
	if (only) rows = rows.filter(only);
	if (json) {
		console.log(JSON.stringify(rows));
		return 0;
	}
	const reset = (t?: number) => (t ? new Date(t * 1000).toLocaleString("en-CA", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "unknown");
	for (const q of rows) {
		console.log(`${a.PROVIDERS[q.provider]} ${q.number}${q.label ? ` (${q.label})` : ""}${q.email ? ` ${q.email}` : ""}${q.source ? `, via ${q.source}` : ""}`);
		if (q.error) console.log(`  ${q.error}`);
		for (const w of q.windows) console.log(`  ${w.group ? `${w.group}: ` : ""}${w.name}: ${w.remaining}% left, resets ${reset(w.resetAt)}`);
	}
	return rows.some((q) => q.error) ? 1 : 0;
}
