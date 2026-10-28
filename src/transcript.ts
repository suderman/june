// Folds a Pi Durable snapshot and its agent events into display items for the terminal client.
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";

/** A heartbeat's whole answer when nothing is worth raising; the heartbeat sends nothing and the terminal shows nothing. */
export const QUIET = "QUIET";
export const isQuiet = (text: string) => /^\s*QUIET\.?\s*$/i.test(text);

type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown; id?: string };

export type Item =
	| { kind: "user"; id: string; source: string; text: string; telegram?: true }
	| { kind: "assistant"; id: string; blocks: Block[]; streaming: boolean; error?: string }
	| { kind: "tool"; id: string; name: string; summary: string; status: "running" | "done" | "error"; output: string }
	| { kind: "note"; id: string; text: string }
	| { kind: "patter"; id: string; text: string }
	| { kind: "reply"; id: string; command: string; text: string };

export class Transcript {
	items: Item[] = [];
	running = false;
	/** Briefs running in June's working context in the background, by task ID. */
	background = new Set<string>();
	queued = 0;
	omitted = 0;
	model = "";
	notice: string | undefined;
	/** When the running compaction started, as this client first saw it; undefined when none runs. */
	compacting: number | undefined;
	#entries = new Set<string>();
	/** Inside a heartbeat, June's private look: only a real message to the user shows, never the look itself. */
	#private = false;
	#live: Extract<Item, { kind: "assistant" }> | undefined;
	#tools = new Map<string, Extract<Item, { kind: "tool" }>>();
	#calls = new Map<string, string>();

	load(snapshot: SnapshotEvent, omitted = 0): void {
		this.items = [];
		this.#entries.clear();
		this.#tools.clear();
		this.background.clear();
		this.#live = undefined;
		this.#private = false;
		this.omitted = omitted;
		for (const entry of snapshot.entries) this.#entry(entry);
		this.running = snapshot.run !== undefined;
		this.queued = snapshot.inbox.length;
		this.compacting = snapshot.compactions.length > 0 ? (this.compacting ?? Date.now()) : undefined;
		this.#model(snapshot.agent);
		if (snapshot.generation?.message && !this.#private) this.#startLive(snapshot.generation.message);
		for (const slot of this.#private ? [] : (snapshot.tools as readonly any[])) {
			if (slot?.toolCallId && !this.#tools.has(slot.toolCallId))
				this.#tool(slot.toolCallId, slot.toolName ?? slot.name ?? "tool", slot.args);
		}
	}

	/** A command's reply. Like a Telegram command reply, it is not part of the conversation; a reconnect drops it. */
	reply(command: string, text: string): void {
		this.items.push({ kind: "reply", id: `reply:${this.items.length}`, command, text });
	}

	apply(events: readonly AgentEvent[]): void {
		for (const event of events) this.#event(event);
	}

	#event(event: AgentEvent): void {
		switch (event.type) {
			case "snapshot":
				return this.load(event);
			case "run_start":
				this.running = true;
				this.notice = undefined;
				return;
			case "run_end":
				this.running = false;
				return;
			case "inbox_update":
				this.queued = event.items.length;
				return;
			case "message_start":
				// Inputs are placed as messages too; only an assistant message streams.
				if (event.message.role === "assistant" && !this.#private) this.#startLive(event.message);
				return;
			case "message_update": {
				const live = this.#live;
				if (live === undefined) return;
				for (const change of event.changes as readonly any[]) {
					if (change.type === "message") live.blocks = [...change.message.content];
					else if (change.type === "text_delta") (live.blocks[change.contentIndex] ??= { type: "text", text: "" }).text += change.delta;
					else if (change.type === "thinking_delta")
						(live.blocks[change.contentIndex] ??= { type: "thinking", thinking: "" }).thinking += change.delta;
					else if (change.block) live.blocks[change.contentIndex] = { ...change.block };
				}
				return;
			}
			case "message_end":
				if (event.entry.kind === "pi.assistant") this.#dropLive();
				return this.#entry(event.entry);
			case "entry_appended":
				return this.#entry(event.entry);
			case "tool_execution_start":
				if (event.parentToolCallId === undefined && !this.#private) this.#tool(event.toolCallId, event.toolName, event.args);
				return;
			case "tool_execution_update": {
				const tool = this.#tools.get(event.toolCallId);
				const output = event.output as any;
				if (tool === undefined || output === undefined) return;
				if ("set" in output) tool.output = output.set;
				else tool.output = tool.output.slice(output.trimStart ?? 0) + (output.append ?? "");
				return;
			}
			case "tool_execution_end": {
				const tool = this.#tools.get(event.toolCallId);
				if (tool !== undefined && tool.status === "running") tool.status = "done";
				if (event.entry) this.#entry(event.entry);
				return;
			}
			case "auto_retry_start":
				this.notice = `retrying (attempt ${event.attempt}): ${event.errorMessage}`;
				return;
			case "auto_retry_end":
				this.notice = undefined;
				return;
			case "task_failed":
				this.notice = `${event.kind} failed: ${event.message}`;
				return;
			case "agent_changed":
				return this.#model(event.agent);
			case "compaction_start":
				this.compacting ??= Date.now();
				return;
			case "compaction_end":
				this.compacting = undefined;
				return;
		}
	}

	#model(agent: any): void {
		if (agent?.model) this.model = `${agent.model.modelId}${agent.thinkingLevel ? `:${agent.thinkingLevel}` : ""}`;
	}

	#startLive(message: any): void {
		this.#dropLive();
		this.#live = { kind: "assistant", id: "live", blocks: [...(message?.content ?? [])], streaming: true };
		this.items.push(this.#live);
	}

	#dropLive(): void {
		if (this.#live === undefined) return;
		this.items = this.items.filter((item) => item !== this.#live);
		this.#live = undefined;
	}

	#tool(id: string, name: string, args: unknown): void {
		const item = { kind: "tool" as const, id, name, summary: summarize(args), status: "running" as const, output: "" };
		this.#tools.set(id, item);
		this.items.push(item);
	}

	#entry(entry: any): void {
		const id = String(entry.id);
		if (this.#entries.has(id)) return;
		this.#entries.add(id);
		const message = entry.model?.[0];
		switch (entry.kind) {
			case "june.input":
				this.#private = entry.data?.source === "heartbeat";
				if (!this.#private) this.items.push({ kind: "user", id, source: entry.data?.source ?? "?", text: entry.data?.text ?? "" });
				return;
			case "june.patter":
				this.items.push({ kind: "patter", id, text: entry.data?.text ?? "" });
				return;
			case "june.work":
				if (entry.data?.state === "started") this.background.add(String(entry.data.id));
				else this.background.delete(String(entry.data?.id));
				return;
			case "pi.user": {
				this.#private = false;
				const text = textOf(message?.content);
				// /stop, from either surface, writes this boundary so queued messages can be placed.
				const own = /^\[(work|follow|reminder)[\] ]\s*/.exec(text);
				if (text.startsWith("[/stop]")) this.items.push({ kind: "note", id, text: "stopped" });
				// A notice delivered through Telegram, which June relays there: one short line here, not the whole report.
				else if (own) this.items.push({ kind: "user", id, source: own[1]!, text: clip(text.slice(own[0].length), 80), telegram: true });
				else this.items.push({ kind: "user", id, source: "telegram", text, telegram: true });
				return;
			}
			case "pi.assistant": {
				const content: Block[] = message?.content ?? [];
				if (this.#private) {
					// Only her final words, and only when they are a message rather than the quiet answer.
					const words = textOf(content.filter((b) => b.type === "text"));
					if (words.trim() !== "" && !isQuiet(words)) this.items.push({ kind: "assistant", id, blocks: [{ type: "text", text: words }], streaming: false });
					return;
				}
				for (const b of content) if (b.type === "toolCall" && b.id) this.#calls.set(b.id, summarize(b.arguments));
				const blocks = content.filter((b) => b.type !== "toolCall");
				const error = message?.stopReason === "error" || message?.stopReason === "aborted" ? (message.errorMessage ?? message.stopReason) : undefined;
				if (blocks.length > 0 || error) this.items.push({ kind: "assistant", id, blocks, streaming: false, ...(error ? { error } : {}) });
				return;
			}
			case "pi.tool-result": {
				if (this.#private) return;
				const callId = message?.toolCallId as string | undefined;
				const tool = callId ? this.#tools.get(callId) : undefined;
				if (tool !== undefined) {
					tool.status = message.isError ? "error" : "done";
					return;
				}
				this.items.push({
					kind: "tool",
					id,
					name: message?.toolName ?? "tool",
					summary: (callId && this.#calls.get(callId)) ?? "",
					status: message?.isError ? "error" : "done",
					output: message?.isError ? textOf(message.content) : "",
				});
				return;
			}
			case "pi.reset":
				this.items.push({ kind: "note", id, text: "new context" });
				return;
			case "pi.compaction":
				this.items.push({ kind: "note", id, text: "earlier conversation compacted" });
				return;
		}
	}
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : ""))
		.join("");
}

function summarize(args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	const values = Object.entries(args as Record<string, unknown>)
		.filter(([, v]) => typeof v === "string" || typeof v === "number")
		.map(([k, v]) => `${k}=${String(v).replace(/\s+/g, " ").slice(0, 60)}`);
	return values.join(" ");
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
