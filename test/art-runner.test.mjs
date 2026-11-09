// The art runner against a stand-in for ComfyUI's HTTP API, whose answers follow what a real job recorded.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertRunLocation, client, comparePixels, contactSheet, driftOf, edgeContact, initRun, listPipelines, loadPipeline, raiseRun, readLedger, readRun, refusal, renderPipeline, renderTemplate, resumeRun, seedsOf, stopRun, submit, uploadFile, validateGraph } from "../art/runner.mjs";

const SCHEMAS = {
	KSampler: { input: { required: { seed: ["INT", {}], model: ["MODEL", {}], sampler_name: [["er_sde", "euler"], {}] } }, output: ["LATENT"] },
	Checkpoint: { input: { required: { name: [["a.safetensors"], {}] } }, output: ["MODEL"] },
	LoadImage: { input: { required: { image: [["top-level.png"], { image_upload: true }] } }, output: ["IMAGE", "MASK"] },
	SaveImage: { input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", {}] }, hidden: { prompt: "PROMPT" } }, output: [] },
	ImageCompositeMasked: { input: { required: { destination: ["IMAGE", {}], source: ["IMAGE", {}] }, optional: { mask: ["MASK", {}] } }, output: ["IMAGE"] },
};

const imageOnly = { 1: { class_type: "LoadImage", inputs: { image: "june-art/x/in.png" } }, 2: { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } } };
const sampled = (seed) => ({ 1: { class_type: "Checkpoint", inputs: { name: "a.safetensors" } }, 2: { class_type: "KSampler", inputs: { seed, model: ["1", 0], sampler_name: "er_sde" } }, 3: { class_type: "LoadImage", inputs: { image: "in.png" } }, 4: { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "x" } } });

/** A ComfyUI that finishes a job after `delay` polls, and records what it was asked. */
async function comfy(t, overrides = {}) {
	const state = { posted: [], busy: false, reject: false, status: "success", neverFinishes: false, polls: 0, delay: 1, uploads: [], ...overrides };
	const server = createServer((req, res) => {
		const send = (code, body, type = "application/json") => {
			res.writeHead(code, { "Content-Type": type });
			res.end(type === "application/json" ? JSON.stringify(body) : body);
		};
		const url = new URL(req.url, "http://x");
		if (req.method === "GET" && url.pathname === "/object_info") return send(200, SCHEMAS);
		if (req.method === "GET" && url.pathname === "/queue") return send(200, { queue_running: state.busy ? [[1]] : [], queue_pending: [] });
		if (req.method === "GET" && url.pathname.startsWith("/history/")) {
			state.polls++;
			if (state.neverFinishes || state.polls <= state.delay) return send(200, {});
			const id = url.pathname.slice("/history/".length);
			return send(200, { [id]: { status: { status_str: state.status, completed: state.status === "success", messages: [["execution_start", {}]] }, outputs: { 4: { images: [{ filename: "out_00001_.png", subfolder: "june-art/r", type: "output" }] } } } });
		}
		if (req.method === "GET" && url.pathname === "/view") return send(200, Buffer.from(`pixels of ${url.searchParams.get("filename")}`), "image/png");
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			if (url.pathname === "/prompt") {
				state.posted.push(JSON.parse(body));
				return state.reject ? send(400, { error: { type: "prompt_outputs_failed_validation" }, node_errors: { 2: { errors: ["bad"] } } }) : send(200, { prompt_id: `id-${state.posted.length}`, number: state.posted.length, node_errors: {} });
			}
			if (url.pathname === "/upload/image") {
				state.uploads.push(body.toString("latin1"));
				return send(200, { name: "uploaded.png", subfolder: "june-art/r", type: "input" });
			}
			send(404, {});
		});
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => server.close());
	return { state, api: client(`http://127.0.0.1:${server.address().port}`) };
}

function newRun(t, options = {}) {
	const parent = mkdtempSync(join(tmpdir(), "june-art-run-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const dir = join(parent, "r");
	initRun(dir, { budget: 2, ...options });
	return dir;
}

const fast = (api) => ({ api, pollMs: 1 });

test("a graph is checked against the server's nodes before anything runs", () => {
	assert.deepEqual(validateGraph(sampled(1), SCHEMAS), []);
	assert.deepEqual(validateGraph(imageOnly, SCHEMAS), [], "an uploaded picture's path is not in the server's list, and need not be");
	const problems = (graph) => validateGraph(graph, SCHEMAS).join("\n");
	assert.match(problems({ 1: { class_type: "Nope", inputs: {} } }), /no such node/);
	assert.match(problems({ 1: { class_type: "SaveImage", inputs: { filename_prefix: "x" } } }), /missing required input images/);
	assert.match(problems({ 1: { class_type: "Checkpoint", inputs: { name: "a.safetensors", extra: 1 } } }), /no input extra/);
	assert.match(problems({ 1: { class_type: "Checkpoint", inputs: { name: "missing.safetensors" } } }), /no choice "missing.safetensors"/);
	assert.match(problems({ 2: { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "x" } } }), /missing node 9/);
	assert.match(problems({ 1: { class_type: "Checkpoint", inputs: { name: "a.safetensors" } }, 2: { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } } }), /wants IMAGE, but node 1 gives MODEL/);
	assert.match(problems({ 1: { class_type: "LoadImage", inputs: { image: "a" } }, 2: { class_type: "SaveImage", inputs: { images: ["1", 5], filename_prefix: "x" } } }), /output 5/);
});

test("a composite with no mask is refused: the wiring fault that once replaced protected art unnoticed", () => {
	const graph = { 1: { class_type: "LoadImage", inputs: { image: "a" } }, 2: { class_type: "ImageCompositeMasked", inputs: { destination: ["1", 0], source: ["1", 0] } } };
	assert.match(validateGraph(graph, SCHEMAS).join(), /no mask connected/);
	assert.deepEqual(validateGraph({ ...graph, 2: { class_type: "ImageCompositeMasked", inputs: { destination: ["1", 0], source: ["1", 0], mask: ["1", 1] } } }, SCHEMAS), []);
});

test("a template keeps a whole value's type, fills text inside strings, and names what is missing", () => {
	assert.deepEqual(renderTemplate({ a: "${seed}", b: "s-${seed}", c: ["${seed}"], d: 3 }, { seed: 7 }), { a: 7, b: "s-7", c: [7], d: 3 });
	assert.throws(() => renderTemplate({ a: "${nope}" }, {}), /needs a value for nope/);
	const pipeline = { name: "p", parameters: { seed: { type: "number" }, width: { default: 1024 }, words: {} }, template: { s: "${seed}", w: "${width}", t: "${words}", f: "${prefix}" } };
	assert.deepEqual(renderPipeline(pipeline, { seed: "5", width: "512", words: "hello" }, { prefix: "out" }), { s: 5, w: 512, t: "hello", f: "out" });
	assert.throws(() => renderPipeline(pipeline, { seed: "5" }, { prefix: "x" }), /needs --set words/);
	assert.throws(() => renderPipeline(pipeline, { seed: "5", words: "a", other: "b" }, { prefix: "x" }), /no parameter other/);
	assert.throws(() => renderPipeline(pipeline, { seed: "five", words: "a" }, { prefix: "x" }), /must be a number/);
});

test("the proven pipelines load, render completely, and record what proved them", () => {
	const names = listPipelines().map((p) => p.name);
	assert.ok(names.includes("character") && names.includes("alpha-toonout"));
	for (const { name, status, proven } of listPipelines()) if (status === "proven") assert.ok(proven, `${name}: a proven pipeline says what proved it`);
	const character = renderPipeline(loadPipeline("character"), { seed: "4002", positive: "p", negative: "n" }, { prefix: "out" });
	assert.equal(character["9"].inputs.seed, 4002);
	assert.equal(character["6"].inputs.height, 1344);
	assert.equal(character["4"].inputs.image, "june-canonical-fullbody.png");
	assert.equal(seedsOf(character)[0], 4002);
	assert.ok(!JSON.stringify(character).includes("${"), "nothing left unfilled");
	assert.ok(!JSON.stringify(renderPipeline(loadPipeline("alpha-toonout"), { image: "a.png" }, { prefix: "o" })).includes("${"));
	const repair = renderPipeline(loadPipeline("masked-repair"), { seed: "5", positive: "p", negative: "n", image: "i.png", mask: "m.png", denoise: "0.6" }, { prefix: "o" });
	assert.equal(repair["9"].inputs.denoise, 0.6);
	assert.deepEqual(repair["17"].inputs.mask, ["15", 0], "the mask stays connected");
	assert.ok(!JSON.stringify(repair).includes("${"));
	for (const example of ["example-idle-attentive", "example-tall-standing-mug", "example-tall-idle-standing"]) {
		const values = JSON.parse(readFileSync(new URL(`../art/pipelines/character/${example}.json`, import.meta.url), "utf8"));
		assert.ok(renderPipeline(loadPipeline("character"), values, { prefix: "o" })["9"].inputs.seed > 0, `${example} fills the pipeline`);
	}
});

test("a run records the job, downloads its outputs and counts it against the budget", async (t) => {
	const { state, api } = await comfy(t);
	const dir = newRun(t);
	const entry = await submit(dir, "first", sampled(11), { ...fast(api), group: "step1", pipeline: "character", main: "4" });
	assert.equal(entry.status, "success");
	assert.deepEqual(entry.seeds, [11]);
	assert.equal(entry.outputs[0].file, "node-4-0.png");
	assert.equal(readFileSync(join(dir, "first", "node-4-0.png"), "utf8"), "pixels of out_00001_.png");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "first", "graph.json"), "utf8")), sampled(11), "the exact graph is kept");
	assert.equal(state.posted[0].prompt["2"].inputs.seed, 11);
	assert.equal(readLedger(dir)[0].status, "success");
	await assert.rejects(submit(dir, "first", sampled(12), fast(api)), /already submitted/, "a label is never replayed");
});

test("generations stop at the budget and the group limit; only an approved raise continues, and it is recorded", async (t) => {
	const { state, api } = await comfy(t, { delay: 0 });
	const dir = newRun(t, { budget: 3, groupLimit: 1 });
	await submit(dir, "a", sampled(1), { ...fast(api), group: "one" });
	await assert.rejects(submit(dir, "b", sampled(2), { ...fast(api), group: "one" }), /group one has used its 1/);
	await submit(dir, "b", sampled(2), { ...fast(api), group: "two" });
	await submit(dir, "c", imageOnly, fast(api));
	await submit(dir, "d", sampled(3), fast(api));
	await assert.rejects(submit(dir, "e", sampled(4), fast(api)), /budget of 3 generations is spent/);
	await submit(dir, "f", imageOnly, fast(api));
	assert.equal(state.posted.length, 5, "a graph without a sampler costs nothing; refused jobs never reach the server");
	assert.throws(() => raiseRun(dir, { budget: 5 }), /who approved/);
	raiseRun(dir, { budget: 5, by: "Jon" });
	await submit(dir, "e", sampled(4), fast(api));
	assert.equal(readRun(dir).changes[0].by, "Jon");
});

test("a stopped run takes no generations until someone reviews it, but can still cut out what it has", async (t) => {
	const { api } = await comfy(t, { delay: 0 });
	const dir = newRun(t);
	stopRun(dir, "the seam failed");
	await assert.rejects(submit(dir, "a", sampled(1), fast(api)), /stopped: the seam failed/);
	await submit(dir, "alpha", imageOnly, fast(api));
	assert.throws(() => resumeRun(dir, ""), /who reviewed/);
	resumeRun(dir, "June");
	await submit(dir, "a", sampled(1), fast(api));
});

test("someone else's work on the shared queue, or an invalid graph, stops a job before it is spent", async (t) => {
	const { state, api } = await comfy(t, { busy: true });
	const dir = newRun(t);
	await assert.rejects(submit(dir, "a", sampled(1), fast(api)), /queue is busy/);
	state.busy = false;
	await assert.rejects(submit(dir, "a", { 1: { class_type: "Nope", inputs: {} } }, fast(api)), /no such node/);
	assert.equal(state.posted.length, 0);
	assert.deepEqual(readLedger(dir), []);
	assert.equal(existsSync(join(dir, "a")), false);
});

test("a graph the server rejects costs nothing; one that fails or hangs does", async (t) => {
	const { state, api } = await comfy(t, { reject: true });
	const dir = newRun(t, { budget: 2 });
	await assert.rejects(submit(dir, "a", sampled(1), fast(api)), /rejected a/);
	assert.equal(readLedger(dir)[0].status, "rejected");
	assert.equal(refusal(readRun(dir), readLedger(dir), { sampler: true }), null);
	state.reject = false;
	state.status = "error";
	await assert.rejects(submit(dir, "b", sampled(2), fast(api)), /ended as error/);
	state.neverFinishes = true;
	await assert.rejects(submit(dir, "c", sampled(3), { ...fast(api), timeoutMs: 20 }), /still running/);
	assert.equal(readLedger(dir)[2].status, "running");
	assert.match(refusal(readRun(dir), readLedger(dir), { sampler: true }), /budget of 2/, "an ended or hung job still spent its generation");
});

test("run evidence stays out of repositories and synced notes, and an existing run is never replaced", (t) => {
	const parent = mkdtempSync(join(tmpdir(), "june-art-where-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	mkdirSync(join(parent, "repo", ".git"), { recursive: true });
	assert.throws(() => assertRunLocation(join(parent, "repo", "deep", "run")), /inside the Git repository/);
	assert.throws(() => assertRunLocation(join(parent, "org", "work", "run"), parent), /syncs/);
	assert.doesNotThrow(() => assertRunLocation(join(parent, "state", "run"), parent));
	assert.throws(() => initRun(join(parent, "state", "r"), {}), /needs --budget/);
	initRun(join(parent, "state", "r"), { budget: 1 });
	assert.throws(() => initRun(join(parent, "state", "r"), { budget: 9 }), /already a run/);
});

test("a run reports any watched file that changed, was added or was removed", (t) => {
	const parent = mkdtempSync(join(tmpdir(), "june-art-watch-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const art = join(parent, "art");
	mkdirSync(join(art, "poses"), { recursive: true });
	writeFileSync(join(art, "manifest.json"), "{}");
	writeFileSync(join(art, "poses", "a.webp"), "a");
	writeFileSync(join(art, "poses", "b.webp"), "b");
	const dir = join(parent, "r");
	initRun(dir, { budget: 1, watch: [art] });
	assert.deepEqual(driftOf(readRun(dir)), []);
	writeFileSync(join(art, "poses", "a.webp"), "changed");
	rmSync(join(art, "poses", "b.webp"));
	writeFileSync(join(art, "new.webp"), "c");
	const changed = driftOf(readRun(dir)).join("\n");
	assert.match(changed, /a\.webp: changed/);
	assert.match(changed, /b\.webp: removed/);
	assert.match(changed, /new\.webp: added/);
});

test("an upload is named by its content, inside the run's folder", async (t) => {
	const { state, api } = await comfy(t);
	const dir = newRun(t);
	const file = join(dir, "..", "picture.png");
	writeFileSync(file, "bytes");
	assert.equal(await uploadFile(dir, file, api), "june-art/r/uploaded.png");
	assert.match(state.uploads[0], /picture-[0-9a-f]{12}\.png/);
	assert.match(state.uploads[0], /name="subfolder"\r\n\r\njune-art\/r/);
});

test("a cut-out touching the top or a side is not clear; a boot just touching the bottom is reported", (t) => {
	const parent = mkdtempSync(join(tmpdir(), "june-art-edges-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const clear = join(parent, "clear.png");
	execFileSync("magick", ["-size", "30x40", "xc:none", "-fill", "#884", "-draw", "rectangle 5,5 20,30", clear]);
	assert.deepEqual(edgeContact(clear), { width: 30, height: 40, top: 0, bottom: 0, left: 0, right: 0, clear: true });
	const cut = join(parent, "cut.png");
	execFileSync("magick", ["-size", "30x40", "xc:none", "-fill", "#884", "-draw", "rectangle 5,0 20,39", cut]);
	const edges = edgeContact(cut);
	assert.equal(edges.top, 16);
	assert.equal(edges.bottom, 16);
	assert.equal(edges.clear, false);
	const feet = join(parent, "feet.png");
	execFileSync("magick", ["-size", "30x40", "xc:none", "-fill", "#884", "-draw", "rectangle 5,5 20,39", feet]);
	assert.equal(edgeContact(feet).clear, true, "feet may meet the bottom");
});

test("pixels are compared exactly inside a region, and a contact sheet is built from jobs' outputs", async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "june-art-pixels-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const a = join(parent, "a.png");
	const b = join(parent, "b.png");
	execFileSync("magick", ["-size", "40x40", "xc:#808080", a]);
	execFileSync("magick", ["-size", "40x40", "xc:#808080", "-fill", "#818080", "-draw", "point 10,30", b]);
	assert.deepEqual(comparePixels(a, b, [0, 0, 40, 20]), { identical: true, differing_pixels: 0, region: [0, 0, 40, 20], box_x0_y0_x1_y1: null });
	const changed = comparePixels(a, b, [0, 0, 40, 40]);
	assert.equal(changed.identical, false, "one level in one channel of one pixel counts");
	assert.equal(changed.differing_pixels, 1);
	assert.deepEqual(changed.box_x0_y0_x1_y1, [10, 30, 10, 30]);
	assert.throws(() => comparePixels(a, b, [30, 30, 40, 40]), /not inside both/);

	const { api } = await comfy(t, { delay: 0 });
	const dir = newRun(t);
	await submit(dir, "one", imageOnly, { ...fast(api), main: "4" });
	execFileSync("magick", ["-size", "64x96", "xc:#336699", join(dir, "one", "node-4-0.png")]);
	const out = join(parent, "sheet.png");
	contactSheet(dir, out, ["one"], { height: 96 });
	assert.ok(existsSync(out));
	assert.throws(() => contactSheet(dir, out, ["nope"]), /no outputs/);
});
