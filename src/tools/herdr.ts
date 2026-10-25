// Herdr tools: structured reads of live agent panes through the herdr CLI's JSON API, and an opt-in prompt.
import { execFile } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";

const TARGET = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;

export type Run = (argv: readonly string[], timeoutMs: number) => Promise<string>;

export const runProcess: Run = (argv, timeoutMs) =>
	new Promise((resolve, reject) => {
		execFile(argv[0]!, argv.slice(1), { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (!error) return resolve(stdout);
			const failure = new Error(`${argv.slice(0, 4).join(" ")}: ${(stderr || error.message).trim().slice(0, 500)}`);
			reject(Object.assign(failure, { exitCode: typeof error.code === "number" ? error.code : undefined, stdout }));
		});
	});

export class Herdr {
	readonly #config: Config["herdr"];
	readonly #run: Run;

	constructor(config: Config["herdr"], run: Run = runProcess) {
		this.#config = config;
		this.#run = run;
	}

	hosts(): string[] {
		return [this.#config.host, ...Object.keys(this.#config.hosts)];
	}

	/** argv for `herdr --session <s> ...args` on `host`; other hosts go over SSH with token-only arguments. */
	#argv(host: string, args: readonly string[]): string[] {
		const base = ["herdr", "--session", this.#config.session, ...args];
		if (host === this.#config.host) return base;
		const remote = this.#config.hosts[host];
		if (remote === undefined) throw new Error(`Unknown host ${host}; known: ${this.hosts().join(", ")}`);
		if (!base.every((arg) => TARGET.test(arg) || /^--?[a-z-]+$/.test(arg)))
			throw new Error("Remote Herdr calls take simple arguments only");
		return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", remote.ssh ?? host, ...base];
	}

	async json(host: string, args: readonly string[], timeoutMs = 15_000): Promise<any> {
		const out = await this.#run(this.#argv(host, args), timeoutMs).catch((error: Error & { stdout?: string }) => {
			if (error.stdout?.trim().startsWith("{")) return error.stdout;
			throw error;
		});
		const json = JSON.parse(out);
		if (json?.error) throw new Error(`herdr on ${host}: ${json.error.code}: ${json.error.message}`);
		return json;
	}

	async text(host: string, args: readonly string[], timeoutMs = 15_000): Promise<string> {
		return this.#run(this.#argv(host, args), timeoutMs);
	}

	async agents(host: string): Promise<AgentSummary[]> {
		const [agents, workspaces] = await Promise.all([
			this.json(host, ["agent", "list"]),
			this.json(host, ["workspace", "list"]).catch(() => undefined),
		]);
		const labels = new Map<string, string>();
		for (const ws of workspaces?.result?.workspaces ?? []) labels.set(ws.workspace_id, ws.label);
		return (agents?.result?.agents ?? []).map((agent: any) => summarize(host, agent, labels));
	}

	async read(host: string, target: string, lines: number): Promise<string> {
		const args = ["agent", "read", checkTarget(target), "--source", "recent-unwrapped", "--lines", String(lines)];
		const out = await this.text(host, args);
		// `agent read` prints JSON in this Herdr version; older ones print text.
		try {
			const json = JSON.parse(out);
			return String(json?.result?.text ?? json?.result?.content ?? out);
		} catch {
			return out;
		}
	}

	prompt(target: string, text: string): Promise<any> {
		return this.json(this.#config.host, ["agent", "prompt", checkTarget(target), "--", text]);
	}
}

export type AgentSummary = {
	host: string;
	pane: string;
	agent: string;
	status: string;
	workspace: string;
	cwd: string;
	session?: string;
	title?: string;
	focused: boolean;
	herdrLink?: string;
};

function summarize(host: string, agent: any, labels: Map<string, string>): AgentSummary {
	const session = agent.agent_session?.value as string | undefined;
	const uuid = session?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0];
	return {
		host,
		pane: agent.pane_id,
		agent: agent.agent,
		status: agent.agent_status,
		workspace: labels.get(agent.workspace_id) ?? agent.workspace_id,
		cwd: agent.foreground_cwd ?? agent.cwd,
		...(uuid ? { session: uuid, herdrLink: `herdr:${host}/${agent.agent}:${uuid}` } : {}),
		...(agent.terminal_title_stripped ? { title: String(agent.terminal_title_stripped).slice(0, 120) } : {}),
		focused: agent.focused === true,
	};
}

function checkTarget(target: string): string {
	if (!TARGET.test(target)) throw new Error(`Invalid Herdr target ${JSON.stringify(target)}`);
	return target;
}

function json(value: unknown) {
	return { output: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}

export function createHerdrExtension(config: Config, herdr = new Herdr(config.herdr)): Extension {
	const host = Type.Optional(
		Type.String({ description: `Machine to inspect; default ${config.herdr.host}. Known: ${herdr.hosts().join(", ")}` }),
	);
	const tools = [
		defineTool({
			name: "herdr_list_agents",
			description:
				"List the coding agents (Pi, Claude, Codex) running in Herdr panes on a machine, with status (working, blocked, done, idle, unknown), workspace, directory, and session link. blocked means the agent waits for a person.",
			parameters: Type.Object({ host, status: Type.Optional(Type.String({ description: "Only agents with this status" })) }),
			replay: "safe",
			execute: async (args) => {
				const agents = await herdr.agents(args.host ?? config.herdr.host);
				return json(args.status ? agents.filter((a) => a.status === args.status) : agents);
			},
		}),
		defineTool({
			name: "herdr_get_agent",
			description: "Show one Herdr agent pane in full, by pane id (such as w4Z:p1) or agent name.",
			parameters: Type.Object({ target: Type.String(), host }),
			replay: "safe",
			execute: async (args) =>
				json((await herdr.json(args.host ?? config.herdr.host, ["agent", "get", checkTarget(args.target)])).result),
		}),
		defineTool({
			name: "herdr_read_agent",
			description: "Read the recent terminal output of a Herdr agent pane, to see what it is doing or asking.",
			parameters: Type.Object({
				target: Type.String(),
				host,
				lines: Type.Optional(Type.Integer({ minimum: 10, maximum: 400, description: "Default 80" })),
			}),
			replay: "safe",
			execute: async (args) => {
				const text = await herdr.read(args.host ?? config.herdr.host, args.target, args.lines ?? 80);
				return { output: [{ type: "text", text: text.trim() || "(no output)" }] };
			},
		}),
	];
	if (config.herdr.allowPrompt) {
		tools.push(
			defineTool({
				name: "herdr_prompt_agent",
				description: `Send a follow-up prompt to an existing agent on ${config.herdr.host}. Use only when Jon asked for this message to be sent to that agent. It types into the agent's terminal; it is not repeated after a restart.`,
				parameters: Type.Object({ target: Type.String(), text: Type.String({ minLength: 1, maxLength: 4000 }) }),
				execute: async (args) => json((await herdr.prompt(args.target, args.text)).result ?? { sent: true }),
			}) as never,
		);
	}
	return defineExtension({ name: "herdr", tools });
}
