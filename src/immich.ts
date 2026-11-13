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
/** The photo's original in the library, when one taken recently looks like it: when, where, and its albums. */
export type Original = { takenAt: string; place?: string; albums: string[] };
/** What a scan found: named people left to right, how many faces it could not name, and the original if found. */
export type Seen = { names: string[]; unknown: number; original?: Original };

/**
 * How recent a visually similar photo must be to count as the original. Similar search ranks without a score, so an
 * old photo of the same spot can come first when the original has not been backed up yet; that one is left out.
 */
const ORIGINAL_DAYS = 7;

/**
 * Scan one image: upload, wait until every face Immich found has a person (or `waitMs` passes), and delete the asset.
 * Undefined when the scan failed; `{ names: [], unknown: 0 }` when it found no faces.
 */
export async function scan(
	immich: Immich,
	image: ImageContent,
	options: { fetch?: typeof fetch; waitMs?: number; noFacesMs?: number; unnamedMs?: number; pollMs?: number; warn?: (error: Error) => void } = {},
): Promise<Seen | undefined> {
	const get = options.fetch ?? fetch;
	// Timed on lux on 2026-11-12: faces appear 0.5 to 1.1 s after upload and are named by 2.1 s; a screenshot never
	// gets one. So no face by noFacesMs means none, and a face still unnamed by unnamedMs is someone Immich does not know.
	const waitMs = options.waitMs ?? 15_000;
	const noFacesMs = options.noFacesMs ?? 2_500;
	const unnamedMs = options.unnamedMs ?? 6_000;
	const pollMs = options.pollMs ?? 1_000;
	const call: Call = async (method, path, body, type) => {
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
		const started = Date.now();
		const until = started + waitMs;
		let faces: Face[] = [];
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, pollMs));
			faces = ((await call("GET", `/faces?id=${encodeURIComponent(id)}`)) ?? []) as Face[];
			// Detection comes first and recognition after, so a face without a person may still be matched.
			const waited = Date.now() - started;
			if (faces.length > 0 && faces.every((face) => face.person?.name)) break;
			if ((faces.length === 0 && waited >= noFacesMs) || waited >= unnamedMs || Date.now() >= until) break;
		}
		const named = faces.filter((face) => face.person?.name).sort((a, b) => (a.boundingBoxX1 ?? 0) - (b.boundingBoxX1 ?? 0));
		const original = await findOriginal(call, id, until, pollMs, options.warn);
		return { names: [...new Set(named.map((face) => face.person!.name!))], unknown: faces.length - named.length, ...(original ? { original } : {}) };
	} catch (error) {
		options.warn?.(error as Error);
		return undefined;
	} finally {
		// Not awaited: June need not wait for the cleanup. A failed delete leaves an archived june-scan asset behind.
		if (id !== undefined) void call("DELETE", "/assets", JSON.stringify({ ids: [id], force: true }), "application/json").catch((error) => options.warn?.(error as Error));
	}
}

type Call = (method: string, path: string, body?: BodyInit, type?: string) => Promise<any>;

/**
 * The scan's original: the most similar photo in the library's timeline, if it was taken in the last ORIGINAL_DAYS.
 * The scan's image embedding may not exist yet, which Immich answers with HTTP 400, so it retries until `until`. A
 * failure here costs only the original, never the names.
 */
async function findOriginal(call: Call, id: string, until: number, pollMs: number, warn?: (error: Error) => void): Promise<Original | undefined> {
	try {
		let hits: any[] = [];
		for (;;) {
			try {
				const found = await call("POST", "/search/smart", JSON.stringify({ queryAssetId: id, size: 3, withExif: true, visibility: "timeline" }), "application/json");
				hits = (found?.assets?.items ?? []).filter((asset: any) => asset?.id !== id);
				break;
			} catch (error) {
				if (!/HTTP 400$/.test((error as Error).message) || Date.now() >= until) throw error;
				await new Promise((resolve) => setTimeout(resolve, pollMs));
			}
		}
		const top = hits[0];
		const takenAt = top?.exifInfo?.dateTimeOriginal ?? top?.fileCreatedAt;
		if (!takenAt || !(Date.now() - Date.parse(takenAt) < ORIGINAL_DAYS * 86_400_000)) return undefined;
		const place = [top.exifInfo?.city, top.exifInfo?.state, top.exifInfo?.country].filter(Boolean).join(", ");
		const albums = ((await call("GET", `/albums?assetId=${encodeURIComponent(top.id)}`).catch((error: Error) => (warn?.(error), []))) ?? []).map((album: any) => String(album.albumName)).filter(Boolean);
		return { takenAt: new Date(takenAt).toISOString(), ...(place ? { place } : {}), albums };
	} catch (error) {
		warn?.(error as Error);
		return undefined;
	}
}

/** When a photo was taken, in local time: "today at 19:42", "yesterday at 13:16", or "on Wednesday, 2026-11-11 at 13:16". */
export function takenWhen(iso: string, now = new Date()): string {
	const at = new Date(iso);
	const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
	const days = Math.round((day(now) - day(at)) / 86_400_000);
	if (days === 0) return `today at ${time}`;
	if (days === 1) return `yesterday at ${time}`;
	const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
	return `on ${at.toLocaleDateString("en-CA", { weekday: "long" })}, ${date} at ${time}`;
}

/** The lines June reads beside a photo, or undefined when the scan failed or found nothing. */
export function seenNote(seen: Seen | undefined, user: string, which?: number, now = new Date()): string | undefined {
	if (seen === undefined) return undefined;
	const where = which === undefined ? "this photo" : `photo ${which}`;
	const faces = (n: number) => (n === 1 ? "one face" : `${n} faces`);
	const lines: string[] = [];
	if (seen.names.length > 0) {
		const names = seen.names.length === 1 ? seen.names[0] : `${seen.names.slice(0, -1).join(", ")} and ${seen.names.at(-1)}, left to right`;
		const rest = seen.unknown === 0 ? "" : `, plus ${faces(seen.unknown)} it does not know`;
		lines.push(`[${user}'s photo library recognized in ${where}: ${names}${rest}.]`);
	} else if (seen.unknown > 0) lines.push(`[${user}'s photo library found ${faces(seen.unknown)} in ${where} that it does not know.]`);
	if (seen.original) {
		const { takenAt, place, albums } = seen.original;
		const album = albums.length === 0 ? "" : `, in ${albums.length === 1 ? "the album" : "the albums"} ${albums.map((name) => `"${name}"`).join(", ")}`;
		lines.push(`[It looks like a photo in the library taken ${takenWhen(takenAt, now)}${place ? ` in ${place}` : ""}${album}.]`);
	}
	return lines.length ? lines.join("\n") : undefined;
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
