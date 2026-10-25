import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createLogger, type TelegramPort } from "pi-durable-telegram";
import type { Config, Paths } from "../src/config.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Client, type Reply } from "../src/protocol.ts";

export type Faux = ReturnType<typeof fauxProvider>;

export function testConfig(dir: string, extra: Partial<Config> = {}): Config {
	return {
		model: { provider: "faux", modelId: "faux-1", thinkingLevel: "off" },
		providersFile: "/nonexistent",
		envFiles: [],
		contextCap: 100_000,
		soulFile: join(dir, "SOUL.md"),
		skillDirs: [],
		org: { root: join(dir, "org"), agendaFiles: join(dir, "agenda") },
		herdr: { session: "default", host: "kit", hosts: {}, allowPrompt: false },
		...extra,
	};
}

export async function tempDir(): Promise<{ dir: string; paths: Paths; cleanup(): Promise<void> }> {
	// Short base: Unix socket paths are limited to 108 bytes.
	const dir = await mkdtemp(join(tmpdir(), "june-"));
	const paths: Paths = {
		config: dir,
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
}): Promise<Daemon> {
	const models = createModels();
	models.setProvider(options.faux.provider);
	return startDaemon({
		config: testConfig(options.dir, options.config),
		paths: options.paths,
		models,
		log: createLogger({ sink: () => {} }),
		extensions: [],
		...(options.telegramPort ? { telegramPort: options.telegramPort } : {}),
		...(options.secrets ? { secrets: options.secrets } : {}),
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
	const sent: { chatId: number; text: string }[] = [];
	let next = 1000;
	const port: TelegramPort = {
		sendMessage: async (chatId, text) => {
			sent.push({ chatId, text });
			return next++;
		},
		editMessageText: async () => {},
		sendDraft: async () => {},
		answerCallbackQuery: async () => {},
		sendChatAction: async () => {},
		sendPhoto: async () => next++,
		sendDocument: async () => next++,
		getFile: async () => ({ path: "x" }),
		downloadFile: async () => new Response(""),
		setMyCommands: async () => {},
	};
	return { port, sent };
}

export async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 20));
	}
}
