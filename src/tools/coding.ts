// Pi Durable's read, write, edit, and bash, with a default timeout on bash. None is replay-safe, so a call a restart
// interrupts is reported as interrupted instead of run again.
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { type BashToolInput, createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

/** Seconds; a command that needs longer says so with its own timeout. */
export const DEFAULT_BASH_TIMEOUT = 120;

export function createCodingExtension(): Extension {
	const bash = createBashTool();
	return defineExtension({
		name: "june-coding",
		tools: [
			createReadTool(),
			createWriteTool(),
			createEditTool(),
			{
				...bash,
				description: `${bash.description} Without one, the command stops after ${DEFAULT_BASH_TIMEOUT} seconds.`,
				execute: (args: BashToolInput, api, context) => bash.execute({ ...args, timeout: args.timeout ?? DEFAULT_BASH_TIMEOUT }, api, context),
			},
		],
	});
}
