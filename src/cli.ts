// june: the daemon (`serve`) and its clients (`june`, `ask`, `status`, `doctor`).
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createLogger } from "pi-durable-telegram";
import { loadConfig, paths, readEnvFiles } from "./config.ts";
import { startDaemon } from "./daemon.ts";
import { createJuneModels, providerFromPiModels } from "./models.ts";
import { findSkills } from "./prompt.ts";
import { Client, DaemonUnavailable, type Reply, type Status } from "./protocol.ts";
import { runProcess } from "./tools/herdr.ts";

const USAGE = `usage:
  june                    open the terminal client
  june ask [--json] TEXT  send one message and print the answer ("-" or no text reads stdin)
  june status [--json]    daemon, model, and conversation state, without a model call
  june doctor             check configuration and dependencies
  june serve              run the daemon`;

// Exit codes: 0 ok, 1 failed or unanswered, 2 usage, 3 daemon unavailable.
async function main(argv: string[]): Promise<number> {
	const [command = "tui", ...rest] = argv;
	const json = rest.includes("--json");
	const args = rest.filter((a) => a !== "--json");
	const p = paths();
	switch (command) {
		case "tui": {
			const { runTui } = await import("./tui.ts");
			await runTui(p.socket);
			return 0;
		}
		case "serve":
			return serve();
		case "ask":
			return ask(p.socket, args, json);
		case "status":
			return status(p.socket, json);
		case "doctor":
			return doctor();
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

async function serve(): Promise<number> {
	const p = paths();
	const config = loadConfig(p);
	const secrets = readEnvFiles(config.envFiles);
	const models = createJuneModels(secrets);
	models.setProvider(providerFromPiModels(config.providersFile, config.model.provider));
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
		`model ${s.model} (${s.thinkingLevel})`,
		`conversation ${s.conversation}: ${s.entries} entries, ${s.busy ? "working" : "idle"}${s.queued ? `, ${s.queued} queued` : ""}`,
		`telegram ${s.telegram}`,
		`tools ${s.tools.join(", ")}`,
	].join("\n");
}

async function doctor(): Promise<number> {
	const checks: [string, () => string | Promise<string>][] = [];
	const p = paths();
	let config: ReturnType<typeof loadConfig> | undefined;
	const check = (name: string, run: () => string | Promise<string>) => checks.push([name, run]);
	check("config", () => {
		config = loadConfig(p);
		return existsSync(`${p.config}/config.json`) ? `${p.config}/config.json` : "defaults (no config.json)";
	});
	check("identity", () => {
		accessSync(config!.soulFile, constants.R_OK);
		return config!.soulFile;
	});
	check("model", async () => {
		const secrets = readEnvFiles(config!.envFiles);
		const models = createJuneModels(secrets);
		models.setProvider(providerFromPiModels(config!.providersFile, config!.model.provider));
		const { provider, modelId } = config!.model;
		if (models.getModel(provider, modelId) === undefined) throw new Error(`${provider}/${modelId} is not in ${config!.providersFile}`);
		const auth = await models.getAuth(provider);
		if (auth === undefined) throw new Error(`no credential for ${provider}`);
		return `${provider}/${modelId}, key from ${auth.source ?? "?"}`;
	});
	check("daemon", async () => {
		const client = await Client.open(p.socket);
		const reply = await client.request({ op: "status", requestId: randomUUID() });
		client.close();
		if (reply.type !== "status") throw new Error("bad status reply");
		return `pid ${reply.status.pid}, telegram ${reply.status.telegram}`;
	});
	check("telegram", () => {
		const tg = config!.telegram;
		if (tg === undefined) return "not configured";
		if (tg.allowedUserIds.length === 0) throw new Error("telegram.allowedUserIds is empty");
		const has = readEnvFiles(config!.envFiles)[tg.tokenEnv] ?? process.env[tg.tokenEnv];
		if (!has) throw new Error(`${tg.tokenEnv} is not set for this shell (the service may still have it)`);
		return `${tg.allowedUserIds.length} allowed user(s), token in ${tg.tokenEnv}`;
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
