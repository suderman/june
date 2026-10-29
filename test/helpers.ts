import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import { createLogger, type TelegramPort } from "pi-durable-telegram";
import type { PatterTiming } from "../src/patter.ts";
import type { Config, Paths } from "../src/config.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Client, type Reply } from "../src/protocol.ts";

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
	telegramPort?: TelegramPort;
	secrets?: Record<string, string>;
	extensions?: Extension[];
	/** More providers, such as a separate one for patter so its requests never take June's scripted answers. */
	providers?: Faux[];
	patterTiming?: Partial<PatterTiming>;
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
		...(options.telegramPort ? { telegramPort: options.telegramPort } : {}),
		...(options.secrets ? { secrets: options.secrets } : {}),
		...(options.patterTiming ? { patterTiming: options.patterTiming } : {}),
		...(options.reflectionClock ? { reflectionClock: options.reflectionClock } : {}),
		...(options.heartbeatClock ? { heartbeatClock: options.heartbeatClock } : {}),
		...(options.mailRun ? { mailRun: options.mailRun } : {}),
		...(options.watchClock ? { watchClock: options.watchClock } : {}),
	});
}

/** Submit over the socket and wait for the answer. */
export async function ask(socket: string, text: string, requestId: string = randomUUID(), source: "cli" | "kitty" = "cli") {
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

/** A Telegram port that records what June sends. */
export function fakeTelegram() {
	const sent: { chatId: number; text: string; id: number }[] = [];
	const edited: { chatId: number; messageId: number; text: string }[] = [];
	const actions: { chatId: number; action: string }[] = [];
	let next = 1000;
	const port: TelegramPort = {
		sendMessage: async (chatId, text) => {
			sent.push({ chatId, text, id: next });
			return next++;
		},
		editMessageText: async (chatId, messageId, text) => {
			edited.push({ chatId, messageId, text });
		},
		sendDraft: async () => {},
		answerCallbackQuery: async () => {},
		sendChatAction: async (chatId, action) => {
			actions.push({ chatId, action });
		},
		sendPhoto: async () => next++,
		sendDocument: async () => next++,
		getFile: async () => ({ path: "x" }),
		downloadFile: async () => new Response(""),
		setMyCommands: async () => {},
	};
	return { port, sent, edited, actions };
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
