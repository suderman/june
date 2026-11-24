// Run history and leaderboard for roster agents, stored in June's SQLite database (june.sqlite, WAL mode).
// Recorded by org-dispatch on launch, finish, retry, handoff and park, and read by `june agents leaderboard`,
// `june agents history`, June's tools, and the agents board.
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const RUN_OUTCOMES = ["running", "done", "eval", "ask", "hold", "retry", "handoff", "parked", "stopped"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export type AgentRun = {
	id: string;
	taskId: string;
	taskTitle: string;
	agent: string;
	harness: string;
	host: string;
	model: string;
	startedAt: number;
	endedAt?: number;
	outcome: RunOutcome;
	switches: number;
	note: string;
};

export type AgentStats = {
	agent: string;
	rank: number;
	runs: number;
	/** Runs that finished normally for review or completion (done + eval). */
	completed: number;
	done: number;
	eval: number;
	ask: number;
	hold: number;
	retry: number;
	handoffs: number;
	parked: number;
	stopped: number;
	running: number;
	avgDurationMs?: number;
	lastRunAt?: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_runs (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	task_title TEXT NOT NULL DEFAULT '',
	agent TEXT NOT NULL,
	harness TEXT NOT NULL DEFAULT '',
	host TEXT NOT NULL DEFAULT '',
	model TEXT NOT NULL DEFAULT '',
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	outcome TEXT NOT NULL DEFAULT 'running',
	switches INTEGER NOT NULL DEFAULT 0,
	note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id, started_at DESC);
`;

function openWritable(dbPath: string): DatabaseSync {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
	db.exec(SCHEMA);
	return db;
}

function openReadable(dbPath: string): DatabaseSync | undefined {
	if (!existsSync(dbPath)) return undefined;
	const db = new DatabaseSync(dbPath, { readOnly: true });
	db.exec("PRAGMA busy_timeout = 2000;");
	const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'").get();
	if (!exists) {
		db.close();
		return undefined;
	}
	return db;
}

export function normalizeOutcome(value: string): RunOutcome {
	const lower = value.trim().toLowerCase();
	if ((RUN_OUTCOMES as readonly string[]).includes(lower)) return lower as RunOutcome;
	throw new Error(`outcome must be one of ${RUN_OUTCOMES.join(", ")}`);
}

export type RunStartInput = {
	run: string;
	taskId: string;
	taskTitle?: string;
	agent: string;
	harness?: string;
	host?: string;
	model?: string;
	startedAt?: number;
};

/** Record the start of a dispatched agent run. Idempotent by run UUID. */
export function recordRunStart(dbPath: string, input: RunStartInput): void {
	if (!input.run.trim()) throw new Error("run id is required");
	if (!input.taskId.trim()) throw new Error("task id is required");
	if (!input.agent.trim()) throw new Error("agent is required");
	const db = openWritable(dbPath);
	try {
		db.prepare(
			`INSERT INTO agent_runs (id, task_id, task_title, agent, harness, host, model, started_at, ended_at, outcome, switches, note)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'running', 0, '')
			 ON CONFLICT(id) DO UPDATE SET
			   task_id = excluded.task_id,
			   task_title = CASE WHEN excluded.task_title != '' THEN excluded.task_title ELSE agent_runs.task_title END,
			   agent = excluded.agent,
			   harness = CASE WHEN excluded.harness != '' THEN excluded.harness ELSE agent_runs.harness END,
			   host = CASE WHEN excluded.host != '' THEN excluded.host ELSE agent_runs.host END,
			   model = CASE WHEN excluded.model != '' THEN excluded.model ELSE agent_runs.model END`,
		).run(
			input.run.trim(),
			input.taskId.trim(),
			(input.taskTitle ?? "").trim(),
			input.agent.trim().toLowerCase(),
			(input.harness ?? "").trim().toLowerCase(),
			(input.host ?? "").trim(),
			(input.model ?? "").trim(),
			Math.round(input.startedAt ?? Date.now()),
		);
	} finally {
		db.close();
	}
}

export type RunEndInput = {
	run: string;
	outcome: string;
	taskId?: string;
	taskTitle?: string;
	agent?: string;
	harness?: string;
	host?: string;
	model?: string;
	startedAt?: number;
	endedAt?: number;
	switches?: number;
	note?: string;
};

/** Record the end of a dispatched agent run, inserting a completed row if start was not previously recorded. */
export function recordRunEnd(dbPath: string, input: RunEndInput): void {
	if (!input.run.trim()) throw new Error("run id is required");
	const outcome = normalizeOutcome(input.outcome);
	const endedAt = Math.round(input.endedAt ?? Date.now());
	const switches = Math.max(0, Math.round(input.switches ?? 0));
	const note = (input.note ?? "").trim().slice(0, 500);
	const db = openWritable(dbPath);
	try {
		const res = db
			.prepare(
				`UPDATE agent_runs
				 SET ended_at = ?, outcome = ?, switches = MAX(switches, ?),
				     note = CASE WHEN ? != '' THEN ? ELSE note END
				 WHERE id = ?`,
			)
			.run(endedAt, outcome, switches, note, note, input.run.trim());
		if (res.changes === 0 && input.taskId?.trim() && input.agent?.trim()) {
			const startedAt = Math.round(input.startedAt ?? endedAt);
			db.prepare(
				`INSERT INTO agent_runs (id, task_id, task_title, agent, harness, host, model, started_at, ended_at, outcome, switches, note)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				input.run.trim(),
				input.taskId.trim(),
				(input.taskTitle ?? "").trim(),
				input.agent.trim().toLowerCase(),
				(input.harness ?? "").trim().toLowerCase(),
				(input.host ?? "").trim(),
				(input.model ?? "").trim(),
				startedAt,
				endedAt,
				outcome,
				switches,
				note,
			);
		}
	} finally {
		db.close();
	}
}

type RawRow = {
	id: string;
	task_id: string;
	task_title: string;
	agent: string;
	harness: string;
	host: string;
	model: string;
	started_at: number;
	ended_at: number | null;
	outcome: string;
	switches: number;
	note: string;
};

function mapRow(r: RawRow): AgentRun {
	return {
		id: r.id,
		taskId: r.task_id,
		taskTitle: r.task_title,
		agent: r.agent,
		harness: r.harness,
		host: r.host,
		model: r.model,
		startedAt: r.started_at,
		...(r.ended_at !== null ? { endedAt: r.ended_at } : {}),
		outcome: (RUN_OUTCOMES as readonly string[]).includes(r.outcome) ? (r.outcome as RunOutcome) : "stopped",
		switches: r.switches,
		note: r.note,
	};
}

/** Recent agent runs, newest first, optionally filtered to one agent slug. */
export function listRuns(dbPath: string, opts: { agent?: string; limit?: number; sinceMs?: number } = {}): AgentRun[] {
	const db = openReadable(dbPath);
	if (!db) return [];
	try {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (opts.agent) {
			where.push("agent = ?");
			params.push(opts.agent.trim().toLowerCase());
		}
		if (opts.sinceMs !== undefined) {
			where.push("started_at >= ?");
			params.push(Math.round(opts.sinceMs));
		}
		const limit = Math.max(1, Math.min(500, Math.round(opts.limit ?? 30)));
		params.push(limit);
		const sql = `SELECT id, task_id, task_title, agent, harness, host, model, started_at, ended_at, outcome, switches, note
			FROM agent_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			ORDER BY started_at DESC LIMIT ?`;
		return (db.prepare(sql).all(...params) as RawRow[]).map(mapRow);
	} finally {
		db.close();
	}
}

/** Per-agent leaderboard, ranked by completions (done + eval), then completion rate, then total runs. */
export function leaderboard(dbPath: string, opts: { sinceMs?: number } = {}): AgentStats[] {
	const db = openReadable(dbPath);
	if (!db) return [];
	try {
		const where = opts.sinceMs !== undefined ? "WHERE started_at >= ?" : "";
		const params = opts.sinceMs !== undefined ? [Math.round(opts.sinceMs)] : [];
		const rows = db
			.prepare(
				`SELECT agent, outcome, started_at, ended_at FROM agent_runs ${where} ORDER BY started_at DESC`,
			)
			.all(...params) as { agent: string; outcome: string; started_at: number; ended_at: number | null }[];
		const map = new Map<string, AgentStats & { durationSum: number; durationCount: number }>();
		for (const r of rows) {
			let s = map.get(r.agent);
			if (!s) {
				s = { agent: r.agent, rank: 0, runs: 0, completed: 0, done: 0, eval: 0, ask: 0, hold: 0, retry: 0, handoffs: 0, parked: 0, stopped: 0, running: 0, durationSum: 0, durationCount: 0 };
				map.set(r.agent, s);
			}
			s.runs++;
			if (s.lastRunAt === undefined || r.started_at > s.lastRunAt) s.lastRunAt = r.started_at;
			switch (r.outcome) {
				case "done": s.done++; s.completed++; break;
				case "eval": s.eval++; s.completed++; break;
				case "ask": s.ask++; break;
				case "hold": s.hold++; break;
				case "retry": s.retry++; break;
				case "handoff": s.handoffs++; break;
				case "parked": s.parked++; break;
				case "running": s.running++; break;
				default: s.stopped++; break;
			}
			if (r.ended_at !== null && r.ended_at >= r.started_at) {
				s.durationSum += r.ended_at - r.started_at;
				s.durationCount++;
			}
		}
		const list: AgentStats[] = [...map.values()].map(({ durationSum, durationCount, ...rest }) => ({
			...rest,
			...(durationCount > 0 ? { avgDurationMs: Math.round(durationSum / durationCount) } : {}),
		}));
		const rate = (s: AgentStats) => {
			const finished = s.runs - s.running;
			return finished > 0 ? s.completed / finished : 0;
		};
		list.sort((a, b) => b.completed - a.completed || rate(b) - rate(a) || b.runs - a.runs || (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) || a.agent.localeCompare(b.agent));
		list.forEach((s, i) => {
			s.rank = i + 1;
		});
		return list;
	} finally {
		db.close();
	}
}

/** Stats and recent runs keyed by agent slug, for the agents board. */
export function statsByAgent(dbPath: string, recentLimit = 5): { stats: Map<string, AgentStats>; recent: Map<string, AgentRun[]> } {
	const stats = new Map<string, AgentStats>();
	const recent = new Map<string, AgentRun[]>();
	for (const s of leaderboard(dbPath)) stats.set(s.agent, s);
	if (stats.size === 0) return { stats, recent };
	const db = openReadable(dbPath);
	if (!db) return { stats, recent };
	try {
		const stmt = db.prepare(
			"SELECT id, task_id, task_title, agent, harness, host, model, started_at, ended_at, outcome, switches, note FROM agent_runs WHERE agent = ? ORDER BY started_at DESC LIMIT ?",
		);
		for (const agent of stats.keys()) {
			recent.set(agent, (stmt.all(agent, recentLimit) as RawRow[]).map(mapRow));
		}
		return { stats, recent };
	} finally {
		db.close();
	}
}
