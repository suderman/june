// The terminal client. It attaches to the daemon's primary conversation, renders the shared transcript, and sends
// input. Closing it never touches running work; it reconnects on its own when the daemon restarts.
import { randomUUID } from "node:crypto";
import {
	type Component,
	Container,
	Editor,
	type EditorTheme,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	TuiAltScreen,
	truncateToWidth,
	VStack,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Client, type Reply } from "./protocol.ts";
import { type Item, Transcript } from "./transcript.ts";

const esc = (code: string, off: string) => (s: string) => `\x1b[${code}m${s}\x1b[${off}m`;
const c = {
	muted: esc("90", "39"),
	user: esc("36", "39"),
	accent: esc("33", "39"),
	ok: esc("32", "39"),
	err: esc("31", "39"),
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
			const tag = item.source === "kitty" ? "" : c.muted(`${item.source} `);
			return [new Line(), new Wrapped(c.user(item.text), `${tag}${c.user("› ")}`)];
		}
		case "assistant": {
			const parts: Component[] = [new Line()];
			for (const block of item.blocks) {
				if (block.type === "text" && block.text) parts.push(new Markdown(block.text, 0, 0, markdownTheme));
				else if (block.type === "thinking" && block.thinking)
					parts.push(new Line(c.italic(c.muted(`∴ ${block.thinking.replace(/\s+/g, " ")}`))));
			}
			if (item.streaming && parts.length === 1) parts.push(new Line(c.muted("…")));
			if (item.error) parts.push(new Line(c.err(`! ${item.error}`)));
			return parts;
		}
		case "tool": {
			const icon = item.status === "running" ? c.accent("•") : item.status === "done" ? c.ok("✓") : c.err("✗");
			const rows: Component[] = [new Line(`${icon} ${c.bold(item.name)} ${c.muted(item.summary)}`)];
			if (item.status === "error" && item.output) rows.push(new Line(c.err(`  ${item.output.split("\n")[0]}`)));
			return rows;
		}
		case "note":
			return [new Line(c.muted(`── ${item.text}`))];
	}
}

class TranscriptView extends Container {
	update(transcript: Transcript) {
		this.clear();
		if (transcript.omitted) this.addChild(new Line(c.muted(`── ${transcript.omitted} earlier entries not shown`)));
		for (const item of transcript.items) for (const part of component(item)) this.addChild(part);
	}
}

export async function runTui(socketPath: string): Promise<void> {
	const tui = new TuiAltScreen(new ProcessTerminal(), false);
	const transcript = new Transcript();
	const header = new Line();
	const view = new TranscriptView();
	const status = new Line();
	const editor = new Editor(tui, editorTheme, { paddingX: 1 });
	const footer = new Line(c.muted("enter send · alt+enter queue while busy · esc interrupt · ctrl+d detach"));
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
	let done!: () => void;
	const finished = new Promise<void>((resolve) => (done = resolve));

	const redraw = () => {
		const state = connection === "online" ? c.ok("●") : c.err("●");
		header.text = `${state} 🦘 ${c.bold("June")} ${c.muted(transcript.model)}`;
		const parts = [];
		if (connection !== "online") parts.push(c.err(connection === "connecting" ? "connecting…" : "daemon unreachable, retrying"));
		if (transcript.running) parts.push(c.accent("working"));
		if (transcript.queued) parts.push(c.muted(`${transcript.queued} queued`));
		if (transcript.notice) parts.push(c.err(transcript.notice));
		if (flash) parts.push(c.err(flash));
		status.text = parts.join(c.muted(" · "));
		view.update(transcript);
		tui.requestRender();
	};

	const exit = () => {
		client?.close();
		tui.stop();
		done();
	};

	const send = async (text: string, whenBusy: "steer" | "followUp") => {
		if (!text.trim()) return;
		if (client === undefined || connection !== "online") {
			flash = "not connected; message not sent";
			editor.setText(text);
			return redraw();
		}
		flash = undefined;
		const reply = await client.request({ op: "submit", requestId: randomUUID(), text, source: "kitty", whenBusy });
		if (reply.type === "error") {
			flash = reply.message;
			redraw();
		}
	};

	editor.onSubmit = (text) => {
		editor.setText("");
		void send(text, transcript.running ? "steer" : "followUp");
	};
	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			if (editor.getText()) editor.setText("");
			else exit();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d") && !editor.getText()) {
			exit();
			return { consume: true };
		}
		if (matchesKey(data, "escape") && !editor.isShowingAutocomplete()) {
			if (transcript.running && client) void client.request({ op: "abort", requestId: randomUUID() });
			return { consume: true };
		}
		if (matchesKey(data, "alt+enter")) {
			const text = editor.getText();
			editor.setText("");
			void send(text, "followUp");
			return { consume: true };
		}
		return undefined;
	});
	tui.setFocus(editor);
	tui.start();
	redraw();

	// Attach, and on any disconnect try again with a capped backoff. Each attach starts from a fresh snapshot.
	void (async () => {
		let delay = 250;
		let stopped = false;
		void finished.then(() => (stopped = true));
		while (!stopped) {
			try {
				const next = await Client.open(socketPath);
				client = next;
				next.on((reply: Reply) => {
					if (reply.type === "snapshot") transcript.load(reply.snapshot, reply.omitted);
					else if (reply.type === "events") transcript.apply(reply.events);
					else return;
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
