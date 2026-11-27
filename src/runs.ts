// Run history and leaderboard for roster agents, stored in June's SQLite database (june.sqlite, WAL mode).
// Recorded by org-dispatch on launch, finish, retry, handoff and park, and read by `june agents leaderboard`,
// `june agents history`, June's tools, and the agents board.
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const RUN_OUTCOMES = ["running", "done", "eval", "ask", "hold", "retry", "handoff", "parked", "stopped"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const RUN_RATINGS = ["good", "mixed", "poor"] as const;
export type RunRating = (typeof RUN_RATINGS)[number];

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
	rating?: RunRating;
	ratingNote?: string;
	ratedAt?: number;
};

export type ModelStats = {
	model: string;
	runs: number;
	completed: number;
	failed: number;
	xp: number;
	good: number;
	mixed: number;
	poor: number;
};

export type LevelInfo = {
	level: number;
	title: string;
	xp: number;
	nextLevelXp: number;
};

export type AgentStats = {
	agent: string;
	rank: number;
	runs: number;
	/** Runs that finished normally for review or completion (done + eval). */
	completed: number;
	/** Runs that hit friction or failed to finish (retry + handoffs + parked). */
	failed: number;
	done: number;
	eval: number;
	ask: number;
	hold: number;
	retry: number;
	handoffs: number;
	parked: number;
	stopped: number;
	running: number;
	good: number;
	mixed: number;
	poor: number;
	xp: number;
	level: number;
	title: string;
	nextLevelXp: number;
	models: ModelStats[];
	avgDurationMs?: number;
	lastRunAt?: number;
};

const OUTCOME_XP: Record<RunOutcome, number> = {
	done: 25,
	eval: 20,
	ask: 5,
	hold: 5,
	retry: -5,
	handoff: -10,
	parked: -15,
	stopped: 0,
	running: 0,
};

const RATING_XP: Record<RunRating, number> = {
	good: 15,
	mixed: 0,
	poor: -20,
};

const LEVELS: readonly { minXp: number; title: string }[] = [
	{ minXp: 0, title: "rookie" },
	{ minXp: 50, title: "hand" },
	{ minXp: 125, title: "regular" },
	{ minXp: 250, title: "veteran" },
	{ minXp: 450, title: "specialist" },
	{ minXp: 750, title: "ace" },
	{ minXp: 1150, title: "legend" },
];

/** Deterministic XP earned (or lost) by one run from its outcome and optional review rating. */
export function runXp(run: { outcome: RunOutcome; rating?: RunRating }): number {
	return (OUTCOME_XP[run.outcome] ?? 0) + (run.rating ? (RATING_XP[run.rating] ?? 0) : 0);
}

/** Map non-negative XP to a clanker's level, title, and threshold for the next level. */
export function levelOf(rawXp: number): LevelInfo {
	const xp = Math.max(0, Math.round(rawXp));
	const last = LEVELS[LEVELS.length - 1]!;
	if (xp >= last.minXp) {
		const extra = Math.floor((xp - last.minXp) / 500);
		return { level: LEVELS.length + extra, title: last.title, xp, nextLevelXp: last.minXp + (extra + 1) * 500 };
	}
	let index = 0;
	for (let i = LEVELS.length - 1; i >= 0; i--) {
		if (xp >= LEVELS[i]!.minXp) {
			index = i;
			break;
		}
	}
	return { level: index + 1, title: LEVELS[index]!.title, xp, nextLevelXp: LEVELS[index + 1]!.minXp };
}

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
	note TEXT NOT NULL DEFAULT '',
	rating TEXT NOT NULL DEFAULT '',
	rating_note TEXT NOT NULL DEFAULT '',
	rated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id, started_at DESC);
`;

function columnsOf(db: DatabaseSync): Set<string> {
	return new Set((db.prepare("PRAGMA table_info(agent_runs)").all() as { name: string }[]).map((c) => c.name));
}

function ensureRatingColumns(db: DatabaseSync): void {
	const cols = columnsOf(db);
	if (!cols.has("rating")) db.exec("ALTER TABLE agent_runs ADD COLUMN rating TEXT NOT NULL DEFAULT ''");
	if (!cols.has("rating_note")) db.exec("ALTER TABLE agent_runs ADD COLUMN rating_note TEXT NOT NULL DEFAULT ''");
	if (!cols.has("rated_at")) db.exec("ALTER TABLE agent_runs ADD COLUMN rated_at INTEGER");
}

function openWritable(dbPath: string, busyTimeoutMs = 5000): DatabaseSync {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.round(busyTimeoutMs))};`);
	// Checking journal_mode before setting WAL avoids taking an EXCLUSIVE lock on every write while the daemon reads june.sqlite.
	const mode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined)?.journal_mode?.toLowerCase();
	if (mode !== "wal") db.exec("PRAGMA journal_mode = WAL;");
	const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'").get();
	if (!exists) db.exec(SCHEMA);
	else ensureRatingColumns(db);
	return db;
}

function openReadable(dbPath: string): { db: DatabaseSync; hasRating: boolean } | undefined {
	if (!existsSync(dbPath)) return undefined;
	const db = new DatabaseSync(dbPath, { readOnly: true });
	db.exec("PRAGMA busy_timeout = 2000;");
	const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'").get();
	if (!exists) {
		db.close();
		return undefined;
	}
	return { db, hasRating: columnsOf(db).has("rating") };
}

export function normalizeOutcome(value: string): RunOutcome {
	const lower = value.trim().toLowerCase();
	if ((RUN_OUTCOMES as readonly string[]).includes(lower)) return lower as RunOutcome;
	throw new Error(`outcome must be one of ${RUN_OUTCOMES.join(", ")}`);
}

export function normalizeRating(value: string): RunRating {
	const lower = value.trim().toLowerCase();
	if ((RUN_RATINGS as readonly string[]).includes(lower)) return lower as RunRating;
	throw new Error(`rating must be one of ${RUN_RATINGS.join(", ")}`);
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

export type RateRunInput = {
	run: string;
	rating: string;
	note?: string;
	ratedAt?: number;
};

/** Record a review rating and optional coaching note on a finished run; returns the updated run. */
export function rateRun(dbPath: string, input: RateRunInput, busyTimeoutMs = 5000): AgentRun {
	const id = input.run.trim();
	if (!id) throw new Error("run id is required");
	const rating = normalizeRating(input.rating);
	const note = (input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
	const ratedAt = Math.round(input.ratedAt ?? Date.now());
	const db = openWritable(dbPath, busyTimeoutMs);
	try {
		const row = db
			.prepare("SELECT id, task_id, task_title, agent, harness, host, model, started_at, ended_at, outcome, switches, note, rating, rating_note, rated_at FROM agent_runs WHERE id = ?")
			.get(id) as RawRow | undefined;
		if (!row) throw new Error(`no run found with id ${id}`);
		if (row.outcome === "running") throw new Error(`cannot rate run ${id} while it is still running`);
		db.prepare("UPDATE agent_runs SET rating = ?, rating_note = ?, rated_at = ? WHERE id = ?").run(rating, note, ratedAt, id);
		return mapRow({ ...row, rating, rating_note: note, rated_at: ratedAt });
	} finally {
		db.close();
	}
}

/** In-process async wrapper for rateRun: yields the event loop on SQLITE_BUSY so the daemon's own SQLite transaction can commit. */
export async function rateRunAsync(dbPath: string, input: RateRunInput, maxWaitMs = 5000): Promise<AgentRun> {
	const deadline = Date.now() + maxWaitMs;
	for (;;) {
		try {
			return rateRun(dbPath, input, 50);
		} catch (error) {
			const msg = (error as Error)?.message ?? "";
			if (!/database is locked|SQLITE_BUSY/i.test(msg) || Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
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
	rating?: string;
	rating_note?: string;
	rated_at?: number | null;
};

const SELECT_BASE = "id, task_id, task_title, agent, harness, host, model, started_at, ended_at, outcome, switches, note";
const selectColumns = (hasRating: boolean) => (hasRating ? `${SELECT_BASE}, rating, rating_note, rated_at` : SELECT_BASE);

function mapRow(r: RawRow): AgentRun {
	const rating = r.rating && (RUN_RATINGS as readonly string[]).includes(r.rating) ? (r.rating as RunRating) : undefined;
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
		...(rating ? { rating } : {}),
		...(r.rating_note ? { ratingNote: r.rating_note } : {}),
		...(r.rated_at !== null && r.rated_at !== undefined ? { ratedAt: r.rated_at } : {}),
	};
}

/** Recent agent runs, newest first, optionally filtered to one agent slug. */
export function listRuns(dbPath: string, opts: { agent?: string; limit?: number; sinceMs?: number } = {}): AgentRun[] {
	const opened = openReadable(dbPath);
	if (!opened) return [];
	const { db, hasRating } = opened;
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
		const sql = `SELECT ${selectColumns(hasRating)}
			FROM agent_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			ORDER BY started_at DESC LIMIT ?`;
		return (db.prepare(sql).all(...params) as RawRow[]).map(mapRow);
	} finally {
		db.close();
	}
}

/** Per-agent leaderboard, ranked by XP (from outcomes and review ratings), then completions, completion rate, and runs. */
export function leaderboard(dbPath: string, opts: { sinceMs?: number; agents?: readonly string[] } = {}): AgentStats[] {
	const opened = openReadable(dbPath);
	if (!opened) return [];
	const { db, hasRating } = opened;
	try {
		const where = opts.sinceMs !== undefined ? "WHERE started_at >= ?" : "";
		const params = opts.sinceMs !== undefined ? [Math.round(opts.sinceMs)] : [];
		const filter = opts.agents ? new Set(opts.agents.map((a) => a.trim().toLowerCase())) : undefined;
		const rows = db
			.prepare(
				`SELECT agent, model, outcome, started_at, ended_at${hasRating ? ", rating" : ""} FROM agent_runs ${where} ORDER BY started_at DESC`,
			)
			.all(...params) as { agent: string; model: string; outcome: string; started_at: number; ended_at: number | null; rating?: string }[];
		type Acc = Omit<AgentStats, "xp" | "level" | "title" | "nextLevelXp" | "models"> & {
			rawXp: number;
			durationSum: number;
			durationCount: number;
			models: Map<string, Omit<ModelStats, "xp"> & { rawXp: number }>;
		};
		const map = new Map<string, Acc>();
		for (const r of rows) {
			if (filter && !filter.has(r.agent)) continue;
			let s = map.get(r.agent);
			if (!s) {
				s = {
					agent: r.agent,
					rank: 0,
					runs: 0,
					completed: 0,
					failed: 0,
					done: 0,
					eval: 0,
					ask: 0,
					hold: 0,
					retry: 0,
					handoffs: 0,
					parked: 0,
					stopped: 0,
					running: 0,
					good: 0,
					mixed: 0,
					poor: 0,
					rawXp: 0,
					durationSum: 0,
					durationCount: 0,
					models: new Map(),
				};
				map.set(r.agent, s);
			}
			const outcome: RunOutcome = (RUN_OUTCOMES as readonly string[]).includes(r.outcome) ? (r.outcome as RunOutcome) : "stopped";
			const rating = r.rating && (RUN_RATINGS as readonly string[]).includes(r.rating) ? (r.rating as RunRating) : undefined;
			const delta = runXp({ outcome, ...(rating ? { rating } : {}) });
			s.runs++;
			s.rawXp += delta;
			if (s.lastRunAt === undefined || r.started_at > s.lastRunAt) s.lastRunAt = r.started_at;
			let isCompleted = false;
			let isFailed = false;
			switch (outcome) {
				case "done": s.done++; s.completed++; isCompleted = true; break;
				case "eval": s.eval++; s.completed++; isCompleted = true; break;
				case "ask": s.ask++; break;
				case "hold": s.hold++; break;
				case "retry": s.retry++; s.failed++; isFailed = true; break;
				case "handoff": s.handoffs++; s.failed++; isFailed = true; break;
				case "parked": s.parked++; s.failed++; isFailed = true; break;
				case "running": s.running++; break;
				default: s.stopped++; break;
			}
			if (rating === "good") s.good++;
			else if (rating === "mixed") s.mixed++;
			else if (rating === "poor") s.poor++;
			if (r.ended_at !== null && r.ended_at >= r.started_at) {
				s.durationSum += r.ended_at - r.started_at;
				s.durationCount++;
			}
			const modelKey = r.model.trim() || "(default)";
			let m = s.models.get(modelKey);
			if (!m) {
				m = { model: modelKey, runs: 0, completed: 0, failed: 0, rawXp: 0, good: 0, mixed: 0, poor: 0 };
				s.models.set(modelKey, m);
			}
			m.runs++;
			if (isCompleted) m.completed++;
			if (isFailed) m.failed++;
			m.rawXp += delta;
			if (rating === "good") m.good++;
			else if (rating === "mixed") m.mixed++;
			else if (rating === "poor") m.poor++;
		}
		const list: AgentStats[] = [...map.values()].map(({ rawXp, durationSum, durationCount, models, ...rest }) => {
			const lv = levelOf(rawXp);
			return {
				...rest,
				xp: lv.xp,
				level: lv.level,
				title: lv.title,
				nextLevelXp: lv.nextLevelXp,
				models: [...models.values()]
					.map(({ rawXp: mXp, ...mRest }) => ({ ...mRest, xp: Math.max(0, Math.round(mXp)) }))
					.sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model)),
				...(durationCount > 0 ? { avgDurationMs: Math.round(durationSum / durationCount) } : {}),
			};
		});
		const rate = (s: AgentStats) => {
			const finished = s.runs - s.running;
			return finished > 0 ? s.completed / finished : 0;
		};
		list.sort((a, b) => b.xp - a.xp || b.completed - a.completed || rate(b) - rate(a) || b.runs - a.runs || (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) || a.agent.localeCompare(b.agent));
		list.forEach((s, i) => {
			s.rank = i + 1;
		});
		return list;
	} finally {
		db.close();
	}
}

/** Newest running run per task_id, for matching active dispatched workers to their roster clanker. */
export function activeRunsByTask(dbPath: string): Map<string, AgentRun> {
	const map = new Map<string, AgentRun>();
	const opened = openReadable(dbPath);
	if (!opened) return map;
	const { db, hasRating } = opened;
	try {
		const rows = db
			.prepare(
				`SELECT ${selectColumns(hasRating)} FROM agent_runs WHERE outcome = 'running' ORDER BY started_at DESC`,
			)
			.all() as RawRow[];
		for (const r of rows) {
			if (!map.has(r.task_id)) map.set(r.task_id, mapRow(r));
		}
		return map;
	} finally {
		db.close();
	}
}

/** Stats and recent runs keyed by agent slug, for the agents board and team tools. */
export function statsByAgent(dbPath: string, recentLimit = 5, opts: { agents?: readonly string[] } = {}): { stats: Map<string, AgentStats>; recent: Map<string, AgentRun[]> } {
	const stats = new Map<string, AgentStats>();
	const recent = new Map<string, AgentRun[]>();
	for (const s of leaderboard(dbPath, opts)) stats.set(s.agent, s);
	if (stats.size === 0) return { stats, recent };
	const opened = openReadable(dbPath);
	if (!opened) return { stats, recent };
	const { db, hasRating } = opened;
	try {
		const stmt = db.prepare(
			`SELECT ${selectColumns(hasRating)} FROM agent_runs WHERE agent = ? ORDER BY started_at DESC LIMIT ?`,
		);
		for (const agent of stats.keys()) {
			recent.set(agent, (stmt.all(agent, recentLimit) as RawRow[]).map(mapRow));
		}
		return { stats, recent };
	} finally {
		db.close();
	}
}
