// The June daemon: the one process that owns the Durable database. It runs the harness, the Telegram channel, and a
// Unix socket that terminal clients attach to.
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { BACKGROUND_CONTEXT as BG, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	type Conversation,
	createRegistry,
	defineDoc,
	type Extension,
	Harness,
	type SnapshotEvent,
	watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	acquireDataDirLock,
	createLogger,
	createSettings,
	createTelegramChannel,
	type Logger,
	type TelegramChannel,
	type TelegramPort,
} from "pi-durable-telegram";
import { type CommandScope, runCommand } from "./commands.ts";
import type { Config, Paths } from "./config.ts";
import { createPromptExtension } from "./prompt.ts";
import { readLines, type Reply, type Request, type Status, writeLine } from "./protocol.ts";
import { createHerdrExtension } from "./tools/herdr.ts";
import { createOrgExtension } from "./tools/org.ts";

export const VERSION = "0.1.0";
const SNAPSHOT_ENTRIES = 200;

// pi-durable-telegram keeps its chat → conversation map in these documents. June writes the same kinds so Jon's
// private chat lands in the primary conversation instead of a new one. Keep in step with its src/channel/docs.ts.
const ChatMap = defineDoc<{ chats: Record<string, number> }>({
	kind: "tg.chats",
	version: 1,
	scope: "session",
	initial: () => ({ chats: {} }),
});
const ChatInfo = defineDoc<{ chatId: number }>({
	kind: "tg.chat",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ chatId: 0 }),
});

export type DaemonOptions = {
	readonly config: Config;
	readonly paths: Paths;
	readonly models: Models;
	readonly secrets?: Readonly<Record<string, string>>;
	readonly log?: Logger;
	/** Tests replace the Telegram transport; polling is then off. */
	readonly telegramPort?: TelegramPort;
	/** Tests replace the infrastructure tools. */
	readonly extensions?: readonly Extension[];
};

export type Daemon = {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly telegram: TelegramChannel | undefined;
	status(): Promise<Status>;
	close(): Promise<void>;
};

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
	const { config, paths } = options;
	const log = options.log ?? createLogger();
	for (const dir of [paths.state, paths.runtime]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = acquireDataDirLock(paths.state);
	const startedAt = new Date().toISOString();
	try {
		const model = { provider: config.model.provider, modelId: config.model.modelId };
		const resolved = options.models.getModel(model.provider, model.modelId);
		if (resolved === undefined) throw new Error(`Unknown model ${model.provider}/${model.modelId}`);

		const registry = createRegistry();
		const extensions = options.extensions ?? [createOrgExtension(config), createHerdrExtension(config)];
		for (const extension of [createPromptExtension(config), ...extensions]) registry.install(extension);

		const telegram = createTelegram(options, model, log);
		if (telegram !== undefined) registry.install(telegram.extension);

		const workdir = `${paths.state}/files`;
		mkdirSync(workdir, { recursive: true, mode: 0o700 });
		const harness = await Harness.open(
			await openNodeSqliteStorage(paths.database),
			{
				models: options.models,
				registry,
				settings: createSettings({ contextCap: config.contextCap, contextWindow: resolved.contextWindow }),
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workdir }),
				onReport: (error) => log.warn("durable_report", { error: String((error as Error)?.message ?? error) }),
			},
			BG,
		);

		const agent = { model, thinkingLevel: config.model.thinkingLevel as never, cwd: workdir };
		const root = await harness.root(BG, { agent });
		const current = await root.agent(BG);
		if (current.model?.modelId !== model.modelId || current.model?.provider !== model.provider || current.thinkingLevel !== agent.thinkingLevel)
			await root.configure(agent, BG);

		let telegramState: Status["telegram"] = "off";
		if (telegram !== undefined) {
			await harness.commit(async (tx) => {
				const map = await tx.doc(ChatMap);
				// Private chats have the user's id as chat id.
				for (const id of config.telegram!.allowedUserIds) map.chats[String(id)] = root.id as unknown as number;
				(await tx.doc(ChatInfo, root.id)).chatId = config.telegram!.allowedUserIds[0]!;
			}, BG);
			// start() runs harness.resume() once the channel listens, then long-polls.
			await telegram
				.start(harness, BG, { polling: options.telegramPort === undefined })
				.then(() => (telegramState = "polling"))
				.catch((error: Error) => {
					telegramState = "failed";
					log.error("telegram_failed", { error: error.message });
					harness.resume();
				});
		} else harness.resume();

		const status = async (): Promise<Status> => {
			const inspection = await harness.inspect(BG);
			const mine = inspection.submissions.filter((s) => s.conversationId === root.id);
			const resolvedAgent = await root.agent(BG);
			const view = await root.context(BG);
			return {
				ok: true,
				pid: process.pid,
				startedAt,
				version: VERSION,
				conversation: root.id as unknown as number,
				model: `${resolvedAgent.model?.provider}/${resolvedAgent.model?.modelId}`,
				thinkingLevel: String(resolvedAgent.thinkingLevel),
				busy: mine.some((s) => s.status === "placed"),
				queued: mine.filter((s) => s.status === "queued").length,
				entries: view.entries.length,
				telegram: telegramState,
				tools: resolvedAgent.tools.map((tool) => tool.name),
			};
		};

		const clients = new Set<Socket>();
		const server = await listen(paths.socket, (socket) => {
			clients.add(socket);
			socket.once("close", () => clients.delete(socket));
			serve(socket, { harness, root, models: options.models, status, log });
		});
		log.info("june_started", { pid: process.pid, socket: paths.socket, conversation: root.id, telegram: telegramState });

		let closing: Promise<void> | undefined;
		const close = () =>
			(closing ??= (async () => {
				log.info("june_stopping", {});
				// Clients reconnect on their own; an open connection must not hold the shutdown.
				const closed = new Promise<void>((resolve) => server.close(() => resolve()));
				for (const socket of clients) socket.destroy();
				await closed;
				await telegram?.stop();
				await harness.close(BG);
				rmSync(paths.socket, { force: true });
				lock.release();
			})());
		return { harness, root, telegram, status, close };
	} catch (error) {
		lock.release();
		throw error;
	}
}

function createTelegram(options: DaemonOptions, model: { provider: string; modelId: string }, log: Logger) {
	const tg = options.config.telegram;
	if (tg === undefined) return undefined;
	const token = options.secrets?.[tg.tokenEnv] ?? process.env[tg.tokenEnv];
	if (!token) {
		log.warn("telegram_disabled", { reason: `${tg.tokenEnv} is not set` });
		return undefined;
	}
	return createTelegramChannel({
		botToken: token,
		allowedUserIds: tg.allowedUserIds,
		workdir: `${options.paths.state}/files`,
		model,
		thinkingLevel: options.config.model.thinkingLevel as never,
		models: options.models,
		log,
		...(options.telegramPort ? { port: options.telegramPort, previewIntervalMs: 20 } : {}),
		onFatal: (reason) => log.error("telegram_fatal", { reason }),
	});
}

/** Listen on `path`; a leftover socket file from a dead daemon is replaced (the data-dir lock proved it dead). */
function listen(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
	rmSync(path, { force: true });
	const server = createServer(onConnection);
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			chmodSync(path, 0o600);
			resolve(server);
		});
	});
}

type Scope = CommandScope & { log: Logger };

function serve(socket: Socket, scope: Scope): void {
	const abort = new AbortController();
	const context = withAbortSignal(abort.signal, BG);
	let stopWatch: (() => Promise<unknown>) | undefined;
	socket.on("error", () => {});
	socket.on("close", () => {
		abort.abort();
		void stopWatch?.();
	});
	const send = (reply: Reply) => writeLine(socket, reply);

	readLines(
		socket,
		(value) => {
			const request = value as Request;
			void handle(request).catch((error: Error) =>
				send({ type: "error", requestId: request?.requestId, message: error.message }),
			);
		},
		() => send({ type: "error", message: "Malformed request line" }),
	);

	async function handle(request: Request): Promise<void> {
		switch (request.op) {
			case "status":
				return send({ type: "status", requestId: request.requestId, status: await scope.status() });
			case "attach": {
				const stream = await watchEvents(scope.harness, scope.root.id, context);
				stopWatch = () => stream.stop();
				const { snapshot, omitted } = trim(stream.snapshot);
				send({ type: "snapshot", requestId: request.requestId, snapshot, omitted });
				stream.start(async (events) => {
					send({ type: "events", events: events.map((e) => (e.type === "snapshot" ? trim(e).snapshot : e)) as AgentEvent[] });
				});
				return;
			}
			case "submit": {
				if (typeof request.text !== "string" || request.text.trim() === "") throw new Error("Empty message");
				const submission = await scope.root.submit(
					{
						type: "input",
						requestId: `${request.source}:${request.requestId}`,
						content: `[${request.source}] ${request.text}`,
						whenBusy: request.whenBusy ?? "followUp",
						entry: { kind: "june.input", data: { source: request.source, text: request.text } },
					},
					context,
				);
				send({ type: "accepted", requestId: request.requestId, submissionId: submission.id as unknown as number });
				if (!request.wait) return;
				const settled = await submission.wait(context);
				const text =
					settled.status === "done"
						? assistantText((await scope.root.commit((tx) => tx.entry(settled.answer!), context))?.model?.[0])
						: undefined;
				return send({
					type: "settled",
					requestId: request.requestId,
					status: settled.status,
					...(text !== undefined ? { text } : {}),
					...(settled.status === "unanswered" ? { reason: settled.reason } : {}),
				});
			}
			case "command": {
				const text = await runCommand(scope, request.name, request.args ?? "", request.requestId, context);
				return send({ type: "reply", requestId: request.requestId, text });
			}
			default:
				throw new Error(`Unknown op ${(request as { op?: string }).op}`);
		}
	}
}

export function assistantText(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function trim(snapshot: SnapshotEvent): { snapshot: SnapshotEvent; omitted: number } {
	const omitted = Math.max(0, snapshot.entries.length - SNAPSHOT_ENTRIES);
	return { snapshot: omitted ? { ...snapshot, entries: snapshot.entries.slice(omitted) } : snapshot, omitted };
}
