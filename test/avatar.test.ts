import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ACTIVITIES, EXPRESSIONS, fallbacks, parseManifest, resolveExpression } from "../src/avatar.ts";
import { TEMPLATES } from "../src/init.ts";

const base = new URL("avatar/", `file://${TEMPLATES}`);
const image = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

test("the vocabulary stays small, every chain ends at idle, and no expression shares a name with an activity", () => {
	const names = Object.keys(EXPRESSIONS);
	assert.ok(names.length >= 12 && names.length <= 16, `${names.length} expressions`);
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
