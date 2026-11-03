import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ACTIVITIES, EXPRESSIONS, FRAMINGS, LIVE_STATES, MARKS, POSE_ACTIVITIES, fallbacks, parseManifest, resolveExpression } from "../src/avatar.ts";
import { TEMPLATES } from "../src/init.ts";

const base = new URL("avatar/", `file://${TEMPLATES}`);
const image = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

test("the vocabulary stays small, every chain ends at idle, and no expression shares a name with an activity", () => {
	const names = Object.keys(EXPRESSIONS);
	assert.ok(names.length >= 12 && names.length <= 18, `${names.length} expressions`);
	for (const name of names) assert.equal(fallbacks(name).at(-1), "idle", name);
	for (const activity of Object.keys(ACTIVITIES)) assert.ok(!names.includes(activity), activity);
	assert.deepEqual(fallbacks("indignant"), ["indignant", "exasperated", "skeptical", "wry", "idle"]);
	assert.deepEqual(fallbacks("no-such-face"), ["idle"]);
});

test("the placeholder set covers the whole vocabulary with images of the declared size", async () => {
	const manifest = parseManifest(JSON.parse(await readFile(new URL("manifest.json", base), "utf8")), { base: true });
	assert.deepEqual(Object.keys(manifest.expressions).sort(), Object.keys(EXPRESSIONS).sort());
	for (const [name, asset] of Object.entries(manifest.expressions)) {
		const { width, height } = image(await readFile(new URL(asset.file, base)));
		assert.deepEqual([width / (asset.frames ?? 1), height], manifest.size, name);
	}
});

test("a theme's set falls back to the base for the same face before trying the next name", () => {
	const still = (file: string) => ({ file, play: "still" as const });
	const theme = parseManifest({ version: 1, size: [64, 64], expressions: { exasperated: still("roll.webp") } });
	const baseSet = parseManifest({ version: 1, size: [64, 64], expressions: { idle: still("idle.png"), indignant: still("huff.png") } }, { base: true });
	assert.deepEqual(resolveExpression("indignant", [theme, baseSet]), { expression: "indignant", set: 1, asset: still("huff.png") });
	assert.deepEqual(resolveExpression("smug", [theme, baseSet]), { expression: "idle", set: 1, asset: still("idle.png") });
	assert.equal(resolveExpression("smug", [theme]), undefined);
});

test("a bad manifest names each problem", () => {
	assert.throws(
		() =>
			parseManifest(
				{ version: 2, size: [0, 64], expressions: { thinking: { file: "a.png", play: "still" }, pout: { file: "../x.png", play: "bounce" }, smug: { file: "s.webp", play: "still", frames: 3, fps: 4 } } },
				{ base: true },
			),
		(e: Error) =>
			["version must be 1", "size must be", "thinking: not in the vocabulary", "pout: file must be", "pout: play must be", "smug: a still has no frames", "smug: sprite sheets are PNG", "must have idle"].every((s) =>
				e.message.includes(s),
			),
	);
	assert.throws(() => parseManifest(null), /not an object/);
	assert.throws(() => parseManifest({ version: 1, size: [1, 1] }), /expressions must be an object/);
});

test("the placeholder poses validate, exist at their declared size, and keep the mouth inside the face", async () => {
	const manifest = parseManifest(JSON.parse(await readFile(new URL("manifest.json", base), "utf8")), { base: true });
	const poses = Object.entries(manifest.poses ?? {});
	assert.ok(poses.length >= 6, `${poses.length} poses`);
	assert.ok(poses.some(([, p]) => p.expression === "idle" && !p.activity), "an idle pose ends every chain");
	for (const activity of ["working", "thinking"]) assert.ok(poses.some(([, p]) => p.activity === activity), `a placeholder ${activity} pose`);
	for (const [name, pose] of poses) {
		const svg = await readFile(new URL(pose.file, base), "utf8");
		const [width, height] = [Number(/width="(\d+)"/.exec(svg)?.[1]), Number(/height="(\d+)"/.exec(svg)?.[1])];
		assert.deepEqual([width, height], pose.size, name);
		assert.ok(FRAMINGS.length >= (pose.framings?.length ?? 0), name);
		for (const mark of pose.marks ?? []) assert.ok((MARKS as readonly string[]).includes(mark), `${name}: ${mark}`);
	}
});

test("a bad pose names each problem, and a base set's poses need an idle one", () => {
	const idle = { idle: { file: "idle.png", play: "still" as const } };
	const good = { file: "p/a.webp", size: [800, 1000], expression: "smug", face: [0.3, 0.1, 0.4, 0.3], mouth: [0.5, 0.35], facing: "right" };
	assert.doesNotThrow(() => parseManifest({ version: 1, size: [64, 64], expressions: idle, poses: { "smug-chin-on-hand": good } }));
	assert.throws(
		() =>
			parseManifest(
				{
					version: 1,
					size: [64, 64],
					expressions: idle,
					poses: {
						Smug_Pose: { ...good, file: "../x.gif" },
						"bad-geometry": { ...good, expression: "thinking", face: [0.8, 0.1, 0.4, 0.3], mouth: [0.1, 0.9], facing: "up", mirror: "no" },
						"bad-lists": { ...good, framings: ["portrait"], marks: [], props: [3], activity: "busy" },
					},
				},
				{ base: true },
			),
		(e: Error) =>
			[
				"pose Smug_Pose: name must be",
				"pose Smug_Pose: file must be",
				"pose bad-geometry: expression must be",
				"pose bad-geometry: face must be",
				"pose bad-geometry: facing must be",
				"pose bad-geometry: mirror must be",
				"pose bad-lists: framings must list",
				"pose bad-lists: marks must list",
				"pose bad-lists: props must be words",
				"pose bad-lists: activity must be one of thinking, working, watching",
				"must have an idle pose",
			].every((s) => e.message.includes(s)),
	);
	assert.throws(() => parseManifest({ version: 1, size: [64, 64], expressions: idle, poses: { "mouth-out": { ...good, mouth: [0.9, 0.9] } } }), /mouth must be inside the face/);
	assert.deepEqual(POSE_ACTIVITIES, ["thinking", "working", "watching"]);
	assert.throws(
		() => parseManifest({ version: 1, size: [64, 64], expressions: idle, poses: { "idle-working": { ...good, expression: "idle", activity: "working" } } }, { base: true }),
		/must have an idle pose/,
		"an idle working pose does not end the chains: a reaction never shows an activity",
	);
});

test("live June's art validates by state, and the placeholder set covers every state", async () => {
	const manifest = parseManifest(JSON.parse(await readFile(new URL("manifest.json", base), "utf8")), { base: true });
	assert.deepEqual(Object.keys(manifest.live ?? {}).sort(), [...LIVE_STATES].sort());
	for (const [state, asset] of Object.entries(manifest.live ?? {})) await readFile(new URL(asset.file, base)).catch(() => assert.fail(`${state}: ${asset.file} missing`));
	const idle = { idle: { file: "idle.png", play: "still" as const } };
	assert.doesNotThrow(() => parseManifest({ version: 1, size: [64, 64], expressions: idle, live: { typing: { file: "live/typing.png", play: "loop", frames: 8, fps: 8 } } }));
	assert.throws(
		() => parseManifest({ version: 1, size: [64, 64], expressions: idle, live: { dancing: { file: "d.png", play: "loop" }, typing: { file: "../t.gif", play: "bounce", frames: 1, fps: 0 } } }),
		(e: Error) => ["live dancing: not a live state", "live typing: file must be", "live typing: play must be", "live typing: a sprite sheet needs"].every((s) => e.message.includes(s)),
	);
});

