// What June actually does, for the user deciding what to tune or drop: the tools she calls (in her conversation and in
// her working contexts), the skills she reads, how she uses her journal, and the director's art picks against the poses
// there are, with where more art would most help. Read-only over the database the daemon writes, which SQLite allows
// while it runs; nothing new is recorded for it.
import { DatabaseSync } from "node:sqlite";
import { EXPRESSIONS } from "./avatar.ts";

/** One entry as the database keeps it. */
export type Row = { id: number; conversation: number; record: { kind?: string; data?: Record<string, unknown>; model?: unknown[] } };

type Count = [name: string, count: number][];
export type Usage = {
	since: number;
	/** Tool calls in her own conversation and in her working contexts, most first; tools she has that went unused. */
	tools: { main: Count; work: Count; unused: string[] };
	skills: Count;
	/** Journal entries written, times she read or searched the journal file herself, and timeline searches. */
	journal: { writes: number; reads: number; timeline: number };
	art: {
		picks: number;
		faces: { face: string; picks: number; poses: number }[];
		poses: { pose: string; face: string; picks: number; placeholder: boolean }[];
		never: { pose: string; face: string; placeholder: boolean }[];
		repeatPose: number;
		repeatFace: number;
		retakes: number;
	};
};

type Pool = { poses?: Record<string, { expression?: string; activity?: string }>; personal?: string[] };

const count = (names: string[]): Count => {
	const c = new Map<string, number>();
	for (const n of names) c.set(n, (c.get(n) ?? 0) + 1);
	return [...c].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

/** The usage in `rows` since `since` (epoch ms), against the tools she has and the poses in `pool`. */
export function summarize(rows: readonly Row[], since: number, tools: readonly string[], pool: Pool | undefined, root = 1): Usage {
	const calls: { name: string; args: unknown; main: boolean }[] = [];
	const picks: { face: string; pose?: string; take: number }[] = [];
	for (const { conversation, record } of rows) {
		const message = record.model?.[0] as { timestamp?: number; content?: unknown } | undefined;
		if (record.kind === "pi.assistant" && (message?.timestamp ?? 0) >= since && Array.isArray(message?.content))
			for (const block of message.content as { type?: string; name?: string; arguments?: unknown }[])
				if (block.type === "toolCall" && block.name) calls.push({ name: block.name, args: block.arguments, main: conversation === root });
		if (record.kind === "june.expression" && Number(record.data?.selectedAt ?? 0) >= since && typeof record.data?.expression === "string")
			picks.push({ face: record.data.expression, ...(typeof record.data.pose === "string" ? { pose: record.data.pose } : {}), take: Number(record.data.take ?? 0) });
	}
	const main = calls.filter((c) => c.main);
	const used = new Set(calls.map((c) => c.name));
	const said = (c: { args: unknown }) => JSON.stringify(c.args ?? "");
	const poses = Object.entries(pool?.poses ?? {}).filter(([, p]) => !p.activity);
	const placeholder = (id: string) => !(pool?.personal ?? []).includes(id);
	const posed = picks.filter((p) => p.pose);
	const byPose = new Map(count(posed.map((p) => p.pose!)));
	const byFace = new Map(count(picks.map((p) => p.face)));
	const faceOf = new Map(poses.map(([id, p]) => [id, p.expression ?? ""]));
	return {
		since,
		tools: { main: count(main.map((c) => c.name)), work: count(calls.filter((c) => !c.main).map((c) => c.name)), unused: tools.filter((t) => !used.has(t)).sort() },
		skills: count(calls.filter((c) => c.name === "skill_read").map((c) => String((c.args as { name?: unknown })?.name ?? "?"))),
		journal: {
			writes: main.filter((c) => c.name === "journal").length,
			reads: calls.filter((c) => c.name !== "journal" && /JOURNAL\.org/.test(said(c))).length,
			timeline: main.filter((c) => c.name === "timeline").length,
		},
		art: {
			picks: picks.length,
			faces: Object.keys(EXPRESSIONS)
				.map((face) => ({ face, picks: byFace.get(face) ?? 0, poses: poses.filter(([, p]) => p.expression === face).length }))
				.sort((a, b) => b.picks - a.picks || a.face.localeCompare(b.face)),
			poses: [...byPose].map(([pose, n]) => ({ pose, face: faceOf.get(pose) ?? "?", picks: n, placeholder: faceOf.has(pose) ? placeholder(pose) : false })),
			never: poses.filter(([id]) => !byPose.has(id)).map(([id, p]) => ({ pose: id, face: p.expression ?? "?", placeholder: placeholder(id) })).sort((a, b) => a.face.localeCompare(b.face) || a.pose.localeCompare(b.pose)),
			repeatPose: posed.slice(1).filter((p, i) => p.pose === posed[i]!.pose).length,
			repeatFace: picks.slice(1).filter((p, i) => p.face === picks[i]!.face).length,
			retakes: picks.filter((p) => p.take > 0).length,
		},
	};
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "0%");

/** The report as text: what she uses, what she does not, and where the director's picks say more art would help. */
export function renderUsage(u: Usage): string {
	const list = (c: Count, max = 12) => (c.length ? c.slice(0, max).map(([n, k]) => `${n} ${k}`).join(", ") + (c.length > max ? `, and ${c.length - max} more` : "") : "none");
	const a = u.art;
	// Where art would help most: faces she shows often over few poses, so each picture recurs; then faces she has art for
	// but the director never picks, which want direction rather than drawing.
	const wanted = a.faces.filter((f) => f.picks >= 5).map((f) => ({ ...f, each: f.picks / Math.max(1, f.poses) })).sort((x, y) => y.each - x.each).slice(0, 4);
	const idle = a.faces.filter((f) => f.picks === 0 && f.poses > 0).map((f) => f.face);
	const shown = a.poses.filter((p) => p.placeholder);
	const lines = [
		`Since ${new Date(u.since).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}`,
		"",
		"Tools",
		`  her conversation: ${list(u.tools.main)}`,
		`  working contexts: ${list(u.tools.work)}`,
		`  never used: ${u.tools.unused.join(", ") || "none"}`,
		`  skills read: ${list(u.skills)}`,
		`  journal: ${u.journal.writes} written, ${u.journal.reads} read or searched, ${u.journal.timeline} timeline searches`,
		"",
		`Art: ${a.picks} picks; the same pose twice in a row ${pct(a.repeatPose, a.picks - 1)}, the same face ${pct(a.repeatFace, a.picks - 1)}; ${a.retakes} retakes`,
		`  faces (picks / poses): ${a.faces.filter((f) => f.picks || f.poses).map((f) => `${f.face} ${f.picks}/${f.poses}`).join(", ")}`,
		`  most picked: ${a.poses.sort((x, y) => y.picks - x.picks).slice(0, 8).map((p) => `${p.pose} ${p.picks}`).join(", ")}`,
		`  never picked: ${a.never.length ? a.never.map((p) => `${p.pose}${p.placeholder ? " (placeholder)" : ""}`).join(", ") : "none"}`,
		...(shown.length ? [`  placeholders shown: ${shown.map((p) => `${p.pose} ${p.picks}`).join(", ")}`] : []),
		"",
		"Where more art would help",
		...(wanted.length ? wanted.map((f) => `  ${f.face}: ${f.picks} picks over ${f.poses} pose${f.poses === 1 ? "" : "s"}, ${f.each.toFixed(1)} each`) : ["  nothing stands out yet"]),
		...(idle.length ? [`  not art but direction: ${idle.join(", ")} ${idle.length === 1 ? "has" : "have"} poses the director never chose`] : []),
	];
	return lines.join("\n");
}

/** Every entry in the database at `path`, read-only. */
export function readRows(path: string): Row[] {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return (db.prepare("select id, conversation_id as conversation, record from entries order by id").all() as { id: number; conversation: number; record: string }[]).map((r) => ({
			id: r.id,
			conversation: r.conversation,
			record: JSON.parse(r.record) as Row["record"],
		}));
	} finally {
		db.close();
	}
}
