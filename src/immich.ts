// Who is in a photo the user sends, by name, from their own Immich library, before June sees the photo. Chat models
// are wary of naming people from a photo, children above all, and on 2026-11-12 June named a family member in a fresh
// photo about half the time at best; given the names Immich matched, she used them every time. The photo is uploaded
// as an archived asset, Immich's face recognition matches it against the people the user has named, and the asset is
// deleted for good. Nothing leaves the user's network. With IMMICH_URL and IMMICH_API_KEY unset it does nothing, and
// any failure or a slow scan just leaves the names out. A watch pings Immich every few minutes so a photo never waits
// on a server that is down, and the delete runs after June has the photo.
import { writeFileSync } from "node:fs";
import type { ImageContent } from "@earendil-works/pi-ai";

export type Immich = { url: string; key: string };

/** The Immich server from the environment, or undefined when it is not configured. */
export function immichFrom(env: Readonly<Record<string, string | undefined>>): Immich | undefined {
	const url = env.IMMICH_URL?.trim().replace(/\/+$/, "");
	const key = env.IMMICH_API_KEY?.trim();
	return url && key ? { url, key } : undefined;
}

type Face = { person?: { name?: string } | null; boundingBoxX1?: number };
/** What a scan found: named people left to right, and how many faces it could not name. */
export type Seen = { names: string[]; unknown: number };

/**
 * Scan one image: upload, wait until every face Immich found has a person (or `waitMs` passes), and delete the asset.
 * Undefined when the scan failed; `{ names: [], unknown: 0 }` when it found no faces.
 */
export async function scan(
	immich: Immich,
	image: ImageContent,
	options: { fetch?: typeof fetch; waitMs?: number; pollMs?: number; warn?: (error: Error) => void } = {},
): Promise<Seen | undefined> {
	const get = options.fetch ?? fetch;
	const waitMs = options.waitMs ?? 15_000;
	const pollMs = options.pollMs ?? 1_000;
	const call = async (method: string, path: string, body?: BodyInit, type?: string) => {
		const response = await get(`${immich.url}/api${path}`, {
			method,
			headers: { "x-api-key": immich.key, accept: "application/json", ...(type ? { "content-type": type } : {}) },
			...(body === undefined ? {} : { body }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error(`Immich ${method} ${path.split("?")[0]}: HTTP ${response.status}`);
		const text = await response.text();
		return text ? JSON.parse(text) : undefined;
	};
	let id: string | undefined;
	try {
		const now = new Date().toISOString();
		const form = new FormData();
		form.set("fileCreatedAt", now);
		form.set("fileModifiedAt", now);
		form.set("visibility", "archive");
		const extension = image.mimeType.split("/")[1] ?? "jpg";
		form.set("assetData", new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType }), `june-scan.${extension}`);
		id = String((await call("POST", "/assets", form)).id);
		const until = Date.now() + waitMs;
		let faces: Face[] = [];
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, pollMs));
			faces = ((await call("GET", `/faces?id=${encodeURIComponent(id)}`)) ?? []) as Face[];
			// Detection comes first and recognition after, so a face without a person may still be matched.
			if ((faces.length > 0 && faces.every((face) => face.person?.name)) || Date.now() >= until) break;
		}
		const named = faces.filter((face) => face.person?.name).sort((a, b) => (a.boundingBoxX1 ?? 0) - (b.boundingBoxX1 ?? 0));
		return { names: [...new Set(named.map((face) => face.person!.name!))], unknown: faces.length - named.length };
	} catch (error) {
		options.warn?.(error as Error);
		return undefined;
	} finally {
		// Not awaited: June need not wait for the cleanup. A failed delete leaves an archived june-scan asset behind.
		if (id !== undefined) void call("DELETE", "/assets", JSON.stringify({ ids: [id], force: true }), "application/json").catch((error) => options.warn?.(error as Error));
	}
}

/** The line June reads beside a photo, or undefined when the scan failed or found no faces. */
export function seenNote(seen: Seen | undefined, user: string, which?: number): string | undefined {
	if (seen === undefined || (seen.names.length === 0 && seen.unknown === 0)) return undefined;
	const where = which === undefined ? "this photo" : `photo ${which}`;
	const faces = (n: number) => (n === 1 ? "one face" : `${n} faces`);
	if (seen.names.length === 0) return `[${user}'s photo library found ${faces(seen.unknown)} in ${where} that it does not know.]`;
	const names = seen.names.length === 1 ? seen.names[0] : `${seen.names.slice(0, -1).join(", ")} and ${seen.names.at(-1)}, left to right`;
	const rest = seen.unknown === 0 ? "" : `, plus ${faces(seen.unknown)} it does not know`;
	return `[${user}'s photo library recognized in ${where}: ${names}${rest}.]`;
}

export type ImmichWatch = { up(): boolean; down(error: Error): void; stop(): void };

/**
 * Whether Immich answered its last ping, checked now and every `everyMs`, with the result written to `file` for a
 * person to read. A scan that fails marks it down at once, so later photos skip it until a ping succeeds again. Until
 * the first ping answers it counts as down, which costs at most the names on a photo sent in the first second.
 */
export function watchImmich(immich: Immich, options: { file: string; everyMs?: number; fetch?: typeof fetch; warn?: (error: Error) => void }): ImmichWatch {
	const get = options.fetch ?? fetch;
	let up = false;
	const record = (ok: boolean, error?: string) => {
		up = ok;
		try {
			writeFileSync(options.file, `${JSON.stringify({ up: ok, url: immich.url, checkedAt: new Date().toISOString(), ...(error ? { error } : {}) })}\n`);
		} catch (failure) {
			options.warn?.(failure as Error);
		}
	};
	const ping = async () => {
		try {
			const response = await get(`${immich.url}/api/server/ping`, { signal: AbortSignal.timeout(5_000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			record(true);
		} catch (error) {
			record(false, (error as Error).message);
		}
	};
	void ping();
	const timer = setInterval(() => void ping(), options.everyMs ?? 5 * 60_000);
	timer.unref?.();
	return { up: () => up, down: (error) => record(false, error.message), stop: () => clearInterval(timer) };
}
