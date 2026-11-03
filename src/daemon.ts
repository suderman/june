// The June daemon: the one process that owns the Durable database. It runs the harness and a Unix socket that clients
// attach to, folding the conversation into display items for each of them.
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as BG, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	type Conversation,
	ConversationTranscript,
	configure,
	createRegistry,
	type Cursor,
	type EntryRecord,
	type Extension,
	Harness,
	LiveDoc,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type CommandScope, runCommand } from "./commands.ts";
import { type Config, expandHome, type Paths } from "./config.ts";
import { acquireDataDirLock, createLogger, createSettings, type Logger } from "./runtime.ts";
import { diff, type Folded, foldView, sourceName } from "./transcript.ts";
import { createPromptExtension } from "./prompt.ts";
import { createHeartbeat } from "./heartbeat.ts";
import { entryTimes } from "./history.ts";
import { createSituation } from "./situation.ts";
import { setUser } from "./user.ts";
import { validateImages } from "./images.ts";
import { describeFiles, saveFiles, startInboxExpiry, validateFiles } from "./inbox.ts";
import { createMemoryExtension } from "./memory.ts";
import { createPatter, type PatterTiming } from "./patter.ts";
import { createGreeting } from "./greeting.ts";
import { createLooseEnds } from "./loose.ts";
import { createReflection } from "./reflect.ts";
import { createWatch } from "./watch.ts";
import { readLines, type Reply, type Request, SOURCES, type Status, writeLine } from "./protocol.ts";
import { createCodingExtension } from "./tools/coding.ts";
import { createHerdrExtension, Herdr, type Run, runProcess } from "./tools/herdr.ts";
import { createDispatchExtension, instanceId } from "./tools/dispatch.ts";
import { createWorkExtension, FocusDoc, WorkDoc } from "./tools/work.ts";
import { createOrgExtension, Org } from "./tools/org.ts";
import { createOrgWriteExtension } from "./tools/write.ts";
import { createMail } from "./mail.ts";

export const VERSION = "0.1.0";
/** The entries a view holds: a client starts with the newest 200, and the window drops back to 200 past 400. */
const WINDOW = { min: 200, max: 400 };
/** Changes go to a client at most this often, so a streaming reply resends its text ten times a second at most. */
const FLUSH_MS = 100;
const SNAPSHOT_ENTRIES = 200;
/** The most entries one history request returns. */
const HISTORY_ENTRIES = 2000;

export type DaemonOptions = {
	readonly config: Config;
	readonly paths: Paths;
	readonly models: Models;
	readonly secrets?: Readonly<Record<string, string>>;
	readonly log?: Logger;
	/** Tests replace the infrastructure tools. */
	readonly extensions?: readonly Extension[];
	/** Tests shorten how long a held focus outlasts the user's last message. */
	readonly focusHoldMs?: number;
	/** Tests shorten patter's waits. */
	readonly patterTiming?: Partial<PatterTiming>;
	/** Tests set the clock and loop speed of the nightly reflection. */
	readonly reflectionClock?: { now: () => Date; tickMs: number };
	/** Tests set the clock and loop speed of the heartbeat. */
	readonly heartbeatClock?: { now: () => Date; tickMs: number };
	/** Tests set the clock and loop speed of the evening look for loose ends. */
	readonly looseEndsClock?: { now: () => Date; tickMs: number };
	/** Tests answer notmuch themselves. */
	readonly mailRun?: Run;
	/** Tests set the watch's clock, loop speed, home directory for local run records, and commands. */
	readonly watchClock?: { now: () => Date; tickMs: number; home: string; run: Run };
};

export type Daemon = {
	readonly harness: Harness;
	readonly root: Conversation;
	status(): Promise<Status>;
	close(): Promise<void>;
};

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
	const { config, paths } = options;
	setUser(config.user.name);
	const log = options.log ?? createLogger();
	for (const dir of [paths.state, paths.runtime]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = acquireDataDirLock(paths.state);
	const startedAt = new Date().toISOString();
	try {
		const model = { provider: config.model.chat.provider, modelId: config.model.chat.modelId };
		const resolved = options.models.getModel(model.provider, model.modelId);
		if (resolved === undefined) throw new Error(`Unknown model ${model.provider}/${model.modelId}`);

		const registry = createRegistry();
		const org = new Org(config.org.root);
		const herdr = new Herdr(config.herdr);
		const extensions = options.extensions ?? [
			createCodingExtension(),
			createOrgExtension(config, org),
			createOrgWriteExtension(config, org),
			createHerdrExtension(config, herdr),
			...(config.dispatch.hosts.length > 0 ? [createDispatchExtension(config, org, herdr, instanceId(paths.state))] : []),
		];
		const situation = createSituation({ config: config.situation, env: { ...process.env, ...options.secrets }, log });
		const prompt = createPromptExtension(config, paths, situation);
		const memory = createMemoryExtension(prompt.files, () => harness);
		const greeting = createGreeting({ wake: config.rhythm.wake });
		const patter = config.model.patter
			? createPatter({
					models: options.models,
					model: config.model.patter,
					focus: config.model.focus,
					files: prompt.files,
					log,
					timing: { openAfterMs: config.patter.openAfterSeconds * 1000, gapsMs: config.patter.gapsSeconds.map((s) => s * 1000), ...options.patterTiming },
				})
			: undefined;
		// June's working context does the work only: no memory review, task queueing, patter, or messages to the user.
		const childless = [memory, ...extensions.filter((e) => e.name === "dispatch"), ...(patter ? [patter.extension] : [])];
		const work = createWorkExtension(config, () => childless);
		for (const extension of [prompt.extension, greeting.extension, memory, work, ...(patter ? [patter.extension] : []), ...extensions]) registry.install(extension);

		const workdir = `${paths.state}/files`;
		mkdirSync(workdir, { recursive: true, mode: 0o700 });
		const harness = await Harness.open(
			await openNodeSqliteStorage(paths.database),
			{
				models: options.models,
				registry,
				settings: createSettings({ contextCap: config.contextCap, contextWindow: resolved.contextWindow }),
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workdir }),
				onReport: (report) => log.warn("durable_report", { kind: report.kind, error: String((report.error as Error)?.message ?? report.error) }),
			},
			BG,
		);

		// Commands and relative paths start in the home directory; files June keeps for herself stay in the workdir. A
		// restart also lets June's hair down: she always starts in default mode.
		const agent = { model, thinkingLevel: config.model.chat.thinkingLevel as never, cwd: expandHome("~") };
		const root = await harness.root(BG, { agent });
		const current = await root.agent(BG);
		if (
			current.model?.modelId !== model.modelId ||
			current.model?.provider !== model.provider ||
			current.thinkingLevel !== agent.thinkingLevel ||
			current.cwd !== agent.cwd
		)
			await root.configure(agent, BG);

		greeting.start(root);
		harness.resume();
		const stopPatter = patter?.start(harness, root);
		// Focus lasts for the turn June tied her hair up in: once the main thread goes quiet, she lets it down again. A held
		// focus lasts across turns until the user has been quiet for focusHoldMs; a hold left from before a restart or /new,
		// which start relaxed, is dropped.
		const focus = config.model.focus;
		const holdMs = options.focusHoldMs ?? 20 * 60_000;
		const unfocus =
			focus &&
			setInterval(
				() =>
					void (async () => {
						const current = (await root.agent(BG)).model;
						const focused = current?.modelId === focus.modelId && current?.provider === focus.provider;
						const held = (await harness.snapshot(FocusDoc, root.id, BG))?.held;
						if (!focused && held === undefined) return;
						if (focused && (await harness.snapshot(LiveDoc, root.id, BG))?.run !== undefined) return;
						if (focused && held !== undefined && Date.now() - Math.max(held, await lastSpoke()) < holdMs) return;
						await harness.commit(async (tx) => {
							if (focused) await configure(tx, root.id, { model, thinkingLevel: agent.thinkingLevel });
							delete (await tx.doc(FocusDoc, root.id)).held;
						}, BG);
					})().catch((error) => log.warn("unfocus_failed", { error: (error as Error).message })),
				1000,
			);
		/** When the user last sent a message of their own, rather than a report, reminder, or heartbeat. */
		const lastSpoke = async () =>
			(await root.context(BG)).messages.findLast((m) => m.role === "user" && !/^\[(\/stop|work|follow|reminder|heartbeat|watch)\b/.test(typeof m.content === "string" ? m.content : m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ")))?.timestamp ?? 0;
		const stopSituation = situation.start();
		const stopReflection = config.reflection.enabled
			? createReflection({ models: options.models, model: config.model.chat, config: config.reflection, window: { start: config.rhythm.sleep, end: config.rhythm.wake }, files: prompt.files, people: config.org.people, state: paths.state, log, ...options.reflectionClock }).start(harness, root)
			: undefined;
		const stopHeartbeat = config.heartbeat.enabled
			? createHeartbeat({
					config: config.heartbeat,
					window: { start: config.rhythm.wake, end: config.rhythm.quiet },
					situation,
					...(config.mail.enabled ? { mail: createMail({ config: config.mail, log, people: config.org.people, ...(options.mailRun ? { run: options.mailRun } : {}) }) } : {}),
					files: prompt.files,
					state: paths.state,
					log,
					...options.heartbeatClock,
				}).start(harness, root)
			: undefined;
		const stopLooseEnds = config.looseEnds.enabled
			? createLooseEnds({
					config: config.looseEnds,
					quiet: config.rhythm.quiet,
					chattingMinutes: config.heartbeat.chattingMinutes,
					files: prompt.files,
					state: paths.state,
					log,
					...options.looseEndsClock,
				}).start(harness, root)
			: undefined;

		const watchRun = options.watchClock?.run ?? runProcess;
		const stopWatch =
			config.watch.enabled && config.dispatch.hosts.length > 0
				? createWatch({
						config: config.watch,
						hosts: config.dispatch.hosts,
						host: config.herdr.host,
						ssh: config.herdr.hosts,
						window: { start: config.rhythm.wake, end: config.rhythm.quiet },
						org,
						registry,
						herdr: options.watchClock ? new Herdr(config.herdr, watchRun) : herdr,
						run: watchRun,
						state: paths.state,
						log,
						...(options.watchClock ? { now: options.watchClock.now, tickMs: options.watchClock.tickMs, home: options.watchClock.home } : {}),
					}).start(harness, root)
				: undefined;

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
				background: Object.keys((await harness.snapshot(WorkDoc, BG))?.active ?? {}).length,
				queued: mine.filter((s) => s.status === "queued").length,
				entries: view.entries.length,
				tools: resolvedAgent.tools.map((tool) => tool.name),
				source: dirname(import.meta.dirname),
			};
		};

		const inbox = `${paths.state}/inbox`;
		const stopInbox = startInboxExpiry(inbox, (error) => log.warn("inbox_expiry_failed", { error: error.message }));

		const clients = new Set<Socket>();
		const server = await listen(paths.socket, (socket) => {
			clients.add(socket);
			socket.once("close", () => clients.delete(socket));
			const relax = () => root.configure({ model, thinkingLevel: agent.thinkingLevel }, BG);
			serve(socket, { harness, root, models: options.models, status, reload: prompt.reload, relax, log, inbox });
		});
		log.info("june_started", { pid: process.pid, socket: paths.socket, conversation: root.id });

		let closing: Promise<void> | undefined;
		const close = () =>
			(closing ??= (async () => {
				log.info("june_stopping", {});
				// Clients reconnect on their own; an open connection must not hold the shutdown.
				const closed = new Promise<void>((resolve) => server.close(() => resolve()));
				for (const socket of clients) socket.destroy();
				await closed;
				stopPatter?.();
				if (unfocus) clearInterval(unfocus);
				stopReflection?.();
				stopSituation();
				stopHeartbeat?.();
				stopLooseEnds?.();
				stopWatch?.();
				stopInbox();
				await harness.close(BG);
				rmSync(paths.socket, { force: true });
				lock.release();
			})());
		return { harness, root, status, close };
	} catch (error) {
		lock.release();
		throw error;
	}
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

type Scope = CommandScope & { log: Logger; inbox: string };

function serve(socket: Socket, scope: Scope): void {
	const abort = new AbortController();
	const context = withAbortSignal(abort.signal, BG);
	let view: View | undefined;
	socket.on("error", () => {});
	socket.on("close", () => {
		abort.abort();
		void view?.stop();
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
				// A second attach on one connection starts the view over.
				await view?.stop();
				view = await attachView(scope.root, context, send, request.requestId, { detail: request.detail === true });
				return;
			}
			case "detail":
				if (view === undefined) throw new Error("Not attached");
				return view.detail(request.on === true, request.requestId);
			case "history": {
				const limit = Math.min(Math.max(1, request.limit ?? (request.since === undefined ? SNAPSHOT_ENTRIES : HISTORY_ENTRIES)), HISTORY_ENTRIES);
				const { entries, earlier } = await history(scope.root, request.since, limit, context);
				return send({ type: "history", requestId: request.requestId, entries, earlier });
			}
			case "submit": {
				const images = request.images ?? [];
				validateImages(images);
				const files = request.files ?? [];
				validateFiles(files, images.reduce((sum, image) => sum + image.data.length, 0));
				if (typeof request.text !== "string" || (!request.text.trim() && images.length === 0 && files.length === 0)) throw new Error("Empty message");
				if (images.length) {
					const model = (await scope.root.agent(context)).model;
					if (model === undefined || !scope.models.getModel(model.provider, model.modelId)?.input.includes("image"))
						throw new Error("The current model does not support images");
				}
				const source = sourceName(String(request.source));
				if (!(SOURCES as readonly string[]).includes(source)) throw new Error(`Unknown source ${String(request.source)}`);
				const requestId = `${source}:${request.requestId}`;
				// Saved before the submission, which names their paths; a retry finds what the first attempt saved.
				const saved = await saveFiles(scope.inbox, requestId, files);
				const said = [request.text, describeFiles(saved)].filter(Boolean).join("\n\n");
				// Telegram stays untagged for the model, so June's prompt and her Markdown there hold.
				const inputText = source === "telegram" ? said : `[${source}] ${said}`;
				const submission = await scope.root.submit(
					{
						type: "input",
						requestId,
						content: images.length ? [{ type: "text", text: inputText }, ...images] : inputText,
						whenBusy: request.whenBusy ?? "followUp",
						entry: {
							kind: "june.input",
							data: {
								source,
								text: request.text,
								...(images.length ? { imageCount: images.length } : {}),
								...(saved.length ? { files: saved.map(({ name, size, path }) => ({ name, size, path })) } : {}),
							},
						},
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

/** A connection's view: `detail` switches between the simple and complete view with a reset, `stop` ends it. */
export type View = { detail(on: boolean, requestId: string): void; stop(): Promise<unknown> };

/**
 * Attach a connection to the folded view: a watch of the root conversation, a `ConversationTranscript` that keeps entries
 * the window drops, and the items last sent, so each flush sends only what changed. A root replacement (the watch fell
 * 10,000 operations behind) starts the transcript over and sends a reset.
 */
export async function attachView(
	root: Pick<Conversation, "watch" | "entries">,
	context: Context,
	send: (reply: Reply) => void,
	requestId: string,
	options: { detail?: boolean } = {},
): Promise<View> {
	let detail = options.detail === true;
	const load = (query: Parameters<Conversation["entries"]>[0], limit: number, ctx: Context) => root.entries(query, limit, undefined, ctx);
	let transcript = new ConversationTranscript(load);
	const watch = await root.watch(context, WINDOW);
	let latest = transcript.merge(watch.value);
	let shown: Folded | undefined;
	let state = "";
	const sent = new Map<string, string>();
	const reset = (id?: string) => {
		shown = foldView(latest, { detail });
		sent.clear();
		for (const item of shown.items) sent.set(item.id, JSON.stringify(item));
		state = JSON.stringify(shown.state);
		send({ type: "view", ...(id ? { requestId: id } : {}), reset: true, items: shown.items, state: shown.state, earlier: shown.earlier });
	};
	reset(requestId);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let flushed = 0;
	let replaced = false;
	const flush = () => {
		timer = undefined;
		flushed = Date.now();
		if (replaced) {
			replaced = false;
			return reset();
		}
		const next = foldView(latest, { detail });
		const changes = diff(shown!.items, next.items, sent);
		const nextState = JSON.stringify(next.state);
		if (changes.length > 0 || nextState !== state) send({ type: "view", changes, ...(nextState !== state ? { state: next.state } : {}) });
		shown = next;
		state = nextState;
	};
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		if (call.ops[0]?.[0] === "r") {
			transcript = new ConversationTranscript(load);
			replaced = true;
		}
		latest = transcript.merge(call.value);
		timer ??= setTimeout(flush, Math.max(0, flushed + FLUSH_MS - Date.now()));
	});
	return {
		// The reset holds everything a pending flush would send.
		detail(on, id) {
			detail = on;
			clearTimeout(timer);
			timer = undefined;
			replaced = false;
			reset(id);
		},
		async stop() {
			clearTimeout(timer);
			await watch.stop();
		},
	};
}

/**
 * The newest `limit` entries since `since` (epoch ms), oldest first, paged back from the newest with `Conversation.entries()`
 * until enough are found. An entry without its own time, such as patter, takes the time of the entry before it.
 */
async function history(root: Conversation, since: number | undefined, limit: number, context: Context): Promise<{ entries: EntryRecord[]; earlier: boolean }> {
	const newest: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await root.entries({ order: "descending" }, 200, cursor, context);
		newest.push(...page.items);
		cursor = page.next;
		const oldest = (newest.at(-1)?.model?.[0] as { timestamp?: unknown } | undefined)?.timestamp;
		// Enough once the oldest held has its own time and is before `since`, or more than `limit` are held.
		if (typeof oldest === "number" && (newest.length > limit || (since !== undefined && oldest < since))) break;
	} while (cursor !== undefined);
	const all = newest.reverse();
	const times = entryTimes(all);
	const from = since === undefined ? 0 : times.findIndex((time) => time >= since);
	const entries = (from < 0 ? [] : all.slice(from)).slice(-limit);
	return { entries, earlier: entries.length < all.length || cursor !== undefined };
}
