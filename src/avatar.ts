// The avatar's two signals: an expression chosen for character from a fixed vocabulary, and an activity derived from
// runtime state. An avatar set is a directory holding manifest.json and its images; templates/avatar/ is the base set.
// See docs/interfaces.org, "Avatar", for what each name is grounded in.

export type Frequency = "common" | "occasional" | "rare";

/** Each expression's meaning, how often it should appear, and the name to show when a set has no image for it. */
export const EXPRESSIONS = {
	idle: { meaning: "composed and attentive; the face most of the time", frequency: "common" },
	warm: { meaning: "a sincere, open smile", frequency: "common", fallback: "idle" },
	wry: { meaning: "a dry half-smile; cheek or affectionate teasing", frequency: "common", fallback: "idle" },
	curious: { meaning: "interested, a little head tilt; asking or looking into something", frequency: "common", fallback: "idle" },
	skeptical: { meaning: "one eyebrow up; unconvinced by a claim or an idea", frequency: "common", fallback: "wry" },
	determined: { meaning: "chin up, taking charge; an attitude, not a sign that work is running", frequency: "common", fallback: "idle" },
	serious: { meaning: "level and plain, no smile; bad news or a matter that drops the teasing", frequency: "common", fallback: "idle" },
	gentle: { meaning: "soft and kind; the user is worried, tired, or upset", frequency: "common", fallback: "warm" },
	smug: { meaning: "pleased with herself; something went right or she was right", frequency: "occasional", fallback: "wry" },
	exasperated: { meaning: "an eye roll; a worker or a plan went sideways", frequency: "occasional", fallback: "skeptical" },
	indignant: { meaning: "a brief theatrical huff when something is spectacularly daft", frequency: "rare", fallback: "exasperated" },
	pout: { meaning: "a reluctant surrender when the user wins a joke or an argument", frequency: "rare", fallback: "wry" },
	bashful: { meaning: "flustered by a compliment or by being caught sentimental", frequency: "rare", fallback: "warm" },
	delighted: { meaning: "composure slipping at something unexpectedly good", frequency: "rare", fallback: "warm" },
	cheering: { meaning: "open celebration of a real win", frequency: "rare", fallback: "delighted" },
} as const satisfies Record<string, { meaning: string; frequency: Frequency; fallback?: string }>;

export type Expression = keyof typeof EXPRESSIONS;

/** Activities in precedence order: a client shows the first that holds, and nothing when none does. Never chosen by a model. */
export const ACTIVITIES = {
	offline: "the client has no connection to the daemon; the client's own state, never sent",
	listening: "a voice session on this client is capturing speech",
	transcribing: "captured speech is being turned into text",
	speaking: "this client is playing a spoken answer",
	thinking: "a run in the main conversation is busy or compacting",
	working: "briefs are running in the working context (WorkDoc.active)",
	watching: "June is following dispatched tasks (Follows)",
} as const;

export type Activity = keyof typeof ACTIVITIES;

export type Playback = "still" | "loop" | "once";
/** One image: a still, an animated WebP, or a horizontal PNG sprite sheet of `frames` frames at `fps`. `once` returns to idle. */
export type Asset = { file: string; play: Playback; frames?: number; fps?: number };
export type Manifest = { version: 1; size: [number, number]; expressions: Partial<Record<Expression, Asset>> };

const isExpression = (name: string): name is Expression => Object.hasOwn(EXPRESSIONS, name);
const positiveInt = (n: unknown) => Number.isInteger(n) && (n as number) > 0;

/** Check a parsed manifest.json, naming every problem. A base set must have idle, so every chain ends somewhere. */
export function parseManifest(data: unknown, options: { base?: boolean } = {}): Manifest {
	const errors: string[] = [];
	const m = data as Partial<Manifest> | null;
	if (typeof m !== "object" || m === null) throw new Error("manifest: not an object");
	if (m.version !== 1) errors.push("version must be 1");
	if (!Array.isArray(m.size) || m.size.length !== 2 || !m.size.every(positiveInt)) errors.push("size must be [width, height] in pixels");
	const expressions = (typeof m.expressions === "object" && m.expressions !== null ? m.expressions : {}) as Record<string, Partial<Asset>>;
	if (m.expressions !== expressions) errors.push("expressions must be an object");
	for (const [name, a] of Object.entries(expressions)) {
		if (!isExpression(name)) errors.push(`${name}: not in the vocabulary`);
		if (typeof a?.file !== "string" || !/^[\w./-]+\.(png|webp)$/i.test(a.file) || a.file.startsWith("/") || a.file.split("/").includes(".."))
			errors.push(`${name}: file must be a .png or .webp path inside the set`);
		if (!["still", "loop", "once"].includes(a?.play as string)) errors.push(`${name}: play must be still, loop, or once`);
		if (a?.frames !== undefined || a?.fps !== undefined) {
			if (!positiveInt(a.frames) || a.frames! < 2 || typeof a.fps !== "number" || !(a.fps > 0)) errors.push(`${name}: a sprite sheet needs frames of 2 or more and fps above 0`);
			if (a.play === "still") errors.push(`${name}: a still has no frames`);
			if (!/\.png$/i.test(a.file ?? "")) errors.push(`${name}: sprite sheets are PNG`);
		}
	}
	if (options.base && expressions.idle === undefined) errors.push("a base set must have idle");
	if (errors.length > 0) throw new Error(`manifest: ${errors.join("; ")}`);
	return m as Manifest;
}

/** The names to try for an expression: itself, its fallbacks, then idle. An unknown name is idle. */
export function fallbacks(name: string): Expression[] {
	const chain: Expression[] = [];
	let next: string | undefined = isExpression(name) ? name : "idle";
	while (next !== undefined && isExpression(next) && !chain.includes(next)) {
		chain.push(next);
		next = (EXPRESSIONS[next] as { fallback?: string }).fallback;
	}
	if (!chain.includes("idle")) chain.push("idle");
	return chain;
}

/** The asset to show: each name in the chain is looked up in every set in order (a theme, then the base) before the next name. */
export function resolveExpression(name: string, sets: readonly Manifest[]): { expression: Expression; set: number; asset: Asset } | undefined {
	for (const expression of fallbacks(name))
		for (const [set, manifest] of sets.entries()) {
			const asset = manifest.expressions[expression];
			if (asset !== undefined) return { expression, set, asset };
		}
	return undefined;
}
