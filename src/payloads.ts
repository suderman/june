// A debugging aid: while `<state>/payloads/` exists, every model request body is saved there as JSON, so a live turn
// can be compared with a replay of it. It is off until the directory is made, and removing the directory turns it off
// again. The body holds the prompt, the conversation, and images, but no credentials, which travel as headers.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";

export function createPayloadsExtension(dir: string, warn: (error: Error) => void) {
	return defineExtension({
		name: "june-payloads",
		hooks: [
			hook(GenerationTask, {
				beforeProviderRequest: ({ model, payload }) => {
					if (!existsSync(dir)) return undefined;
					try {
						writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${model.id}.json`), JSON.stringify(payload), { mode: 0o600 });
					} catch (error) {
						warn(error as Error);
					}
					return undefined;
				},
			}),
		],
	});
}
