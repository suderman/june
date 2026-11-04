// The overlay's logic without Qt: the view and its panels (overlay/strip.mjs) and the comic layout engine
// (overlay/compose.mjs), which its QML imports. Plain JavaScript, so tsc leaves it out.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { activity, applyView, beats, caption, emptyView, markup, panels, readInput } from "../overlay/strip.mjs";
import { ACTIVITIES, FALLBACK, aimTail, aimTrail, balloonPath, chain, cloudPath, chooseFraming, choosePose, chooseSide, jagged, liveActivity, metrics, picked, plan, readPoses, standIn, tallFor } from "../overlay/compose.mjs";
import { EXPRESSIONS, LIVE_STATES, POSE_ACTIVITIES, fallbacks } from "../src/avatar.ts";
import { PAGE, pageTarget, rest, step, wheel } from "../overlay/scroll.mjs";
import { LIVE_STATES as LIVE, RECENT_MS, excerpt, idleState, liveState, newReply, readLive, readingTime, recent } from "../overlay/live.mjs";

const user = (id, text = "hi", source = "gui") => ({ kind: "user", id, source, text });
const june = (id, text = "hello", streaming = false) => ({ kind: "assistant", id, text, streaming, answers: "gui" });
const tool = (id, name = "read", summary = "x", status = "done") => ({ kind: "tool", id, name, summary, status });
const patter = (id, text = "hmm") => ({ kind: "patter", id, text });

const manifest = JSON.parse(await readFile(new URL("../templates/avatar/manifest.json", import.meta.url), "utf8"));
const POSES = readPoses(manifest, "file:///set/");
const pose = (id) => POSES.find((p) => p.id === id);

test("a reset replaces the view and changes put, replace, and drop items in order", () => {
	let view = applyView(emptyView(), { type: "view", reset: true, items: [user("u1"), june("a1")], state: { running: true, background: 0 }, earlier: true });
	assert.deepEqual(view.items.map((i) => i.id), ["u1", "a1"]);
	assert.equal(view.earlier, true);
	view = applyView(view, { type: "view", changes: [{ op: "put", item: june("a1", "hello there", true), after: "u1" }] });
	assert.equal(view.items[1].text, "hello there");
	view = applyView(view, { type: "view", changes: [{ op: "put", item: patter("p1"), after: null }, { op: "drop", id: "u1" }] });
	assert.deepEqual(view.items.map((i) => i.id), ["p1", "a1"]);
	assert.equal(view.state.running, true, "a change without state keeps the old state");
	const same = applyView(view, { type: "accepted", requestId: "r", submissionId: 3 });
	assert.equal(same, view, "other replies leave the view alone");
});

test("a reply splits into beats: short paragraphs join the next, a list stays with its introduction, four at most", () => {
	assert.deepEqual(beats("ok."), ["ok."]);
	assert.deepEqual(beats("here's the shape of today.\n\nWork\n\n- servers\n- tabs"), ["here's the shape of today.\n\nWork\n\n- servers\n- tabs"]);
	const long = (n) => `${"word ".repeat(30)}${n}`;
	assert.deepEqual(beats(`${long(1)}\n\n${long(2)}\n\n- a\n- b`), [long(1), `${long(2)}\n\n- a\n- b`]);
	assert.equal(beats([1, 2, 3, 4, 5, 6].map(long).join("\n\n")).length, 4);
	assert.deepEqual(beats("\n\n  \n\n"), []);
});

test("panels hold elements: the user's note, June's beats, tools gathered, one thought, and bursts", () => {
	const strip = panels([
		june("a0", "earlier"),
		user("u1", "check the servers"),
		patter("p1", "first"),
		tool("t1"),
		tool("t2"),
		june("a1", "  "),
		patter("p2", "second"),
		june("a2", `${"x".repeat(150)}\n\n${"y".repeat(150)}`, true),
		{ kind: "note", id: "n1", text: "model failed, retrying" },
		{ ...june("a3"), private: true },
		user("u2"),
		{ ...june("a4", ""), error: "boom" },
	]);
	assert.deepEqual(strip.map((p) => p.id), ["a0", "u1", "u2"]);
	assert.equal(strip[0].user, null);
	assert.deepEqual(strip[1].elements.map((e) => e.kind), ["user", "tools", "thought", "june", "june", "burst"]);
	assert.deepEqual(strip[1].elements[1].items.map((i) => i.id), ["t1", "t2"]);
	assert.equal(strip[1].elements[2].item.text, "second", "a panel keeps only its latest thought");
	assert.deepEqual(strip[1].elements.filter((e) => e.kind === "june").map((e) => e.streaming), [false, true], "only the last beat is still being written");
	assert.deepEqual(strip[2].elements.map((e) => e.kind), ["user", "burst"]);
});

test("a crowded exchange continues in the next panel, taking the tools and thought that lead into the balloon", () => {
	// Jon's panel: a long message, a first reply, tool calls, a second reply, and a thought.
	const strip = panels([user("u1", "x".repeat(420)), june("a1", "got it on the retakes."), tool("t1", "work"), tool("t2", "journal"), june("a2", "that clears three things off the plate."), patter("p1", "a minute of calendar plumbing")]);
	assert.deepEqual(strip.map((p) => p.elements.map((e) => e.kind)), [["user", "june"], ["tools", "june", "thought"]]);
	assert.equal(strip[1].id, "t1", "the new panel is named for what opens it");
	assert.equal(strip[1].user, null);
});

test("a long exchange continues in the next panel at a beat, and its ids stay stable", () => {
	const para = (n) => `${"words ".repeat(50)}${n}`;
	const strip = panels([user("u1"), june("a1", [1, 2, 3, 4].map(para).join("\n\n"))]);
	assert.ok(strip.length >= 2, `${strip.length} panels`);
	assert.equal(strip[0].id, "u1");
	assert.match(strip[1].id, /^a1#\d$/);
	const short = panels([user("u1", "a quick joke"), june("a1", "and the punchline.")]);
	assert.equal(short.length, 1, "a joke and its punchline share a panel");
	assert.equal(strip[1].user, null);
	assert.ok(strip.every((p) => p.elements.length > 0));
});

test("a failed tool keeps its first line in the caption, and summaries read as narration", () => {
	assert.equal(caption({ name: "bash", summary: "khal new", status: "error", error: "no such calendar" }), "bash · khal new · failed: no such calendar");
	assert.equal(caption({ name: "read", summary: "path=/home/jon/.local/share/june/MEMORY.org offset=1 limit=100", status: "done" }), "read · MEMORY.org");
	assert.equal(caption({ name: "org_read_task", summary: "file=work/nonfiction/nterchange/nterchange.org heading=Remove old migration servers", status: "done" }), "org_read_task · nterchange.org Remove old migration servers");
});

test("markup escapes everything and turns stressed words, code, and links into spans", () => {
	const out = markup("update their **résumés**.\nrun `nix flake check`, see [the notes](https://x.y) & <b>this</b>", { stress: "S", code: "C" });
	assert.equal(out, 'update their <span style="S">résumés</span>.<br>run <span style="C">nix flake check</span>, see the notes &amp; &lt;b&gt;this&lt;/b&gt;');
	assert.equal(markup("an *aside* and _another_, but not snake_case_name or 2*3*4", { stress: "S" }), 'an <span style="S">aside</span> and <span style="S">another</span>, but not snake_case_name or 2*3*4');
	assert.equal(markup("## Heading\n> quoted"), "Heading<br>quoted");
});

test("input reads commands, refuses /new, and submits anything else; the badge says what June is doing", () => {
	assert.deepEqual(readInput("/compact keep the server notes"), { kind: "command", name: "compact", args: "keep the server notes" });
	assert.equal(readInput("/new").kind, "refuse");
	assert.deepEqual(readInput("/nonsense here"), { kind: "submit", text: "/nonsense here" });
	assert.deepEqual(readInput("  "), { kind: "empty" });
	const idle = { running: false, background: 0, compacting: false };
	assert.equal(activity(idle, false), "offline");
	assert.equal(activity({ ...idle, running: true }, true), "thinking");
	assert.equal(activity({ ...idle, background: 2 }, true), "2 briefs running");
	assert.equal(activity(idle, true), "");
});

test("the overlay's expression chains match the daemon's vocabulary", () => {
	assert.deepEqual(Object.keys(FALLBACK).sort(), Object.keys(EXPRESSIONS).filter((e) => e !== "idle").sort());
	for (const name of [...Object.keys(EXPRESSIONS), "no-such-face"]) assert.deepEqual(chain(name), fallbacks(name), name);
});

test("June's activity in the live panel comes from runtime state: thinking, then working, then her own words", () => {
	const busy = { running: true, background: 0, compacting: false };
	const panel = (...kinds) => ({ id: "p", elements: kinds.map((k) => (typeof k === "string" ? { kind: k } : k)) });
	const writing = { kind: "june", text: "two need a reply", streaming: true };
	assert.equal(liveActivity(busy, panel("user")), "thinking", "before her first words");
	assert.equal(liveActivity(busy, panel("user", "thought")), "thinking", "patter alone is still thinking");
	assert.equal(liveActivity(busy, panel("user", { kind: "june", text: "i'll check.", streaming: false }, "tools", "thought")), "working", "tools since her last words, patter coming through");
	assert.equal(liveActivity(busy, panel("user", "tools", writing)), null, "writing her reply: her expression shows");
	assert.equal(liveActivity(busy, panel("user", { kind: "june", text: "", streaming: true })), "thinking", "a reply with no words yet");
	assert.equal(liveActivity({ ...busy, running: false, compacting: true }, panel("user")), "working", "tidying up while compacting");
	assert.equal(liveActivity({ ...busy, running: false }, panel("user", "tools")), null, "no run: the panel settles");
	assert.deepEqual(ACTIVITIES, [...POSE_ACTIVITIES], "the overlay's activities match the daemon's");
});

test("activity poses show only while she is doing it, never as a reaction", () => {
	const doing = POSES.filter((p) => p.activity);
	assert.ok(doing.some((p) => p.activity === "working") && doing.some((p) => p.activity === "thinking"));
	assert.equal(choosePose(POSES, { activity: "working" }).activity, "working");
	assert.equal(choosePose(POSES, { activity: "thinking" }).id, "thinking-finger-tapping");
	assert.equal(choosePose(POSES, { activity: "watching", expression: "curious" }).id, "curious-head-tilt", "no watching pose: her expression instead");
	for (const expression of [...Object.keys(EXPRESSIONS), "no-such-face"])
		for (const seed of ["a", "b", "c", "d"]) assert.equal(choosePose(POSES, { expression }, "", seed).activity, null, `${expression}: a reaction pose`);
	const twoAtWork = POSES.filter((p) => p.activity === "working").map((p) => p.id);
	assert.notEqual(choosePose(POSES, { activity: "working" }, twoAtWork[0], "x").id, twoAtWork[0], "variety among working poses too");
	assert.equal(tallFor(POSES, pose("working-typing-laptop")), null, "no tall working pose, and none in determined's chain: the inset");
	const thinkingSerious = { ...pose("thinking-finger-tapping"), expression: "serious" };
	assert.equal(tallFor(POSES, thinkingSerious).id, "explaining-standing-clipboard", "otherwise she stands in her expression's tall pose, not a working one");
	const tallWorker = { ...pose("content-standing-mug"), id: "working-standing-armful", activity: "working", expression: "serious" };
	assert.equal(tallFor([...POSES, tallWorker], pose("working-typing-laptop")).id, "working-standing-armful", "a tall working pose keeps her at work");
});

test("poses are read leniently from a manifest, and chosen by name, expression chain, and variety", () => {
	assert.equal(POSES.length, Object.keys(manifest.poses).length);
	assert.equal(pose("playful-wink-pointing").mirror, false);
	assert.equal(pose("idle-attentive").url, "file:///set/poses/idle-attentive.svg");
	const read = readPoses({ poses: { ok: { file: "a.png", size: [10, 10], expression: "idle", face: [0.1, 0.1, 0.5, 0.5], mouth: [0.3, 0.4], facing: "up" }, "no-face": { file: "b.png", size: [10, 10], expression: "idle", mouth: [0.3, 0.4] } } }, "");
	assert.deepEqual(read.map((p) => [p.id, p.facing]), [["ok", "front"]], "a pose without a face is skipped; an unknown facing reads as front");

	assert.equal(choosePose(POSES, { pose: "thoughtful-pen" }).id, "thoughtful-pen");
	assert.equal(choosePose(POSES, { expression: "indignant" }).id, "exasperated-facepalm", "indignant falls back to exasperated");
	assert.equal(choosePose(POSES, { expression: "bashful" }).expression, "warm");
	assert.equal(choosePose(POSES, { pose: "no-such-pose", expression: "smug" }).id, "smug-chin-on-hand");
	const twins = [...POSES, { ...pose("smug-chin-on-hand"), id: "smug-arms-folded" }];
	assert.notEqual(choosePose(twins, { expression: "smug" }, "smug-chin-on-hand", "x").id, "smug-chin-on-hand", "the previous panel's pose is avoided when another fits");
	assert.equal(choosePose(twins, { expression: "smug" }, "", "seed").id, choosePose(twins, { expression: "smug" }, "", "seed").id, "a seed keeps the choice");
	assert.equal(choosePose([], {}), null);
	assert.deepEqual(standIn({ id: "x", elements: [{ kind: "burst" }] }, false), { expression: "exasperated" });
	assert.deepEqual(standIn({ id: "x", elements: [] }, true), { expression: "curious" });
});

test("June alternates sides, except when a pose that may not be mirrored would face away from the words", () => {
	assert.equal(chooseSide(undefined, pose("idle-attentive")), "left");
	assert.equal(chooseSide("left", pose("idle-attentive")), "right");
	assert.equal(chooseSide("right", pose("smug-chin-on-hand")), "left", "a mirrorable pose keeps the alternation");
	assert.equal(chooseSide("left", pose("smug-chin-on-hand")), "right");
	assert.equal(chooseSide("left", pose("playful-wink-pointing")), "left", "she faces right and may not be flipped, so she stays on the left");
	assert.equal(chooseSide("right", pose("playful-wink-pointing")), "left");
	let side;
	const sides = ["idle-attentive", "curious-head-tilt", "laughing-head-back", "thoughtful-pen"].map((id) => (side = chooseSide(side, pose(id))));
	assert.deepEqual(sides, ["left", "right", "left", "right"]);
});

const overlaps = (a, b, slack = 0) => a.x < b.x + b.w - slack && b.x < a.x + a.w - slack && a.y < b.y + b.h - slack && b.y < a.y + a.h - slack;
const inside = (a, b, slack = 0.5) => a.x >= b.x - slack && a.y >= b.y - slack && a.x + a.w <= b.x + b.w + slack && a.y + a.h <= b.y + b.h + slack;

// Element sets measured as QML would, each no wider than the column it was given.
const sets = (width) => {
	const t = metrics(width).textWidth;
	const w = (f) => Math.min(t, Math.round(t * f));
	return {
		joke: [{ kind: "user", w: w(0.7), h: 44 }, { kind: "june", w: w(0.85), h: 70 }],
		report: [{ kind: "user", w: w(0.5), h: 44 }, { kind: "card", w: Math.min(220, w(0.4)), h: 110 }, { kind: "june", w: w(0.55), h: 160 }, { kind: "june", w: w(0.9), h: 70 }],
		musing: [{ kind: "thought", w: w(0.6), h: 54 }, { kind: "chip", w: w(0.4), h: 28 }, { kind: "june", w: w(1), h: 120 }],
		wall: [{ kind: "user", w: w(1), h: 120 }, { kind: "june", w: w(1), h: 760 }, { kind: "burst", w: w(0.8), h: 80 }],
		alone: [{ kind: "june", w: w(0.4), h: 44 }],
	};
};

test("every composition keeps words in the panel, apart from each other, and off June's face, at every width", () => {
	for (const width of [820, 640, 460, 340]) {
		for (const [name, elements] of Object.entries(sets(width))) {
			for (const side of ["left", "right"]) {
				for (const p of [pose("idle-attentive"), pose("smug-chin-on-hand"), pose("playful-wink-pointing"), pose("content-standing-mug")]) {
					const at = `${width} ${name} ${side} ${p.id}`;
					const out = plan({ width, side, pose: p, elements });
					const panel = { x: 0, y: 0, w: width, h: out.height };
					assert.equal(out.elements.length, elements.length, at);
					for (const [i, e] of out.elements.entries()) {
						assert.ok(inside(e, panel), `${at}: element ${i} leaves the panel`);
						assert.ok(!overlaps(e, out.face, 1), `${at}: element ${i} covers her face`);
						for (const other of out.elements.slice(i + 1)) assert.ok(!overlaps(e, other), `${at}: elements overlap`);
					}
					assert.ok(inside(out.clip, panel), `${at}: art area leaves the panel`);
					assert.ok(inside(out.face, out.clip, 1), `${at}: her face is cropped`);
					assert.ok(inside(out.face, out.art, 1), `${at}: her face is outside her image`);
					assert.ok(out.face.w >= Math.min(60, width * 0.15), `${at}: face only ${Math.round(out.face.w)} px wide`);
					for (const mark of out.marks) assert.ok(inside({ x: mark.x, y: mark.y, w: mark.size, h: mark.size }, out.clip), `${at}: a mark leaves the art`);
				}
			}
		}
	}
});

test("words take the far side from June: her balloons sit toward her, the user's notes away", () => {
	const els = sets(820).joke;
	const left = plan({ width: 820, side: "left", pose: pose("idle-attentive"), elements: els });
	assert.ok(left.face.x + left.face.w < left.elements[1].x, "June on the left, her balloon to her right");
	assert.ok(left.elements[0].x + left.elements[0].w > left.elements[1].x + left.elements[1].w, "the user's note reaches further from her");
	const right = plan({ width: 820, side: "right", pose: pose("idle-attentive"), elements: els });
	assert.ok(right.face.x > right.elements[1].x + right.elements[1].w, "June on the right, her balloon to her left");
	assert.ok(right.elements[0].x < right.elements[1].x, "the user's note starts further from her");
	const report = plan({ width: 820, side: "left", pose: pose("thoughtful-pen"), elements: sets(820).report });
	assert.equal(report.elements[1].y, report.elements[2].y, "a status card shares a row with the balloon after it");
	assert.ok(report.elements[1].x > report.elements[2].x, "the card on the outside, the balloon toward June");
});

test("tails leave the side facing June, join the outline, and point at her mouth without reaching her face", () => {
	for (const side of ["left", "right"]) {
		const out = plan({ width: 820, side, pose: pose("idle-attentive"), elements: sets(820).report });
		for (const e of out.elements.filter((e) => e.tail)) {
			const { edge, at, tip } = e.tail;
			const base = edge === "bottom" || edge === "top" ? { x: e.x + at, y: edge === "top" ? e.y : e.y + e.h } : { x: edge === "left" ? e.x : e.x + e.w, y: e.y + at };
			const end = { x: e.x + tip.x, y: e.y + tip.y };
			assert.ok(["top", "bottom", side].includes(edge), `${side}: tail on the ${edge}`);
			assert.ok(edge === side || (end.y < e.y) === (edge === "top"), `${side}: a top or bottom tail points out of the balloon`);
			assert.ok(Math.hypot(end.x - out.mouth.x, end.y - out.mouth.y) < Math.hypot(base.x - out.mouth.x, base.y - out.mouth.y), `${side}: the tail points toward her mouth`);
			assert.ok(!overlaps({ x: end.x, y: end.y, w: 1, h: 1 }, out.face), `${side}: the tail stops short of her face`);
			assert.ok(end.x >= 0 && end.x <= 820 && end.y >= 0 && end.y <= out.height, `${side}: the tail stays in the panel`);
			for (const other of out.elements.filter((o) => o !== e)) assert.ok(!overlaps({ x: end.x, y: end.y, w: 1, h: 1 }, other), `${side}: the tail runs into another balloon`);
		}
	}
	// A long note pushes two consecutive balloons below her face: they are one speech and share one tail.
	const run = plan({ width: 820, side: "left", pose: pose("idle-attentive"), elements: [{ kind: "user", w: 400, h: 420 }, { kind: "june", w: 300, h: 70 }, { kind: "june", w: 300, h: 70 }] });
	assert.ok(run.elements[1].y > run.face.y + run.face.h, "the balloons start below her face");
	assert.deepEqual(run.elements.map((e) => Boolean(e.tail)), [false, true, false], "only the balloon nearest her mouth has a tail");
	const { edge, at, tip } = run.elements[1].tail;
	assert.ok(["top", "left"].includes(edge), `it leaves an edge toward her, not the ${edge}`);
	const base = edge === "top" ? { x: at, y: 0 } : { x: 0, y: at };
	assert.ok(Math.hypot(tip.x - base.x, tip.y - base.y) >= 20, "a real tail, not a stub");
	// Jon's case: June in an inset above and to the right of a balloon, far up the panel. The tail may not bend past 50°.
	const below = aimTail({ x: 40, y: 640, w: 620, h: 100 }, { x: 760, y: 300 }, { x: 700, y: 120, w: 200, h: 230 }, "right");
	const normal = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }[below.edge];
	const root = below.edge === "top" || below.edge === "bottom" ? [below.at, below.edge === "top" ? 0 : 100] : [below.edge === "left" ? 0 : 620, below.at];
	const v = [below.tip.x - root[0], below.tip.y - root[1]];
	const lean = Math.acos((v[0] * normal[0] + v[1] * normal[1]) / Math.hypot(...v));
	assert.ok(lean <= (50 * Math.PI) / 180 + 1e-6, `the tail leans ${Math.round((lean * 180) / Math.PI)}° from its edge`);
	assert.equal(below.edge, "top", "far below her, the top edge bends least");
	assert.equal(aimTail({ x: 400, y: 20, w: 40, h: 40 }, { x: 250, y: 120 }, { x: 180, y: 40, w: 120, h: 140 }, "left"), null, "a balloon too small for a base gets no tail rather than a broken one");
	const pill = aimTail({ x: 400, y: 20, w: 90, h: 40 }, { x: 250, y: 120 }, { x: 180, y: 40, w: 120, h: 140 }, "left");
	assert.ok(pill.at - pill.base / 2 >= 20 && pill.at + pill.base / 2 <= 90 - 20, "a narrow pill's base stays on its straight run");
	const short = aimTail({ x: 400, y: 20, w: 200, h: 40 }, { x: 250, y: 120 }, { x: 180, y: 40, w: 120, h: 140 }, "left");
	assert.equal(short.edge, "bottom", "a balloon too short for a side tail takes it from the bottom when her mouth is lower");
	assert.equal(aimTail({ x: 400, y: 200, w: 200, h: 40 }, { x: 250, y: 120 }, { x: 180, y: 40, w: 120, h: 140 }, "left").edge, "top", "and from the top when it is higher");
});

test("tool cards and thoughts do not end a speech: the balloon after them shares the tail", () => {
	// As in Jon's panel: a tall first balloon beside her inset, then a card, then a balloon below her face.
	const out = plan({ width: 820, side: "right", pose: pose("thoughtful-pen"), elements: [{ kind: "june", w: 420, h: 300 }, { kind: "card", w: 380, h: 70 }, { kind: "june", w: 420, h: 70 }, { kind: "thought", w: 420, h: 70 }] });
	assert.ok(out.elements[2].y > out.face.y + out.face.h, "the second balloon is below her face");
	assert.ok(out.elements[0].tail, "the first balloon points at her");
	assert.equal(out.elements[2].tail, undefined, "the balloon after the card is the same speech");
	const t = out.elements[3].trail;
	if (t) for (const c of [14, 30]) {
		const p = { x: out.elements[3].x + t.x + t.dx * c, y: out.elements[3].y + t.y + t.dy * c, w: 1, h: 1 };
		for (const other of out.elements.slice(0, 3)) assert.ok(!overlaps(p, other), "the trail stays off the balloons");
	}
	const boxed = aimTrail({ x: 100, y: 100, w: 200, h: 60 }, { x: 600, y: 0, w: 100, h: 100 }, [{ x: 0, y: 0, w: 800, h: 98 }, { x: 0, y: 162, w: 800, h: 100 }, { x: 302, y: 0, w: 400, h: 400 }, { x: 0, y: 0, w: 98, h: 400 }]);
	assert.equal(boxed, null, "boxed in on every side: no trail");
	assert.equal(aimTail({ x: 100, y: 100, w: 300, h: 80 }, { x: 600, y: 140 }, { x: 560, y: 60, w: 120, h: 160 }, "right", [{ x: 402, y: 0, w: 140, h: 400 }, { x: 0, y: 0, w: 800, h: 98 }, { x: 0, y: 182, w: 800, h: 100 }]), null, "boxed in on every edge: no tail");
});

test("a thought's trail starts at the cloud's corner nearest her face and drifts toward it", () => {
	const face = { x: 700, y: 40, w: 200, h: 230 };
	const below = aimTrail({ x: 40, y: 600, w: 560, h: 110 }, face);
	assert.deepEqual([below.x, below.y], [560 - 18, 6], "the top right corner, toward her above and to the right");
	assert.ok(below.dx > 0 && below.dy < 0, "drifting up and right");
	const level = aimTrail({ x: 300, y: 100, w: 300, h: 80 }, { x: 40, y: 60, w: 180, h: 200 });
	assert.ok(level.x < 150 && level.dx < 0, "she is to the left: it leaves the left side, heading left");
	for (const side of ["left", "right"]) {
		const out = plan({ width: 820, side, pose: pose("idle-attentive"), elements: sets(820).musing });
		const t = out.elements[0].trail;
		const fx = out.face.x + out.face.w / 2 - (out.elements[0].x + t.x);
		assert.ok(Math.sign(t.dx) === Math.sign(fx), `${side}: the trail heads toward her`);
	}
});

test("the words set the panel's height; the art is framed to it, and long words put June in an inset", () => {
	const m = metrics(820);
	const small = plan({ width: 820, side: "left", pose: pose("idle-attentive"), elements: sets(820).alone });
	assert.equal(small.height, m.minHeight, "a short reply gets a compact panel");
	assert.equal(small.framing, "close-up", "a compact panel gets a close-up");
	assert.equal(small.clip.inset, false);
	const medium = plan({ width: 820, side: "left", pose: pose("idle-attentive"), elements: sets(820).report });
	assert.ok(medium.height > small.height);
	assert.ok(["head", "bust"].includes(medium.framing), medium.framing);
	assert.ok(medium.art.y + medium.art.h >= medium.height - 1, "her image reaches the bottom of the panel: no floating torso");
	const wall = plan({ width: 820, side: "right", pose: pose("idle-attentive"), elements: sets(820).wall });
	assert.ok(wall.height > m.maxArt, "the panel grows with the words");
	assert.equal(wall.clip.inset, true, "and June moves to an inset");
	assert.ok(wall.clip.h <= m.maxArt && wall.clip.y === m.pad, "an inset at the top, no taller than the art may grow");
	assert.ok(wall.clip.x > 820 / 2, "on her side");
	assert.equal(chooseFraming(820, 600, { framings: ["bust"] }), "bust", "only framings the pose supports");
	assert.equal(chooseFraming(820, 200, pose("idle-attentive"), "waist"), "waist", "a hint wins when the pose supports it");
});

test("a long panel shows the whole of her when a tall pose exists, and an inset only when none can fill it", () => {
	const m = metrics(820);
	const words = sets(820).wall;
	assert.equal(tallFor(POSES, pose("content-holding-mug")).id, "content-standing-mug", "a standing pose of the same expression");
	assert.equal(tallFor(POSES, pose("thoughtful-pen")).id, "explaining-standing-clipboard");
	assert.equal(tallFor(POSES, pose("smug-chin-on-hand")), null, "no tall pose anywhere in smug's chain");
	assert.equal(tallFor(POSES, pose("content-standing-mug")).id, "content-standing-mug", "a tall pose is its own");
	assert.ok(!pose("idle-attentive").framings.includes("full"), "a pose that names no framings never claims full");

	for (const side of ["left", "right"]) {
		const out = plan({ width: 820, side, pose: pose("content-standing-mug"), elements: words });
		assert.ok(out.height > m.maxArt + m.pad, "a long panel");
		assert.equal(out.clip.inset, false, `${side}: no inset`);
		assert.equal(out.framing, "full");
		assert.ok(out.art.y + out.art.h >= out.height - 1, `${side}: her figure reaches the bottom of the panel`);
		assert.ok(out.face.y < out.height * 0.3, `${side}: her face near the top`);
		for (const e of out.elements) assert.ok(!overlaps(e, out.face, 1), `${side}: words stay off her face`);
	}
	const inset = plan({ width: 820, side: "left", pose: pose("idle-attentive"), elements: words });
	assert.equal(inset.clip.inset, true, "no tall pose: the inset");
	assert.notEqual(inset.framing, "full");
	const huge = plan({ width: 820, side: "left", pose: pose("content-standing-mug"), elements: [{ kind: "june", w: 400, h: 3000 }] });
	assert.equal(huge.clip.inset, true, "a panel taller than even a standing figure can fill falls back to the inset");
	const short = plan({ width: 820, side: "left", pose: pose("content-standing-mug"), elements: sets(820).joke });
	assert.notEqual(short.framing, "full", "a tall pose in a short panel is framed like any other");
	assert.equal(chooseFraming(820, 800, pose("idle-attentive")), "waist", "full only for poses that name it");
});

test("a pose facing away from the words is mirrored where allowed, and a lettered one never is", () => {
	const els = sets(820).joke;
	assert.equal(plan({ width: 820, side: "left", pose: pose("curious-head-tilt"), elements: els }).mirror, true, "facing left, placed left: flipped to face the words");
	assert.equal(plan({ width: 820, side: "right", pose: pose("curious-head-tilt"), elements: els }).mirror, false);
	assert.equal(plan({ width: 820, side: "right", pose: pose("playful-wink-pointing"), elements: els }).mirror, false, "never mirrored");
	assert.equal(plan({ width: 820, side: "left", pose: null, elements: els }).art, null, "no art set: words only");
});

test("narrow strips give the words more of the width, and a phone-narrow one stacks June above them", () => {
	assert.ok(metrics(560).textWidth / 560 > metrics(820).textWidth / 820);
	assert.equal(metrics(340).textWidth, 340 - 2 * metrics(340).pad, "full width for the words");
	const out = plan({ width: 360, side: "right", pose: pose("idle-attentive"), elements: sets(360).report });
	assert.equal(out.clip.y, 0);
	assert.equal(out.clip.w, 360, "a band across the panel");
	assert.ok(out.elements.every((e) => e.y >= out.clip.h), "the words start below her");
	assert.ok(out.face.x + out.face.w / 2 > 180, "on her side of the band");
	assert.ok(out.face.w >= 80, `a face worth seeing: ${Math.round(out.face.w)} px`);
});

test("a balloon and its tail are one closed outline from any side, and a burst stays in its box", () => {
	const tail = (edge, at, tip) => ({ edge, at, base: 22, tip });
	const left = balloonPath(200, 80, tail("left", 40, { x: -30, y: 70 }));
	assert.match(left, /^M 26 0 H 174 /);
	assert.match(left, / V 51 L -30 70 L 0 29 V 26 /, "up the left side: base, tip, back to the side");
	assert.match(left, / Z$/);
	assert.match(balloonPath(200, 80, tail("right", 40, { x: 230, y: 60 })), / V 29 L 230 60 L 200 51 V 54 /);
	assert.match(balloonPath(200, 40, tail("bottom", 31, { x: -10, y: 70 })), / H 42 L -10 70 L 20 40 H 20 /);
	assert.match(balloonPath(200, 40, tail("top", 31, { x: -10, y: -30 })), /^M 20 0 H 20 L -10 -30 L 42 0 H 180 /);
	assert.doesNotMatch(balloonPath(200, 60, null), / L /);
	const cloud = cloudPath(260, 90, 18, 6);
	assert.match(cloud, /^M 6 6 A /);
	assert.match(cloud, / Z$/);
	const ends = [[14, 14], ...[...cloud.matchAll(/A ([\d.]+) [\d.]+ 0 0 1 ([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[2]), Number(m[3]), Number(m[1])])];
	assert.ok(ends.length >= 12, `${ends.length} bumps`);
	for (let i = 1; i < ends.length; i++) {
		// Each scallop rises its sagitta above the chord between two points on the inset rectangle: at most the depth.
		const [x0, y0] = ends[i - 1];
		const [x1, y1, r] = ends[i];
		const half = Math.hypot(x1 - x0, y1 - y0) / 2;
		const sagitta = r - Math.sqrt(Math.max(r * r - half * half, 0));
		assert.ok(sagitta <= 6.5, `scallop ${i} bulges ${sagitta.toFixed(1)} px`);
		assert.ok([x1, y1].every((v, k) => v >= 6 - 0.5 && v <= [260, 90][k] - 6 + 0.5), `scallop ${i} ends off the inset rectangle`);
	}
	const burst = jagged(300, 120, 9);
	const points = burst.slice(2, -2).split(" L ").map((p) => p.split(" ").map(Number));
	assert.ok(points.every(([x, y]) => x >= 0 && x <= 300 && y >= 0 && y <= 120));
});

test("the shared modules use only JavaScript that QML's engine runs", async () => {
	// Each of these loaded under Node but failed in Quickshell, blanking the overlay.
	for (const file of ["strip.mjs", "compose.mjs", "live.mjs", "scroll.mjs"]) {
		const source = (await readFile(new URL(`../overlay/${file}`, import.meta.url), "utf8")).replace(/^\s*(\/\/|\*).*$/gm, "");
		assert.doesNotMatch(source, /\.at\(/, `${file}: Array.prototype.at`);
		assert.doesNotMatch(source, /Object\.hasOwn\(/, `${file}: Object.hasOwn`);
		assert.doesNotMatch(source, /\{\s*\.\.\./, `${file}: object spread`);
	}
});

test("live June's state follows the run: thinking, digging or delegating, typing, tidying, offline", () => {
	const now = new Date(2026, 10, 3, 14, 0);
	const at = (items, state, extra = {}) => liveState({ view: { items, state }, linked: true, now, idleSince: now.getTime(), ...extra });
	const busy = { running: true, background: 0, compacting: false };
	const ask = user("u1", "any emails worth responding to?");
	assert.equal(at([ask], busy), "thinking", "a run with no words or tools yet");
	assert.equal(at([ask, tool("t1", "bash", "notmuch search")], busy), "digging", "her own tools");
	assert.equal(at([ask, june("a1", "i'll check."), tool("t1", "work", "brief=Find replies")], busy), "delegating", "handing work to a brief");
	assert.equal(at([ask, tool("t1"), june("a2", "two need a reply", true)], busy), "typing", "her reply streaming");
	assert.equal(at([ask, june("a2", "", true)], busy), "thinking", "a reply with no words yet");
	assert.equal(at([ask], { ...busy, running: false, compacting: true }), "tidying");
	assert.equal(at([ask], { running: false, background: 2 }), "delegating", "briefs running in the background");
	assert.equal(liveState({ view: { items: [], state: busy }, linked: false, now }), "offline");
	assert.equal(at([ask], busy, { once: { state: "pop-in", until: now.getTime() + 1000 } }), "pop-in", "a one-shot plays first");
	assert.equal(at([ask], busy, { once: { state: "pop-in", until: now.getTime() - 1 } }), "thinking", "then the run shows again");
	assert.deepEqual(LIVE, [...LIVE_STATES], "the overlay's live states match the daemon's");
});

test("idle, she sips her mug, then reads, doodles, listens to music in the evening, and snoozes late", () => {
	const at = (h) => new Date(2026, 10, 3, h, 30);
	assert.equal(idleState(at(14), 2), "sipping", "just finished");
	assert.equal(idleState(at(14), 20), "reading");
	assert.equal(idleState(at(14), 90), "doodling");
	assert.equal(idleState(at(20), 20), "music");
	assert.equal(idleState(at(23), 20), "snoozing");
	assert.equal(idleState(at(3), 20), "snoozing");
	assert.equal(idleState(at(3), 2), "sipping", "even late, a moment of sipping first");
	const now = at(20);
	assert.equal(liveState({ view: { items: [], state: { running: false, background: 0 } }, linked: true, now, idleSince: now.getTime() - 30 * 60000 }), "music");
});

test("she pops up for a newly finished desktop reply, once, with its opening lines", () => {
	const done = (id, text, alert = "gui") => ({ ...june(id, text), alert });
	assert.equal(newReply([user("u1"), done("a1", "two need a reply.")], null).id, "a1");
	assert.equal(newReply([user("u1"), done("a1", "two need a reply.")], "a1"), null, "already shown");
	assert.equal(newReply([user("u1"), { ...june("a1", "writing", true), alert: "gui" }], null), null, "still streaming");
	assert.equal(newReply([user("u1"), done("a1", "on telegram", "telegram")], null), null, "meant for another surface");
	assert.equal(newReply([done("a0", "older"), user("u1"), done("a1", "  ")], null).id, "a0", "an empty reply is skipped");
	assert.equal(excerpt("short reply.\n\nmore detail"), "short reply.");
	const long = `${"word ".repeat(30)}ends here. ${"more ".repeat(40)}`;
	assert.equal(excerpt(long, 200), `${"word ".repeat(30)}ends here.`, "cut at a sentence");
	assert.ok(excerpt("a".repeat(50) + " " + "b".repeat(300), 200).endsWith("…"), "or at a word, with an ellipsis");
});

test("live June's art is read by state, a sprite sheet keeping its frames, an unknown state skipped", () => {
	const art = readLive(manifest, "file:///set/");
	assert.equal(Object.keys(art).length, LIVE.length, "the placeholder set covers every state");
	assert.equal(art.typing.url, "file:///set/live/typing.svg");
	assert.equal(art["pop-in"].play, "once");
	const sheet = readLive({ live: { typing: { file: "t.png", play: "loop", frames: 8, fps: 8 }, dancing: { file: "d.png", play: "loop" }, sipping: { play: "loop" } } }, "");
	assert.deepEqual(Object.keys(sheet), ["typing"]);
	assert.deepEqual([sheet.typing.frames, sheet.typing.fps], [8, 8]);
	assert.deepEqual(readLive({}, ""), {});
});

test("a popped-up reply stays as long as it takes to read, and a recent one shows again when she is summoned", () => {
	assert.equal(readingTime("hi!"), 5180, "a word: about five seconds");
	assert.equal(readingTime("x".repeat(200)), 17000, "a few sentences: longer");
	assert.equal(readingTime("x".repeat(2000)), 30000, "never more than thirty seconds");
	assert.equal(readingTime(""), 5000);
	assert.ok(readingTime("a longer reply with more to read") > readingTime("ok"));
	const now = 1_000_000_000;
	assert.equal(recent(now - 60_000, now), true, "a minute ago");
	assert.equal(recent(now - RECENT_MS, now), true, "ten minutes ago, just");
	assert.equal(recent(now - RECENT_MS - 1, now), false, "older");
	assert.equal(recent(0, now), false, "none yet");
});

// Run frames at `fps` until the motion stops; return the total distance and how long it took.
const glide = (state, now, fps = 60) => {
	let moved = 0;
	let t = now;
	for (let i = 0; i < 2000; i++) {
		t += 1000 / fps;
		const r = step(state, 1 / fps, t);
		moved += r.dy;
		state = r.state;
		if (r.done) return { moved, ms: t - now };
	}
	return { moved, ms: Infinity };
};

test("a wheel notch glides up toward earlier panels and slows to a stop, the same at any frame rate", () => {
	const up = wheel(rest(), { angleY: 120, now: 0 });
	assert.equal(up.dy, 0, "a wheel moves nothing at once: it glides");
	const at60 = glide(up.state, 0, 60);
	const at144 = glide(up.state, 0, 144);
	assert.ok(at60.moved < -120 && at60.moved > -220, `one notch glides about 170 px up, not ${Math.round(at60.moved)}`);
	assert.ok(Math.abs(at60.moved - at144.moved) < 4, "the same glide at 60 and 144 fps");
	assert.ok(at60.ms < 1200, `and settles in about a second, not ${Math.round(at60.ms)} ms`);
	const twice = wheel(up.state, { angleY: 120, now: 20 });
	assert.ok(glide(twice.state, 20).moved < at60.moved, "a second notch goes further");
	const back = wheel(up.state, { angleY: -120, now: 20 });
	assert.ok(glide(back.state, 20).moved > 0, "a notch the other way reverses at once");
});

test("a touchpad follows the fingers, then coasts on when they lift", () => {
	let state = rest();
	let moved = 0;
	for (let t = 0; t <= 160; t += 16) {
		const r = wheel(state, { pixelY: -12, now: t });
		state = r.state;
		moved += r.dy;
	}
	assert.equal(moved, 12 * 11, "each event moves exactly as far as the fingers did");
	const held = step(state, 1 / 60, 170);
	assert.equal(held.dy, 0, "no coast while the fingers are still on the pad");
	const coast = glide(state, 160 + 50);
	assert.ok(coast.moved > 60, `released at about 750 px/s, it coasts on down, ${Math.round(coast.moved)} px`);
	assert.ok(coast.ms < 2500);
});

test("a page turn moves most of a view, toward newer or earlier panels, and stops at the ends", () => {
	assert.equal(PAGE, 0.85);
	assert.equal(pageTarget(1000, 800, 0, 4000, 1), 1680, "Ctrl+N: down toward newer panels");
	assert.equal(pageTarget(1000, 800, 0, 4000, -1), 320, "Ctrl+P: up toward earlier ones");
	assert.equal(pageTarget(3800, 800, 0, 4000, 1), 4000, "not past the newest");
	assert.equal(pageTarget(200, 800, 0, 4000, -1), 0, "not past the earliest");
	assert.equal(pageTarget(-500, 800, -3000, 0, 1), 0, "a list laid out bottom to top has negative positions; the same rules hold");
});

test("a settled panel shows the face the daemon picked for its reply, the pose when named, else a stand-in until it comes", () => {
	const strip = panels([user("u1", "you win."), { ...june("a1", "a hollow victory, but i'll take it."), expression: "wry", pose: "smug-chin-on-hand" }]);
	assert.deepEqual(strip[0].elements[1].expression, "wry", "the reply's face rides on its balloon");
	assert.deepEqual(picked(strip[0]), { pose: "smug-chin-on-hand", expression: "wry" });
	assert.equal(choosePose(POSES, picked(strip[0])).id, "smug-chin-on-hand");
	const noPose = panels([user("u1", "thanks"), { ...june("a1", "anytime."), expression: "warm" }]);
	assert.deepEqual(picked(noPose[0]), { expression: "warm" });
	assert.equal(choosePose(POSES, picked(noPose[0])).expression, "warm");
	assert.equal(picked(panels([user("u1"), june("a1", "not yet")])[0]), null, "before the pick: none, so the stand-in shows");
});

