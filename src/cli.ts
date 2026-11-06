// june: the daemon (`serve`) and its clients (`june`, `ask`, `status`, `doctor`).
import { spawn } from "node:child_process";
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
import { runProcess } from "./tools/herdr.ts";

const USAGE = `usage:
  june                    open the terminal client
  june ask [--json] TEXT  send one message and print the answer ("-" or no text reads stdin)
  june status [--json]    daemon, model, and conversation state, without a model call
  june transcript [--last N] [--since WHEN] [--detail] [--json]
                          the recent conversation as text: the last N entries (200 by default), or those since
                          WHEN (30m, 2h, 1d, 16:20, or a date); --detail adds thinking, tool output, and private looks
  june transcript --search WORDS [--since WHEN] [--until WHEN] [--kinds K,K] [--last N] [--json]
                          search the whole timeline, newest first: every word must appear, "a phrase" as it is;
                          kinds are user, june, patter, action, note
  june transcript --around ID [--before N] [--after N] [--json]
                          the timeline around entry ID, from a search result
  june transcript --hide ID[-ID] | --unhide ID[-ID] | --hidden
                          leave entries out of the timeline, transcripts, and views (they stay in the database)
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
	if (["tui", "ask", "status", "transcript", "device"].includes(command)) {
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
		case "transcript":
			return transcript(p, args, json);
		case "device":
			return device(p.socket, args, json);
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
	let hide: { action: "add" | "remove" | "list"; range?: [number, number] } | undefined;
	const count = (text: string | undefined) => (/^\d+$/.test(text ?? "") ? Number(text) : undefined);
	for (let i = 0; i < args.length; i++) {
		const next = args[i + 1];
		if (args[i] === "--detail") detail = true;
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
					...(around !== undefined ? { around, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) } : { query: search ?? "", ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}), ...(kinds ? { kinds } : {}), ...(limit ? { limit } : {}) }),
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
	check("herdr", async () => {
		const out = await runProcess(["herdr", "--session", config!.herdr.session, "status", "server"], 5000);
		return out.split("\n").filter((l) => /status|version/.test(l)).join(", ");
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
