// `june telegram`: Telegram as a client of June's protocol, a separate process on the Unix socket (see "Telegram bridge"
// in docs/architecture.org). Messages from the user's private chat become `submit` and `command` requests; it attaches to
// the simple items view and sends what answers Telegram or is routed there, exactly once across restarts of either
// process, with patter in one edited message per wait, the streaming reply as a native draft, and "typing…".
// The retry policy and draft pacing follow pi-durable-telegram 0.1.5 (dist/telegram/retry.js, dist/telegram/grammy-port.js,
// dist/delivery/preview.js), MIT License, Copyright (c) 2026 smixs.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Api, Bot, GrammyError, HttpError } from "grammy";
import type { Message, Update } from "grammy/types";
import { loadConfig, paths, readEnvFiles } from "./config.ts";
import { prepare } from "./images.ts";
import type { FileAttachment } from "./inbox.ts";
import { Client, COMMANDS, type Reply, type Request } from "./protocol.ts";
import { createLogger, type Logger } from "./runtime.ts";
import { escapeHtml, splitForTelegram, tail } from "./telegram-format.ts";
import { applyChanges, type ViewItem, type ViewState } from "./transcript.ts";
import { orgToMarkdown } from "./org.ts";

/** Commands Telegram offers; /start is Telegram's own and shows help. */
const TELEGRAM_COMMANDS = COMMANDS.filter((c) => c.name !== "reload");
/** Bots may download files up to 20 MB. */
const MAX_DOWNLOAD = 20 * 1024 * 1024;
/** Telegram clears "typing…" after about five seconds. */
const TYPING_MS = 4000;
/** At most one draft update a second; a draft vanishes about 30 s after its last update, so a quiet one is re-sent. */
const DRAFT_MS = 1000;
const DRAFT_REFRESH_MS = 20_000;
const DRAFT_CHARS = 3500;
const PATTER_CHARS = 3500;
/** Without saved state, messages older than this when the bridge starts are left unanswered. */
const STALE_MS = 5 * 60_000;
const REFUSED = "I can only take text, images, and files here: send a message, a photo, or a file.";

/** A Bot API refusal: nothing was sent. */
export class TelegramApiError extends Error {
	readonly code: number;
	readonly description: string;
	readonly retryAfter: number | undefined;
	constructor(method: string, code: number, description: string, retryAfter?: number) {
		super(`${method}: ${code} ${description}`);
		this.name = "TelegramApiError";
		this.code = code;
		this.description = description;
		this.retryAfter = retryAfter;
	}
}

/** A send whose outcome is unknown (network error, 5xx): Telegram may have accepted it, so it is never sent again. */
export class TelegramUnknown extends Error {
	constructor(method: string, reason: string) {
		super(`${method}: outcome unknown (${reason})`);
		this.name = "TelegramUnknown";
	}
}

/** What the bridge needs from Telegram; tests give a fake. Errors are `TelegramApiError`, `TelegramUnknown`, or others. */
export interface TelegramPort {
	/** Send a message: rich Markdown, Telegram HTML, or plain text, with link previews off where Telegram allows. */
	send(chatId: number, text: string, mode: "rich" | "html" | "plain"): Promise<number>;
	editHtml(chatId: number, messageId: number, html: string): Promise<void>;
	draft(chatId: number, draftId: number, markdown: string): Promise<void>;
	typing(chatId: number): Promise<void>;
	/** The file's bytes, refused over `limit`. */
	download(fileId: string, limit: number): Promise<Uint8Array>;
	setCommands(commands: readonly { command: string; description: string }[]): Promise<void>;
}

/** The daemon as the bridge uses it: one request at a time, retried on reconnect when `retry` is set. */
export interface DaemonLink {
	request(request: Request, options?: { retry?: boolean }): Promise<Reply>;
}

/** What survives a restart of either process, in `$XDG_STATE_HOME/june/telegram.json`. */
type State = {
	/** The newest Telegram update handled. */
	update: number;
	/** The newest entry id the bridge has acted on; undefined before the first view. */
	seen?: number;
	/** Run failures already sent, which have no entry id. */
	failures: string[];
	/** The open patter message: the wait's first patter item, the lines in it, and its message once sent. */
	patter?: { first: string; lines: string[]; messageId?: number };
};

export type BridgeOptions = {
	port: TelegramPort;
	link: DaemonLink;
	/** The first allowed user's private chat, whose id is the user's. */
	chatId: number;
	allowedUserIds: readonly number[];
	stateFile: string;
	log: Logger;
	/** Tests shorten these. */
	timing?: { typingMs?: number; draftMs?: number; draftRefreshMs?: number; tickMs?: number };
	/** Tests set the clock; also used for the staleness of messages on a first start. */
	now?: () => number;
	/** Turns image bytes into model content; tests skip the decoder. */
	prepareImage?: (bytes: Uint8Array, mimeType: string) => Promise<ImageContent>;
};

export class Bridge {
	readonly #o: BridgeOptions;
	readonly #now: () => number;
	readonly #allowed: ReadonlySet<number>;
	readonly #started: number;
	readonly #timing: Required<NonNullable<BridgeOptions["timing"]>>;
	#state: State;
	/** No saved state: a first start, which neither answers old messages nor sends old replies. */
	readonly #fresh: boolean;
	#items: ViewItem[] = [];
	#view: ViewState | undefined;
	#reset = false;
	#chain: Promise<void> = Promise.resolve();
	#ticker: ReturnType<typeof setInterval> | undefined;
	#typingAt = 0;
	#draftAt = 0;
	#draftText: string | undefined;
	#drafting = false;
	#drafts = true;
	#rich = true;
	readonly #detached = new Set<Promise<unknown>>();

	constructor(options: BridgeOptions) {
		this.#o = options;
		this.#now = options.now ?? Date.now;
		this.#started = this.#now();
		this.#allowed = new Set(options.allowedUserIds);
		this.#timing = { typingMs: TYPING_MS, draftMs: DRAFT_MS, draftRefreshMs: DRAFT_REFRESH_MS, tickMs: 1000, ...options.timing };
		const loaded = loadState(options.stateFile, options.log);
		this.#fresh = loaded === undefined;
		this.#state = loaded ?? { update: 0, failures: [] };
	}

	start(): void {
		this.#ticker ??= setInterval(() => this.#pulse(), this.#timing.tickMs);
	}

	/** Stop the pulse and wait for sends and commands in progress. */
	async stop(): Promise<void> {
		clearInterval(this.#ticker);
		this.#ticker = undefined;
		await this.#chain;
		await Promise.allSettled([...this.#detached]);
	}

	/** Wait for sends queued so far; tests use it. */
	idle(): Promise<void> {
		return this.#chain;
	}

	// ---- In: Telegram updates ----

	/** Handle one update. Never throws; an update is handled once even when Telegram delivers it again. */
	async handle(update: Update): Promise<void> {
		try {
			await this.#route(update);
		} catch (error) {
			this.#o.log.error("telegram_update_failed", { update_id: update.update_id, error: (error as Error).message });
		}
	}

	async #route(update: Update): Promise<void> {
		const id = update.update_id;
		if (id <= this.#state.update) return this.#o.log.info("telegram_update_duplicate", { update_id: id });
		const stopped = update.stopped_message_generation;
		if (stopped !== undefined) {
			// The stop button on a draft; a stop names no sender, and a private chat's id is its user's.
			if (stopped.chat.id !== this.#o.chatId) return this.#ignore(id, "other_chat");
			this.#mark(id);
			return this.#command("stop", "");
		}
		const message = update.message;
		if (message === undefined) return this.#ignore(id, "not_a_message");
		const from = message.from;
		if (message.chat.type !== "private" || message.chat.id !== this.#o.chatId) return this.#ignore(id, "other_chat", message);
		if (from === undefined || from.is_bot || !this.#allowed.has(from.id)) return this.#ignore(id, "not_allowed", message);
		if (this.#fresh && message.date * 1000 < this.#started - STALE_MS) return this.#ignore(id, "stale", message);

		const command = message.forward_origin === undefined && message.text !== undefined ? telegramCommand(message.text) : undefined;
		if (command !== undefined) {
			// Marked first: running a command twice is worse than losing it.
			this.#mark(id);
			return this.#command(command.name, command.args);
		}
		const attachment = imageOf(message);
		// An animation also comes as a document; it is video, which June cannot take.
		const document = attachment === undefined && message.animation === undefined ? message.document : undefined;
		if (message.text === undefined && attachment === undefined && document === undefined) {
			this.#mark(id);
			return this.#reply(REFUSED);
		}
		const files: FileAttachment[] = [];
		if (document !== undefined) {
			const name = document.file_name ?? "file";
			try {
				if ((document.file_size ?? 0) > MAX_DOWNLOAD) throw new Error("bots can download files up to 20 MB");
				const bytes = await this.#o.port.download(document.file_id, MAX_DOWNLOAD);
				files.push({ name, mimeType: document.mime_type ?? "application/octet-stream", data: Buffer.from(bytes).toString("base64") });
			} catch (error) {
				this.#o.log.warn("telegram_file_failed", { update_id: id, error: (error as Error).message });
				this.#mark(id);
				return this.#reply(`I couldn't take ${name}: ${(error as Error).message}`);
			}
		}
		const images: ImageContent[] = [];
		if (attachment !== undefined) {
			try {
				const bytes = await this.#o.port.download(attachment.fileId, MAX_DOWNLOAD);
				images.push(await (this.#o.prepareImage ?? prepare)(bytes, attachment.mimeType));
			} catch (error) {
				this.#o.log.warn("telegram_image_failed", { update_id: id, error: (error as Error).message });
				this.#mark(id);
				return this.#reply(`I couldn't read that image: ${(error as Error).message}`);
			}
		}
		const text = message.text ?? message.caption ?? "";
		// The update id is the request id, so a message Telegram delivers again is the same submission.
		const reply = await this.#o.link.request({ op: "submit", requestId: `update:${id}`, text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), source: "telegram", whenBusy: "followUp" }, { retry: true });
		this.#mark(id);
		if (reply.type === "error") return this.#reply(`⚠ ${reply.message}`);
		this.#o.log.info("telegram_message_submitted", { update_id: id, images: images.length, files: files.length });
	}

	#ignore(id: number, reason: string, message?: Message): void {
		this.#o.log.info("telegram_update_ignored", { update_id: id, reason, from: message?.from?.id, chat: message?.chat.id });
		this.#mark(id);
	}

	#mark(id: number): void {
		this.#state.update = Math.max(this.#state.update, id);
		this.#save();
	}

	/** Run a command apart from the update, so polling (and a later /stop) goes on while /compact works. */
	#command(name: string, args: string): void {
		const work = (async () => {
			if (name === "help" || name === "start") return this.#reply(help());
			const reply = await this.#o.link.request({ op: "command", requestId: randomUUID(), name, ...(args ? { args } : {}) });
			await this.#reply(reply.type === "reply" ? reply.text : reply.type === "error" ? `⚠ ${reply.message}` : "Unexpected reply");
		})().catch((error) => this.#o.log.warn("telegram_command_failed", { command: name, error: (error as Error).message }));
		this.#detached.add(work);
		void work.finally(() => this.#detached.delete(work));
	}

	/** A short plain message of the bridge's own, such as a command's reply. */
	#reply(text: string): Promise<void> {
		return this.#send(text, "plain");
	}

	// ---- Out: the folded view ----

	/** The daemon is out of reach: no "typing…" until the next attach brings its state again. */
	disconnected(): void {
		this.#view = undefined;
	}

	/** Take a view reply: a reset replaces the items, changes apply to them. */
	view(reply: Reply): void {
		if (reply.type !== "view") return;
		if ("reset" in reply) {
			this.#items = reply.items;
			this.#reset = true;
		} else this.#items = applyChanges(this.#items, reply.changes);
		if (reply.state !== undefined) this.#view = reply.state;
		this.#chain = this.#chain.then(() => this.#deliver()).catch((error) => this.#o.log.error("telegram_delivery_failed", { error: (error as Error).message }));
		this.#pulse();
	}

	/**
	 * Send, in order, what is new since the last entry acted on: replies that answer Telegram or alert it, and patter while
	 * the user's latest message came from Telegram. Each is recorded before it is sent, so a crash loses it rather than
	 * sending it twice. A reset sends nothing by itself: it only shows what was missed while either process was down.
	 */
	async #deliver(): Promise<void> {
		const items = this.#items;
		const reset = this.#reset;
		this.#reset = false;
		const newest = Math.max(0, ...items.flatMap((item) => (/^\d+$/.test(item.id) ? [Number(item.id)] : [])));
		if (this.#state.seen === undefined || (reset && newest < this.#state.seen)) {
			// A first start, or a conversation that starts over in a new database: everything shown is old.
			this.#state.seen = newest;
			this.#state.failures = items.flatMap((item) => (item.id.startsWith("failure:") ? [item.id] : []));
			delete this.#state.patter;
			return this.#save();
		}
		let latest = "";
		let waitFirst: string | undefined;
		for (const item of items) {
			if (item.kind === "user") {
				latest = item.source;
				waitFirst = undefined;
			}
			if (item.kind === "assistant" && (item.text.trim() !== "" || item.error !== undefined)) waitFirst = undefined;
			if (item.kind === "patter") waitFirst ??= item.id;
			const entry = /^\d+$/.test(item.id) ? Number(item.id) : undefined;
			if (entry === undefined) {
				if (item.kind === "assistant" && item.id.startsWith("failure:") && qualifies(item) && !this.#state.failures.includes(item.id)) {
					this.#state.failures = [...this.#state.failures, item.id].slice(-20);
					this.#save();
					await this.#send(`⚠ ${item.error}`, "plain");
				}
				continue;
			}
			if (entry <= this.#state.seen!) continue;
			this.#state.seen = entry;
			if (item.kind === "assistant" && qualifies(item)) {
				const text = replyText(item);
				this.#save();
				if (text !== undefined) await this.#sendMarkdown(text);
			} else if (item.kind === "patter" && latest === "telegram" && item.text.trim() !== "") await this.#patter(waitFirst!, item.text);
		}
		this.#save();
	}

	/**
	 * One message per wait, edited to add each line: an edit makes no sound, so the phone buzzes once. A wait whose
	 * message is lost, or would grow too long, goes on in a new one.
	 */
	async #patter(first: string, line: string): Promise<void> {
		const open = this.#state.patter;
		const html = (lines: readonly string[]) => lines.map((l) => `🦘 <i>${escapeHtml(l)}</i>`).join("\n\n");
		if (open?.first === first && open.messageId !== undefined && html([...open.lines, line]).length <= PATTER_CHARS) {
			open.lines.push(line);
			this.#save();
			try {
				await this.#o.port.editHtml(this.#o.chatId, open.messageId, html(open.lines));
			} catch (error) {
				this.#o.log.warn("telegram_patter_failed", { error: (error as Error).message });
			}
			return;
		}
		const next: NonNullable<State["patter"]> = { first, lines: [line] };
		this.#state.patter = next;
		this.#save();
		try {
			next.messageId = await this.#o.port.send(this.#o.chatId, html(next.lines), "html");
			this.#save();
		} catch (error) {
			this.#o.log.warn("telegram_patter_failed", { error: (error as Error).message });
		}
	}

	/** A reply: rich Markdown, else Telegram HTML when Telegram refuses it, else plain text when it refuses the HTML. */
	async #sendMarkdown(markdown: string): Promise<void> {
		for (const chunk of splitForTelegram(markdown)) {
			if (this.#rich) {
				try {
					await withRateLimit(() => this.#o.port.send(this.#o.chatId, chunk.markdown, "rich"));
					continue;
				} catch (error) {
					if (!(error instanceof TelegramApiError && error.code === 400)) {
						this.#failed(error);
						continue;
					}
					this.#o.log.warn("telegram_rich_refused", { description: error.description.slice(0, 200) });
					// Rich messages the bot cannot send (an older Bot API) are not tried again until a restart.
					if (/method not found|not supported|unknown method/i.test(error.description)) this.#rich = false;
				}
			}
			try {
				await withRateLimit(() => this.#o.port.send(this.#o.chatId, chunk.html, "html"));
			} catch (error) {
				if (!(error instanceof TelegramApiError && error.code === 400)) {
					this.#failed(error);
					continue;
				}
				await this.#send(chunk.plain, "plain");
			}
		}
	}

	async #send(text: string, mode: "html" | "plain"): Promise<void> {
		try {
			await withRateLimit(() => this.#o.port.send(this.#o.chatId, text, mode));
		} catch (error) {
			this.#failed(error);
		}
	}

	#failed(error: unknown): void {
		this.#o.log.warn(error instanceof TelegramUnknown ? "telegram_delivery_unknown" : "telegram_delivery_failed", { error: (error as Error).message.slice(0, 200) });
	}

	// ---- The pulse: drafts and "typing…" ----

	/** While June works on a Telegram message: her streaming reply as a draft, else "typing…". Never throws. */
	#pulse(): void {
		const items = this.#items;
		const latest = items.findLast((item) => item.kind === "user");
		if (latest?.kind !== "user" || latest.source !== "telegram" || this.#view === undefined) return;
		const now = this.#now();
		const live = items.find((item) => item.id === "live");
		// June writes Org; Telegram renders Markdown.
		const text = live?.kind === "assistant" ? orgToMarkdown(live.text.trim()) : "";
		if (text !== "" && this.#drafts) {
			const due = now - this.#draftAt >= this.#timing.draftMs && (text !== this.#draftText || now - this.#draftAt >= this.#timing.draftRefreshMs);
			if (this.#drafting || !due) return;
			this.#drafting = true;
			this.#draftAt = now;
			this.#draftText = text;
			const shown = text.length > DRAFT_CHARS ? `…${tail(text, DRAFT_CHARS)}` : text;
			const draftId = /^\d+$/.test(latest.id) ? Number(latest.id) : 1;
			void this.#o.port
				.draft(this.#o.chatId, draftId, shown)
				.catch((error) => {
					if (error instanceof TelegramApiError && error.code === 400) {
						// Telegram refused drafts here: "typing…" for the rest of this process.
						this.#drafts = false;
						this.#o.log.info("telegram_draft_unavailable", { description: error.description.slice(0, 200) });
					} else this.#o.log.debug("telegram_draft_failed", { error: (error as Error).message });
				})
				.finally(() => (this.#drafting = false));
			return;
		}
		if ((this.#view.running || this.#view.background > 0) && now - this.#typingAt >= this.#timing.typingMs) {
			this.#typingAt = now;
			void this.#o.port.typing(this.#o.chatId).catch((error) => this.#o.log.debug("telegram_typing_failed", { error: (error as Error).message }));
		}
	}

	#save(): void {
		saveState(this.#o.stateFile, this.#state);
	}
}

/** A reply that answers Telegram or is routed there, finished, with words or an error. */
function qualifies(item: Extract<ViewItem, { kind: "assistant" }>): boolean {
	return !item.streaming && (item.answers === "telegram" || item.alert === "telegram") && (item.text.trim() !== "" || item.error !== undefined);
}

/**
 * The text to send for a reply; a run the user stopped with no words says nothing, since /stop already answered. A failed
 * attempt with no words says nothing either: the harness retries it, and if every retry fails the run's own failure item
 * is sent instead.
 */
function replyText(item: Extract<ViewItem, { kind: "assistant" }>): string | undefined {
	const stopped = item.error !== undefined && /abort/i.test(item.error);
	const text = orgToMarkdown(item.text.trim());
	if (item.error === undefined) return text;
	if (text === "") return undefined;
	return stopped ? `${text}\n\n⏹ stopped` : `${text}\n\n⚠ ${item.error}`;
}

function help(): string {
	const commands = TELEGRAM_COMMANDS.map((c) => `/${c.name} - ${c.description}`).join("\n");
	return `June on Telegram. Send a message, a photo, or a file (up to 20 MB) with a caption. Files land in June's inbox for 30 days.\n\n${commands}`;
}

/** `/name args` for Telegram's commands and /start; other slash words go to June as text. */
export function telegramCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([a-z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (match === null) return undefined;
	const name = match[1]!;
	if (name !== "start" && !TELEGRAM_COMMANDS.some((c) => c.name === name)) return undefined;
	return { name, args: (match[2] ?? "").trim() };
}

/** A photo (its largest size) or an image sent as a file, which is how Telegram delivers an uncompressed screenshot. */
function imageOf(message: Message): { fileId: string; mimeType: string } | undefined {
	const photo = message.photo?.at(-1);
	if (photo !== undefined) return { fileId: photo.file_id, mimeType: "image/jpeg" };
	const document = message.document;
	if (document?.mime_type?.startsWith("image/")) return { fileId: document.file_id, mimeType: document.mime_type };
	return undefined;
}

/** Retry a call Telegram refused with 429, which proves nothing was sent, after the time it asks for. */
async function withRateLimit<T>(call: () => Promise<T>, waits = 5): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await call();
		} catch (error) {
			if (!(error instanceof TelegramApiError && error.code === 429) || attempt >= waits) throw error;
			await sleep(Math.min(30, Math.max(1, error.retryAfter ?? 5)) * 1000);
		}
	}
}

function loadState(file: string, log: Logger): State | undefined {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return {
			update: Number.isInteger(raw.update) ? raw.update : 0,
			...(Number.isInteger(raw.seen) ? { seen: raw.seen } : {}),
			failures: Array.isArray(raw.failures) ? raw.failures.filter((f: unknown) => typeof f === "string") : [],
			...(raw.patter && typeof raw.patter.first === "string" && Array.isArray(raw.patter.lines) ? { patter: raw.patter } : {}),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("telegram_state_unreadable", { file, error: (error as Error).message });
		return undefined;
	}
}

/** 0600, replaced atomically. */
function saveState(file: string, state: State): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
	renameSync(temp, file);
}

// ---- grammY ----

const NON_IDEMPOTENT = new Set(["sendMessage", "sendRichMessage", "sendPhoto", "sendDocument", "sendMediaGroup", "copyMessage", "forwardMessage"]);
const BACKOFF_MS = [1000, 2000, 4000];

/**
 * A grammY transformer that retries by method. Idempotent methods retry 429 (after `retry_after`), 5xx, and network
 * errors, up to three attempts. Sends retry only 429, which proves nothing was sent; a 5xx or network error becomes
 * `TelegramUnknown` and is never retried. `fast` calls (drafts, typing) are tried once.
 */
export function retryTransformer(options: { fast?: boolean; wait?: (ms: number) => Promise<unknown> } = {}) {
	const wait = options.wait ?? ((ms: number) => sleep(ms));
	// grammY types the signal with its abort-controller polyfill; it is only checked for `aborted`.
	return async (prev: any, method: string, payload: any, signal?: any): Promise<any> => {
		const idempotent = !NON_IDEMPOTENT.has(method);
		for (let attempt = 1; ; attempt++) {
			const last = options.fast === true || attempt >= 3;
			let result: any;
			try {
				result = await prev(method, payload, signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				if (!idempotent) throw new TelegramUnknown(method, "network error");
				if (last) throw error;
				await wait(BACKOFF_MS[attempt - 1] ?? 4000);
				continue;
			}
			if (typeof result !== "object" || result === null || typeof result.ok !== "boolean") {
				if (!idempotent) throw new TelegramUnknown(method, "malformed response");
				if (last) return result;
				await wait(BACKOFF_MS[attempt - 1] ?? 4000);
				continue;
			}
			if (result.ok) return result;
			if ((result.error_code ?? 0) >= 500) {
				if (!idempotent) throw new TelegramUnknown(method, `HTTP ${result.error_code}`);
				if (last) return result;
				await wait(BACKOFF_MS[attempt - 1] ?? 4000);
				continue;
			}
			if (result.error_code === 429 && !last) {
				await wait(Math.min(30, Math.max(0, result.parameters?.retry_after ?? 1)) * 1000);
				continue;
			}
			return result;
		}
	};
}

/** Rebuild grammY's errors without payloads or URLs, which may carry the token or the user's text. */
function translate(method: string, error: unknown): unknown {
	if (error instanceof TelegramUnknown || error instanceof TelegramApiError) return error;
	if (error instanceof GrammyError) return new TelegramApiError(method, error.error_code, error.description, error.parameters.retry_after);
	if (error instanceof HttpError) return new Error(`${method}: network error`);
	return error;
}

async function guard<T>(method: string, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		throw translate(method, error);
	}
}

/** `TelegramPort` over grammY's `Api`: sends retry by the transformer above, drafts and typing are tried once. */
export function grammyPort(api: Api, token: string, apiRoot = "https://api.telegram.org"): TelegramPort {
	const fast = new Api(token, { apiRoot, timeoutSeconds: 30 });
	fast.config.use(retryTransformer({ fast: true }));
	const noPreview = { link_preview_options: { is_disabled: true } };
	return {
		send: (chatId, text, mode) =>
			mode === "rich"
				? guard("sendRichMessage", async () => (await api.sendRichMessage(chatId, { markdown: text })).message_id)
				: guard("sendMessage", async () => (await api.sendMessage(chatId, text, { ...noPreview, ...(mode === "html" ? { parse_mode: "HTML" as const } : {}) })).message_id),
		editHtml: (chatId, messageId, html) =>
			guard("editMessageText", async () => {
				await api.editMessageText(chatId, messageId, html, { parse_mode: "HTML", ...noPreview });
			}),
		draft: (chatId, draftId, markdown) =>
			guard("sendRichMessageDraft", async () => {
				await fast.sendRichMessageDraft(chatId, draftId, { markdown }, { can_stop: true });
			}),
		typing: (chatId) =>
			guard("sendChatAction", async () => {
				await fast.sendChatAction(chatId, "typing");
			}),
		download: (fileId, limit) =>
			guard("getFile", async () => {
				const file = await api.getFile(fileId);
				if (file.file_path === undefined) throw new Error("Telegram gave no download path");
				if ((file.file_size ?? 0) > limit) throw new Error(`bots can download files up to ${Math.round(limit / 1024 / 1024)} MB`);
				const response = await fetch(`${apiRoot}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
				if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (bytes.length > limit) throw new Error(`bots can download files up to ${Math.round(limit / 1024 / 1024)} MB`);
				return bytes;
			}),
		setCommands: (commands) =>
			guard("setMyCommands", async () => {
				await api.setMyCommands(commands.map((c) => ({ command: c.command, description: c.description })));
			}),
	};
}

// ---- The daemon connection ----

/**
 * The socket to the daemon, attached to the simple view and reconnected with backoff from 1 to 30 seconds. Each attach
 * starts from a reset, which the bridge reads as the truth. A retried submit keeps its request id, so it is one message.
 */
export class SocketLink implements DaemonLink {
	readonly #socket: string;
	readonly #log: Logger;
	#client: Client | undefined;
	#ready: Promise<Client>;
	#resolve!: (client: Client) => void;
	readonly #stop = new AbortController();
	/** Rejects once stopped, so a request waiting for the daemon gives up. */
	readonly #halted: Promise<never>;

	constructor(socket: string, log: Logger) {
		this.#socket = socket;
		this.#log = log;
		this.#ready = new Promise((resolve) => (this.#resolve = resolve));
		this.#halted = new Promise((_, reject) => this.#stop.signal.addEventListener("abort", () => reject(new Error("The bridge is stopping"))));
		this.#halted.catch(() => {});
	}

	/** Connect and keep connected; every reply goes to `onReply`, and `onClose` hears each lost connection. */
	async run(onReply: (reply: Reply) => void, onClose: () => void = () => {}): Promise<void> {
		let delay = 1000;
		while (!this.#stop.signal.aborted) {
			let client: Client | undefined;
			try {
				client = await Client.open(this.#socket);
				client.on(onReply);
				const attached = await client.request({ op: "attach", requestId: randomUUID() });
				if (attached.type === "error") throw new Error(attached.message);
				this.#client = client;
				this.#resolve(client);
				this.#log.info("telegram_attached");
				delay = 1000;
				await client.closed;
				this.#log.warn("telegram_daemon_closed");
			} catch (error) {
				client?.close();
				this.#log.debug("telegram_daemon_unavailable", { error: (error as Error).message });
			}
			this.#client = undefined;
			this.#ready = new Promise((resolve) => (this.#resolve = resolve));
			onClose();
			if (this.#stop.signal.aborted) return;
			await sleep(delay, undefined, { signal: this.#stop.signal }).catch(() => {});
			delay = Math.min(delay * 2, 30_000);
		}
	}

	async request(request: Request, options: { retry?: boolean } = {}): Promise<Reply> {
		for (;;) {
			const client = this.#client ?? (await Promise.race([this.#ready, this.#halted]));
			try {
				return await client.request(request);
			} catch (error) {
				if (!options.retry || this.#stop.signal.aborted) throw error;
			}
		}
	}

	stop(): void {
		this.#stop.abort();
		this.#client?.close();
	}
}

/** `june telegram`: run the bridge until SIGTERM. */
export async function runTelegram(): Promise<number> {
	const p = paths();
	const config = loadConfig(p);
	const log = createLogger({ level: (process.env.JUNE_LOG_LEVEL as never) ?? "info" });
	if (config.telegram === undefined) {
		console.error("Telegram is not configured: set TELEGRAM_ALLOWED_USERS and TELEGRAM_BOT_TOKEN in June's environment.");
		return 2;
	}
	const { tokenEnv, allowedUserIds } = config.telegram;
	const token = process.env[tokenEnv] || readEnvFiles(config.envFiles)[tokenEnv];
	if (!token) {
		console.error(`Telegram is not configured: ${tokenEnv} is not set.`);
		return 2;
	}
	const bot = new Bot(token, { client: { timeoutSeconds: 75 } });
	bot.api.config.use(retryTransformer());
	const port = grammyPort(bot.api, token);
	const link = new SocketLink(p.socket, log);
	const bridge = new Bridge({ port, link, chatId: allowedUserIds[0]!, allowedUserIds, stateFile: join(p.state, "telegram.json"), log });
	bridge.start();
	const linked = link.run(
		(reply) => bridge.view(reply),
		() => bridge.disconnected(),
	);
	await port.setCommands(TELEGRAM_COMMANDS.map((c) => ({ command: c.name, description: c.description }))).catch((error) => log.warn("telegram_commands_failed", { error: (error as Error).message }));
	bot.use((ctx) => bridge.handle(ctx.update));
	bot.catch((error) => log.error("telegram_bot_error", { update_id: error.ctx.update.update_id, error: (translate("update", error.error) as Error).message }));
	// The link first, so an update waiting for the daemon gives up and Telegram delivers it again next time.
	const stop = () => {
		link.stop();
		void bot.stop();
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		await bot.start({ allowed_updates: ["message", "stopped_message_generation"], onStart: (info) => log.info("telegram_polling", { bot: info.username }) });
	} finally {
		link.stop();
		await bridge.stop();
		await linked;
	}
	return 0;
}
