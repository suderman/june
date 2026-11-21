// The terminal client. It attaches to the daemon's primary conversation, renders the items the daemon folds, and sends
// input. Closing it never touches running work; it reconnects on its own when the daemon restarts.
import { randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import { clipboardInput, imageInput } from "./images.ts";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	type EditorTheme,
	getKeybindings,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	type ProgramStatus,
	ScrollView,
	TuiAltScreen,
	truncateToWidth,
	VStack,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Client, COMMANDS, parseCommand, type Reply, type Request } from "./protocol.ts";
import { applyChanges, type ViewItem, type ViewState } from "./transcript.ts";
import { orgToMarkdown } from "./org.ts";
import { emacsCall, linkKind, momentOf } from "../desktop/strip.mjs";
import { runProcess, type Run } from "./tools/herdr.ts";

/** Use the desktop's link rules and file arguments; never pass a link through a shell. */
export async function openTuiLink(url: string, run: Run = runProcess): Promise<void> {
	const kind = linkKind(url);
	if (kind === null) throw new Error("June cannot open that kind of link");
	let argv = ["xdg-open", url];
	if (kind === "file") argv = emacsCall(url);
	else if (kind === "herdr") argv = ["herdr-link", "jump", url];
	await run(argv, 30_000);
}

/** The terminal's own commands, for browsing June's history; the daemon never sees them. */
export const LOCAL_COMMANDS = [
	{ name: "day", description: "Browse a past day: YYYY-MM-DD or yesterday; alone, list the days" },
	{ name: "today", description: "Back to today's live conversation" },
	{ name: "search", description: "Find what you and June said; /at ID opens a hit" },
	{ name: "at", description: "Open the day of a moment by its id, marked" },
] as const;
type LocalCommand = (typeof LOCAL_COMMANDS)[number]["name"];

/** `/name args` when `text` is one of the terminal's own commands; undefined otherwise. */
export function localCommand(text: string): { name: LocalCommand; args: string } | undefined {
	const match = /^\/(day|today|search|at)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? { name: match[1] as LocalCommand, args: (match[2] ?? "").trim() } : undefined;
}

/** The day before `date`, both "YYYY-MM-DD". */
export function previousDay(date: string): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const day = new Date(y, m - 1, d - 1);
	return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

const dayLabel = (date: string, style: "long" | "short" = "long") => {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return new Date(y, m - 1, d).toLocaleDateString("en-CA", style === "long" ? { weekday: "long", month: "long", day: "numeric", year: "numeric" } : { weekday: "short", month: "short", day: "numeric" });
};

/** The most recent days with conversation, newest first, for /day alone. */
export function daysText(reply: Extract<Reply, { type: "days" }>, count = 14): string {
	if (reply.days.length === 0) return "No conversation yet.";
	const rows = reply.days.slice(-count).reverse().map(({ date, count: n }) => `${date}  ${dayLabel(date, "short")}  ${n} message${n === 1 ? "" : "s"}${date === reply.today ? "  (today)" : ""}`);
	const earlier = reply.days.length > count ? `${reply.days.length - count} earlier days not listed. ` : "";
	return [...rows, `${earlier}/day YYYY-MM-DD opens one.`].join("\n");
}

/** Search hits, newest first, one a line led by the id /at takes. */
export function searchText(reply: Extract<Reply, { type: "search" }>): string {
	if (reply.hits.length === 0) return "Nothing found.";
	const time = (at: number) => new Date(at).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false });
	const rows = reply.hits.map((hit) => `${hit.id}  ${dayLabel(hit.date, "short")} ${time(hit.at)}  ${hit.kind === "user" ? "you" : "June"}: ${hit.text}`);
	return [...rows, `${reply.more ? "Older hits left out; add words to narrow it. " : ""}/at ID opens one.`].join("\n");
}

/** Items kept after the moment /at opens, so the view, which follows its end, shows the moment near the bottom. */
const AFTER_MOMENT = 3;

/** A past day being browsed, fixed while the live view keeps updating underneath; `more` items past the moment are cut. */
export type Past = { date: string; items: ViewItem[]; at?: string; more: number };

/** A command's reply. Like a Telegram command reply, it is not part of the conversation; a reconnect drops it. */
type CommandReply = { kind: "reply"; id: string; command: string; text: string };
type Item = ViewItem | CommandReply;

const esc = (code: string, off: string) => (s: string) => `\x1b[${code}m${s}\x1b[${off}m`;
const c = {
	muted: esc("90", "39"),
	user: esc("36", "39"),
	accent: esc("33", "39"),
	ok: esc("32", "39"),
	err: esc("31", "39"),
	// Patter's own colour: readable on a dim or translucent background, and used for nothing else.
	patter: esc("35", "39"),
	bold: esc("1", "22"),
	italic: esc("3", "23"),
};
const markdownTheme: MarkdownTheme = {
	heading: (s) => c.bold(c.accent(s)),
	link: c.user,
	linkUrl: c.muted,
	code: c.accent,
	codeBlock: (s) => s,
	codeBlockBorder: c.muted,
	quote: c.muted,
	quoteBorder: c.muted,
	hr: c.muted,
	listBullet: c.accent,
	bold: c.bold,
	italic: c.italic,
	strikethrough: esc("9", "29"),
	underline: esc("4", "24"),
};
const editorTheme: EditorTheme = {
	borderColor: c.muted,
	selectList: {
		selectedPrefix: c.accent,
		selectedText: c.accent,
		description: c.muted,
		scrollInfo: c.muted,
		noMatch: c.muted,
	},
};

// What June is up to while the old conversation is summarized and her memory reviewed. One phrase every six seconds.
const CHORES = [
	"boiling the billy",
	"rolling up the swag",
	"tidying the paddock",
	"sorting the yarns worth keeping",
	"jotting the good bits in MEMORY.org",
	"packing the esky",
	"herding the loose ends",
	"folding the old chat neatly",
	"checking what's worth remembering",
	"shooing the drop bears out of the context",
];
const LATE = ["nearly there, reckon", "still at it, don't rush me", "this one's a big swag"];
const TRACK = 8;

/** What the terminal client tells herdr-core and other OSC 7501 terminals about June. One June answers every surface,
 * so a reply to Telegram or the phone shows here as working too. Prompts and replies are never reported. */
export function programStatus(now: {
	connection: "connecting" | "online" | "offline";
	running: boolean;
	background: number;
	queued: number;
	compacting: boolean;
	notice?: string;
	answered: boolean;
}): ProgramStatus {
	const app = "june";
	if (now.connection === "offline") return { state: "error", app, message: "Daemon unreachable" };
	if (now.compacting) return { state: "working", app, message: "Compacting" };
	if (now.running) return { state: "working", app, message: now.queued ? `${now.queued} queued` : "June" };
	if (now.background > 0) return { state: "working", app, message: "Working in the background" };
	if (now.notice) return { state: "error", app, message: now.notice };
	return { state: now.answered ? "done" : "idle", app, message: "June" };
}

/**
 * A kangaroo hopping along a track, a chore, and the time so far. Past a minute she gets a touch defensive. Noto's
 * kangaroo faces left and a terminal cannot mirror a glyph, so she hops right to left, footprints behind her, and starts
 * again from the right.
 */
export function compactingStatus(elapsedMs: number): string {
	const at = TRACK - 1 - (Math.floor(elapsedMs / 250) % TRACK);
	const track = Array.from({ length: TRACK }, (_, i) => (i === at ? "🦘" : i > at ? "·" : " ")).join("");
	const seconds = Math.floor(elapsedMs / 1000);
	const phrases = seconds >= 60 ? LATE : CHORES;
	const chore = phrases[Math.floor(seconds / 6) % phrases.length]!;
	const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	return `${c.accent(track)} ${c.italic(`${chore}…`)} ${c.muted(clock)}`;
}

/** m:ss for a finished compaction. */
const took = (ms: number) => {
	const seconds = Math.round(ms / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

class Line implements Component {
	text: string;
	constructor(text = "") {
		this.text = text;
	}
	render(width: number) {
		return [truncateToWidth(this.text, width)];
	}
	invalidate() {}
}

class Wrapped implements Component {
	readonly text: string;
	readonly prefix: string;
	constructor(text: string, prefix: string) {
		this.text = text;
		this.prefix = prefix;
	}
	render(width: number) {
		const lines = this.text.split("\n").flatMap((l) => (l ? wrapTextWithAnsi(l, Math.max(1, width - 2)) : [""]));
		return lines.map((l, i) => truncateToWidth((i ? "  " : this.prefix) + l, width));
	}
	invalidate() {}
}

function component(item: Item): Component[] {
	switch (item.kind) {
		case "user": {
			const tag = item.source === "tui" ? "" : c.muted(`${item.source} `);
			const images = item.imageCount ? `[${item.imageCount} image${item.imageCount === 1 ? "" : "s"}]` : "";
			const files = (item.files ?? []).map((f) => `[file ${f.name}]`).join(" ");
			return [new Line(), new Wrapped(c.user([item.text, images, files].filter(Boolean).join("\n")), `${tag}${c.user("› ")}`)];
		}
		case "assistant": {
			const parts: Component[] = [new Line()];
			for (const line of item.thinking?.split("\n") ?? []) parts.push(new Line(c.italic(c.muted(`∴ ${line}`))));
			// June writes Org; the terminal draws Markdown. A moment she links opens on a click, or by the /at it names.
			if (item.text) parts.push(new Markdown(orgToMarkdown(item.text).replace(/\]\(june:at\/(\d+)\)/g, "](june:at/$1) (/at $1)"), 0, 0, markdownTheme));
			if (item.streaming && parts.length === 1) parts.push(new Line(c.muted("…")));
			if (item.error) parts.push(new Line(c.err(`! ${item.error}`)));
			return parts;
		}
		case "tool": {
			const icon = item.status === "running" ? c.accent("•") : item.status === "done" ? c.ok("✓") : c.err("✗");
			const rows: Component[] = [new Line(`${icon} ${c.bold(item.name)} ${c.muted(item.summary)}`)];
			if (item.status === "error" && item.error) rows.push(new Line(c.err(`  ${item.error}`)));
			return rows;
		}
		case "shown":
			return item.files.map((f) => new Line(`${c.accent("⎘")} ${c.bold(f.name)} ${c.muted(`shown, ${f.mimeType}`)}`));
		case "note":
			return [new Line(c.muted(`── ${item.text}`))];
		case "patter":
			// June keeping you company while the work runs; styled apart from her real answers.
			return [new Line(), new Wrapped(c.italic(c.patter(item.text)), "🦘 ")];
		case "reply":
			return [new Line(), new Wrapped(c.muted(item.text), c.muted(`/${item.command} `))];
	}
}

/** What the daemon sent, and the command replies shown after the item that was last when each arrived. */
export class Transcript {
	items: ViewItem[] = [];
	state: ViewState = { running: false, background: 0, queued: 0, model: "", compacting: false, expression: "idle" };
	earlier = false;
	/** When the running compaction started, as this client first saw it; undefined when none runs. */
	compacting: number | undefined;
	#replies: { after: string | null; reply: CommandReply }[] = [];
	past: Past | undefined;
	#pastReplies: CommandReply[] = [];

	/** Browse a day the daemon folded: all of it, or with a moment, up to a few items past it. */
	browse(reply: Extract<Reply, { type: "day" }>): void {
		const at = reply.at === undefined ? -1 : reply.items.findIndex((item) => item.id === reply.at);
		const end = at < 0 ? reply.items.length : Math.min(reply.items.length, at + 1 + AFTER_MOMENT);
		this.past = { date: reply.date, items: reply.items.slice(0, end), ...(reply.at !== undefined ? { at: reply.at } : {}), more: reply.items.length - end };
		this.#pastReplies = [];
	}

	/** Back to the live view. */
	today(): void {
		this.past = undefined;
		this.#pastReplies = [];
	}

	apply(reply: Extract<Reply, { type: "view" }>): void {
		if ("reset" in reply) {
			this.items = reply.items;
			this.earlier = reply.earlier;
			this.#replies = [];
		} else this.items = applyChanges(this.items, reply.changes);
		if (reply.state !== undefined) this.state = reply.state;
		this.compacting = this.state.compacting ? (this.compacting ?? Date.now()) : undefined;
	}

	reply(command: string, text: string): void {
		// A past day does not change, so a reply given there follows it.
		if (this.past) {
			this.#pastReplies.push({ kind: "reply", id: `reply:past:${this.#pastReplies.length}`, command, text });
			return;
		}
		// After the last item that stays: the streaming reply and a failure note are replaced when the run settles.
		const anchor = this.items.findLast((item) => item.id !== "live" && !item.id.startsWith("failure:"));
		this.#replies.push({ after: anchor?.id ?? null, reply: { kind: "reply", id: `reply:${this.#replies.length}`, command, text } });
	}

	/** Items and replies in display order; a reply whose item is gone stays at the end. */
	shown(): Item[] {
		if (this.past) return [...this.past.items, ...this.#pastReplies];
		const ids = new Set(this.items.map((item) => item.id));
		const after = (id: string | null) => this.#replies.filter((r) => r.after === id).map((r) => r.reply);
		return [...after(null), ...this.items.flatMap((item) => [item, ...after(item.id)]), ...this.#replies.filter((r) => r.after !== null && !ids.has(r.after)).map((r) => r.reply)];
	}
}

class TranscriptView extends Container {
	update(transcript: Transcript) {
		this.clear();
		const past = transcript.past;
		if (past) {
			this.addChild(new Line(c.accent(`── ${dayLabel(past.date)} · /today returns`)));
			if (past.items.length === 0) this.addChild(new Line(c.muted("── nothing said that day · /day lists the days")));
		} else if (transcript.earlier) this.addChild(new Line(c.muted("── earlier days: /day yesterday · /day lists them · /search WORDS")));
		for (const item of transcript.shown()) {
			if (past?.at !== undefined && item.id === past.at) this.addChild(new Line(c.accent("▶ the moment")));
			for (const part of component(item)) this.addChild(part);
		}
		if (past?.more) this.addChild(new Line(c.muted(`── ${past.more} more that day · /day ${past.date}`)));
	}
}

export async function runTui(socketPath: string): Promise<void> {
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal, false, undefined, {
		openUrl: (url) => {
			const moment = momentOf(url);
			if (moment !== undefined) return void browse("at", String(moment)).catch(fail);
			void openTuiLink(url).catch((error) => {
				flash = `Link failed: ${error instanceof Error ? error.message : String(error)}`;
				redraw();
			});
		},
	});
	const transcript = new Transcript();
	const header = new Line();
	const view = new TranscriptView();
	const status = new Line();
	// As in Jon's pi: Alt+Enter breaks the line, Shift+Enter queues, and Up recalls earlier prompts.
	getKeybindings().setUserBindings({ "tui.input.newLine": ["alt+enter", "ctrl+j"] });
	const editor = new Editor(tui, editorTheme, { paddingX: 1 });
	const footer = new Line(c.muted("enter send · ctrl+v / shift+insert paste · alt+enter newline · ↑ history · shift+enter queue · esc /stop · ctrl+d detach"));
	tui.setLayoutRoot(
		new VStack([
			{ component: header, basis: "auto" },
			{ component: new ScrollView(view, { follow: "end", primary: true }), basis: 0, grow: 1, minSize: 3 },
			{ component: status, basis: "auto" },
			{ component: editor, basis: "auto", shrink: 1, minSize: 1 },
			{ component: footer, basis: "auto" },
		]),
	);

	let client: Client | undefined;
	let connection: "connecting" | "online" | "offline" = "connecting";
	let flash: string | undefined;
	let inputBusy = false;
	let imageNumber = 0;
	const pasted = new Map<string, ImageContent>();
	// /compact's own start, before the daemon's compaction event arrives; the transcript's wins once it does.
	let compactStarted: number | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	// Idle until June works while this client watches; done after that, as Pi reports.
	let answered = false;
	let reported: string | undefined;
	let done!: () => void;
	const finished = new Promise<void>((resolve) => (done = resolve));

	const redraw = () => {
		const state = connection === "online" ? c.ok("●") : c.err("●");
		header.text = `${state} 🦘 ${c.bold("June")} ${c.muted(transcript.state.model)}`;
		const parts = [];
		if (connection !== "online") parts.push(c.err(connection === "connecting" ? "connecting…" : "daemon unreachable, retrying"));
		if (transcript.state.running) parts.push(c.accent("working"));
		else if (transcript.state.background > 0) parts.push(c.accent("working in the background"));
		if (transcript.state.queued) parts.push(c.muted(`${transcript.state.queued} queued`));
		if (transcript.state.notice) parts.push(c.err(transcript.state.notice));
		if (flash) parts.push(c.err(flash));
		if (inputBusy) parts.push(c.muted("preparing input…"));
		const since = transcript.compacting ?? compactStarted;
		if (since !== undefined) parts.push(compactingStatus(Date.now() - since));
		if (since !== undefined && ticker === undefined) ticker = setInterval(redraw, 250);
		if (since === undefined && ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
		status.text = parts.join(c.muted(" · "));
		view.update(transcript);
		tui.requestRender();
		const { running, background, queued, notice } = transcript.state;
		if (running || background > 0 || since !== undefined) answered = true;
		const report = programStatus({ connection, running, background, queued, compacting: since !== undefined, notice, answered });
		const key = JSON.stringify(report);
		if (key === reported) return; // the compaction stopwatch redraws four times a second
		reported = key;
		terminal.setProgramStatus(report);
	};

	const exit = () => {
		clearInterval(ticker);
		client?.close();
		tui.stop();
		done();
	};

	const send = async (text: string, whenBusy: "steer" | "followUp") => {
		if (!text.trim() || inputBusy) return;
		editor.setText(text);
		if (client === undefined || connection !== "online") {
			flash = "not connected; message not sent";
			editor.setText(text);
			return redraw();
		}
		flash = undefined;
		const own = localCommand(text);
		if (own !== undefined) {
			editor.addToHistory(text);
			editor.setText("");
			await browse(own.name, own.args).catch(fail);
			return;
		}
		const command = parseCommand(text);
		if (command !== undefined) {
			editor.addToHistory(text);
			editor.setText("");
			pasted.clear();
			try { await run(command.name, command.args); }
			catch (error) {
				flash = error instanceof Error ? error.message : String(error);
				redraw();
			}
			return;
		}
		inputBusy = true;
		redraw();
		try {
			const input = await imageInput(text, pasted);
			const reply = await client.request({ op: "submit", requestId: randomUUID(), ...input, source: "tui", whenBusy });
			if (reply.type === "error") throw new Error(reply.message);
			// Sent from a past day, the message joins today's conversation, so the view follows it there.
			transcript.today();
			editor.addToHistory(text);
			editor.setText("");
			pasted.clear();
		} catch (error) {
			flash = error instanceof Error ? error.message : String(error);
		} finally {
			inputBusy = false;
			redraw();
		}
	};

	const paste = async () => {
		inputBusy = true;
		flash = undefined;
		redraw();
		try {
			if (process.env.SSH_CONNECTION) throw new Error("Clipboard access is unavailable over SSH; use a path on the daemon host");
			const input = await clipboardInput();
			if ("text" in input) editor.insertTextAtCursor(input.text);
			else {
				const marker = `[image ${++imageNumber}]`;
				pasted.set(marker, input.image);
				editor.insertTextAtCursor(`${marker} `);
			}
		} catch (error) {
			flash = `Paste failed: ${error instanceof Error ? error.message : String(error)}. Paste an image file path instead.`;
		} finally {
			inputBusy = false;
			redraw();
		}
	};

	const run = async (name: string, args = "") => {
		if (client === undefined) return;
		if (name === "compact") {
			compactStarted = Date.now();
			redraw();
		}
		const started = compactStarted;
		const reply = await client.request({ op: "command", requestId: randomUUID(), name, args }).finally(() => {
			if (name === "compact") compactStarted = undefined;
		});
		flash = undefined;
		// A compaction that did real work takes seconds; an instant reply needs no stopwatch.
		const elapsed = started === undefined ? 0 : Date.now() - started;
		if (reply.type === "reply") transcript.reply(name, elapsed < 1000 ? reply.text : `${reply.text} (${took(elapsed)})`);
		else if (reply.type === "error") flash = reply.message;
		redraw();
	};

	const fail = (error: unknown) => {
		flash = error instanceof Error ? error.message : String(error);
		redraw();
	};

	/** The terminal's own commands: browse a day or a moment, search, or return to today. */
	const browse = async (name: LocalCommand, args: string) => {
		const current = client;
		if (current === undefined || connection !== "online") throw new Error("not connected");
		const ask = async (request: Request) => {
			const reply = await current.request(request);
			if (reply.type === "error") throw new Error(reply.message);
			return reply;
		};
		const open = async (where: { date: string } | { at: number }) => {
			const reply = await ask({ op: "day", requestId: randomUUID(), ...where });
			if (reply.type !== "day") return;
			if (reply.today && reply.at === undefined) transcript.today();
			else transcript.browse(reply);
		};
		flash = undefined;
		if (name === "today" || (name === "day" && args === "today")) transcript.today();
		else if (name === "search") {
			if (args === "") throw new Error("/search needs words");
			const reply = await ask({ op: "search", requestId: randomUUID(), query: args, limit: 20 });
			if (reply.type === "search") transcript.reply("search", searchText(reply));
		} else if (name === "at") {
			const id = momentOf(`june:at/${args.replace(/^june:at\//, "")}`);
			if (id === undefined) throw new Error("/at takes an entry id, such as /at 38039");
			await open({ at: id });
		} else if (args === "" || args === "yesterday") {
			const reply = await ask({ op: "days", requestId: randomUUID() });
			if (reply.type !== "days") return;
			if (args === "") transcript.reply("day", daysText(reply));
			else await open({ date: previousDay(reply.today) });
		} else if (/^\d{4}-\d{2}-\d{2}$/.test(args)) await open({ date: args });
		else throw new Error("/day takes YYYY-MM-DD, yesterday or today");
		redraw();
	};

	editor.onSubmit = (text) => {
		void send(text, transcript.state.running ? "steer" : "followUp");
	};
	tui.addInputListener((data) => {
		if (inputBusy) return { consume: true };
		if (matchesKey(data, "ctrl+v") || matchesKey(data, "shift+insert")) {
			void paste();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+c")) {
			if (editor.getText()) {
				editor.setText("");
				pasted.clear();
			}
			else exit();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d") && !editor.getText()) {
			exit();
			return { consume: true };
		}
		if (matchesKey(data, "escape") && !editor.isShowingAutocomplete()) {
			if (transcript.state.running || transcript.state.background > 0) void run("stop");
			return { consume: true };
		}
		if (matchesKey(data, "shift+enter")) {
			void send(editor.getExpandedText(), "followUp");
			return { consume: true };
		}
		return undefined;
	});
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...COMMANDS, ...LOCAL_COMMANDS], process.cwd()));
	tui.setFocus(editor);
	tui.start();
	redraw();

	// Attach, and on any disconnect try again with a capped backoff. Each attach starts from a reset of the whole view.
	// The first reset seeds the history with what the user typed before this client opened.
	let seeded = false;
	void (async () => {
		let delay = 250;
		let stopped = false;
		void finished.then(() => (stopped = true));
		while (!stopped) {
			try {
				const next = await Client.open(socketPath);
				client = next;
				next.on((reply: Reply) => {
					if (reply.type !== "view") return;
					transcript.apply(reply);
					if (!seeded && "reset" in reply) {
						for (const item of transcript.items) if (item.kind === "user" && item.source === "tui") editor.addToHistory(item.text);
						seeded = true;
					}
					redraw();
				});
				const attached = await next.request({ op: "attach", requestId: randomUUID() });
				if (attached.type === "error") throw new Error(attached.message);
				connection = "online";
				delay = 250;
				redraw();
				await next.closed;
			} catch {}
			if (stopped) return;
			connection = "offline";
			client = undefined;
			redraw();
			await new Promise((resolve) => setTimeout(resolve, delay));
			delay = Math.min(delay * 2, 5000);
		}
	})();

	return finished;
}
