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
	laughing: { meaning: "laughing at something genuinely funny", frequency: "occasional", fallback: "wry" },
	surprised: { meaning: "caught off guard by something unexpected, good or bad", frequency: "occasional", fallback: "curious" },
	confused: { meaning: "not following; something does not add up", frequency: "occasional", fallback: "curious" },
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

/**
 * How much of June a comic panel shows, closest first: her face, head and shoulders, bust, down to the waist, or a
 * three-quarter or full figure. A pose that lists no framings fills the first four; `full` is only for art drawn tall.
 */
export const FRAMINGS = ["close-up", "head", "bust", "waist", "full"] as const;
export type Framing = (typeof FRAMINGS)[number];
/** Marks a client may draw beside a pose's face to reinforce it; never baked into the art. */
export const MARKS = ["sparkle", "heart", "sweat", "vein", "steam", "emphasis"] as const;
export type Mark = (typeof MARKS)[number];

/**
 * A pose: one illustration of June, ideally on a transparent background, that a client scales, crops, mirrors, and places
 * into panels of any size, like a hero image. Its name describes it (`smug-chin-on-hand`) so a model can choose it; its
 * expression ties it to the vocabulary, so an unknown name or a missing pose falls back through the expression chain.
 * Geometry is in fractions of the image: `face` is the box no balloon may cover, `mouth` the point tails aim at.
 * `facing` is where she looks; a client mirrors a pose to face the text unless `mirror` is false (lettering or a prop that
 * must not flip). `framings` lists the crops the image can fill; `marks` are decorations that suit it.
 */
export type Pose = {
	file: string;
	size: [number, number];
	expression: Expression;
	description?: string;
	face: [number, number, number, number];
	mouth: [number, number];
	facing: "left" | "right" | "front";
	mirror?: boolean;
	framings?: Framing[];
	marks?: Mark[];
	props?: string[];
};
export type Manifest = { version: 1; size: [number, number]; expressions: Partial<Record<Expression, Asset>>; poses?: Record<string, Pose> };

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
	errors.push(...poseErrors(m.poses, options));
	if (errors.length > 0) throw new Error(`manifest: ${errors.join("; ")}`);
	return m as Manifest;
}

const fraction = (n: unknown): n is number => typeof n === "number" && n >= 0 && n <= 1;
const listOf = (value: unknown, allowed: readonly string[]) => Array.isArray(value) && value.length > 0 && value.every((v) => allowed.includes(v));

/** Problems with a manifest's optional poses. A base set's poses must include an idle one, so every chain ends at a pose. */
function poseErrors(data: unknown, options: { base?: boolean }): string[] {
	if (data === undefined) return [];
	if (typeof data !== "object" || data === null || Array.isArray(data)) return ["poses must be an object"];
	const errors: string[] = [];
	const poses = data as Record<string, Partial<Pose>>;
	for (const [name, p] of Object.entries(poses)) {
		const at = `pose ${name}`;
		if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) errors.push(`${at}: name must be lowercase words joined by hyphens`);
		if (typeof p?.file !== "string" || !/^[\w./-]+\.(png|webp|svg)$/i.test(p.file) || p.file.startsWith("/") || p.file.split("/").includes(".."))
			errors.push(`${at}: file must be a .png, .webp, or .svg path inside the set`);
		if (!Array.isArray(p?.size) || p.size.length !== 2 || !p.size.every(positiveInt)) errors.push(`${at}: size must be [width, height] in pixels`);
		if (typeof p?.expression !== "string" || !isExpression(p.expression)) errors.push(`${at}: expression must be in the vocabulary`);
		const face = p?.face;
		if (!Array.isArray(face) || face.length !== 4 || !face.every(fraction) || !(face[2]! > 0 && face[3]! > 0) || face[0]! + face[2]! > 1 || face[1]! + face[3]! > 1)
			errors.push(`${at}: face must be [x, y, width, height] inside the image, as fractions`);
		const mouth = p?.mouth;
		if (!Array.isArray(mouth) || mouth.length !== 2 || !mouth.every(fraction)) errors.push(`${at}: mouth must be [x, y] as fractions`);
		else if (Array.isArray(face) && face.length === 4 && !(mouth[0]! >= face[0]! && mouth[0]! <= face[0]! + face[2]! && mouth[1]! >= face[1]! && mouth[1]! <= face[1]! + face[3]!))
			errors.push(`${at}: mouth must be inside the face`);
		if (!["left", "right", "front"].includes(p?.facing as string)) errors.push(`${at}: facing must be left, right, or front`);
		if (p?.mirror !== undefined && typeof p.mirror !== "boolean") errors.push(`${at}: mirror must be true or false`);
		if (p?.framings !== undefined && !listOf(p.framings, FRAMINGS)) errors.push(`${at}: framings must list some of ${FRAMINGS.join(", ")}`);
		if (p?.marks !== undefined && !listOf(p.marks, MARKS)) errors.push(`${at}: marks must list some of ${MARKS.join(", ")}`);
		if (p?.props !== undefined && !(Array.isArray(p.props) && p.props.every((v) => typeof v === "string"))) errors.push(`${at}: props must be words`);
		if (p?.description !== undefined && typeof p.description !== "string") errors.push(`${at}: description must be text`);
	}
	const names = Object.values(poses);
	if (options.base && names.length > 0 && !names.some((p) => p?.expression === "idle")) errors.push("a base set with poses must have an idle pose");
	return errors;
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
