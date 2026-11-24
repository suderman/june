// june: the daemon (`serve`) and its clients (`june`, `ask`, `status`, `doctor`).
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { createLogger } from "./runtime.ts";
import { daemonHost, loadConfig, paths, readConfigFile, readEnvFiles, shortHostname } from "./config.ts";
import { startDaemon } from "./daemon.ts";
import { parseSince, renderHistory } from "./history.ts";
import { formatSize } from "./inbox.ts";
import { KINDS, parseRange, renderTimeline } from "./timeline.ts";
import { createJuneModels, DIRECT_PROVIDER, juneProvider } from "./models.ts";
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
  june agents [NAME] [--json]
                          the roster (ROSTER.org): each agent's host, harness, model and effort, whether it is busy,
                          and its battery, the quota its harness has to spare there; NAME shows one agent's card
  june agents leaderboard [--json]
                          per-agent run counts, completions, handoffs, parked runs, and average duration from june.sqlite
  june agents history [NAME] [--limit N] [--json]
                          recent dispatched runs (newest first), optionally for one agent
  june agents pick NAME... [--host HOST] [--harnesses H,H] [--except A,A] [--explain]
                          which of these agents, in your order, to give a task: the first available, unless a later
                          one would lose quota at a reset within hours; a harness name (pi, claude, codex, agy) is
                          an unnamed worker on it; the dispatcher passes its host and the harnesses it can start
  june start NAME [PROMPT...]
                          start roster agent NAME here, in this terminal, on the account its harness picks; refuses
                          while NAME is busy or works on another host
  june tasks [--json]     the dispatched tasks: what needs you, what is working, what is queued, and what finished today
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
  june accounts pick HARNESS [--model MODEL] [--explain] [--trust]
                          the login the plain claude, codex or pi runs: the account with quota to spare, five-hour
                          allowances first; --explain shows every account's standing as JSON; --trust also trusts here
  june accounts check NAME [--model MODEL] [--refresh] [--json]
                          whether login NAME can still work (for MODEL's quota group when given), and which login of
                          its harness would take over
  june accounts trust NAME [DIR]
                          trust DIR's project root (here by default) in login NAME's harness, which each launch does
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
	if (
		["tui", "ask", "status", "agenda", "tasks", "transcript", "device", "usage"].includes(command) ||
		(command === "agents" && ["record", "leaderboard", "stats", "history"].includes(args[0] ?? ""))
	) {
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
			return board(p.socket, "agenda", json);
		case "tasks":
			return board(p.socket, "agents", json);
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
		case "agents":
			return agentsCommand(p, args, json);
		case "start":
			return startCommand(p, args);
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

/**
 * June's models. With openai-codex she signs in through a Pi account login (pi1, pi2, ...): the one with most quota to
 * spare, kept while it lasts, so no proxy stands between her and ChatGPT. Other providers come from Pi's models.json.
 */
async function juneModels(p: ReturnType<typeof paths>, config: ReturnType<typeof loadConfig>, secrets: Record<string, string>) {
	const direct = [config.model.chat, config.model.focus, config.model.patter, config.model.expression].some((m) => m?.provider === DIRECT_PROVIDER);
	let credentials: InstanceType<typeof import("./accounts.ts").AccountCredentials> | undefined;
	if (direct) {
		const a = await import("./accounts.ts");
		credentials = new a.AccountCredentials(async () => {
			const accounts = a.accountsConfig(readConfigFile(p).accounts);
			const logins = (await a.status(accounts, people(p, a.parseAccountsOrg))).filter((r) => r.harness === "pi" && r.loggedIn && !r.problems.length);
			if (!logins.length) return undefined;
			const quotas = await a.sharedQuotas(accounts, people(p, a.parseAccountsOrg), `${p.state}/quota.json`, { maxAge: 600 });
			const ranked = a.rank(logins.map((slot) => ({ slot, quota: quotas!.find((q) => q.provider === slot.provider && q.number === slot.number) })));
			const best = ranked.find((r) => r.usable)?.slot ?? logins[0]!.name;
			return logins.find((s) => s.name === best);
		});
	}
	const models = createJuneModels(secrets, credentials as never);
	for (const id of new Set([config.model.chat.provider])) models.setProvider(juneProvider(config.providersFile, id));
	return models;
}

async function serve(): Promise<number> {
	const p = paths();
	const config = loadConfig(p);
	const secrets = readEnvFiles(config.envFiles);
	const models = await juneModels(p, config, secrets);
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
		const models = await juneModels(paths(), config!, secrets);
		const { provider, modelId } = config!.model.chat;
		if (models.getModel(provider, modelId) === undefined) throw new Error(`${provider}/${modelId} is not in ${config!.providersFile}`);
		const { focus, patter, expression } = config!.model;
		for (const [name, mode] of Object.entries({ focus, patter, expression })) {
			if (mode === undefined) continue;
			if (mode.provider !== provider) models.setProvider(juneProvider(config!.providersFile, mode.provider));
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
	if (args[0] === "pick" && args.length >= 2) {
		const rest = args.slice(2);
		let model: string | undefined;
		let explain = false;
		let trust = false;
		for (let i = 0; i < rest.length; i++) {
			if (rest[i] === "--explain") explain = true;
			else if (rest[i] === "--trust") trust = true;
			else if (rest[i] === "--model" && rest[i + 1]) model = rest[++i];
			else {
				console.error(USAGE);
				return 2;
			}
		}
		return accountsPick(a, config, p, args[1]!, explain, trust, model);
	}
	if (args[0] === "trust" && (args.length === 2 || args.length === 3)) return accountsTrust(a, config, args[1]!, args[2] ?? here());
	if (args[0] === "check" && args.length >= 2) {
		const rest = args.slice(2);
		let model: string | undefined;
		let fresh = false;
		for (let i = 0; i < rest.length; i++) {
			if (rest[i] === "--refresh") fresh = true;
			else if (rest[i] === "--model" && rest[i + 1]) model = rest[++i];
			else {
				console.error(USAGE);
				return 2;
			}
		}
		return accountsCheck(a, config, p, args[1]!, fresh, json, model);
	}
	if (args.length) {
		console.error(USAGE);
		return 2;
	}
	const rows = await a.status(config, people(p, a.parseAccountsOrg));
	if (json) {
		console.log(JSON.stringify(rows));
		return 0;
	}
	const nameWidth = Math.max(8, ...rows.map((x) => x.name.length));
	const labelWidth = Math.max(...rows.map((x) => (x.label ?? "").length)) + 1;
	for (const r of rows) {
		const who = r.email ?? (r.loggedIn ? "logged in" : "not logged in");
		console.log(`${r.name.padEnd(nameWidth)} ${(r.label ?? "").padEnd(labelWidth)} ${who}${r.expected && r.email !== r.expected ? `  (expects ${r.expected})` : ""}`);
		for (const problem of r.problems) console.log(`${"".padEnd(nameWidth)} ${problem}`);
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

/**
 * The daemon host's quota from its listener (GET /quota), authorised by this device's desktop token, as the desktop
 * client connects: undefined when it cannot be reached. JUNE_DAEMON_URL overrides https://june.HOST.
 */
async function daemonQuotas(host: string, fresh: boolean): Promise<import("./accounts.ts").Quota[] | undefined> {
	const base = process.env.JUNE_DAEMON_URL?.replace(/\/+$/, "") || `https://june.${host}`;
	const tokenFile = process.env.JUNE_DESKTOP_TOKEN_FILE || `${homedir()}/.local/state/june-desktop/token`;
	let token: string;
	try {
		token = readFileSync(tokenFile, "utf8").trim();
	} catch {
		return undefined;
	}
	try {
		const response = await fetch(`${base}/quota${fresh ? "?refresh=1" : ""}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(fresh ? 30_000 : 8_000) });
		if (!response.ok) return undefined;
		const body = (await response.json()) as { quotas?: unknown };
		return Array.isArray(body.quotas) ? (body.quotas as import("./accounts.ts").Quota[]) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Every account's quota. Only the daemon's host reads providers, through one shared, rate-limit-aware reader
 * (accounts.ts sharedQuotas) that the daemon keeps fresh; a caller there reads providers itself only when the
 * daemon's copy is ten minutes old, or for --refresh. A worker host never reads them: it asks the daemon host's
 * listener, and while that cannot be reached it uses its last answer, marked stale.
 */
async function currentQuotas(a: typeof import("./accounts.ts"), config: import("./accounts.ts").AccountsConfig, p: ReturnType<typeof paths>, fresh = false) {
	const file = `${p.state}/quota.json`;
	const host = remoteHost(p);
	if (!host) return a.sharedQuotas(config, people(p, a.parseAccountsOrg), file, { maxAge: 600, force: fresh });
	const saved = fresh ? undefined : a.cached(file, 120);
	if (saved) return saved;
	const remote = await daemonQuotas(host, fresh);
	if (remote) {
		a.save(file, remote);
		return remote;
	}
	const last = a.savedQuotas(file)?.quotas ?? [];
	return last.map((q) => ({ ...q, stale: true, error: q.error ?? `${host} did not answer for its quota` }));
}

/**
 * `june accounts pick HARNESS [--explain]`: the login the plain-name wrapper runs, printed alone. Without fresh quota
 * for any account it falls back to the lowest-numbered login, so a session still starts.
 */
async function accountsPick(
	a: typeof import("./accounts.ts"),
	config: import("./accounts.ts").AccountsConfig,
	p: ReturnType<typeof paths>,
	harness: string,
	explain: boolean,
	trustHere = false,
	model?: string,
): Promise<number> {
	if (!(harness in a.HARNESSES) || !config.harnesses[harness as keyof typeof a.HARNESSES]) {
		console.error(`june accounts pick: ${harness} has no accounts here`);
		return 2;
	}
	const rows = (await a.status(config, people(p, a.parseAccountsOrg))).filter((r) => r.harness === harness && r.loggedIn && !r.problems.length);
	if (!rows.length) {
		console.error(`june accounts pick: no ${harness} login here is signed in as ACCOUNTS.org expects; run june accounts login`);
		return 1;
	}
	const quotas = await currentQuotas(a, config, p);
	const ranked = a.rank(
		rows.map((slot) => ({ slot, quota: quotas.find((q) => q.provider === slot.provider && q.number === slot.number) })),
		undefined,
		model,
	);
	const chosen = ranked.find((r) => r.usable)?.slot;
	const fallback = chosen ? undefined : rows[0]!.name;
	if (trustHere) await accountsTrust(a, config, chosen ?? fallback!, here());
	if (explain) console.log(JSON.stringify({ selected: chosen ?? fallback, fallback: !!fallback, accounts: ranked }));
	else {
		if (fallback) console.error(`june accounts pick: no account has fresh quota to spare (${ranked.map((r) => `${r.slot}: ${r.reason}`).join("; ")}); using ${fallback}`);
		console.log(chosen ?? fallback);
	}
	return 0;
}

/**
 * `june accounts check NAME [--model MODEL] [--refresh] [--json]`: whether login NAME can still work, and if not, the
 * login of the same harness that would take over. The dispatcher asks this of an idle worker before nudging it, to
 * continue its session on another account rather than nudge one that has run out.
 */
async function accountsCheck(
	a: typeof import("./accounts.ts"),
	config: import("./accounts.ts").AccountsConfig,
	p: ReturnType<typeof paths>,
	name: string,
	fresh: boolean,
	json: boolean,
	model?: string,
): Promise<number> {
	const rows = await a.status(config, people(p, a.parseAccountsOrg));
	const slot = rows.find((r) => r.name === name);
	if (!slot) {
		console.error(`june accounts check: ${name} is not a login here`);
		return 2;
	}
	const mine = rows.filter((r) => r.harness === slot.harness && r.loggedIn && !r.problems.length);
	const quotas = await currentQuotas(a, config, p, fresh);
	const ranked = a.rank(
		mine.map((s) => ({ slot: s, quota: quotas.find((q) => q.provider === s.provider && q.number === s.number) })),
		undefined,
		model,
	);
	const own = ranked.find((r) => r.slot === name);
	// Another account of the same provider number shares this one's quota, so it cannot take over.
	const next = ranked.find((r) => r.usable && r.slot !== name && mine.find((s) => s.name === r.slot)?.number !== slot.number)?.slot;
	const result = { name, usable: own?.usable ?? false, reason: own?.reason ?? "not signed in here", ...(next ? { next } : {}) };
	if (json) console.log(JSON.stringify(result));
	else console.log(`${name}: ${result.usable ? "can work" : `out (${result.reason})`}${next ? `; ${next} would take over` : ""}`);
	return 0;
}

/** The working directory as the shell names it: $PWD keeps a symlinked path that process.cwd() resolves. */
function here(): string {
	const pwd = process.env.PWD;
	try {
		if (pwd?.startsWith("/") && realpathSync(pwd) === realpathSync(process.cwd())) return pwd;
	} catch {}
	return process.cwd();
}

/** `june accounts trust NAME [DIR]`: trust DIR's project root (the working directory's by default) in login NAME's harness,
 * as the harness records a "trust this folder" answer. The wrappers run it before each launch; it never stops one. */
async function accountsTrust(a: typeof import("./accounts.ts"), config: import("./accounts.ts").AccountsConfig, name: string, dir: string): Promise<number> {
	const slot = a.slots(config).find((s) => s.name === name);
	if (!slot) {
		console.error(`june accounts trust: ${name} is not a login here`);
		return 2;
	}
	try {
		for (const root of a.trust(slot, await a.projectRoots(dir))) console.error(`${name}: trusted ${root}`);
	} catch (error) {
		console.error(`june accounts trust: ${(error as Error).message}`);
		return 1;
	}
	return 0;
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
	let rows = await currentQuotas(a, config, p, refresh);
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

/** Each roster card with whether it is busy (a live terminal carries its june.agent label) and, on this host, its battery:
 * the tightest window left on the account its harness would pick now. */
async function rosterStanding(p: ReturnType<typeof paths>): Promise<import("./roster.ts").RosterEntry[]> {
	const { computeStanding, parseRoster } = await import("./roster.ts");
	const a = await import("./accounts.ts");
	const { Herdr } = await import("./tools/herdr.ts");
	const file = `${p.data}/ROSTER.org`;
	const cards = parseRoster(existsSync(file) ? readFileSync(file, "utf8") : "");
	const config = loadConfig(p);
	const herdr = new Herdr(config.herdr);
	const here = shortHostname();
	const hosts = new Map<string, Awaited<ReturnType<typeof herdr.agents>> | undefined>();
	for (const host of new Set(cards.flatMap((c) => (c.host ? [c.host] : [])))) hosts.set(host, await herdr.agents(host).catch(() => undefined));
	const accounts = a.accountsConfig(readConfigFile(p).accounts);
	const logins = await a.status(accounts, people(p, a.parseAccountsOrg));
	const quotas = logins.length ? await currentQuotas(a, accounts, p) : [];
	return computeStanding(cards, hosts, logins, quotas, here);
}

/** `june agents [NAME|pick|leaderboard|history|record]`: roster, picker, run history and leaderboard. */
async function agentsCommand(p: ReturnType<typeof paths>, args: string[], json: boolean): Promise<number> {
	if (args[0] === "pick") return agentsPick(p, args.slice(1).filter((x) => x !== "--explain"), json || args.includes("--explain"));
	if (args[0] === "record") return agentsRecord(p, args.slice(1));
	if (args[0] === "leaderboard" || args[0] === "stats") return agentsLeaderboard(p, json);
	if (args[0] === "history") return agentsHistory(p, args.slice(1), json);
	if (args.length > 1) {
		console.error(USAGE);
		return 2;
	}
	const { findCard } = await import("./roster.ts");
	const { statsByAgent } = await import("./runs.ts");
	let rows = await rosterStanding(p);
	if (!rows.length) {
		console.error(`june agents: ${p.data}/ROSTER.org names no agents`);
		return 1;
	}
	const { stats } = statsByAgent(p.database);
	for (const row of rows) {
		const s = stats.get(row.card.slug);
		if (s) row.stats = { rank: s.rank, runs: s.runs, completed: s.completed, handoffs: s.handoffs, parked: s.parked, ...(s.avgDurationMs !== undefined ? { avgDurationMs: s.avgDurationMs } : {}), ...(s.lastRunAt !== undefined ? { lastRunAt: s.lastRunAt } : {}) };
	}
	if (args[0]) {
		const card = findCard(rows.map((r) => r.card), args[0]);
		if (!card) {
			console.error(`june agents: no agent called ${args[0]}; the roster has ${rows.map((r) => r.card.name).join(", ")}`);
			return 2;
		}
		rows = rows.filter((r) => r.card === card);
	}
	if (json) {
		console.log(JSON.stringify(args[0] ? rows[0] : rows));
		return 0;
	}
	const battery = (b: import("./roster.ts").RosterEntry["battery"]) =>
		!b ? "" : "account" in b ? `${b.weekly}% weekly, resets in ${b.hours < 48 ? `${Math.round(b.hours)}h` : `${Math.round(b.hours / 24)}d`}, via ${b.account}` : b.reason;
	if (args[0]) {
		const { card, status, terminal, battery: b, stats: s } = rows[0]!;
		const runSummary = s ? `#${s.rank} · ${s.runs} run${s.runs === 1 ? "" : "s"} (${s.completed} ok${s.handoffs ? `, ${s.handoffs} handoff` : ""}${s.parked ? `, ${s.parked} parked` : ""}${s.avgDurationMs ? `, ${formatDuration(s.avgDurationMs)} avg` : ""})` : undefined;
		console.log(`${card.name} (${card.slug})`);
		for (const [k, v] of [["host", card.host], ["harness", card.harness], ["model", card.model ?? "the harness's default"], ["effort", card.effort ?? "the harness's default"], ["avatar", card.avatar], ["status", terminal ? `${status} in ${terminal}` : status], ["battery", battery(b)], ["history", runSummary]] as const)
			if (v) console.log(`  ${k.padEnd(8)} ${v}`);
		for (const problem of card.problems) console.log(`  problem  ${problem}`);
		if (card.instructions) console.log(`\n${card.instructions}`);
		return card.problems.length ? 1 : 0;
	}
	const width = Math.max(...rows.map((r) => r.card.name.length));
	for (const { card, status, terminal, battery: b } of rows) {
		const kit = [card.harness, card.model, card.effort].filter(Boolean).join(" ");
		console.log(`${card.name.padEnd(width)}  ${(card.host ?? "?").padEnd(4)}  ${kit.padEnd(28)}  ${(terminal ? `${status} ${terminal}` : status).padEnd(16)}  ${battery(b)}`);
		for (const problem of card.problems) console.log(`${"".padEnd(width)}  ${problem}`);
	}
	return 0;
}

function formatDuration(ms?: number): string {
	if (ms === undefined || ms < 0) return "—";
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	return m ? `${h}h ${m}m` : `${h}h`;
}

/** `june agents record start|end ...`: called by org-dispatch to record run history in june.sqlite. */
async function agentsRecord(p: ReturnType<typeof paths>, args: string[]): Promise<number> {
	const phase = args[0];
	const rest = args.slice(1);
	const flag = (name: string): string | undefined => {
		const i = rest.indexOf(name);
		if (i < 0) return undefined;
		const val = rest[i + 1];
		rest.splice(i, 2);
		return val;
	};
	const { recordRunEnd, recordRunStart } = await import("./runs.ts");
	const at = flag("--at");
	const atMs = at !== undefined && Number.isFinite(Number(at)) ? Number(at) : undefined;
	if (phase === "start") {
		recordRunStart(p.database, {
			run: flag("--run") ?? "",
			taskId: flag("--task") ?? "",
			taskTitle: flag("--title") ?? "",
			agent: flag("--agent") ?? "",
			harness: flag("--harness") ?? "",
			host: flag("--host") ?? "",
			model: flag("--model") ?? "",
			...(atMs !== undefined ? { startedAt: atMs } : {}),
		});
		return 0;
	}
	if (phase === "end") {
		const sw = flag("--switches");
		recordRunEnd(p.database, {
			run: flag("--run") ?? "",
			outcome: flag("--outcome") ?? "",
			taskId: flag("--task"),
			taskTitle: flag("--title"),
			agent: flag("--agent"),
			harness: flag("--harness"),
			host: flag("--host"),
			model: flag("--model"),
			...(atMs !== undefined ? { endedAt: atMs } : {}),
			...(sw !== undefined && Number.isFinite(Number(sw)) ? { switches: Number(sw) } : {}),
			note: flag("--note") ?? "",
		});
		return 0;
	}
	console.error("usage: june agents record start|end --run ID ...");
	return 2;
}

/** `june agents leaderboard [--json]`: per-agent completion counts and stats from june.sqlite. */
async function agentsLeaderboard(p: ReturnType<typeof paths>, json: boolean): Promise<number> {
	const { leaderboard } = await import("./runs.ts");
	const rows = leaderboard(p.database);
	if (json) {
		console.log(JSON.stringify(rows));
		return 0;
	}
	if (!rows.length) {
		console.log("No agent runs recorded yet.");
		return 0;
	}
	const width = Math.max(5, ...rows.map((r) => r.agent.length));
	console.log(`${"#".padEnd(3)} ${"AGENT".padEnd(width)}  ${"RUNS".padStart(4)}  ${"OK".padStart(4)}  ${"RATE".padStart(5)}  ${"HAND".padStart(4)}  ${"PARK".padStart(4)}  ${"AVG".padStart(6)}  LAST`);
	for (const r of rows) {
		const finished = r.runs - r.running;
		const rate = finished > 0 ? `${Math.round((r.completed * 100) / finished)}%` : "—";
		const last = r.lastRunAt ? new Date(r.lastRunAt).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
		console.log(`${String(r.rank).padEnd(3)} ${r.agent.padEnd(width)}  ${String(r.runs).padStart(4)}  ${String(r.completed).padStart(4)}  ${rate.padStart(5)}  ${String(r.handoffs).padStart(4)}  ${String(r.parked).padStart(4)}  ${formatDuration(r.avgDurationMs).padStart(6)}  ${last}`);
	}
	return 0;
}

/** `june agents history [NAME] [--limit N] [--json]`: recent dispatched runs, newest first. */
async function agentsHistory(p: ReturnType<typeof paths>, args: string[], json: boolean): Promise<number> {
	const rest = [...args];
	const li = rest.indexOf("--limit");
	let limit = 20;
	if (li >= 0) {
		limit = Number(rest[li + 1] ?? 20);
		rest.splice(li, 2);
	}
	const agent = rest[0];
	const { listRuns } = await import("./runs.ts");
	const rows = listRuns(p.database, { ...(agent ? { agent } : {}), limit });
	if (json) {
		console.log(JSON.stringify(rows));
		return 0;
	}
	if (!rows.length) {
		console.log(agent ? `No runs recorded for ${agent}.` : "No agent runs recorded yet.");
		return 0;
	}
	const width = Math.max(5, ...rows.map((r) => r.agent.length));
	for (const r of rows) {
		const at = new Date(r.startedAt).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
		const dur = r.endedAt !== undefined && r.endedAt >= r.startedAt ? formatDuration(r.endedAt - r.startedAt) : "live";
		const label = r.taskTitle || r.taskId;
		console.log(`${at.padEnd(13)}  ${r.agent.padEnd(width)}  ${r.outcome.padEnd(7)}  ${dur.padStart(6)}  ${label}${r.note ? ` — ${r.note}` : ""}`);
	}
	return 0;
}

/**
 * `june agents pick NAME... [--explain]`: the candidate to give a task, from names in the user's order: the first one
 * available, unless a later one would otherwise lose quota at a reset within hours. Prints the name alone.
 */
async function agentsPick(p: ReturnType<typeof paths>, args: string[], json: boolean): Promise<number> {
	const { choose, findCard } = await import("./roster.ts");
	const a = await import("./accounts.ts");
	const flag = (name: string) => {
		const i = args.indexOf(name);
		if (i < 0) return undefined;
		const value = args[i + 1];
		args.splice(i, 2);
		return value;
	};
	// The dispatcher asks for agents on its own host that it knows how to start.
	const host = flag("--host");
	const harnesses = flag("--harnesses")?.split(",");
	// Agents the dispatcher has given a task earlier in this pass, not yet labelled busy.
	const taken = new Set(flag("--except")?.split(",") ?? []);
	const names = args;
	if (!names.length) {
		console.error("june agents pick: name the candidates, in order");
		return 2;
	}
	const rows = await rosterStanding(p);
	type Option = import("./roster.ts").Option & { row?: import("./roster.ts").RosterEntry; legacy?: string };
	const option = (row: import("./roster.ts").RosterEntry): Option => {
		const b = row.battery;
		const quota = b && "account" in b ? { weekly: b.weekly, hours: b.hours, rate: b.rate } : {};
		const base = { name: row.card.slug, row, ...quota };
		if (taken.has(row.card.slug)) return { ...base, available: false, reason: "given a task this pass" };
		if (host && row.card.host !== host) return { ...base, available: false, reason: `works on ${row.card.host}` };
		if (harnesses && !harnesses.includes(row.card.harness ?? "")) return { ...base, available: false, reason: `the dispatcher cannot start ${row.card.harness} yet` };
		// A card on another host is available while idle; its quota is read there.
		const spent = b && "reason" in b && !b.reason.startsWith("quota is read on");
		return { ...base, available: row.status === "idle" && !spent, reason: spent ? (b as { reason: string }).reason : row.status };
	};
	const options: Option[] = names.flatMap((name): Option[] => {
		const row = rows.find((r) => r.card === findCard(rows.map((x) => x.card), name));
		if (row) return [option(row)];
		// A harness name means an unnamed worker on it, as before the roster: always free, any number at once.
		if (name in a.HARNESSES) {
			if (harnesses && !harnesses.includes(name)) return [{ name, available: false, reason: `the dispatcher cannot start ${name} yet` }];
			return [{ name, legacy: name, available: true, reason: `an unnamed ${name} worker` }];
		}
		return [{ name, available: false, reason: "not on the roster" }];
	});
	const result = choose(options);
	const picked = options.find((o) => o.name === result.chosen);
	if (json)
		console.log(
			JSON.stringify({
				...result,
				...(picked?.row ? { card: picked.row.card } : {}),
				...(picked?.legacy ? { legacy: picked.legacy } : {}),
				options: options.map(({ row: _, ...o }) => o),
			}),
		);
	else if (result.chosen) console.log(result.chosen);
	else console.error(`june agents pick: none is available (${result.why})`);
	return result.chosen ? 0 : 1;
}

/** `june start NAME [PROMPT...]`: run a roster agent in this terminal, labelled as its while it runs. */
async function startCommand(p: ReturnType<typeof paths>, args: string[]): Promise<number> {
	const [name, ...words] = args;
	if (!name) {
		console.error(USAGE);
		return 2;
	}
	const { findCard, launchArgs } = await import("./roster.ts");
	const rows = await rosterStanding(p);
	const row = rows.find((r) => r.card === findCard(rows.map((x) => x.card), name));
	if (!row) {
		console.error(`june start: no agent called ${name}; the roster has ${rows.map((r) => r.card.name).join(", ") || "no one"}`);
		return 2;
	}
	const { card } = row;
	if (card.problems.length) {
		console.error(`june start: ${card.name}'s card has problems: ${card.problems.join("; ")}`);
		return 1;
	}
	if (card.host !== shortHostname()) {
		console.error(`june start: ${card.name} works on ${card.host}; start it there`);
		return 1;
	}
	if (row.terminal) {
		console.error(`june start: ${card.name} is busy in ${row.terminal}; one task at a time`);
		return 1;
	}
	// Label this terminal as the agent's while it runs, so the roster shows it busy; the label goes when it stops.
	const terminal = process.env.HC_TERMINAL_ID;
	const label = (value: string) => terminal && spawnSync("hc", ["label", terminal, `june.agent=${value}`], { stdio: "ignore" });
	if (!terminal) console.error(`june start: not in a herdr terminal, so the roster cannot show ${card.name} busy`);
	label(card.slug);
	// Ctrl+C belongs to the agent; june stays to take the label off when it exits.
	for (const signal of ["SIGINT", "SIGQUIT"] as const) process.on(signal, () => {});
	const run = spawnSync(card.harness!, launchArgs(card, words.join(" ") || undefined), { stdio: "inherit" });
	label("");
	if (run.error) {
		console.error(`june start: ${card.harness}: ${run.error.message}`);
		return 1;
	}
	return run.status ?? 1;
}
