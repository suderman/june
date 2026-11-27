// Herdr tools: structured reads and user-requested follow-ups through herdr-core's CLI, hc.
// hc runs each agent in a terminal with a permanent address (t7). Another machine's terminals are reached as
// HOST/t7 when this core has that machine added (`hc machine add HOST`), and over SSH otherwise.
import { execFile } from "node:child_process";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { HARNESS_ALIASES } from "../../desktop/harnesses.mjs";
import type { Config } from "../config.ts";

/** A terminal address (t7), a name, or a session label value; never a path or an option. */
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const isKnownAgent = (name: unknown) => typeof name === "string" && name.toLowerCase() in HARNESS_ALIASES;

export type Run = (argv: readonly string[], timeoutMs: number) => Promise<string>;

export const runProcess: Run = (argv, timeoutMs) =>
	new Promise((resolve, reject) => {
		execFile(argv[0]!, argv.slice(1), { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (!error) return resolve(stdout);
			const failure = new Error(`${argv.slice(0, 4).join(" ")}: ${(stderr || error.message).trim().slice(0, 500)}`);
			reject(Object.assign(failure, { exitCode: typeof error.code === "number" ? error.code : undefined, stdout, stderr }));
		});
	});

/** An hc terminal record, as `hc get` prints it. */
export type Terminal = {
	address: string;
	state: "live" | "finished";
	status?: { state?: string; app?: string; kind?: string; msg?: string } | null;
	labels?: Record<string, string>;
	cwd?: string;
	title?: string;
	turn?: number;
	foreground?: { name?: string; cwd?: string } | null;
};

export class Herdr {
	readonly #config: Config["herdr"];
	readonly #run: Run;
	#machines?: { at: number; names: Promise<Set<string>> };

	constructor(config: Config["herdr"], run: Run = runProcess) {
		this.#config = config;
		this.#run = run;
	}

	hosts(): string[] {
		return [this.#config.host, ...Object.keys(this.#config.hosts)];
	}

	/** Whether this core reaches HOST itself: this machine, or a machine hc has added and is connected to. */
	native(host: string): Promise<boolean> {
		return this.#native(host);
	}

	/** Machines this core reaches natively, refreshed every half minute. */
	#native(host: string): Promise<boolean> {
		if (host === this.#config.host) return Promise.resolve(true);
		if (this.#machines === undefined || Date.now() - this.#machines.at > 30_000) {
			const names = this.#run(["hc", "machine", "ls", "--json"], 10_000)
				.then((out) => new Set<string>((JSON.parse(out).machines ?? []).filter((m: any) => m.state === "connected").map((m: any) => m.name)))
				.catch(() => new Set<string>());
			this.#machines = { at: Date.now(), names };
		}
		return this.#machines.names.then((names) => names.has(host));
	}

	/** argv for hc ARGS about HOST: local hc for this host and added machines, else hc over SSH with simple arguments. */
	async #argv(host: string, args: readonly string[]): Promise<{ argv: string[]; prefix: string }> {
		if (await this.#native(host)) return { argv: ["hc", ...args], prefix: host === this.#config.host ? "" : `${host}/` };
		const remote = this.#config.hosts[host];
		if (remote === undefined) throw new Error(`Unknown host ${host}; known: ${this.hosts().join(", ")}`);
		if (!args.every((arg) => TARGET.test(arg) || /^--?[a-z-]+$/.test(arg) || /^[a-z.]+=[0-9a-f-]+$/.test(arg)))
			throw new Error("Remote hc calls take simple arguments only");
		return { argv: ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", remote.ssh ?? host, "hc", ...args], prefix: "" };
	}

	async #json(host: string, args: readonly string[], timeoutMs = 15_000): Promise<any> {
		const { argv } = await this.#argv(host, args);
		const out = await this.#run(argv, timeoutMs).catch((error: Error & { stderr?: string }) => {
			const json = (() => { try { return JSON.parse(error.stderr ?? ""); } catch { return undefined; } })();
			if (json?.error) throw Object.assign(new Error(`hc on ${host}: ${json.error.kind}: ${json.error.message}`), { kind: json.error.kind });
			throw error;
		});
		return out.trim() === "" ? undefined : JSON.parse(out);
	}

	/** The address hc on this machine uses for HOST's terminal ADDRESS. */
	async #address(host: string, address: string): Promise<string> {
		checkTarget(address);
		return (await this.#argv(host, [])).prefix + address;
	}

	/** One terminal's full record, or undefined when hc has none. */
	async terminal(host: string, address: string): Promise<Terminal | undefined> {
		return this.#json(host, ["get", await this.#address(host, address), "--json"]).catch((error) => {
			if (error.kind === "not_found") return undefined;
			throw error;
		});
	}

	/** A terminal's reported status, "unknown" while live without one, undefined once it is gone. */
	async status(host: string, address: string): Promise<string | undefined> {
		const terminal = await this.terminal(host, address);
		return terminal?.state === "live" ? (terminal.status?.state ?? "unknown") : undefined;
	}

	/** Live terminals on HOST carrying LABEL=VALUE, with full records. */
	async labelled(host: string, label: string, value: string): Promise<Terminal[]> {
		checkTarget(value);
		const { prefix } = await this.#argv(host, []);
		const list = await this.#json(host, ["ls", "--json", "--label", `${label}=${value}`]);
		const rows = (list?.terminals ?? []).filter((row: any) => row.state === "live" && sameHost(row.address, prefix));
		return (await Promise.all(rows.map((row: any) => this.#json(host, ["get", row.address, "--json"]).catch(() => undefined))))
			.filter((terminal): terminal is Terminal => terminal !== undefined);
	}

	/** The live terminal running agent SESSION on HOST, by its org.session label. */
	async session(host: string, session: string): Promise<Terminal | undefined> {
		const live = await this.labelled(host, "org.session", session);
		if (live.length > 1) throw new Error(`Session ${session} runs in ${live.length} terminals on ${host}`);
		return live[0];
	}

	async agents(host: string): Promise<AgentSummary[]> {
		const { prefix } = await this.#argv(host, []);
		const list = await this.#json(host, ["ls", "--json"]);
		const rows = (list?.terminals ?? []).filter((row: any) =>
			row.state === "live" && sameHost(row.address, prefix) && row.agent !== "june" && (isKnownAgent(row.agent) || row.status != null));
		const full = await Promise.all(rows.map((row: any) => this.#json(host, ["get", row.address, "--json"]).catch(() => undefined)));
		return rows.map((row: any, i: number) => summarize(host, prefix, row, full[i]));
	}

	/**
	 * Start ARGV in a new terminal on HOST in DIR (absolute; the machine's home without one), in the background with no
	 * parent, named NAME with LABELS. Only this machine and machines this core has added: over SSH it would need a shell.
	 * Returns the terminal's address on HOST, as agents() names it (t7).
	 */
	async start(host: string, argv: readonly string[], options: { name: string; dir?: string; labels?: Record<string, string> }): Promise<string> {
		if (!(await this.#native(host))) throw new Error(`hc here has not added ${host}, so June cannot start a session there`);
		if (!/^[a-z0-9_-]{1,32}$/.test(options.name)) throw new Error(`bad terminal name ${options.name}`);
		const local = host === this.#config.host;
		const args = ["hc", "run", "--json", "--bg", "--no-parent", "--name", options.name, ...(local ? [] : ["--on", host]), ...(options.dir ? ["--cwd", options.dir] : [])];
		for (const [k, v] of Object.entries(options.labels ?? {})) args.push("--label", `${k}=${v}`);
		const out = await this.#run([...args, "--", ...argv], 30_000).catch((error: Error & { stderr?: string }) => {
			// hc says why it could not start the program as JSON; say it plainly, with where.
			const said = (() => { try { return JSON.parse(/\{[\s\S]*\}/.exec(error.stderr || error.message)?.[0] ?? ""); } catch { return undefined; } })();
			const why = String(said?.error?.message ?? "").replace(/^cannot start "[^"]*": /, "");
			if (why) throw new Error(`Could not start ${argv[0]} on ${host}${options.dir ? ` in ${options.dir}` : ""}: ${why}`);
			throw error;
		});
		const address = String(JSON.parse(out).address ?? "");
		if (!address) throw new Error(`hc run on ${host} returned no terminal`);
		return local ? address : address.replace(new RegExp(`^${host}/`), "");
	}

	/**
	 * The herdr-app space on HOST named NAME, as the dispatcher finds one (org-dispatch--space): a live terminal there whose
	 * place reads "NAME / TAB" carries its id as herdr.space. Undefined when no terminal is in such a space.
	 */
	async space(host: string, name: string): Promise<string | undefined> {
		const { prefix } = await this.#argv(host, []);
		const list = await this.#json(host, ["ls", "--json"]);
		const place = new RegExp(`^(?:\\[\\d+\\] )?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} / `);
		const rows = (list?.terminals ?? []).filter((row: any) => row.state === "live" && sameHost(row.address, prefix) && place.test(String(row.where ?? "")));
		for (const row of rows) {
			const id = (await this.#json(host, ["get", row.address, "--json"]).catch(() => undefined))?.labels?.["herdr.space"];
			if (typeof id === "string" && id !== "") return id;
		}
		return undefined;
	}

	/** HOST's /proc/stat and /proc/meminfo, for its load: read here, through hc on a machine it has added, else over SSH. */
	async load(host: string): Promise<string> {
		const files = ["/proc/stat", "/proc/meminfo"];
		if (host === this.#config.host) return this.#run(["cat", ...files], 5_000);
		if (await this.#native(host)) return this.#run(["hc", "exec", "--on", host, "--timeout", "5", "cat", ...files], 10_000);
		const remote = this.#config.hosts[host];
		if (remote === undefined) throw new Error(`Unknown host ${host}; known: ${this.hosts().join(", ")}`);
		return this.#run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", remote.ssh ?? host, "cat", ...files], 10_000);
	}

	async read(host: string, target: string, lines: number): Promise<string> {
		const { argv } = await this.#argv(host, ["read", await this.#address(host, target), "--lines", String(lines)]);
		return this.#run(argv, 15_000);
	}

	/** Type TEXT into a local terminal and press Enter; hc refuses one that is blocked on a dialog. June's own terminal
	 * client reports itself as app june, and June does not prompt herself. */
	async prompt(target: string, text: string): Promise<any> {
		checkTarget(target);
		if ((await this.terminal(this.#config.host, target))?.status?.app === "june") throw new Error(`${target} is June's own terminal client`);
		return this.#json(this.#config.host, ["send", target, text, "--json"]);
	}
}

export type AgentSummary = {
	host: string;
	terminal: string;
	agent: string;
	status: string;
	where?: string;
	cwd: string;
	session?: string;
	task?: string;
	title?: string;
	herdrLink?: string;
	/** The roster agent this terminal belongs to (its june.agent label), while it works there. */
	rosterAgent?: string;
};

function sameHost(address: string, prefix: string): boolean {
	return prefix === "" ? !address.includes("/") : address.startsWith(prefix);
}

function summarize(host: string, prefix: string, row: any, full: Terminal | undefined): AgentSummary {
	const labels = full?.labels ?? {};
	const terminal = String(row.address).slice(prefix.length);
	const rawAgent = String(row.agent ?? "unknown");
	const agent = labels["org.agent"] ?? HARNESS_ALIASES[rawAgent.toLowerCase()] ?? rawAgent;
	const session = labels["org.session"];
	return {
		host, terminal, agent,
		// No reported status is unknown, never idle.
		status: typeof row.status === "string" ? row.status : (full?.status?.state ?? "unknown"),
		...(row.where ? { where: String(row.where) } : {}),
		cwd: full?.foreground?.cwd ?? row.cwd,
		...(session ? { session, herdrLink: `herdr:${host}/${agent}:${session}@${terminal}` } : {}),
		...(labels["org.task"] ? { task: labels["org.task"] } : {}),
		...(labels["june.agent"] ? { rosterAgent: labels["june.agent"] } : {}),
		...(full?.title ? { title: String(full.title).slice(0, 120) } : {}),
	};
}

function checkTarget(target: string): string {
	if (!TARGET.test(target)) throw new Error(`Invalid hc terminal ${JSON.stringify(target)}`);
	return target;
}

function json(value: unknown) {
	return { output: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}

export function createHerdrExtension(config: Config, herdr = new Herdr(config.herdr)): Extension {
	const host = opt(
		str({ description: `Machine to inspect; default ${config.herdr.host}. Known: ${herdr.hosts().join(", ")}` }),
	);
	const tools = [
		defineTool({
			name: "herdr_list_agents",
			description:
				"List the coding agents (Pi, Claude, Codex, Antigravity) running in herdr-core terminals on a machine, with terminal address, status (working, blocked, done, idle, or unknown when the agent reports none), directory, and session link. blocked means the agent waits for a person; idle or done means its terminal settled, not that its task succeeded, so read its output and the task's Org state before reporting success. Unknown is never idle. Inspect agents here to say what they are doing, but leave launching, watching, and nudging them to the dispatcher.",
			parameters: obj({ host, status: opt(str({ description: "Only agents with this status" })) }),
			replay: "safe",
			execute: async (args) => {
				const agents = await herdr.agents(args.host ?? config.herdr.host);
				return json(args.status ? agents.filter((a) => a.status === args.status) : agents);
			},
		}),
		defineTool({
			name: "herdr_get_agent",
			description: "Show one agent's herdr-core terminal in full, by its address (such as t7) or name.",
			parameters: obj({ target: str(), host }),
			replay: "safe",
			execute: async (args) => {
				const terminal = await herdr.terminal(args.host ?? config.herdr.host, args.target);
				if (terminal === undefined) throw new Error(`No terminal ${args.target}`);
				return json(terminal);
			},
		}),
		defineTool({
			name: "herdr_read_agent",
			description: "Read the recent screen and history of an agent's herdr-core terminal, to see what it is doing or asking.",
			parameters: obj({
				target: str(),
				host,
				lines: opt(int({ minimum: 10, maximum: 400, description: "Default 80" })),
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
				description: `Send a follow-up prompt to an existing agent on ${config.herdr.host}, only when the user explicitly asks. First inspect the agent and its recent output to confirm the target and that it is ready for normal input. Never answer an approval or question dialog with this tool; blocked agents need the user, and hc refuses to type into them. Success means submitted, not started or finished; read the agent again before reporting its response. An error or restart may follow delivery, so inspect before any retry. The call is not repeated after a restart.`,
				parameters: obj({ target: str(), text: str({ minLength: 1, maxLength: 4000 }) }),
				execute: async (args) => json((await herdr.prompt(args.target, args.text)) ?? { sent: true }),
			}) as never,
		);
	}
	return defineExtension({ name: "herdr", tools });
}
