// What June sends a model provider, adjusted and optionally saved just before it goes out.
//
// A turn whose newest message carries an image goes without `prompt_cache_key`. Replaying one captured live request
// for a family photo on 2026-11-12, the chat model named the child in 8 of 14 samples without the key and 2 of 38 with
// one (June's own key or a fresh one), whatever else changed; the key ties the request to a session upstream, which
// handled photos of the family more warily. Such a turn costs one uncached request.
//
// While `<state>/payloads/` exists, every request body is saved there as JSON, so a live turn can be compared with a
// replay of it. It is off until the directory is made, and removing the directory turns it off again. The body holds
// the prompt, the conversation, and images, but no credentials, which travel as headers.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";

/** The body without its cache key when the newest user message in it carries an image; the same body otherwise. */
export function withoutCacheKeyForImages(payload: unknown): unknown {
	const body = payload as { prompt_cache_key?: unknown; input?: unknown };
	if (body === null || typeof body !== "object" || body.prompt_cache_key === undefined || !Array.isArray(body.input)) return payload;
	const newest = body.input.findLast((item: any) => item?.role === "user");
	const image = Array.isArray(newest?.content) && newest.content.some((part: any) => part?.type === "input_image");
	if (!image) return payload;
	const { prompt_cache_key: _, ...rest } = body;
	return rest;
}

export function createPayloadsExtension(dir: string, warn: (error: Error) => void) {
	return defineExtension({
		name: "june-payloads",
		hooks: [
			hook(GenerationTask, {
				beforeProviderRequest: ({ model, payload }) => {
					const sent = withoutCacheKeyForImages(payload);
					if (existsSync(dir)) {
						try {
							writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${model.id}.json`), JSON.stringify(sent), { mode: 0o600 });
						} catch (error) {
							warn(error as Error);
						}
					}
					return sent === payload ? undefined : { payload: sent };
				},
			}),
		],
	});
}
