import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS, FACE, MARGIN, gesturePreservation, kindOf, mouthOf, parseBox, parseNumbers, placeChibi, placeCover, placePose, placeProp, windowOf } from "../art/layout.mjs";
import { gestureShown } from "../overlay/compose.mjs";

const close = (a, b, tolerance = 0.002) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not within ${tolerance} of ${b}`);

for (const legacy of [false, true]) test(`re-ingest preserves ${legacy ? "a legacy pose's missing added date" : "a pose's original added date over incoming metadata"}`, (t) => {
	const set = mkdtempSync(join(tmpdir(), "june-art-date-"));
	t.after(() => rmSync(set, { recursive: true, force: true }));
	mkdirSync(join(set, "incoming"));
	const source = join(set, "synthetic.png");
	// Oversized synthetic face means downscaling only. This never invokes the GPU upscaler or touches real artwork.
	execFileSync("magick", ["-size", "1600x2500", "xc:none", "-fill", "#cc9966", "-draw", "rectangle 100,100 1500,2480", source]);
	const metadata = { section: "poses", expression: "warm", facing: "front", framings: ["head", "bust"], gestureBoxes: [{ name: "raised-hand", box: [300, 800, 200, 200], primary: true }] };
	const ingest = (details) => {
		writeFileSync(join(set, "incoming", "synthetic.json"), JSON.stringify(details));
		execFileSync(process.execPath, [new URL("../art/june-art.mjs", import.meta.url).pathname, "ingest", set, "synthetic", "--file", source, "--face", "600,200,400,800"], { stdio: "pipe" });
		return JSON.parse(readFileSync(join(set, "manifest.json"), "utf8"));
	};
	const manifest = ingest(metadata);
	const first = manifest.poses.synthetic.added;
	assert.ok(Number.isFinite(Date.parse(first)), "first ingest stamps the new pose");
	if (legacy) {
		delete manifest.poses.synthetic.added;
		writeFileSync(join(set, "manifest.json"), JSON.stringify(manifest));
	}
	const after = ingest({ ...metadata, ...(legacy ? {} : { added: "2099-01-01T00:00:00.000Z" }) });
	assert.equal(after.poses.synthetic.added, legacy ? undefined : first);
});

test("ingest refuses a low hand before writing an asset or clamping its gesture box", (t) => {
	const set = mkdtempSync(join(tmpdir(), "june-art-gesture-"));
	t.after(() => rmSync(set, { recursive: true, force: true }));
	mkdirSync(join(set, "incoming"));
	const source = join(set, "synthetic.png");
	execFileSync("magick", ["-size", "1600x3000", "xc:none", "-fill", "#cc9966", "-draw", "rectangle 100,100 1500,2980", source]);
	const metadata = { section: "poses", expression: "skeptical", facing: "left", faceBox: [600, 200, 400, 800], gestureBoxes: [{ name: "hip-hand", box: [200, 2500, 100, 300], primary: true }] };
	writeFileSync(join(set, "incoming", "synthetic.json"), JSON.stringify(metadata));
	assert.throws(() => execFileSync(process.execPath, [new URL("../art/june-art.mjs", import.meta.url).pathname, "ingest", set, "synthetic", "--file", source], { stdio: "pipe" }), /hip-hand.*source pixels.*outside/);
	assert.equal(existsSync(join(set, "manifest.json")), false);
	assert.equal(existsSync(join(set, "poses", "synthetic.webp")), false);
	assert.equal(existsSync(join(set, "source")), false);
	assert.equal(existsSync(join(set, "incoming", "synthetic.json")), true);
});

test("a fully visible surviving box cannot certify source-gesture preservation", () => {
	const source = { w: 10, h: 10, alpha: new Uint8Array(100).fill(255) };
	const place = { size: [10, 10], scale: 1, x: 0, y: 3 };
	const [hand, high] = gesturePreservation([{ name: "hand", box: [2, 6, 3, 4] }, { name: "high", box: [2, 2, 3, 2] }], source, place);
	assert.equal(hand.solid_source_pixels, 12);
	assert.equal(hand.projected_outside_canvas, 9);
	assert.equal(hand.source_edge_pixels.bottom, 3, "source completeness is a separate inspection flag");
	assert.equal(high.projected_outside_canvas, 0);
	const surviving = { gestures: [{ box: { x: 0.2, y: 0.9, w: 0.3, h: 0.1 } }] };
	assert.equal(gestureShown({ art: { x: 0, y: 0, w: 10, h: 10 }, clip: { x: 0, y: 0, w: 10, h: 10 }, elements: [] }, surviving), 1);
	assert.ok(hand.projected_outside_canvas > 0, "100% panel visibility does not waive source loss");
	assert.throws(() => gesturePreservation([{ name: "bad", box: [-1, 2, 3, 2] }], source, place), /inside the source/);
});

test("a pose's face lands at its kind's size and height, centred across", () => {
	// A 500 × 650 source, the figure inside a margin, the face 150 × 175 at (175, 127).
	const place = placePose("pose", { x: 58, y: 104, w: 384, h: 546 }, { x: 175, y: 127, w: 150, h: 175 });
	assert.deepEqual(place.size, CANVAS.pose);
	close(place.face[3], FACE.pose.h);
	close(place.face[1] + place.face[3] / 2, FACE.pose.cy);
	close(place.face[0] + place.face[2] / 2, 0.5);
	assert.deepEqual(place.problems, []);
});

test("a tall pose keeps her face smaller and higher", () => {
	const place = placePose("tall", { x: 100, y: 40, w: 600, h: 1500 }, { x: 330, y: 80, w: 130, h: 160 });
	assert.deepEqual(place.size, CANVAS.tall);
	close(place.face[3], FACE.tall.h);
	close(place.face[1] + place.face[3] / 2, FACE.tall.cy);
});

test("a pose is moved in from a side, and too wide a figure is reported", () => {
	// Her face at the source's left edge, the figure reaching far right of it.
	const shifted = placePose("pose", { x: 10, y: 100, w: 300, h: 550 }, { x: 20, y: 130, w: 100, h: 120 });
	const left = shifted.x + 10 * shifted.scale;
	const right = shifted.x + 310 * shifted.scale;
	assert.ok(left >= CANVAS.pose[0] * MARGIN - 0.5 && right <= CANVAS.pose[0] * (1 - MARGIN) + 0.5);
	assert.ok(shifted.face[0] + shifted.face[2] / 2 < 0.5, "her face moves off centre rather than the figure leaving the canvas");
	const wide = placePose("pose", { x: 0, y: 100, w: 1000, h: 550 }, { x: 450, y: 130, w: 100, h: 120 });
	assert.match(wide.refused, /past the 3072 px limit/, "a figure eight faces wide is refused, not cut");
	assert.equal(placePose("pose", { x: 0, y: 100, w: 1000, h: 550 }, { x: 450, y: 130, w: 100, h: 120 }, { maxWidth: 20000 }).refused, undefined, "the limit can be raised");
});

test("a wide gesture widens the canvas at the same height and face size, keeping every finger (Pi's wave 10002)", () => {
	// The original wave: face 442,120,226,267 in a 1152 x 1344 source, its solid figure 2280 px wide at the 27% face.
	const face = { x: 442, y: 120, w: 226, h: 267 };
	const figure = { x: 120, y: 60, w: 847, h: 1284 };
	const place = placePose("pose", figure, face);
	assert.equal(place.refused, undefined);
	assert.deepEqual(place.size, [2560, CANVAS.pose[1]], "the next 128 px step past the 2479 px it needs");
	assert.equal(place.face[3], 0.27, "her face keeps its height");
	const left = place.x + figure.x * place.scale;
	const right = place.x + (figure.x + figure.w) * place.scale;
	assert.ok(left >= 2560 * MARGIN - 0.5 && right <= 2560 * (1 - MARGIN) + 0.5, "the whole figure inside the margins");
	assert.match(place.problems.join(), /widened to 2560 px/);
	const fits = placePose("pose", { x: 58, y: 104, w: 384, h: 546 }, { x: 175, y: 127, w: 150, h: 175 });
	assert.deepEqual(fits.size, CANVAS.pose, "a pose that fits keeps the standard canvas");
});

test("a pose whose hair would touch the top sits lower, and says so", () => {
	const place = placePose("pose", { x: 50, y: 0, w: 400, h: 900 }, { x: 175, y: 300, w: 150, h: 175 });
	assert.ok(place.y >= CANVAS.pose[1] * MARGIN - 0.5);
	assert.match(place.problems.join(), /lower/);
});

test("a pose that stops short of the bottom is reported", () => {
	const place = placePose("pose", { x: 50, y: 50, w: 400, h: 250 }, { x: 175, y: 80, w: 150, h: 175 });
	assert.match(place.problems.join(), /floating/);
});

test("a chibi fills its square inside the margins, standing on the bottom margin", () => {
	const [W, H] = CANVAS.chibi;
	const place = placeChibi({ x: 400, y: 400, w: 1800, h: 2200 });
	const bottom = place.y + 2600 * place.scale;
	close(bottom, H * (1 - MARGIN), 0.5);
	const top = place.y + 400 * place.scale;
	close(top, H * MARGIN, 0.5);
	const centre = place.x + 1300 * place.scale;
	close(centre, W / 2, 0.5);
});

test("rooms and views cover their canvas, and a different shape is reported", () => {
	const room = placeCover("room", { x: 0, y: 0, w: 1600, h: 1000 });
	assert.equal(room.scale, 2);
	assert.deepEqual([room.x, room.y], [0, 0]);
	assert.deepEqual(room.problems, []);
	const square = placeCover("plate", { x: 0, y: 0, w: 1024, h: 1024 });
	close(square.scale, 1600 / 1024);
	assert.ok(square.y < 0 && square.x === 0);
	assert.match(square.problems.join(), /top and bottom/);
});

test("a prop is trimmed and fitted inside its planned size", () => {
	const place = placeProp({ x: 8, y: 18, w: 324, h: 497 }, [340, 520]);
	assert.ok(place.size[0] <= 340 && place.size[1] <= 520);
	assert.ok(place.size[1] === 520 || place.size[0] === 340);
	close(place.x, -8 * place.scale, 1e-9);
});

test("geometry helpers", () => {
	assert.deepEqual(windowOf({ x: 1856, y: 200, w: 1024, h: 920 }, [3200, 2000]), [0.58, 0.1, 0.32, 0.46]);
	assert.deepEqual(parseBox("384x546+58+104"), { w: 384, h: 546, x: 58, y: 104 });
	assert.equal(parseBox("0x0+0+0"), null);
	assert.deepEqual(parseNumbers("175,127,150,175", 4), [175, 127, 150, 175]);
	assert.throws(() => parseNumbers("1,2", 4), /4 numbers/);
	assert.deepEqual(mouthOf([0.35, 0.196, 0.3, 0.269]), [0.5, 0.411]);
	assert.equal(kindOf("poses", { framings: ["bust", "full"] }), "tall");
	assert.equal(kindOf("poses", { framings: ["bust"] }), "pose");
	assert.equal(kindOf("rooms", {}), "room");
	assert.equal(kindOf("live", {}), null);
});
