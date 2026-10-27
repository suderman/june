// June's own working context and her focus mode. `work` runs a brief in a child conversation the call owns, so shell
// output, file contents, and dead ends stay out of the main thread and only the report comes back. `focus` switches
// the calling conversation between the default and focus models from its next request.
import { Type } from "@earendil-works/pi-ai";
import { configure, defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { Config, ModelChoice } from "../config.ts";

const WORKER = `You are June's working context, running one brief from your main conversation. The user does not see this conversation and cannot answer here.
Do the work with your tools, then end with one report for your main thread: the answer or outcome first, then the evidence that matters (commands, paths, findings), what you changed, and anything unresolved or needing the user's decision. Keep it concise and leave out dead ends unless they matter.
You cannot queue, resume, or close Org tasks, and you cannot ask the user anything. If the brief needs a decision or an approval, stop and say so in the report instead of acting.`;

const agentOf = (m: ModelChoice) => ({ model: { provider: m.provider, modelId: m.modelId }, thinkingLevel: m.thinkingLevel as never });
const label = (m: ModelChoice) => `${m.provider}/${m.modelId}, ${m.thinkingLevel}`;

/** `childless` are extensions the working context must not have, read when a brief starts. */
export function createWorkExtension(config: Config, childless: () => readonly Extension[]): Extension {
	const normal = config.model.chat;
	const focus = config.model.focus;

	const work = defineTool({
		name: "work",
		description:
			"Run a self-contained brief in your own separate working context, with your tools, and get back only its report. Use it for anything beyond a quick check, so shell output and dead ends stay out of this conversation.",
		parameters: Type.Object({
			brief: Type.String({ description: "The goal, what you already know, constraints, and what the report must contain" }),
			...(focus ? { focus: Type.Optional(Type.Boolean({ description: "Run it in focus mode, for work that needs care" })) } : {}),
		}),
		// A rerun after a restart finds the same child and the same submission, so the brief runs once.
		replay: "safe",
		execute: async (args, api, context) => {
			const model = (args as { focus?: boolean }).focus && focus ? focus : normal;
			const child = await api.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
				if (existing !== undefined) return existing.id;
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				await configure(tx, created.id, { ...agentOf(model), extensions: { remove: [extension, ...childless()] }, instructions: WORKER });
				return created.id;
			}, context);
			await api.details({ conversationId: child as unknown as number }, context);
			const handle = (await api.conversation(child, context))!;
			const submission = await handle.submit({ type: "input", content: args.brief, requestId: `work:${api.taskId}` }, context);
			const settled = await submission.wait(context);
			if (settled.status !== "done") throw new Error(`The working context ended ${settled.status}${"reason" in settled && settled.reason ? `: ${settled.reason}` : ""}`);
			const answer = await api.commit((tx) => tx.entry(settled.answer!), context);
			const report = textOf(answer?.model?.[0]);
			return { output: [{ type: "text", text: report || "The working context finished without a report." }] };
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
		sections: [mode],
	});
	return extension;
}

function textOf(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
