import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { orgToMarkdown } from "../src/org.ts";
import { Transcript } from "../src/transcript.ts";
import { compactingStatus } from "../src/tui.ts";

test("the compaction line hops, changes chores, counts time, and keeps its width", () => {
	const plain = (ms: number) => compactingStatus(ms).replace(/\x1b\[[0-9;]*m/g, "");
	const frames = [0, 250, 500, 750, 1000, 1250, 1500, 1750].map(plain);
	assert.equal(new Set(frames).size, 8, "the kangaroo moves every frame");
	const columns = frames.map((f) => f.indexOf("🦘"));
	assert.ok(columns.every((at, i) => i === 0 || at < columns[i - 1]!), "she only hops left, the way she faces");
	assert.equal(plain(2000).indexOf("🦘"), columns[0], "then she starts again from the right");
	assert.equal(new Set([0, 250, 1750].map((ms) => visibleWidth(compactingStatus(ms)))).size, 1, "the line does not jitter");
	assert.match(compactingStatus(42_000), /0:42/);
	const chore = (ms: number) => /🦘[· ]* (.+)…/.exec(plain(ms))?.[1];
	assert.ok(chore(1000) && chore(7000) && chore(1000) !== chore(7000), "the chore changes every six seconds");
	assert.match(compactingStatus(65_000), /1:05/);
	assert.match(compactingStatus(65_000), /nearly there|don't rush me|big swag/, "past a minute she gets defensive");
});

test("the transcript knows while a compaction runs, from events or a reconnect snapshot", () => {
	const transcript = new Transcript();
	assert.equal(transcript.compacting, undefined);
	transcript.apply([{ type: "compaction_start", taskId: 1, reason: "manual", blocking: false } as never]);
	const since = transcript.compacting;
	assert.ok(since !== undefined && since <= Date.now());
	transcript.apply([{ type: "compaction_start", taskId: 2, reason: "threshold", blocking: true } as never]);
	assert.equal(transcript.compacting, since, "a second start keeps the first time");
	transcript.apply([{ type: "compaction_end", taskId: 1, reason: "manual" } as never]);
	assert.equal(transcript.compacting, undefined);
	const snapshot = { entries: [], inbox: [], tools: [], compactions: [{ taskId: 3 }], agent: {} } as never;
	transcript.load(snapshot);
	assert.ok(transcript.compacting !== undefined, "a client that attaches mid-compaction shows it too");
});

test("June's Org replies render as Markdown in the terminal, leaving paths and Markdown alone", () => {
	const org = "* Plan\nSome *bold*, /italic/ and =code=, see [[https://a.ca][A]].\nA path /home/alex/src/ and **markdown** stay.\n#+begin_src sh\necho *x*\n#+end_src";
	assert.equal(
		orgToMarkdown(org),
		"# Plan\nSome **bold**, *italic* and `code`, see [A](https://a.ca).\nA path /home/alex/src/ and **markdown** stay.\n```sh\necho *x*\n```",
	);
	assert.equal(orgToMarkdown("queued in =~/org/work/emacs.org=."), "queued in `~/org/work/emacs.org`.", "verbatim may start with the other marker");
	assert.equal(orgToMarkdown("set =a b= then =c=, not ==x=="), "set `a b` then `c`, not ==x==", "each span ends at its own marker");
});

test("a watch, work, follow, or heartbeat notice shows only June's words, whether it came through Telegram or the terminal", () => {
	const user = (id: number, text: string) => ({ id, kind: "pi.user", model: [{ role: "user", content: text }] });
	const said = (id: number, text: string, tool = false) => ({
		id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [...(tool ? [{ type: "toolCall", id: `c${id}`, name: "org_read_task", arguments: {} }] : []), { type: "text", text }] }],
	});
	const entries = [
		user(1, "hi"),
		said(2, "hello"),
		user(3, "[watch] Dispatched tasks you did not queue changed since you last heard:\n- «Snape» on kit is now EVAL."),
		said(4, "", true),
		said(5, "Snape's uptime report is at EVAL."),
		{ id: 6, kind: "june.input", data: { source: "watch", text: "1 dispatched task changed" } },
		user(7, "[watch] Dispatched tasks you did not queue changed since you last heard:\n- «Pirate» on kit is DONE."),
		said(8, "The pirate report is done."),
		user(9, "[heartbeat] A private heartbeat."),
		said(10, "QUIET"),
		user(11, "[follow] The task «Ship» is EVAL."),
		said(12, "Ship is ready."),
		{ id: 13, kind: "june.input", data: { source: "work", text: "report: Jon asks about Home Assistant" } },
		user(14, "[work] Home Assistant runs on hub."),
		said(15, "yes, it runs on hub."),
	];
	const transcript = new Transcript();
	transcript.load({ entries, inbox: [], tools: [], compactions: [], agent: {} } as never);
	const shown = transcript.items.map((i) => (i.kind === "user" ? `${i.source} › ${i.text}` : i.kind === "assistant" ? `june: ${i.blocks.map((b) => b.text ?? "").join("")}` : i.kind));
	assert.deepEqual(shown, ["telegram › hi", "june: hello", "june: Snape's uptime report is at EVAL.", "june: The pirate report is done.", "june: Ship is ready.", "june: yes, it runs on hub."]);
});
