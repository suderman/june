import assert from "node:assert/strict";
import { test } from "node:test";
import { renderUsage, type Row, summarize } from "../src/usage.ts";

const call = (id: number, conversation: number, name: string, args: unknown, at = 2000): Row => ({ id, conversation, record: { kind: "pi.assistant", model: [{ timestamp: at, content: [{ type: "toolCall", name, arguments: args }] }] } });
const pick = (id: number, expression: string, pose?: string, at = 2000, take = 0): Row => ({ id, conversation: 1, record: { kind: "june.expression", data: { expression, ...(pose ? { pose } : {}), selectedAt: at, take } } });

test("usage counts her tools apart from her working contexts, her skills and journal, and the director's picks", () => {
	const rows = [
		call(1, 1, "journal", { title: "x" }),
		call(2, 1, "bash", { command: "rg -n walk ~/org/june/JOURNAL.org" }),
		call(3, 7, "read", { path: "/home/a/org/june/JOURNAL.org" }),
		call(4, 1, "skill_read", { name: "unslop" }),
		call(5, 1, "timeline", { query: "walk" }),
		call(6, 1, "bash", { command: "old" }, 500),
		pick(10, "wry", "knowing"),
		pick(11, "wry", "knowing"),
		pick(12, "serious", "report", 2000, 1),
		pick(13, "wry", "old", 500),
	];
	const pool = { poses: { knowing: { expression: "wry" }, mug: { expression: "wry" }, report: { expression: "serious" }, laugh: { expression: "laughing" }, typing: { expression: "determined", activity: "working" } }, personal: ["knowing", "report", "laugh"] };
	const u = summarize(rows, 1000, ["journal", "bash", "read", "skill_read", "timeline", "phone"], pool);
	assert.deepEqual(u.tools.main, [["bash", 1], ["journal", 1], ["skill_read", 1], ["timeline", 1]], "only since the start, her own conversation");
	assert.deepEqual(u.tools.work, [["read", 1]]);
	assert.deepEqual(u.tools.unused, ["phone"]);
	assert.deepEqual(u.skills, [["unslop", 1]]);
	assert.deepEqual(u.journal, { writes: 1, reads: 2, timeline: 1 }, "reads in either place count, the journal tool's writes do not");
	assert.equal(u.art.picks, 3);
	assert.equal(u.art.repeatPose, 1);
	assert.equal(u.art.retakes, 1);
	assert.deepEqual(u.art.never, [{ pose: "laugh", face: "laughing", placeholder: false }, { pose: "mug", face: "wry", placeholder: true }], "an activity pose is not the director's to pick");
	assert.deepEqual(u.art.faces.slice(0, 2), [{ face: "wry", picks: 2, poses: 2 }, { face: "serious", picks: 1, poses: 1 }]);
	const text = renderUsage(u);
	assert.match(text, /journal: 1 written, 2 read or searched, 1 timeline searches/);
	assert.match(text, /never picked: laugh, mug \(placeholder\)/);
	assert.match(text, /not art but direction: laughing has poses the director never chose/);
});
