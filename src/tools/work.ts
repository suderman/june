// June's own working context and her focus mode. `work` hands a brief to a background task that owns a child
// conversation, so shell output, file contents, and dead ends stay out of the main thread, and June stays free to talk
// while it runs; the report comes back as a [work] follow-up. `focus` switches the calling conversation between the
// default and focus models from its next request.
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, configure, defineDoc, LiveDoc, defineExtension, defineTask, defineTool, type Extension, section, type Tx } from "@earendil-works/pi-durable";
import type { Config, ModelChoice } from "../config.ts";
import { deliverIn, type Notice, noticeSurface, submitNotice, type Surface } from "../notify.ts";

export const WORK = "june.work";

/** Briefs running in the background, for patter and /stop; `byCall` lets a replayed work call find its task. */
export const WorkDoc = defineDoc<{
	/** `run` is the first input of the run that handed it off, so stopping that run stops the brief too. */
	active: Record<string, { brief: string; started: number; run?: number; child?: number }>;
	byCall: Record<string, number>;
}>({ kind: "june.work", version: 1, scope: "session", initial: () => ({ active: {}, byCall: {} }) });

type WorkInput = { brief: string; model: ModelChoice; call: string };

const WORKER = `You are June's working context, running one brief from your main conversation. The user does not see this conversation and cannot answer here.
Do the work with your tools, then end with one report for your main thread: the answer or outcome first, then the evidence that matters (commands, paths, findings), what you changed, and anything unresolved or needing the user's decision. Keep it concise and leave out dead ends unless they matter.
You cannot queue, resume, or close Org tasks, and you cannot ask the user anything. If the brief needs a decision or an approval, stop and say so in the report instead of acting.`;

const agentOf = (m: ModelChoice) => ({ model: { provider: m.provider, modelId: m.modelId }, thinkingLevel: m.thinkingLevel as never });
const label = (m: ModelChoice) => `${m.provider}/${m.modelId}, ${m.thinkingLevel}`;

/** `childless` are extensions the working context must not have, read when a brief starts. */
export function createWorkExtension(config: Config, childless: () => readonly Extension[]): Extension {
	const normal = config.model.chat;
	const focus = config.model.focus;

	/** The terminal client's view of background work: a display-only entry, never in a model context. */
	const mark = (tx: Tx, conversation: ConversationId, id: string, state: "started" | "finished" | "stopped", brief: string) =>
		tx.appendEntry(conversation, { kind: WORK, data: { id, state, brief } });

	const done = async (tx: Tx, task: { id: unknown; input: WorkInput }) => {
		const doc = await tx.doc(WorkDoc);
		delete doc.active[String(task.id)];
		delete doc.byCall[task.input.call];
	};

	const task = defineTask<WorkInput, { phase: "run" } | { phase: "report"; report: string; surface: Surface }, null>({
		name: "june.work",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				const id = String(task.id);
				let child: unknown;
				// A rerun after a restart finds the same child and the same submission, so the brief runs once.
				await runtime.commit(async (tx): Promise<undefined> => {
					child = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0]?.id;
					if (child !== undefined) return;
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
					await configure(tx, created.id, { ...agentOf(task.input.model), extensions: { remove: [extension, ...childless()] }, instructions: WORKER });
					const entry = (await tx.doc(WorkDoc)).active[id];
					if (entry) entry.child = created.id as unknown as number;
					await mark(tx, runtime.conversationId, id, "started", task.input.brief);
					child = created.id;
				}, context);
				const handle = (await runtime.conversation(child as ConversationId, context))!;
				const submission = await handle.submit({ type: "input", content: task.input.brief, requestId: `work:${id}` }, context);
				const settled = await submission.wait(context);
				// A stopped brief sends no report: the abort already ended the task and /stop told June.
				if (context.abortSignal?.aborted) return;
				await runtime.commit(async (tx) => {
					if ((await tx.doc(WorkDoc)).active[id] === undefined) return undefined;
					// Decided once and kept, so a restart cannot send the report both ways. Reads come before the writes below.
					const surface = await noticeSurface(tx, runtime.registry, runtime.conversationId);
					const report =
						settled.status === "done"
							? textOf((await tx.entry(settled.answer!))?.model?.[0]) || "The working context finished without a report."
							: `The working context ended ${settled.status}${"reason" in settled && settled.reason ? `: ${settled.reason}` : ""}. Tell Jon what happened.`;
					await done(tx, task);
					await mark(tx, runtime.conversationId, id, "finished", task.input.brief);
					return { status: "running", checkpoint: { phase: "report", report, surface } };
				}, context);
			},
			// The report is its own phase, so a restart sends it once and never marks the work finished twice.
			report: async (task, runtime, context) => {
				const checkpoint = task.state.checkpoint;
				if (checkpoint.phase !== "report") return;
				const notice: Notice = {
					requestId: `work-report:${task.id}`,
					content: `[work] ${checkpoint.report}`,
					source: "work",
					label: `report: ${clip(task.input.brief, 80)}`,
				};
				if (checkpoint.surface === "terminal") await submitNotice(await runtime.conversation(runtime.conversationId, context), notice, context);
				await runtime.commit(async (tx) => {
					if (checkpoint.surface === "telegram") await deliverIn(tx, runtime.registry, runtime.conversationId, notice);
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context);
			},
		},
		abort: (task, runtime, context) =>
			runtime.commit(async (tx) => {
				await done(tx, task);
				await mark(tx, runtime.conversationId, String(task.id), "stopped", task.input.brief);
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context),
	});

	const work = defineTool({
		name: "work",
		description:
			"Hand a self-contained brief to your own separate working context, with your tools. It runs in the background: this call returns at once, you stay free to talk with Jon, and its report comes back to you later as a [work] message. Use it for anything beyond a quick check, so shell output and dead ends stay out of this conversation.",
		parameters: Type.Object({
			brief: Type.String({ description: "The goal, what you already know, constraints, and what the report must contain" }),
			...(focus ? { focus: Type.Optional(Type.Boolean({ description: "Run it in focus mode, for work that needs care" })) } : {}),
		}),
		// A rerun after a restart finds the task the first run started.
		replay: "safe",
		execute: async (args, api, context) => {
			const model = (args as { focus?: boolean }).focus && focus ? focus : normal;
			const call = String(api.taskId);
			await api.commit(async (tx) => {
				const doc = await tx.doc(WorkDoc);
				if (doc.byCall[call] !== undefined) return;
				const run = (await tx.doc(LiveDoc, api.conversationId)).run?.inputs[0];
				const id = await tx.createTask(task, { brief: args.brief, model, call }, { ownership: { kind: "conversation" }, background: true, conversationId: api.conversationId });
				doc.byCall[call] = Number(id);
				doc.active[String(id)] = { brief: args.brief, started: Date.now(), ...(run !== undefined ? { run: Number(run) } : {}) };
			}, context);
			return {
				output: [{ type: "text", text: "Started in your working context. Tell Jon in a few words that you're on it, without repeating anything you already said this turn. Its report arrives later as a [work] message, and then you tell him what it found." }],
			};
		},
	});

	const focusTool = defineTool({
		name: "focus",
		description: `Tie your hair up and get focused for careful heads-down work, or let it down and relax back to your everyday self. Yours to manage; it applies from your next model request.`,
		parameters: Type.Object({
			on: Type.Boolean(),
			reason: Type.String({ description: "Why, in a few words" }),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const model = args.on ? focus! : normal;
			await api.commit((tx) => configure(tx, api.conversationId, agentOf(model)), context);
			const text = args.on ? "Hair tied up: focus mode from your next request." : "Hair let down: chat mode from your next request.";
			return { output: [{ type: "text", text: `${text} (${label(model)})` }] };
		},
	});

	const mode = section("mode", ({ agent }) => {
		if (focus === undefined) return undefined;
		const focused =
			agent.model?.provider === focus.provider && agent.model?.modelId === focus.modelId && agent.thinkingLevel === focus.thinkingLevel;
		return focused
			? `Your hair is tied up: you are focused. Write the careful work out yourself while focused; relaxing first would hand the writing to your everyday self. Once it is delivered, let your hair down at the start of a later turn that no longer needs care, or as soon as the user asks you to relax, by calling focus with on false before anything else. Do not mention modes or models unless asked.`
			: `Your hair is down: your everyday self. When the user asks you to focus, or a step in this conversation needs careful heads-down work such as writing a complete Org task, call focus with on true. A brief that needs care can instead run in work with focus true, which keeps you relaxed here. This is yours to manage; do not mention modes or models unless asked.`;
	});

	const extension: Extension = defineExtension({
		name: "june-work",
		tools: focus ? [work, focusTool] : [work],
		tasks: [task],
		sections: [mode],
	});
	return extension;
}

function textOf(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
