import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import type { PatterTiming } from "../src/patter.ts";
import type { Config, Paths } from "../src/config.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Client, type Reply, type Source } from "../src/protocol.ts";
import { createLogger } from "../src/runtime.ts";
import { applyChanges, type ViewItem, type ViewState } from "../src/transcript.ts";

export type Faux = ReturnType<typeof fauxProvider>;

export function testConfig(dir: string, extra: Partial<Config> = {}): Config {
	return {
		user: { name: "Alex" },
		model: { chat: { provider: "faux", modelId: "faux-1", thinkingLevel: "off" } },
		providersFile: "/nonexistent",
		envFiles: [],
		contextCap: 100_000,
		soulFile: undefined,
		memoryFile: undefined,
		journalFile: undefined,
		heartbeatFile: undefined,
		moodFile: undefined,
		selfFile: undefined,
		instructionsFile: undefined,
		daemonHost: undefined,
		skillDirs: [],
		org: { root: join(dir, "org"), agendaFiles: join(dir, "agenda"), people: join(dir, "org", "people.org") },
		dispatch: { hosts: [] },
		herdr: { session: "default", host: "kit", hosts: {}, allowPrompt: false },
		// Off unless a test turns it on, so no test depends on the hour it runs.
		rhythm: { wake: "05:00", quiet: "22:00", sleep: "01:00" },
		reflection: { enabled: false, quietMinutes: 60, recentDays: 3, periods: [] },
		heartbeat: { enabled: false, everyMinutes: 60, chattingMinutes: 15 },
		mail: { enabled: false, query: "tag:inbox and tag:unread", accounts: {} },
		watch: { enabled: false, gapMinutes: 10 },
		patter: { openAfterSeconds: 8, gapsSeconds: [25] },
		situation: { calendars: [], homeAssistant: { people: [], pollSeconds: 300 } },
		...extra,
	};
}

export async function tempDir(): Promise<{ dir: string; paths: Paths; cleanup(): Promise<void> }> {
	// Short base: Unix socket paths are limited to 108 bytes.
	const dir = await mkdtemp(join(tmpdir(), "june-"));
	const paths: Paths = {
		config: dir,
		data: dir,
		state: join(dir, "state"),
		runtime: join(dir, "run"),
		socket: join(dir, "run", "s"),
		database: join(dir, "state", "june.sqlite"),
	};
	return { dir, paths, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function openTestDaemon(options: {
	dir: string;
	paths: Paths;
	faux: Faux;
	config?: Partial<Config>;
	secrets?: Record<string, string>;
	extensions?: Extension[];
	/** More providers, such as a separate one for patter so its requests never take June's scripted answers. */
	providers?: Faux[];
	patterTiming?: Partial<PatterTiming>;
	focusHoldMs?: number;
	reflectionClock?: { now: () => Date; tickMs: number };
	heartbeatClock?: { now: () => Date; tickMs: number };
	mailRun?: (argv: readonly string[]) => Promise<string>;
	watchClock?: { now: () => Date; tickMs: number; home: string; run: (argv: readonly string[]) => Promise<string> };
}): Promise<Daemon> {
	const models = createModels();
	models.setProvider(options.faux.provider);
	for (const extra of options.providers ?? []) models.setProvider(extra.provider);
	return startDaemon({
		config: testConfig(options.dir, options.config),
		paths: options.paths,
		models,
		log: createLogger({ sink: () => {} }),
		extensions: options.extensions ?? [],
		...(options.secrets ? { secrets: options.secrets } : {}),
		...(options.patterTiming ? { patterTiming: options.patterTiming } : {}),
		...(options.focusHoldMs !== undefined ? { focusHoldMs: options.focusHoldMs } : {}),
		...(options.reflectionClock ? { reflectionClock: options.reflectionClock } : {}),
		...(options.heartbeatClock ? { heartbeatClock: options.heartbeatClock } : {}),
		...(options.mailRun ? { mailRun: options.mailRun } : {}),
		...(options.watchClock ? { watchClock: options.watchClock } : {}),
	});
}

/** Submit over the socket and wait for the answer. */
export async function ask(socket: string, text: string, requestId: string = randomUUID(), source: Source = "cli") {
	const client = await Client.open(socket);
	try {
		const settled = new Promise<Extract<Reply, { type: "settled" }>>((resolve) =>
			client.on((r) => r.type === "settled" && r.requestId === requestId && resolve(r)),
		);
		const accepted = await client.request({ op: "submit", requestId, text, source, wait: true });
		if (accepted.type !== "accepted") throw new Error(JSON.stringify(accepted));
		return { submissionId: accepted.submissionId, ...(await settled) };
	} finally {
		client.close();
	}
}

/** A client attached to the folded view, as the terminal is: it holds the items and state the daemon sends. */
export async function attachView(
	socket: string,
	options: { detail?: boolean } = {},
): Promise<{ items(): ViewItem[]; state(): ViewState; earlier(): boolean; replies: Extract<Reply, { type: "view" }>[]; detail(on: boolean): Promise<Reply>; close(): void }> {
	const client = await Client.open(socket);
	let items: ViewItem[] = [];
	let state: ViewState | undefined;
	let earlier = false;
	const replies: Extract<Reply, { type: "view" }>[] = [];
	client.on((reply) => {
		if (reply.type !== "view") return;
		replies.push(reply);
		if ("reset" in reply) {
			items = reply.items;
			earlier = reply.earlier;
		} else items = applyChanges(items, reply.changes);
		if (reply.state !== undefined) state = reply.state;
	});
	const attached = await client.request({ op: "attach", requestId: randomUUID(), ...options });
	if (attached.type !== "view") throw new Error(JSON.stringify(attached));
	return {
		items: () => items,
		state: () => state!,
		earlier: () => earlier,
		replies,
		detail: (on) => client.request({ op: "detail", requestId: randomUUID(), on }),
		close: () => client.close(),
	};
}

/** Items as short lines: "alex: hi", "june: hello", "tool: name", "note: text", "patter: text". */
export function lines(items: readonly ViewItem[], user = "alex"): string[] {
	return items.map((i) =>
		i.kind === "user" ? `${user}: ${i.text}` : i.kind === "assistant" ? `june: ${i.text}${i.error ? ` ! ${i.error}` : ""}` : i.kind === "tool" ? `tool: ${i.name} ${i.status}` : `${i.kind}: ${i.text}`,
	);
}

export async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 20));
	}
}

type Step = Parameters<Faux["setResponses"]>[0][number];

/**
 * Responses for a main thread and a working context that run at once: each request takes the next step from its own
 * queue, told apart by the working context's instructions, so the order between them cannot race.
 */
export function routed(main: Step[], worker: Step[]): Step[] {
	const queues = { main: [...main], worker: [...worker] };
	const next: Step = (ctx, ...rest) => {
		const queue = JSON.stringify(ctx.messages.filter((m) => m.role === "system")).includes("You are June's working context") ? queues.worker : queues.main;
		const step = queue.shift();
		if (step === undefined) throw new Error("no scripted response left");
		return typeof step === "function" ? step(ctx, ...rest) : step;
	};
	return Array.from({ length: main.length + worker.length }, () => next);
}
