// Pushes that tell a phone the agenda changed, so its widget and reminders refresh at once rather than at the next
// 15-minute refresh: a reminder June or the desktop sets a few minutes ahead then reaches the phone in time. The phone
// registers with its UnifiedPush distributor, the ntfy app, which gives it an address on the ntfy server; it sends that
// address here (the `push` request), and when the agenda's revision moves this posts a short message to it, which ntfy
// hands to June's app even while it is closed (android Push.kt). Only addresses on the configured ntfy server are kept,
// so a paired device cannot point the daemon elsewhere.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Boards } from "./board.ts";
import type { Logger } from "./runtime.ts";

type Post = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

export type PushesOptions = {
	/** Where each device's address is kept: { device: endpoint }. */
	file: string;
	/** The ntfy server's origin, from ntfy.url; without one, pushes are off. */
	origin: string | undefined;
	boards: Pick<Boards, "onChange" | "revisions" | "watchAgenda">;
	log: Logger;
	post?: Post;
	/** How long the agenda must stay unchanged before a push, so a burst of edits sends one. */
	debounceMs?: number;
};

export class Pushes {
	readonly #o: Required<Omit<PushesOptions, "origin">> & { origin: string | undefined };
	#endpoints: Record<string, string> = {};
	#pushed: string | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#unwatch: (() => void) | undefined;
	readonly #stopListening: () => void;

	constructor(options: PushesOptions) {
		this.#o = { post: (url, init) => fetch(url, init), debounceMs: 2_000, ...options };
		try {
			const saved = JSON.parse(readFileSync(options.file, "utf8"));
			for (const [device, endpoint] of Object.entries(saved)) if (typeof endpoint === "string" && this.#allowed(endpoint)) this.#endpoints[device] = endpoint;
		} catch {}
		this.#pushed = options.boards.revisions().agenda;
		this.#stopListening = options.boards.onChange(() => this.#changed());
		this.#watch();
	}

	/** DEVICE's push address, from its distributor; refused unless it is on the ntfy server. */
	register(device: string, endpoint: string): void {
		if (!this.#o.origin) throw new Error("Pushes need ntfy.url in June's config");
		if (!this.#allowed(endpoint)) throw new Error(`A push address must be on ${this.#o.origin}`);
		if (this.#endpoints[device] === endpoint) return;
		this.#endpoints[device] = endpoint;
		mkdirSync(dirname(this.#o.file), { recursive: true });
		writeFileSync(this.#o.file, `${JSON.stringify(this.#endpoints)}\n`);
		this.#o.log.info("push_registered", { device });
		this.#watch();
	}

	stop(): void {
		clearTimeout(this.#timer);
		this.#stopListening();
		this.#unwatch?.();
		this.#unwatch = undefined;
	}

	#allowed(endpoint: string): boolean {
		try {
			const url = new URL(endpoint);
			return this.#o.origin !== undefined && url.origin === this.#o.origin && (url.protocol === "https:" || url.protocol === "http:");
		} catch {
			return false;
		}
	}

	/** While any phone takes pushes, the agenda follows its files even with no board open. */
	#watch(): void {
		if (!this.#unwatch && Object.keys(this.#endpoints).length > 0) this.#unwatch = this.#o.boards.watchAgenda();
	}

	#changed(): void {
		const revision = this.#o.boards.revisions().agenda;
		if (revision === undefined || revision === this.#pushed || Object.keys(this.#endpoints).length === 0) return;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			const now = this.#o.boards.revisions().agenda;
			if (now === undefined || now === this.#pushed) return;
			this.#pushed = now;
			for (const [device, endpoint] of Object.entries(this.#endpoints)) {
				void this.#o.post(endpoint, { method: "POST", body: "agenda" }).then(
					(r) => (r.ok ? this.#o.log.info("push_sent", { device }) : this.#o.log.warn("push_refused", { device, status: r.status })),
					(error: Error) => this.#o.log.warn("push_failed", { device, error: error.message }),
				);
			}
		}, this.#o.debounceMs);
	}
}
