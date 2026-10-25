// Model access through pi-ai. The provider comes from Pi's own models.json, so codex-lb is configured once.
import { readFileSync } from "node:fs";
import { createModels, createProvider, envApiKeyAuth, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

type PiProvider = {
	name?: string;
	baseUrl: string;
	api: string;
	apiKey?: string;
	headers?: Record<string, string>;
	models: Array<Record<string, unknown> & { id: string }>;
};

const APIS = { "openai-responses": openAIResponsesApi, "openai-completions": openAICompletionsApi } as const;

/** Build `id` from a Pi models.json. Its `apiKey` must name an environment variable (`$NAME`), never hold a key. */
export function providerFromPiModels(file: string, id: string): Provider {
	const json = JSON.parse(readFileSync(file, "utf8")) as { providers?: Record<string, PiProvider> };
	const entry = json.providers?.[id];
	if (entry === undefined) throw new Error(`${file} defines no provider ${JSON.stringify(id)}`);
	const api = APIS[entry.api as keyof typeof APIS];
	if (api === undefined) throw new Error(`provider ${id}: unsupported api ${entry.api}`);
	const keyVar = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(entry.apiKey ?? "")?.[1];
	if (entry.apiKey !== undefined && keyVar === undefined)
		throw new Error(`provider ${id}: apiKey must reference an environment variable`);
	return createProvider({
		id,
		name: entry.name ?? id,
		baseUrl: entry.baseUrl,
		...(entry.headers ? { headers: entry.headers } : {}),
		auth: { apiKey: envApiKeyAuth(`${id} API key`, keyVar ? [keyVar] : []) },
		models: entry.models.map((model) => ({
			name: model.id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 32_000,
			...model,
			api: entry.api,
			provider: id,
			baseUrl: entry.baseUrl,
			type: "chat",
		})) as never,
		api: api(),
	});
}

/** Models whose keys come from `secrets` first, then the process environment. */
export function createJuneModels(secrets: Readonly<Record<string, string>>): MutableModels {
	return createModels({
		authContext: {
			env: async (name) => secrets[name] ?? process.env[name],
			fileExists: async () => false,
		},
	});
}
