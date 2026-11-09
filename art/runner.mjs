// june-art run: drive ComfyUI for art jobs, so an agent starts from tested tooling rather than writing it again. A run is
// a directory outside the repository holding what a job did: its budget, every submitted graph, every output with its
// hash, and the state of anything it promised not to touch. A pipeline (art/pipelines/NAME/) is a versioned graph with
// named parameters. Standard library only; magick is needed for pixel checks and contact sheets.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PIPELINES = join(dirname(fileURLToPath(import.meta.url)), "pipelines");
const DEFAULT_URL = "http://127.0.0.1:8188";
const STATUSES = ["proven", "experimental", "failed"];
const SAMPLERS = ["KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"];
const LABEL = /^[a-z0-9][a-z0-9._-]*$/;
/** The font contact sheets are lettered in: magick has no default, and fails without one. The package names a file. */
export const FONT = process.env.JUNE_ART_FONT || "DejaVu-Sans";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Write JSON so a crash leaves the old file or the new one, never half of either. */
function writeJson(path, data) {
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
	renameSync(temporary, path);
}

const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (path) => hashBytes(readFileSync(path));

/** A file's hash, or a directory's as one hash per file, so a later check can say what changed. */
function fingerprint(path) {
	if (!statSync(path).isDirectory()) return { [basename(path)]: hashFile(path) };
	const out = {};
	const walk = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else out[relative(path, full)] = hashFile(full);
		}
	};
	walk(path);
	return out;
}

/** Run evidence stays out of Git, and out of ~/org, which syncs between hosts. */
export function assertRunLocation(dir, home = homedir()) {
	const path = resolve(dir);
	const org = join(home, "org");
	if (path === org || path.startsWith(`${org}/`)) throw new Error(`${path}: run evidence does not belong in ~/org, which syncs; use ~/.local/state/org-work/...`);
	for (let at = path; ; at = dirname(at)) {
		if (existsSync(join(at, ".git"))) throw new Error(`${path}: inside the Git repository at ${at}; run evidence stays out of repositories`);
		if (at === parse(at).root) return;
	}
}

// Graphs

const isLink = (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);

/** The nodes of a graph that sample, each costing a generation against the run's budget. */
export const samplers = (graph) => Object.values(graph).filter((node) => SAMPLERS.includes(node.class_type));

/** Every seed the graph's samplers use. */
export const seedsOf = (graph) => samplers(graph).flatMap((node) => [node.inputs.seed, node.inputs.noise_seed].filter((seed) => seed !== undefined));

/** An input's declared choices, in either form ComfyUI reports them; null for an input that is not a choice. */
function choices(spec) {
	if (Array.isArray(spec[0])) return spec[0];
	if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) return spec[1].options;
	return null;
}

/**
 * What is wrong with an API-format graph, against the server's /object_info: unknown nodes, missing or unknown inputs,
 * links to nothing or of the wrong type, and choices the server does not have. An image input is exempt from its list,
 * which leaves out uploaded subfolders; ComfyUI checks the file itself.
 */
export function validateGraph(graph, schemas) {
	const problems = [];
	for (const [id, node] of Object.entries(graph)) {
		const at = `node ${id} (${node.class_type})`;
		const schema = schemas[node.class_type];
		if (!schema) {
			problems.push(`${at}: the server has no such node`);
			continue;
		}
		const required = schema.input?.required ?? {};
		const optional = schema.input?.optional ?? {};
		const hidden = schema.input?.hidden ?? {};
		for (const name of Object.keys(required)) if (!(name in node.inputs)) problems.push(`${at}: missing required input ${name}`);
		// An optional mask left unconnected composites the whole image, silently losing what the mask was to protect.
		if (node.class_type === "ImageCompositeMasked" && !node.inputs.mask) problems.push(`${at}: no mask connected, so it would replace the whole image`);
		for (const [name, value] of Object.entries(node.inputs)) {
			const spec = required[name] ?? optional[name];
			if (!spec) {
				if (!(name in hidden)) problems.push(`${at}: the server has no input ${name}`);
				continue;
			}
			if (isLink(value)) {
				const source = graph[value[0]];
				if (!source) {
					problems.push(`${at}: ${name} links to missing node ${value[0]}`);
					continue;
				}
				const outputs = schemas[source.class_type]?.output;
				if (!outputs) continue;
				if (value[1] >= outputs.length) problems.push(`${at}: ${name} links to output ${value[1]} of node ${value[0]}, which has ${outputs.length}`);
				else {
					const want = choices(spec) ? "COMBO" : spec[0];
					const have = outputs[value[1]];
					if (want !== have && want !== "*" && have !== "*") problems.push(`${at}: ${name} wants ${want}, but node ${value[0]} gives ${have}`);
				}
				continue;
			}
			const options = choices(spec);
			if (options && !spec[1]?.image_upload && !options.includes(value)) problems.push(`${at}: ${name} has no choice ${JSON.stringify(value)}`);
		}
	}
	return problems;
}

/** A template with its ${name} placeholders filled: a whole-string placeholder keeps its value's type. */
export function renderTemplate(template, params) {
	const fill = (value) => {
		if (Array.isArray(value)) return value.map(fill);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
		if (typeof value !== "string") return value;
		const name = (key) => {
			if (!(key in params)) throw new Error(`the template needs a value for ${key}`);
			return params[key];
		};
		const whole = /^\$\{(\w+)\}$/.exec(value);
		if (whole) return name(whole[1]);
		return value.replace(/\$\{(\w+)\}/g, (_, key) => String(name(key)));
	};
	return fill(template);
}

/** A pipeline by name: its description and graph. */
export function loadPipeline(name, root = PIPELINES) {
	const dir = join(root, name);
	if (!LABEL.test(name) || !existsSync(join(dir, "pipeline.json"))) throw new Error(`${name}: no such pipeline; known: ${listPipelines(root).map((p) => p.name).join(", ")}`);
	const pipeline = readJson(join(dir, "pipeline.json"));
	if (!STATUSES.includes(pipeline.status)) throw new Error(`${name}: status must be one of ${STATUSES.join(", ")}`);
	return { ...pipeline, name, dir, template: readJson(join(dir, pipeline.graph ?? "graph.json")) };
}

export function listPipelines(root = PIPELINES) {
	if (!existsSync(root)) return [];
	return readdirSync(root).filter((name) => existsSync(join(root, name, "pipeline.json"))).sort().map((name) => ({ name, ...readJson(join(root, name, "pipeline.json")) }));
}

/** A pipeline's graph for these values: defaults filled in, and unknown or missing names refused. */
export function renderPipeline(pipeline, values, builtin = {}) {
	const declared = pipeline.parameters ?? {};
	for (const name of Object.keys(values)) if (!(name in declared)) throw new Error(`${pipeline.name} has no parameter ${name}; it takes ${Object.keys(declared).join(", ")}`);
	const params = { ...builtin };
	for (const [name, spec] of Object.entries(declared)) {
		if (name in values) params[name] = typeof spec.default === "number" || spec.type === "number" ? Number(values[name]) : values[name];
		else if ("default" in spec) params[name] = spec.default;
		else throw new Error(`${pipeline.name} needs --set ${name}=...`);
		if (typeof params[name] === "number" && !Number.isFinite(params[name])) throw new Error(`${name} must be a number`);
	}
	return renderTemplate(pipeline.template, params);
}

// The server

export function client(url = DEFAULT_URL) {
	const check = async (response, what) => {
		if (!response.ok) throw new Error(`${what}: ${response.status} ${(await response.text()).slice(0, 2000)}`);
		return response;
	};
	const get = async (route) => (await check(await fetch(url + route), route)).json();
	return {
		get,
		schemas: () => get("/object_info"),
		queue: () => get("/queue"),
		history: async (id) => (await get(`/history/${id}`))[id] ?? null,
		/** Post a graph: the server's answer, including a rejection, which comes with node_errors and a 400. */
		async prompt(graph, clientId) {
			const response = await fetch(`${url}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph, client_id: clientId }) });
			const text = await response.text();
			try {
				return { ok: response.ok, ...JSON.parse(text) };
			} catch {
				return { ok: false, error: text.slice(0, 2000) };
			}
		},
		async view({ filename, subfolder, type }) {
			const query = new URLSearchParams({ filename, subfolder: subfolder ?? "", type: type ?? "output" });
			return Buffer.from(await (await check(await fetch(`${url}/view?${query}`), `/view ${filename}`)).arrayBuffer());
		},
		async upload(bytes, name, subfolder) {
			const form = new FormData();
			form.append("image", new Blob([bytes]), name);
			form.append("subfolder", subfolder);
			form.append("overwrite", "true");
			return (await check(await fetch(`${url}/upload/image`, { method: "POST", body: form }), "/upload/image")).json();
		},
	};
}

// Runs

const runFile = (dir) => join(dir, "run.json");
const ledgerFile = (dir) => join(dir, "ledger.json");

export function readRun(dir) {
	if (!existsSync(runFile(dir))) throw new Error(`${dir}: not a run; start one with june-art run init`);
	return readJson(runFile(dir));
}

export const readLedger = (dir) => readJson(ledgerFile(dir));

/** Start a run with its limits, recording what must not change while it works. An existing run is never replaced. */
export function initRun(dir, { budget, groupLimit = null, watch = [], url = DEFAULT_URL }) {
	assertRunLocation(dir);
	if (existsSync(runFile(dir))) throw new Error(`${dir}: already a run`);
	if (!Number.isInteger(budget) || budget < 0) throw new Error("a run needs --budget N, how many generations it may spend");
	mkdirSync(dir, { recursive: true });
	const baseline = {};
	for (const path of watch) baseline[resolve(path)] = fingerprint(path);
	writeJson(runFile(dir), { url, budget, groupLimit, created: new Date().toISOString(), baseline, stopped: null, changes: [] });
	writeJson(ledgerFile(dir), []);
}

/** What has changed in the watched paths since the run began. */
export function driftOf(run) {
	const changed = [];
	for (const [path, before] of Object.entries(run.baseline ?? {})) {
		if (!existsSync(path)) {
			changed.push(`${path}: gone`);
			continue;
		}
		const now = fingerprint(path);
		for (const name of new Set([...Object.keys(before), ...Object.keys(now)])) if (before[name] !== now[name]) changed.push(`${join(path, name)}: ${!(name in before) ? "added" : !(name in now) ? "removed" : "changed"}`);
	}
	return changed;
}

/** Generations spent: anything the server accepted or might have, but not a graph it refused to run. */
const spent = (ledger, group) => ledger.filter((e) => e.sampler && e.status !== "rejected" && (group === undefined || e.group === group)).length;

/** Why this generation may not be spent, or null. */
export function refusal(run, ledger, { sampler, group }) {
	if (!sampler) return null;
	if (run.stopped) return `the run is stopped: ${run.stopped.reason}. Resuming needs review: june-art run resume RUN --by WHO`;
	if (spent(ledger) >= run.budget) return `the budget of ${run.budget} generations is spent. Raising it needs approval: june-art run raise RUN --budget N --by WHO`;
	if (group && run.groupLimit !== null && spent(ledger, group) >= run.groupLimit) return `group ${group} has used its ${run.groupLimit} generations. Raising it needs approval: june-art run raise RUN --group-limit N --by WHO`;
	return null;
}

/** Change a run's limits or stop it, keeping who did and why with the run. */
function changeRun(dir, change, note) {
	const run = readRun(dir);
	Object.assign(run, change);
	run.changes.push({ at: new Date().toISOString(), ...note });
	writeJson(runFile(dir), run);
}

export const stopRun = (dir, reason) => changeRun(dir, { stopped: { reason, at: new Date().toISOString() } }, { stopped: reason });
export function resumeRun(dir, by) {
	if (!by) throw new Error("say who reviewed it: --by WHO");
	changeRun(dir, { stopped: null }, { resumed: true, by });
}
export function raiseRun(dir, { budget, groupLimit, by }) {
	if (!by) throw new Error("say who approved it: --by WHO");
	const change = {};
	if (budget !== undefined) change.budget = budget;
	if (groupLimit !== undefined) change.groupLimit = groupLimit;
	if (Object.keys(change).length === 0) throw new Error("give --budget N or --group-limit N");
	changeRun(dir, change, { raised: change, by });
}

/** Upload a picture for a run's graphs, named by its content so a name always means one picture. Returns the name to use. */
export async function uploadFile(dir, path, api = client(readRun(dir).url)) {
	const bytes = readFileSync(path);
	const name = `${parse(path).name}-${hashBytes(bytes).slice(0, 12)}${extname(path)}`;
	const result = await api.upload(bytes, name, `june-art/${basename(resolve(dir))}`);
	return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Submit one graph and wait for it. Refused before anything runs when the label was used, the budget or group is
 * spent, the run is stopped, the shared queue is busy, or the graph is invalid. The ledger records the attempt before
 * it is posted, so a crash still counts it. Outputs land in RUN/LABEL/ with their hashes.
 */
export async function submit(dir, label, graph, { group, pipeline, main, api = client(readRun(dir).url), timeoutMs = 900_000, pollMs = 2000 } = {}) {
	if (!LABEL.test(label)) throw new Error(`${label}: labels are lowercase letters, digits, dots, hyphens and underscores`);
	const run = readRun(dir);
	const ledger = readLedger(dir);
	if (ledger.some((e) => e.label === label) || existsSync(join(dir, label))) throw new Error(`${label}: already submitted in this run; use a new label`);
	const sampler = samplers(graph).length > 0;
	const refused = refusal(run, ledger, { sampler, group });
	if (refused) throw new Error(refused);
	const queue = await api.queue();
	if (queue.queue_running?.length || queue.queue_pending?.length) throw new Error("ComfyUI's queue is busy with someone else's work; wait for it");
	const problems = validateGraph(graph, await api.schemas());
	if (problems.length > 0) throw new Error(`the graph is invalid:\n  ${problems.join("\n  ")}`);

	const job = join(dir, label);
	mkdirSync(job);
	writeJson(join(job, "graph.json"), graph);
	const entry = { label, sampler, group: group ?? null, pipeline: pipeline ?? null, seeds: seedsOf(graph), graph_sha256: hashBytes(JSON.stringify(graph)), submitted_at: new Date().toISOString(), status: "submitting" };
	ledger.push(entry);
	const save = () => writeJson(ledgerFile(dir), ledger);
	save();

	const started = Date.now();
	const answer = await api.prompt(graph, `june-art-${label}`);
	writeJson(join(job, "response.json"), answer);
	if (!answer.ok || !answer.prompt_id) {
		entry.status = "rejected";
		entry.error = answer.node_errors && Object.keys(answer.node_errors).length ? answer.node_errors : answer.error ?? "no prompt id";
		save();
		throw new Error(`ComfyUI rejected ${label}: ${JSON.stringify(entry.error).slice(0, 2000)}`);
	}
	entry.prompt_id = answer.prompt_id;
	entry.status = "running";
	save();

	while (Date.now() - started < timeoutMs) {
		const history = await api.history(answer.prompt_id);
		if (history) {
			writeJson(join(job, "history.json"), history);
			entry.wall_seconds = Math.round((Date.now() - started) / 100) / 10;
			entry.status = history.status?.status_str ?? "unknown";
			if (entry.status !== "success" || !history.status?.completed) {
				save();
				throw new Error(`${label} ended as ${entry.status}: ${JSON.stringify(history.status?.messages ?? []).slice(-2000)}`);
			}
			entry.outputs = [];
			for (const [node, output] of Object.entries(history.outputs ?? {})) {
				const files = Object.values(output).flat().filter((f) => f && typeof f.filename === "string");
				for (const [i, file] of files.entries()) {
					const name = `node-${node}-${i}${extname(file.filename)}`;
					const bytes = await api.view(file);
					writeFileSync(join(job, name), bytes);
					entry.outputs.push({ node, file: name, sha256: hashBytes(bytes), native: file });
				}
			}
			if (main) entry.main = main;
			save();
			return entry;
		}
		await sleep(pollMs);
	}
	throw new Error(`${label} is still running after ${timeoutMs / 1000} s; it stays in the ledger as spent. Check ComfyUI before submitting more`);
}

// Pictures

const magick = (args) => execFileSync("magick", args, { maxBuffer: 2 ** 31 - 1, stdio: ["ignore", "pipe", "pipe"] });

/** Compare two images' pixels inside a region, exactly: the proof that protected art was not touched. */
export function comparePixels(a, b, [x, y, w, h]) {
	const raw = (path) => magick([path, "-crop", `${w}x${h}+${x}+${y}`, "+repage", "-depth", "8", "RGB:-"]);
	const one = raw(a);
	const two = raw(b);
	if (one.length !== w * h * 3 || two.length !== w * h * 3) throw new Error(`the region ${w}x${h}+${x}+${y} is not inside both images`);
	let differing = 0;
	let box = null;
	for (let i = 0; i < w * h; i++) {
		if (one[3 * i] === two[3 * i] && one[3 * i + 1] === two[3 * i + 1] && one[3 * i + 2] === two[3 * i + 2]) continue;
		differing++;
		const px = i % w;
		const py = Math.floor(i / w);
		box = box ? [Math.min(box[0], px), Math.min(box[1], py), Math.max(box[2], px), Math.max(box[3], py)] : [px, py, px, py];
	}
	return { identical: differing === 0, differing_pixels: differing, region: [x, y, w, h], box_x0_y0_x1_y1: box && [box[0] + x, box[1] + y, box[2] + x, box[3] + y] };
}

function rgbToHsv(r, g, b) {
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	let h = 0;
	if (d > 0) {
		if (max === r) h = ((g - b) / d + 6) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
	}
	return [h * 60, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h, s, v) {
	const c = v * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = v - c;
	const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
	return [r + m, g + m, b + m].map((n) => Math.round(n * 255));
}

function boundingBox(points) {
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	const [x0, y0] = [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys))];
	return [x0, y0, Math.ceil(Math.max(...xs)) - x0, Math.ceil(Math.max(...ys)) - y0];
}

/** Whether a point is inside a polygon, by counting edge crossings. */
function inPolygon(points, x, y) {
	let within = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const [xi, yi] = points[i];
		const [xj, yj] = points[j];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) within = !within;
	}
	return within;
}

const hsvToHex = ({ h, s, v }) => `#${hsvToRgb(h, s, v).map((n) => n.toString(16).padStart(2, "0")).join("")}`;
const signedHue = (d) => ((d + 540) % 360) - 180;

function hexToHsv(hex) {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) throw new Error(`${hex}: a colour is #RRGGBB`);
	return rgbToHsv(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

/** The middle hue, saturation and value of some pixels, hue taken around the circle. */
function typicalColour(pixels) {
	const x = pixels.reduce((n, p) => n + Math.cos((p.h * Math.PI) / 180), 0);
	const y = pixels.reduce((n, p) => n + Math.sin((p.h * Math.PI) / 180), 0);
	return { h: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, s: median(pixels.map((p) => p.s)), v: median(pixels.map((p) => p.v)) };
}

/**
 * Recolour the pixels inside a region that match a hue, saturation and value range, keeping each pixel's value so the
 * drawing's shading survives. Nothing else changes, and alpha never does: a colour fix cannot alter a drawn shape.
 */
export function recolor(input, output, { region, polygon, mask: maskFile, exclude = [], hue = [0, 360], sat = [0, 1], val = [0, 1], toHue, toSat, match, keepValue = false, hueKeep = 1, strength = 1, clean = false, minArea = 0, maxHole = 0, feather = 0 }) {
	if (polygon && polygon.length < 3) throw new Error("a polygon needs at least 3 points");
	if (resolve(input) === resolve(output)) throw new Error("recolor writes a new file; give a different output");
	if (!match && (!Number.isFinite(toHue) || !Number.isFinite(toSat))) throw new Error("recolor needs --match HEX, or --to-hue and --to-sat");
	const [width, height] = magick([input, "-format", "%w %h", "info:"]).toString().trim().split(" ").map(Number);
	const guide = maskFile ? magick([maskFile, "-alpha", "off", "-resize", `${width}x${height}!`, "-colorspace", "Gray", "-depth", "8", "GRAY:-"]) : null;
	const inside = guide ? (x, y) => guide[y * width + x] > 127 : polygon ? (x, y) => inPolygon(polygon, x + 0.5, y + 0.5) : () => true;
	const left = (x, y) => exclude.some((shape) => inPolygon(shape, x + 0.5, y + 0.5));
	const [rx, ry, rw, rh] = guide ? [0, 0, width, height] : polygon ? boundingBox(polygon) : region;
	if (rx < 0 || ry < 0 || rw <= 0 || rh <= 0 || rx + rw > width || ry + rh > height) throw new Error(`the region is not inside the ${width}x${height} image`);
	const pixels = magick([input, "-alpha", "on", "-depth", "8", "RGBA:-"]);
	const inHue = (h) => (hue[0] <= hue[1] ? h >= hue[0] && h <= hue[1] : h >= hue[0] || h <= hue[1]);
	// `mask` is what will change; `barred` is what must not, however a clean-up would treat it.
	const mask = new Uint8Array(rw * rh);
	const barred = new Uint8Array(rw * rh);
	const colour = new Float32Array(rw * rh * 3);
	for (let y = 0; y < rh; y++) {
		for (let x = 0; x < rw; x++) {
			const at = y * rw + x;
			const i = 4 * ((y + ry) * width + x + rx);
			const [h, s, v] = rgbToHsv(pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255);
			colour.set([h, s, v], 3 * at);
			if (pixels[i + 3] === 0 || !inside(x + rx, y + ry) || left(x + rx, y + ry)) barred[at] = 1;
			else if (inHue(h) && s >= sat[0] && s <= sat[1] && v >= val[0] && v <= val[1]) mask[at] = 1;
		}
	}
	const tidied = clean ? tidyMask(mask, barred, rw, rh, minArea, maxHole) : { removed: 0, filled: 0 };
	const weights = insetWeights(mask, rw, rh, feather);
	const selected = [];
	for (let at = 0; at < mask.length; at++) if (mask[at]) selected.push({ at, h: colour[3 * at], s: colour[3 * at + 1], v: colour[3 * at + 2] });
	// Matching moves the selection's typical colour toward the target, keeping each pixel's difference from it, so folds,
	// highlights and shadows stay as drawn. With keepValue only hue and saturation move, so a dark iris stays dark.
	// hueKeep shrinks each pixel's hue difference: near-neutral cloth has a hue spread that turns to purple and olive once saturated.
	const before = typicalColour(selected);
	const target = match ? hexToHsv(match) : null;
	const bounded = (ratio) => Math.min(3, Math.max(1 / 3, ratio));
	const ratioS = target && before.s > 0 ? 1 + (bounded(target[1] / before.s) - 1) * strength : 1;
	const ratioV = target && before.v > 0 && !keepValue ? 1 + (bounded(target[2] / before.v) - 1) * strength : 1;
	const turn = target ? strength * signedHue(target[0] - before.h) : 0;
	let changed = 0;
	let box = null;
	const after = [];
	for (const { at, h, s, v } of selected) {
		const moved = target ? { h: (before.h + turn + signedHue(h - before.h) * hueKeep + 360) % 360, s: Math.min(1, s * ratioS), v: Math.min(1, v * ratioV) } : { h: toHue, s: toSat, v };
		after.push(moved);
		const x = (at % rw) + rx;
		const y = Math.floor(at / rw) + ry;
		const i = 4 * (y * width + x);
		const blend = weights ? weights[at] : 1;
		const next = hsvToRgb(moved.h, moved.s, moved.v).map((n, c) => Math.round(pixels[i + c] + (n - pixels[i + c]) * blend));
		if (next[0] === pixels[i] && next[1] === pixels[i + 1] && next[2] === pixels[i + 2]) continue;
		pixels.set(next, i);
		changed++;
		box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
	}
	execFileSync("magick", ["-size", `${width}x${height}`, "-depth", "8", "RGBA:-", `PNG32:${output}`], { input: pixels, maxBuffer: 2 ** 31 - 1, stdio: ["pipe", "pipe", "pipe"] });
	return { input, output, selected_pixels: selected.length, changed_pixels: changed, removed_specks: tidied.removed, filled_holes: tidied.filled, box_x0_y0_x1_y1: box, before: selected.length ? hsvToHex(before) : null, after: after.length ? hsvToHex(typicalColour(after)) : null };
}

/** The 4-connected parts of a grid where `member(index)` holds, as lists of indexes. */
function connectedParts(size, width, height, member) {
	const seen = new Uint8Array(size);
	const parts = [];
	for (let start = 0; start < size; start++) {
		if (seen[start] || !member(start)) continue;
		seen[start] = 1;
		const part = [start];
		for (let n = 0; n < part.length; n++) {
			const at = part[n];
			const x = at % width;
			for (const next of [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1, at >= width ? at - width : -1, at < size - width ? at + width : -1]) {
				if (next >= 0 && !seen[next] && member(next)) {
					seen[next] = 1;
					part.push(next);
				}
			}
		}
		parts.push(part);
	}
	return parts;
}

/** Drop specks too small to be the garment, and fill small holes inside it that were not deliberately left out. */
function tidyMask(mask, barred, width, height, minArea, maxHole) {
	let removed = 0;
	for (const part of connectedParts(mask.length, width, height, (at) => mask[at] === 1)) {
		if (part.length >= minArea) continue;
		for (const at of part) mask[at] = 0;
		removed += part.length;
	}
	let filled = 0;
	for (const hole of connectedParts(mask.length, width, height, (at) => mask[at] === 0)) {
		const touchesEdge = hole.some((at) => at % width === 0 || at % width === width - 1 || at < width || at >= mask.length - width);
		if (touchesEdge || hole.length > maxHole || hole.some((at) => barred[at])) continue;
		for (const at of hole) mask[at] = 1;
		filled += hole.length;
	}
	return { removed, filled };
}

/** How strongly each masked pixel changes, rising from the mask's edge over `feather` pixels, so no hard join appears. */
function insetWeights(mask, width, height, feather) {
	if (feather <= 0) return null;
	const depth = new Uint8Array(mask.length);
	for (let at = 0; at < mask.length; at++) if (mask[at]) depth[at] = 255;
	for (let pass = 1; pass <= feather; pass++) {
		const edge = [];
		for (let at = 0; at < mask.length; at++) {
			if (depth[at] !== 255) continue;
			const x = at % width;
			const open = (next) => next < 0 || next >= mask.length || depth[next] < 255;
			if (x === 0 || x === width - 1 || open(at - width) || open(at + width) || depth[at - 1] < 255 || depth[at + 1] < 255) edge.push(at);
		}
		for (const at of edge) depth[at] = pass;
	}
	const weights = new Float32Array(mask.length);
	for (let at = 0; at < mask.length; at++) weights[at] = depth[at] === 255 ? 1 : depth[at] / (feather + 1);
	return weights;
}

/** Union the `includes` masks, take away the `subtracts`, and write the result: white where it applies. */
export function combineMasks(includes, subtracts, out) {
	const [width, height] = magick([includes[0], "-format", "%w %h", "info:"]).toString().trim().split(" ").map(Number);
	const read = (file) => magick([file, "-alpha", "off", "-resize", `${width}x${height}!`, "-colorspace", "Gray", "-depth", "8", "GRAY:-"]);
	const result = Buffer.alloc(width * height);
	for (const file of includes) read(file).forEach((v, i) => { if (v > 127) result[i] = 255; });
	for (const file of subtracts) read(file).forEach((v, i) => { if (v > 127) result[i] = 0; });
	execFileSync("magick", ["-size", `${width}x${height}`, "-depth", "8", "GRAY:-", `PNG8:${out}`], { input: result, maxBuffer: 2 ** 31 - 1, stdio: ["pipe", "pipe", "pipe"] });
	return result.reduce((n, v) => n + (v ? 1 : 0), 0) / result.length;
}

/** The colour targets, by item. */
export const colourTargets = () => readJson(join(dirname(fileURLToPath(import.meta.url)), "colour-targets.json"));

/**
 * Segment each garment a colour plan needs, saving SET/colour-masks/NAME-ITEM.png. Masks already there are kept, so a
 * corrected plan or an interrupted run costs nothing again. Waits for the queue when someone else is using ComfyUI.
 */
export async function makeMasks(dir, set, planPath, { api = client(readRun(dir).url), force = false, waitMs = 15_000, pollMs = 1000 } = {}) {
	const plan = readJson(planPath);
	const targets = colourTargets();
	const pipeline = loadPipeline("segment");
	const masks = join(set, "colour-masks");
	mkdirSync(masks, { recursive: true });
	mkdirSync(join(dir, "flat"), { recursive: true });
	const report = [];
	const submitted = new Map();
	const wanted = async (name, prompt, image) => {
		const key = `${name}|${prompt}`;
		if (submitted.has(key)) return submitted.get(key);
		const stem = `${name}-${prompt.replace(/[^a-z0-9]+/gi, "-").replace(/-$/, "").toLowerCase()}`;
		const taken = readLedger(dir).filter((e) => e.label.startsWith(stem)).length;
		const label = taken ? `${stem}.${taken}` : stem;
		const graph = renderPipeline(pipeline, { image, prompt }, { prefix: `june-art/${basename(resolve(dir))}/${label}` });
		for (let tries = 0; ; tries++) {
			try {
				const entry = await submit(dir, label, graph, { pipeline: "segment", main: pipeline.main, api, pollMs });
				const file = join(dir, label, entry.outputs.find((o) => o.node === pipeline.main).file);
				submitted.set(key, file);
				return file;
			} catch (error) {
				if (!/queue is busy/.test(error.message) || tries >= 240) throw error;
				await sleep(waitMs);
			}
		}
	};
	for (const [name, steps] of Object.entries(plan.poses)) {
		for (const step of steps) {
			const merged = { ...targets[step.item], ...step };
			if (!merged.segment) continue;
			const out = join(masks, `${name}-${step.item}.png`);
			if (existsSync(out) && !force) continue;
			try {
				const source = existsSync(join(set, "colour-originals", `${name}.png`)) ? join(set, "colour-originals", `${name}.png`) : join(set, "source", `${name}.png`);
				const flat = join(dir, "flat", `${name}.png`);
				if (!existsSync(flat)) magick([source, "-background", "#ece7dd", "-flatten", "-alpha", "off", flat]);
				const image = await uploadFile(dir, flat, api);
				const includes = [];
				for (const prompt of [merged.segment].flat()) includes.push(await wanted(name, prompt, image));
				const subtracts = [];
				for (const prompt of [merged.subtract ?? []].flat()) subtracts.push(await wanted(name, prompt, image));
				const coverage = combineMasks(includes, subtracts, out);
				report.push({ pose: name, item: step.item, coverage: Math.round(coverage * 10000) / 10000 });
				console.log(`${name} ${step.item}: ${(coverage * 100).toFixed(1)}% of the image`);
			} catch (error) {
				report.push({ pose: name, item: step.item, error: error.message });
				console.error(`${name} ${step.item}: FAILED: ${error.message}`);
				process.exitCode = 1;
			}
		}
	}
	writeJson(join(set, "colour-masks.json"), report);
	return report;
}

/** How many solid pixels of a cut-out touch each edge of its image: a figure touching the top has lost its crown. */
export function edgeContact(path) {
	const [width, height] = magick([path, "-format", "%w %h", "info:"]).toString().trim().split(" ").map(Number);
	const alpha = magick([path, "-alpha", "extract", "-depth", "8", "GRAY:-"]);
	const solid = (i) => alpha[i] > 127;
	const edges = { top: 0, bottom: 0, left: 0, right: 0 };
	for (let x = 0; x < width; x++) {
		if (solid(x)) edges.top++;
		if (solid((height - 1) * width + x)) edges.bottom++;
	}
	for (let y = 0; y < height; y++) {
		if (solid(y * width)) edges.left++;
		if (solid(y * width + width - 1)) edges.right++;
	}
	return { width, height, ...edges, clear: edges.top === 0 && edges.left === 0 && edges.right === 0 };
}

/** A labelled contact sheet of jobs' main outputs, for a person to judge. */
export function contactSheet(dir, out, labels, { node, height = 720, columns = 4 } = {}) {
	const ledger = readLedger(dir);
	const tiles = labels.map((label) => {
		const entry = ledger.find((e) => e.label === label);
		if (!entry?.outputs?.length) throw new Error(`${label}: no outputs in this run`);
		const pick = node ?? entry.main;
		const output = pick === undefined ? entry.outputs[entry.outputs.length - 1] : entry.outputs.find((o) => o.node === String(pick));
		if (!output) throw new Error(`${label}: no output from node ${pick}`);
		return ["(", join(dir, label, output.file), "-resize", `x${height}`, "-background", "#f4efe6", "-flatten", "-font", FONT, "-fill", "#333", "-pointsize", "20", "-gravity", "southwest", "-annotate", "+8+6", `${label}  seed ${entry.seeds.join(",") || "none"}`, "-gravity", "northwest", "-bordercolor", "#333", "-border", "2", ")"];
	});
	const rows = [];
	for (let i = 0; i < tiles.length; i += columns) rows.push(["(", ...tiles.slice(i, i + columns).flat(), "+append", ")"]);
	mkdirSync(dirname(resolve(out)), { recursive: true });
	magick([...rows.flat(), "-background", "#f4efe6", "-append", out]);
}

/** A copy of an image with a labelled pixel grid, for reading off regions in source coordinates. */
export function gridImage(input, output, { step = 100 } = {}) {
	const [width, height] = magick([input, "-format", "%w %h", "info:"]).toString().trim().split(" ").map(Number);
	const lines = ["-background", "#f4efe6", "-flatten", "-font", FONT, "-pointsize", "16", "-fill", "none", "-stroke", "#d3333366", "-strokewidth", "1"];
	for (let x = step; x < width; x += step) lines.push("-draw", `line ${x},0 ${x},${height}`);
	for (let y = step; y < height; y += step) lines.push("-draw", `line 0,${y} ${width},${y}`);
	lines.push("-fill", "#b00020", "-stroke", "none");
	for (let x = step; x < width; x += step) lines.push("-annotate", `+${x + 2}+16`, String(x));
	for (let y = step; y < height; y += step) lines.push("-annotate", `+2+${y - 3}`, String(y));
	mkdirSync(dirname(resolve(output)), { recursive: true });
	magick([input, ...lines, output]);
}

/** Before and after a colour plan, side by side for each pose, from a set's kept originals and its current sources. */
export function compareSheet(set, out, names, { height = 720, columns = 4 } = {}) {
	const tile = (path, label) => ["(", path, "-resize", `x${height}`, "-background", "#f4efe6", "-flatten", "-font", FONT, "-fill", "#333", "-pointsize", "18", "-gravity", "southwest", "-annotate", "+6+4", label, "-gravity", "northwest", ")"];
	const pairs = names.map((name) => {
		const before = join(set, "colour-originals", `${name}.png`);
		if (!existsSync(before)) throw new Error(`${name}: no kept original in this set`);
		return ["(", ...tile(before, `${name} before`), ...tile(join(set, "source", `${name}.png`), "after"), "+append", "-bordercolor", "#333", "-border", "2", ")"];
	});
	const rows = [];
	for (let i = 0; i < pairs.length; i += columns) rows.push(["(", ...pairs.slice(i, i + columns).flat(), "+append", ")"]);
	mkdirSync(dirname(resolve(out)), { recursive: true });
	magick([...rows.flat(), "-background", "#f4efe6", "-append", out]);
}

// The command line

function parseFlags(args) {
	const flags = { set: {}, watch: [], positional: [] };
	const number = (text, name) => {
		const n = Number(text);
		if (!Number.isInteger(n) || n < 0) throw new Error(`${name} takes a whole number`);
		return n;
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = () => {
			if (i + 1 >= args.length) throw new Error(`${arg} needs a value`);
			return args[++i];
		};
		if (arg === "--set") {
			const text = next();
			const at = text.indexOf("=");
			if (at < 1) throw new Error("--set takes NAME=VALUE, or NAME=@FILE for a long value");
			const value = text.slice(at + 1);
			flags.set[text.slice(0, at)] = value.startsWith("@") ? readFileSync(value.slice(1), "utf8").trimEnd() : value;
		} else if (arg === "--watch") flags.watch.push(next());
		else if (arg === "--budget") flags.budget = number(next(), arg);
		else if (arg === "--group-limit") flags.groupLimit = number(next(), arg);
		else if (arg === "--timeout") flags.timeoutMs = number(next(), arg) * 1000;
		else if (arg === "--height") flags.height = number(next(), arg);
		else if (arg === "--step") flags.step = number(next(), arg);
		else if (arg === "--columns") flags.columns = number(next(), arg);
		else if (arg === "--url") flags.url = next();
		else if (arg === "--by") flags.by = next();
		else if (arg === "--group") flags.group = next();
		else if (arg === "--pipeline") flags.pipeline = next();
		else if (arg === "--graph") flags.graph = next();
		else if (arg === "--node") flags.node = next();
		else if (arg === "--region") flags.region = next().split(",").map(Number);
		else if (arg === "--hue") flags.hue = next().split(",").map(Number);
		else if (arg === "--sat") flags.sat = next().split(",").map(Number);
		else if (arg === "--val") flags.val = next().split(",").map(Number);
		else if (arg === "--match") flags.match = next();
		else if (arg === "--force") flags.force = true;
		else if (arg === "--polygon") flags.polygon = next().trim().split(/\s+/).map((point) => point.split(",").map(Number));
		else if (arg === "--to-hue") flags.toHue = Number(next());
		else if (arg === "--to-sat") flags.toSat = Number(next());
		else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
		else flags.positional.push(arg);
	}
	return flags;
}

export const USAGE = `usage: june-art run VERB ...
  pipelines                                   the pipelines there are, and how proven each is
  render PIPELINE [--set K=V]...              print a pipeline's graph (K=@FILE reads a long value)
  validate (PIPELINE|--graph F) [--set K=V]... check a graph against the live server, submitting nothing
  init RUN --budget N [--group-limit N] [--watch PATH]... [--url URL]
  status RUN                                  spending, each job, and anything watched that changed
  upload RUN PATH                             send a picture to ComfyUI; prints the name for a graph
  submit RUN LABEL (--pipeline P [--set K=V]... | --graph F) [--group G] [--timeout S]
  unchanged A B --region X,Y,W,H              exact pixel comparison inside a region
  edges CUTOUT...                             solid pixels touching each edge; fails if the top or a side is touched
  recolor IN OUT (--region X,Y,W,H | --polygon "X,Y X,Y ...") (--match HEX | --to-hue H --to-sat S) [--hue L,H] [--sat L,H] [--val L,H]
                                              recolour matching pixels in a region, keeping shading and alpha
  sheet RUN OUT LABEL... [--node ID] [--height PX] [--columns N]
  grid IMAGE OUT [--step N]                   a copy with a pixel grid, for reading off regions
  compare SET OUT NAME... [--height PX] [--columns N]
                                              before and after a colour plan, side by side
  masks RUN SET PLAN [--force]                segment the garments a colour plan needs, into SET/colour-masks
  stop RUN REASON | resume RUN --by WHO | raise RUN [--budget N] [--group-limit N] --by WHO`;

const print = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

/** The graph a command names, with the run's built-in values. */
function graphFor(flags, name, builtin) {
	if (flags.graph) return { graph: readJson(flags.graph) };
	const pipeline = loadPipeline(name ?? flags.pipeline);
	return { graph: renderPipeline(pipeline, flags.set, builtin), pipeline };
}

export async function runCommand(argv) {
	const [verb, ...rest] = argv;
	const flags = parseFlags(rest);
	const [first, second, ...others] = flags.positional;
	if (verb === "pipelines") return print(listPipelines().map(({ name, status, summary }) => `${name}  [${status}]  ${summary ?? ""}`).join("\n"));
	if (verb === "render" && first) return print(graphFor(flags, first, { prefix: "june-art/render" }).graph);
	if (verb === "validate" && (first || flags.graph)) {
		const { graph } = graphFor(flags, first, { prefix: "june-art/validate" });
		const problems = validateGraph(graph, await client(flags.url).schemas());
		if (problems.length > 0) throw new Error(`the graph is invalid:\n  ${problems.join("\n  ")}`);
		return print(`valid: ${Object.keys(graph).length} nodes, ${samplers(graph).length} sampler(s)`);
	}
	if (verb === "unchanged" && first && second) {
		if (flags.region?.length !== 4 || !flags.region.every(Number.isInteger)) throw new Error("unchanged needs --region X,Y,W,H");
		const result = comparePixels(first, second, flags.region);
		print(result);
		if (!result.identical) process.exitCode = 1;
		return;
	}
	if (verb === "grid" && first && second) {
		gridImage(first, second, { step: flags.step });
		return print(second);
	}
	if (verb === "compare" && first && second && others.length > 0) {
		compareSheet(first, second, others, { height: flags.height, columns: flags.columns });
		return print(second);
	}
	if (verb === "recolor" && first && second) {
		if (!flags.polygon && (flags.region?.length !== 4 || !flags.region.every(Number.isInteger))) throw new Error("recolor needs --region X,Y,W,H or --polygon \"X,Y X,Y ...\"");
		return print(recolor(first, second, flags));
	}
	if (verb === "edges" && first) {
		const results = flags.positional.map((path) => ({ path, ...edgeContact(path) }));
		print(results);
		if (results.some((r) => !r.clear)) process.exitCode = 1;
		return;
	}
	if (verb === "init" && first) {
		initRun(first, { budget: flags.budget, groupLimit: flags.groupLimit ?? null, watch: flags.watch, url: flags.url ?? DEFAULT_URL });
		return print(`started ${first}: ${flags.budget} generations`);
	}
	if (!first) {
		console.error(USAGE);
		process.exit(2);
	}
	if (verb === "status") {
		const run = readRun(first);
		const ledger = readLedger(first);
		const groups = {};
		for (const e of ledger) if (e.group && e.sampler && e.status !== "rejected") groups[e.group] = (groups[e.group] ?? 0) + 1;
		return print({ spent: spent(ledger), budget: run.budget, groupLimit: run.groupLimit, groups, stopped: run.stopped, changed_since_start: driftOf(run), jobs: ledger.map(({ label, status, seeds, group, wall_seconds }) => ({ label, status, seeds, group, wall_seconds })), changes: run.changes });
	}
	if (verb === "masks" && second && others[0]) {
		await makeMasks(first, second, others[0], { force: flags.force });
		return;
	}
	if (verb === "upload" && second) return print(await uploadFile(first, second));
	if (verb === "stop" && second) return stopRun(first, [second, ...others].join(" "));
	if (verb === "resume") return resumeRun(first, flags.by);
	if (verb === "raise") return raiseRun(first, { budget: flags.budget, groupLimit: flags.groupLimit, by: flags.by });
	if (verb === "sheet" && second && others.length > 0) {
		contactSheet(first, second, others, { node: flags.node, height: flags.height, columns: flags.columns });
		return print(second);
	}
	if (verb === "submit" && second) {
		const { graph, pipeline } = graphFor(flags, undefined, { prefix: `june-art/${basename(resolve(first))}/${second}` });
		return print(await submit(first, second, graph, { group: flags.group, pipeline: pipeline?.name, main: pipeline?.main, timeoutMs: flags.timeoutMs }));
	}
	console.error(USAGE);
	process.exit(2);
}
