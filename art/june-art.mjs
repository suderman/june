#!/usr/bin/env node
// june-art: turn approved generated images into finished pieces of an avatar set outside the repository.
//
//   june-art status SET           what is planned, waiting in incoming/, and finished
//   june-art ingest SET NAME      finish incoming/NAME.png: key, trim, upscale, place on its canvas, write WebP and
//                                 the manifest entry, and keep the original and its prompt in source/
//   june-art sheet SET NAME [OUT] a contact sheet: the piece, its face box and mouth, and its crop at every framing
//   june-art figure SET NAME...   record where finished poses' drawn figures lie (`figure`), for poses ingested before
//                                 ingest wrote it; a tall panel stands her on the panel's bottom by it
//   june-art colours SET PLAN     apply a plan of colour fixes to a set's sources and finish those poses again, with
//                                 their manifest entries unchanged (--check only confirms each one can be finished)
//   june-art run VERB ...         drive ComfyUI: pipelines, budgets, a ledger of every job, pixel checks (runner.mjs)
//
// ingest options: --file PATH (instead of incoming/NAME.png), --face X,Y,W,H and --mouth X,Y in source pixels,
// --gesture NAME,X,Y,W,H (repeatable, the first primary) for a gesture away from her face, --max-width PX for how wide
// a pose's canvas may grow to keep a wide gesture (default 3072), --key COLOUR to make a flat colour see-through (a
// room's window, a view's sky), --fuzz PERCENT (default 12).
//
// An entry's details (expression, description, facing, setting, ...) come from incoming/NAME.json, a flat manifest
// entry with "section" (poses, chibi, rooms, plates, props) and optionally "faceBox" [x, y, w, h] and "gestureBoxes"
// [{name, box: [x, y, w, h], primary}] in source pixels;
// else from the entry already in manifest.json; else from planned.json, a manifest-shaped catalogue of what is still
// to be made. Needs magick and realesrgan-ncnn-vulkan on PATH; the Nix package provides both.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "../src/avatar.ts";
import { FRAMINGS, frame, framingsShowing, readPoses } from "../overlay/compose.mjs";
import { FONT, recolor, runCommand } from "./runner.mjs";
import { CROWN_CUT_SHARE, MAX_WIDTH, gesturePreservation, kindOf, mouthOf, parseBox, parseNumbers, placeChibi, placeCover, placePose, placeProp, windowOf } from "./layout.mjs";

const SECTIONS = ["poses", "chibi", "rooms", "plates", "props"];
const BACKGROUND = ["rooms", "plates", "props"];

const magick = (...args) => execFileSync("magick", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
const offset = (n) => `${n < 0 ? "-" : "+"}${Math.abs(Math.round(n))}`;

/** A set's entries by section, flattened so backgrounds sit beside poses and chibi. */
function entries(manifest, section) {
	const holder = BACKGROUND.includes(section) ? manifest?.backgrounds : manifest;
	return holder?.[section] ?? {};
}

function setEntry(manifest, section, key, entry) {
	if (BACKGROUND.includes(section)) {
		manifest.backgrounds ??= {};
		manifest.backgrounds[section] ??= {};
		manifest.backgrounds[section][key] = entry;
	} else {
		manifest[section] ??= {};
		manifest[section][key] = entry;
	}
}

function deleteEntry(manifest, section, key) {
	const holder = entries(manifest, section);
	delete holder[key];
}

/** The manifest key for a name: chibi stills are keyed by expression, so chibi-warm is chibi "warm". */
const keyFor = (section, name) => (section === "chibi" ? name.replace(/^chibi-/, "") : name);

/** Where a name's details come from, and its section. */
function findEntry(set, name, manifest, planned) {
	const sidecar = readJson(join(set, "incoming", `${name}.json`), null);
	if (sidecar) {
		if (!SECTIONS.includes(sidecar.section)) throw new Error(`incoming/${name}.json: section must be one of ${SECTIONS.join(", ")}`);
		const { section, faceBox, gestureBoxes, ...entry } = sidecar;
		const existing = entries(manifest, section)[keyFor(section, name)] ?? entries(planned, section)[keyFor(section, name)] ?? {};
		return { section, entry: { ...existing, ...entry }, faceBox, gestureBoxes, from: `incoming/${name}.json` };
	}
	for (const [source, label] of [
		[manifest, "manifest.json"],
		[planned, "planned.json"],
	])
		for (const section of SECTIONS) {
			const entry = entries(source, section)[keyFor(section, name)];
			if (entry) return { section, entry: { ...entry }, faceBox: null, from: label };
		}
	throw new Error(`${name}: no details; add incoming/${name}.json with its section, or an entry in planned.json`);
}

/** The box of a source's solid pixels, or with `holes`, of its see-through ones. */
function alphaBox(file, holes = false) {
	const args = [file, "-alpha", "extract", "-threshold", "50%"];
	if (holes) args.push("-negate");
	const box = parseBox(magick(...args, "-bordercolor", "black", "-border", "1", "-format", "%@", "info:"));
	return box ? { x: box.x - 1, y: box.y - 1, w: box.w, h: box.h } : null;
}

/** The share of the top pixel row that is solid: a drawing cut by its top edge has a span of hair there, not a stray pixel. */
function topSolidShare(file) {
	return Number(magick(file, "-alpha", "extract", "-crop", "x1+0+0", "+repage", "-threshold", "50%", "-format", "%[fx:mean]", "info:"));
}

function size(file) {
	const [w, h] = magick(file, "-format", "%w %h", "info:").split(" ").map(Number);
	return { x: 0, y: 0, w, h };
}

/** A finished pose's measured face box, in source pixels, from the records kept beside its source. */
function recordedFaceBox(set, name) {
	const fromJson = readJson(join(set, "source", `${name}.json`), {}).faceBox;
	if (fromJson) return fromJson;
	const text = join(set, "source", `${name}.txt`);
	if (!existsSync(text)) throw new Error(`${name}: no recorded face box in source/`);
	const record = readJson(text, {});
	const box = (record.measurement ?? record.measurements)?.face ?? (record.measurement ?? {}).faceBox;
	if (!box) throw new Error(`${name}: no recorded face box in source/`);
	return box;
}

/**
 * Apply a plan of colour fixes to a set's sources, then finish each pose again, its manifest entry unchanged. Each pose
 * starts from the copy kept in colour-originals/, so running a corrected plan again never stacks changes. A pose that
 * fails is reported and the rest go on. With --check, confirms only that every pose can be finished again.
 */
function applyColours(set, planPath, { check = false } = {}) {
	const plan = readJson(planPath, null);
	if (!plan?.poses) throw new Error(`${planPath}: a plan is { "poses": { NAME: [{ "item": ..., "region": [x, y, w, h] }] } }`);
	const targets = readJson(new URL("./colour-targets.json", import.meta.url).pathname, {});
	const originals = join(set, "colour-originals");
	mkdirSync(originals, { recursive: true });
	const reportPath = join(set, "colour-report.json");
	const report = readJson(reportPath, {});
	const manifest = readJson(join(set, "manifest.json"), {});
	let failed = 0;
	for (const [name, steps] of Object.entries(plan.poses)) {
		const work = mkdtempSync(join(tmpdir(), "june-art-colour-"));
		try {
			if (!entries(manifest, "poses")[name]) throw new Error("not a pose in this set");
			const original = join(originals, `${name}.png`);
			if (!check && !existsSync(original)) copyFileSync(join(set, "source", `${name}.png`), original);
			if (check) {
				ingest(set, name, { file: join(set, "source", `${name}.png`), keepEntry: true, checkOnly: true });
				console.log(`${name}: ok`);
				continue;
			}
			let current = original;
			const results = [];
			steps.forEach((step, index) => {
				const merged = { ...targets[step.item], ...step };
				if (!merged.match && !Number.isFinite(merged.toHue)) throw new Error(`step ${index}: no target for "${step.item}"`);
				const region = merged.region === "face" ? recordedFaceBox(set, name) : merged.region;
				if (!merged.polygon && !Array.isArray(region)) throw new Error(`step ${index} (${step.item}): needs a region or a polygon`);
				const next = join(work, `${index}.png`);
				const done = recolor(current, next, { ...merged, region });
				results.push({ item: step.item, region: merged.polygon ?? region, selected: done.selected_pixels, changed: done.changed_pixels, before: done.before, after: done.after });
				current = next;
			});
			ingest(set, name, { file: current, keepEntry: true });
			report[name] = { steps: results, at: new Date().toISOString() };
			console.log(`${name}: ${results.map((r) => `${r.item} ${r.before} -> ${r.after} (${r.changed} px)`).join(", ") || "unchanged"}`);
		} catch (error) {
			failed++;
			report[name] = { error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
			console.error(`${name}: FAILED: ${report[name].error}`);
		} finally {
			rmSync(work, { recursive: true, force: true });
			if (!check) writeJson(reportPath, report);
		}
	}
	if (failed > 0) process.exitCode = 1;
}

function ingest(set, name, options) {
	const manifestPath = join(set, "manifest.json");
	const manifest = readJson(manifestPath, { version: 1, size: [256, 256], expressions: {} });
	const planned = readJson(join(set, "planned.json"), {});
	const { section, entry, faceBox, gestureBoxes, from } = findEntry(set, name, manifest, planned);
	const key = keyFor(section, name);
	// Portrait art extended to her feet lists `full` but keeps a portrait's face size, so its close-ups stay sharp.
	const kind = options.portrait && section === "poses" ? "pose" : kindOf(section, entry);
	const source = options.file ?? join(set, "incoming", `${name}.png`);
	if (!existsSync(source)) throw new Error(`${source}: no such file`);
	const dir = { poses: "poses", chibi: "chibi", rooms: "backgrounds/rooms", plates: "backgrounds/plates", props: "backgrounds/props" }[section];
	const file = `${dir}/${key}.webp`;

	// Check the details before any pixel work, with stand-in geometry.
	const trial = structuredClone(manifest);
	setEntry(trial, section, key, { ...entry, file, size: [1, 1], ...(section === "poses" ? { face: [0.4, 0.2, 0.2, 0.2], mouth: [0.5, 0.35] } : {}), ...(section === "chibi" ? { play: "still" } : {}) });
	parseManifest(trial);

	const work = mkdtempSync(join(tmpdir(), "june-art-"));
	try {
		let image = join(work, "keyed.png");
		if (options.key) magick(source, "-alpha", "set", "-fuzz", `${options.fuzz ?? 12}%`, "-transparent", options.key, `PNG32:${image}`);
		else magick(source, "-alpha", "set", `PNG32:${image}`);
		const whole = size(image);
		const figure = alphaBox(image);
		if (!figure) throw new Error(`${name}: the image is entirely see-through`);
		figure.cutTop = topSolidShare(image) >= CROWN_CUT_SHARE;
		const holes = alphaBox(image, true);
		if (!holes) throw new Error(`${name}: nothing is see-through; give --key COLOUR for its flat background${section === "rooms" ? " or window" : section === "plates" ? " or sky" : ""}`);

		let place;
		let face = null;
		if (kind === "pose" || kind === "tall") {
			if (options.keepEntry) {
				options.face ??= recordedFaceBox(set, name);
				options.maxWidth ??= Math.max(entry.size?.[0] ?? 0, MAX_WIDTH);
			}
			const box = options.face ?? faceBox;
			if (!box) throw new Error(`${name}: a pose needs its face box in source pixels: --face X,Y,W,H`);
			face = { x: box[0], y: box[1], w: box[2], h: box[3] };
			place = placePose(kind, figure, face, { maxWidth: options.maxWidth });
			if (place.refused) throw new Error(`${name}: ${place.refused}; compose the gesture closer, or give --max-width`);
		} else if (kind === "chibi") place = placeChibi(figure);
		else if (kind === "room" || kind === "plate") place = placeCover(kind, whole);
		else {
			const fit = Array.isArray(entry.size) ? entry.size : [400, 400];
			place = placeProp(figure, fit);
		}

		if (options.keepEntry && String(place.size) !== String(entry.size)) throw new Error(`${name}: placing it again gives ${place.size}, not the recorded ${entry.size}`);
		if (options.checkOnly) return;
		const gestures = options.gestures?.length ? options.gestures : gestureBoxes;
		if (face && Array.isArray(gestures) && gestures.length > 0) {
			const alpha = execFileSync("magick", [image, "-alpha", "extract", "-depth", "8", "gray:-"], { maxBuffer: 64 * 1024 * 1024 });
			for (const g of gesturePreservation(gestures, { ...whole, alpha }, place)) {
				if (!g.solid_source_pixels) throw new Error(`${name}: ${g.name} has no solid source pixels`);
				if (g.projected_outside_canvas) throw new Error(`${name}: ${g.name} projects ${g.projected_outside_canvas}/${g.solid_source_pixels} solid source pixels outside the normalized canvas; recompose the source gesture, not its clamped box`);
				if (Object.values(g.source_edge_pixels).some((n) => n > 0)) place.problems.push(`${g.name} touches the source edge; inspect original gesture completeness`);
			}
		}

		// Upscale when the piece would be drawn larger than generated, then scale down to the exact size.
		const fromSource = place.scale;
		if (place.scale > 1.05) {
			const up = join(work, "up.png");
			execFileSync("realesrgan-ncnn-vulkan", ["-i", image, "-o", up, "-n", "realesrgan-x4plus-anime", "-s", "4"], { stdio: ["ignore", "ignore", "pipe"] });
			image = up;
			place = { ...place, scale: place.scale / 4 };
		}
		const src = size(image);
		const [W, H] = place.size;
		mkdirSync(join(set, dir), { recursive: true });
		const out = join(set, file);
		magick(
			"-size", `${W}x${H}`, "xc:none",
			"(", image, "-filter", "Lanczos", "-resize", `${Math.round(src.w * place.scale)}x${Math.round(src.h * place.scale)}!`, ")",
			"-geometry", `${offset(place.x)}${offset(place.y)}`, "-composite",
			"-define", "webp:lossless=true", "-define", "webp:exact=false", `WEBP:${out}`,
		);

		const finished = { ...entry, file, size: [W, H] };
		if (section === "chibi") finished.play ??= "still";
		if (face) {
			finished.face = place.face;
			// Where her drawn figure lies on the canvas, so a tall panel can stand her on its bottom edge, not the canvas's.
			const r = (n) => Math.round(n * 1000) / 1000;
			const fx = Math.max(0, place.x + figure.x * fromSource), fy = Math.max(0, place.y + figure.y * fromSource);
			finished.figure = [r(fx / W), r(fy / H), r((Math.min(W, place.x + (figure.x + figure.w) * fromSource) - fx) / W), r((Math.min(H, place.y + (figure.y + figure.h) * fromSource) - fy) / H)];
			const at = (px, py) => [Math.round(((place.x + px * fromSource) / W) * 1000) / 1000, Math.round(((place.y + py * fromSource) / H) * 1000) / 1000];
			finished.mouth = options.mouth ? at(options.mouth[0], options.mouth[1]) : mouthOf(place.face);
			// Its gestures in the finished image, the primary first, and only the framings that keep that one in view.
			if (Array.isArray(gestures) && gestures.length > 0) {
				const clamp = (n) => Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));
				finished.gestures = gestures.map((g, i) => {
					const [gx, gy, gw, gh] = g.box;
					const x0 = clamp((place.x + gx * fromSource) / W);
					const y0 = clamp((place.y + gy * fromSource) / H);
					const box = [x0, y0, Math.min(Math.floor((1 - x0) * 1000) / 1000, clamp((gw * fromSource) / W)), Math.min(Math.floor((1 - y0) * 1000) / 1000, clamp((gh * fromSource) / H))];
					return { name: g.name, box, ...((g.primary ?? i === 0) ? { primary: true } : {}) };
				});
				const primaries = finished.gestures.filter((g) => g.primary);
				if (primaries.length !== 1) throw new Error(`${name}: exactly one gesture must be primary`);
				const [shown] = readPoses({ poses: { [key]: { ...finished, expression: entry.expression ?? "idle", facing: entry.facing ?? "front" } } }, "");
				const allowed = (entry.framings ?? ["close-up", "head", "bust", "waist"]).filter((f) => f === "full" || framingsShowing(shown).includes(f));
				if (allowed.length > 0) finished.framings = allowed;
				else place.problems.push("no framing shows its primary gesture; its framings are left as they were");
			}
		}
		// When it entered the set, never changed after: a panel only falls back to poses that existed when it happened.
		if (section === "poses") {
			const existing = entries(manifest, section)[key];
			if (existing?.added !== undefined) finished.added = existing.added;
			else if (existing) delete finished.added; // Legacy entries were always available, not newly added today.
			else finished.added ??= new Date().toISOString();
		}
		if (section === "rooms") {
			const hole = alphaBox(out, true);
			if (!hole) throw new Error(`${name}: the finished room has no window`);
			finished.window = windowOf(hole, [W, H]);
		}
		setEntry(manifest, section, key, options.keepEntry ? entry : finished);
		parseManifest(manifest);
		writeJson(manifestPath, manifest);

		// Keep the original and its prompt beside the set; incoming/ empties as pieces finish.
		mkdirSync(join(set, "source"), { recursive: true });
		copyFileSync(source, join(set, "source", `${name}.png`));
		for (const ext of ["txt", "json"]) {
			const side = join(set, "incoming", `${name}.${ext}`);
			if (existsSync(side)) renameSync(side, join(set, "source", `${name}.${ext}`));
		}
		if (!options.file) rmSync(source);
		if (entries(planned, section)[key]) {
			deleteEntry(planned, section, key);
			writeJson(join(set, "planned.json"), planned);
		}

		console.log(`${name}: ${file}, ${W} × ${H}, details from ${from}`);
		if (finished.face) console.log(`  face ${finished.face.join(", ")}, mouth ${finished.mouth.join(", ")}`);
		if (finished.window) console.log(`  window ${finished.window.join(", ")}`);
		for (const p of place.problems) console.log(`  look: ${p}`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * Record where each named pose's drawn figure lies (`figure`, from the finished image's opaque pixels) in a set's
 * manifest, for poses ingested before ingest wrote it. Changes nothing else, `added` included.
 */
function measureFigures(set, names) {
	const manifestPath = join(set, "manifest.json");
	const manifest = readJson(manifestPath, null);
	if (!manifest) throw new Error(`${manifestPath}: no manifest`);
	const r = (n) => Math.round(n * 1000) / 1000;
	for (const name of names) {
		const entry = manifest.poses?.[name];
		if (!entry) throw new Error(`${name}: no such pose in ${manifestPath}`);
		const file = join(set, entry.file);
		const whole = size(file);
		const box = alphaBox(file);
		if (!box) throw new Error(`${name}: ${entry.file} is entirely see-through`);
		entry.figure = [r(box.x / whole.w), r(box.y / whole.h), r(box.w / whole.w), r(box.h / whole.h)];
		console.log(`${name}: figure ${entry.figure.join(", ")}`);
	}
	parseManifest(manifest);
	writeJson(manifestPath, manifest);
}

function status(set) {
	const manifest = readJson(join(set, "manifest.json"), {});
	const planned = readJson(join(set, "planned.json"), {});
	for (const section of SECTIONS) {
		const done = Object.keys(entries(manifest, section));
		const todo = Object.keys(entries(planned, section));
		if (done.length + todo.length === 0) continue;
		console.log(`${section}: ${done.length} finished, ${todo.length} planned`);
		if (todo.length > 0) console.log(`  to make: ${todo.map((k) => (section === "chibi" ? `chibi-${k}` : k)).join(", ")}`);
	}
	const incoming = join(set, "incoming");
	if (existsSync(incoming)) {
		const waiting = execFileSync("ls", [incoming], { encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".png"));
		console.log(`incoming: ${waiting.length === 0 ? "empty" : waiting.join(", ")}`);
	}
}

/** Panel art areas for the contact sheet, one per framing, as the strip would size them. */
const AREAS = { "close-up": [330, 150], head: [330, 210], bust: [330, 300], waist: [330, 400], full: [330, 700] };

function sheet(set, name, outPath) {
	const manifest = readJson(join(set, "manifest.json"), {});
	const out = outPath ?? join(set, "sheets", `${name}.png`);
	mkdirSync(join(out, ".."), { recursive: true });
	const pose = readPoses(manifest, `${set}/`).find((p) => p.id === name);
	const tiles = [];
	if (pose) {
		const path = join(set, manifest.poses[name].file);
		const S = 600 / pose.height;
		const f = pose.face;
		tiles.push([
			"(", path, "-resize", `x600`, "-background", "#f4efe6", "-flatten",
			"-fill", "none", "-stroke", "#d33", "-strokewidth", "3",
			"-draw", `rectangle ${f.x * pose.width * S},${f.y * 600} ${(f.x + f.w) * pose.width * S},${(f.y + f.h) * 600}`,
			"-fill", "#d33", "-draw", `circle ${pose.mouth.x * pose.width * S},${pose.mouth.y * 600} ${pose.mouth.x * pose.width * S + 5},${pose.mouth.y * 600}`,
			// Its gestures: the primary in green, others in amber.
			...pose.gestures.flatMap((g, i) => ["-fill", "none", "-stroke", i === 0 ? "#2a9d4b" : "#d99a1e", "-strokewidth", "3", "-draw", `rectangle ${g.box.x * pose.width * S},${g.box.y * 600} ${(g.box.x + g.box.w) * pose.width * S},${(g.box.y + g.box.h) * 600}`]),
			")",
		]);
		for (const framing of FRAMINGS.filter((fr) => pose.framings.includes(fr))) {
			const [w, h] = AREAS[framing];
			const r = frame(pose, { x: 0, y: 0, w, h }, "right", w * 0.25, framing, false).image;
			tiles.push([
				"(", "-size", `${w}x${h}`, "xc:#f4efe6",
				"(", path, "-resize", `${Math.round(r.w)}x${Math.round(r.h)}!`, ")",
				"-geometry", `${offset(r.x)}${offset(r.y)}`, "-composite",
				"-font", FONT, "-fill", "#333", "-pointsize", "16", "-gravity", "southwest", "-annotate", "+6+4", framing, "-gravity", "northwest",
				"-bordercolor", "#333", "-border", "2", ")",
			]);
		}
	} else {
		let found = null;
		for (const section of SECTIONS) {
			const e = entries(manifest, section)[keyFor(section, name)];
			if (e) found = { section, entry: e };
		}
		if (!found) throw new Error(`${name}: not in ${set}/manifest.json`);
		const path = join(set, found.entry.file);
		const draw = [];
		if (found.section === "rooms") {
			const [W, H] = found.entry.size;
			const s = 900 / W;
			const win = found.entry.window;
			draw.push("-fill", "none", "-stroke", "#d33", "-strokewidth", "3", "-draw", `rectangle ${win[0] * W * s},${win[1] * H * s} ${(win[0] + win[2]) * W * s},${(win[1] + win[3]) * H * s}`);
			for (const [spot, points] of Object.entries(found.entry.spots ?? {}))
				for (const [x, y] of points) draw.push("-fill", "#2a6", "-stroke", "none", "-draw", `circle ${x * W * s},${y * H * s} ${x * W * s + 7},${y * H * s}`, "-fill", "#2a6", "-pointsize", "16", "-annotate", `+${x * W * s + 10}+${y * H * s - 6}`, spot);
		}
		// See-through parts show as a checkerboard, so a missing or ragged cut-out shows.
		const room = found.section === "rooms";
		tiles.push(["(", "-size", room ? "900x562" : "600x600", "pattern:checkerboard", "(", path, "-resize", room ? "900x562!" : "600x600>", ")", "-gravity", room ? "northwest" : "center", "-composite", "-gravity", "northwest", ...draw, ")"]);
	}
	magick(...tiles.flat(), "-background", "#ffffff", "-gravity", "north", "+append", "-gravity", "northwest", out);
	console.log(out);
}

function main(argv) {
	if (argv[0] === "run") return runCommand(argv.slice(1));
	if (argv[0] === "colours" && argv[1] && argv[2]) return applyColours(argv[1], argv[2], { check: argv.includes("--check") });
	const [command, set, name, ...rest] = argv;
	const options = {};
	const positional = [];
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--file") options.file = rest[++i];
		else if (arg === "--face") options.face = parseNumbers(rest[++i], 4);
		else if (arg === "--mouth") options.mouth = parseNumbers(rest[++i], 2);
		else if (arg === "--gesture") {
			const [gname, ...parts] = String(rest[++i]).split(",");
			if (!gname || parts.length !== 4) throw new Error("--gesture takes NAME,X,Y,W,H in source pixels");
			(options.gestures ??= []).push({ name: gname, box: parseNumbers(parts.join(","), 4) });
		} else if (arg === "--max-width") options.maxWidth = Number(rest[++i]);
		else if (arg === "--portrait") options.portrait = true;
		else if (arg === "--keep-entry") options.keepEntry = true;
		else if (arg === "--key") options.key = rest[++i];
		else if (arg === "--fuzz") options.fuzz = Number(rest[++i]);
		else positional.push(arg);
	}
	if (command === "status" && set) return status(set);
	if (command === "ingest" && set && name) return ingest(set, name, options);
	if (command === "sheet" && set && name) return sheet(set, name, positional[0]);
	if (command === "figure" && set && name) return measureFigures(set, [name, ...positional]);
	console.error("usage: june-art status SET | ingest SET NAME [--file PATH] [--face X,Y,W,H] [--mouth X,Y] [--gesture NAME,X,Y,W,H]... [--max-width PX] [--portrait] [--keep-entry] [--key COLOUR] [--fuzz PERCENT] | colours SET PLAN [--check] | sheet SET NAME [OUT] | figure SET NAME...");
	process.exit(2);
}

Promise.resolve()
	.then(() => main(process.argv.slice(2)))
	.catch((error) => {
		console.error(`june-art: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	});
