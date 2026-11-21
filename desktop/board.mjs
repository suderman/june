// The agents and projects boards as both clients draw them (see "Agents and projects" in docs/interfaces.org): the
// window's layout, and the daemon's agenda and agents boards (src/board.ts) shaped into sections and rows. Plain
// JavaScript that QML's engine, QuickJS on the phone, and Node all run: no flatMap, no .at().

/** The side columns' width and the gaps around them, and the strip's narrowest and widest. */
export const SIDE = 268;
export const GAP = 20;
export const MIN_STRIP = 680;
export const MAX_STRIP = 820;

/**
 * How a window `width` wide lays out: three columns (agents, the strip, projects) while the strip keeps at least
 * MIN_STRIP, giving up some of its width first; otherwise tabs, the strip as wide as fits.
 */
export function boardLayout(width) {
	const strip = Math.min(MAX_STRIP, width - 2 * (SIDE + GAP) - 2 * GAP);
	if (strip >= MIN_STRIP) return { columns: true, side: SIDE, gap: GAP, strip: strip };
	return { columns: false, side: 0, gap: GAP, strip: Math.min(MAX_STRIP, width) };
}

/** Each state's chip: fill and ink, ink also the outline; both pass 4.5:1. */
export const CHIPS = {
	TODO: { fill: "#ffd6cf", ink: "#8a1f12" },
	PROG: { fill: "#d7e4f2", ink: "#1c3a66" },
	EVAL: { fill: "#ebe5ff", ink: "#3d3466" },
	HOLD: { fill: "#fff3c4", ink: "#6b4e00" },
	AUTO: { fill: "#d4efe9", ink: "#0f5148" },
	DONE: { fill: "#dfead6", ink: "#2f5a22" },
};

/** The order the state counts come in: work in hand first. */
export const COUNT_ORDER = ["PROG", "EVAL", "HOLD", "AUTO", "TODO"];

/** A placeholder clanker's colours by harness, until the art lands: Pi teal, Claude orange, any other yellow. */
export const HARNESS = {
	pi: { eye: "#1fa89a", band: "#2a8f84" },
	claude: { eye: "#f08a3e", band: "#d9692a" },
	other: { eye: "#e0b419", band: "#b8911a" },
};

/** The chip and clanker colours together, for clients that cannot read the constants directly (the phone). */
export function colours() {
	return { chips: CHIPS, harness: HARNESS };
}

export function harnessOf(agent) {
	const name = String(agent ?? "").replace(/-code$/, "");
	return HARNESS[name] ? name : "other";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A YYYY-MM-DD date's weekday and day, read as the calendar date it names. */
function calendar(date) {
	const [y, m, d] = String(date).split("-").map(Number);
	const at = new Date(Date.UTC(y, m - 1, d, 12));
	return { weekday: WEEKDAYS[at.getUTCDay()], month: MONTHS[m - 1], day: d };
}

/** "SAT NOV 21" for a day heading. */
export function dayHeading(date) {
	const c = calendar(date);
	return `${c.weekday} ${c.month} ${c.day}`.toUpperCase();
}

/** The link that opens a task in Emacs at its heading line (june-open, through the clients' file links). */
export function taskLink(task) {
	return task?.file ? `file:~/org/${task.file}::${task.line}` : null;
}

/** Org's agenda prefix for an entry ("Sched. 3x:", "In 7 d.:") as plain words. */
export function entryMeta(entry, task) {
	const extra = String(entry.extra ?? "");
	let when = "";
	let n = /Sched\.\s*(\d+)x/.exec(extra);
	if (n) when = `scheduled ${n[1]} day${n[1] === "1" ? "" : "s"} ago`;
	else if ((n = /(\d+)\s*d\.\s*ago/.exec(extra))) when = `deadline ${n[1]} day${n[1] === "1" ? "" : "s"} ago`;
	else if ((n = /In\s+(\d+)\s*d\./.exec(extra))) when = `due in ${n[1]} day${n[1] === "1" ? "" : "s"}`;
	else if ((n = /\((\d+)\/(\d+)\)/.exec(extra))) when = `day ${n[1]} of ${n[2]}`;
	else if (entry.type === "deadline") when = "due";
	else if (entry.type === "scheduled") when = "scheduled";
	const who = task?.state === "AUTO" && task.agent ? `${task.agent} on ${task.host ?? "?"}` : "";
	return [when, who, task?.project ?? ""].filter((s) => s !== "").join(" · ");
}

function row(entry, agenda, extra) {
	const task = agenda.tasks[entry.task];
	return Object.assign({
		key: `${entry.task}|${entry.type}|${entry.date ?? ""}`,
		task: entry.task,
		state: task?.state ?? "",
		title: task?.title ?? entry.task,
		time: entry.time ?? "",
		meta: entryMeta(entry, task),
		link: taskLink(task),
	}, extra);
}

/**
 * The agenda board as sections of rows: overdue, today, and the rest of the week with each day's name on its first
 * row; then the counts by state and the projects with open work.
 */
export function agendaView(agenda) {
	if (!agenda) return { sections: [], counts: [], projects: [], today: "" };
	const sections = [];
	if (agenda.overdue.length > 0)
		sections.push({ id: "overdue", title: `OVERDUE · ${agenda.overdue.length}`, alert: true, rows: agenda.overdue.map((e) => row(e, agenda, { overdue: true })) });
	const first = agenda.days[0];
	sections.push({ id: "today", title: `TODAY · ${dayHeading(agenda.today)}`, alert: false, rows: (first?.entries ?? []).map((e) => row(e, agenda, {})) });
	const week = [];
	for (let i = 1; i < agenda.days.length; i++) {
		const day = agenda.days[i];
		const label = calendar(day.date).weekday;
		day.entries.forEach((e, j) => week.push(row(e, agenda, { day: j === 0 ? label : "" })));
	}
	if (week.length > 0) sections.push({ id: "week", title: "THIS WEEK", alert: false, rows: week });
	const counts = COUNT_ORDER.filter((s) => (agenda.counts[s] ?? 0) > 0).map((s) => ({ state: s, n: agenda.counts[s] }));
	const projects = agenda.projects.map((p) => ({
		file: p.file,
		title: p.title,
		counts: COUNT_ORDER.filter((s) => (p.counts[s] ?? 0) > 0).map((s) => ({ state: s, n: p.counts[s] })),
		link: `file:~/org/${p.file}`,
	}));
	return { sections, counts, projects, today: agenda.today };
}

/** The tasks in one state, for drilling into a count, newest file order kept. */
export function stateRows(agenda, state) {
	if (!agenda) return [];
	const rows = [];
	for (const key of Object.keys(agenda.tasks)) {
		const t = agenda.tasks[key];
		if (t.state === state) rows.push({ key, task: key, state, title: t.title, time: "", meta: t.project, link: taskLink(t) });
	}
	return rows;
}

/** "3 min", "2 h", "4 d" since `at` (epoch ms). */
export function since(at, now) {
	const s = Math.max(0, (now - at) / 1000);
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
	if (s < 86400) return `${Math.round(s / 3600)} h`;
	return `${Math.round(s / 86400)} d`;
}

/** "Sat 04:30", or "today 04:30", for an Org timestamp's start. */
export function startOf(stamp, today) {
	const m = /(\d{4}-\d{2}-\d{2})(?: \S+)?(?: (\d{1,2}:\d{2}))?/.exec(String(stamp ?? ""));
	if (!m) return "";
	const day = m[1] === today ? "today" : calendar(m[1]).weekday;
	return m[2] ? `${day} ${m[2]}` : day;
}

/** The agent a task's newest Herdr link names, pi or claude, else its AGENT. */
function taskAgent(task) {
	const last = task?.sessions?.length ? task.sessions[task.sessions.length - 1] : "";
	const m = /^herdr:[^/]+\/([a-z]+):/.exec(last);
	return m ? m[1] : (task?.agent ?? "");
}

/** The first line of a task's last Dialog entry not written by the user, else its headline. */
function lastWord(task, user) {
	const dialog = task?.dialog ?? [];
	for (let i = dialog.length - 1; i >= 0; i--) {
		if (dialog[i].who !== user) return String(dialog[i].text).split("\n")[0];
	}
	return task?.headline?.text ?? "";
}

/**
 * The agents board as the clankers' room: what needs the user (most urgent first), who is working, who is idle, what
 * is queued and under agent review, and what reported today. `today` is YYYY-MM-DD for start times; `user` signs
 * the user's Dialog entries.
 */
export function agentsView(agents, now, today, user) {
	if (!agents) return { summary: "", needs: [], working: [], idle: [], queued: [], reviewing: [], recent: [], down: [] };
	const tasks = agents.tasks;
	const workerOf = (key) => agents.workers.find((w) => w.taskKey === key);
	const needs = agents.needs.map((n) => {
		const task = n.task ? tasks[n.task] : undefined;
		if (n.kind === "blocked") {
			const w = agents.workers.find((x) => x.host === n.worker?.host && x.terminal === n.worker?.terminal);
			return {
				key: `blocked|${n.worker?.host}|${n.worker?.terminal}`, level: 1, kind: n.kind, label: "NEEDS PERMISSION",
				title: task?.title ?? w?.title ?? w?.cwd ?? "an agent", line: w?.title ?? "", harness: harnessOf(w?.agent),
				where: `${n.worker?.host} · ${n.worker?.terminal}`, action: "Open in Herdr", link: w?.herdrLink ?? null,
			};
		}
		const w = workerOf(n.task);
		return {
			key: `${n.kind}|${n.task}`, level: n.level, kind: n.kind,
			label: n.kind === "asks" ? "ASKS YOU" : "READY FOR YOUR REVIEW",
			title: task?.title ?? n.task,
			line: n.kind === "asks" ? lastWord(task, user) : (task?.headline?.text ?? ""),
			harness: harnessOf(taskAgent(task)),
			where: `${task?.host ?? w?.host ?? ""}${task?.host || w?.host ? " · " : ""}${task?.state ?? ""}`,
			action: "Open in Emacs", link: taskLink(task),
		};
	});
	const blocked = new Set(needs.filter((n) => n.kind === "blocked").map((n) => n.key));
	const worker = (w) => {
		const task = w.taskKey ? tasks[w.taskKey] : undefined;
		const place = String(w.cwd ?? "").split("/").filter((s) => s !== "");
		return {
			key: `${w.host}|${w.terminal}`, harness: harnessOf(w.agent), status: w.status,
			title: task?.title ?? w.title ?? (place.length ? place[place.length - 1] : w.terminal),
			where: `${w.agent} · ${w.host}/${w.terminal}`, link: w.herdrLink ?? null,
		};
	};
	const working = agents.workers.filter((w) => w.status === "working").map(worker);
	const idle = agents.workers.filter((w) => w.status !== "working" && !blocked.has(`blocked|${w.host}|${w.terminal}`)).map(worker);
	const queued = agents.queued.map((key) => {
		const t = tasks[key];
		const dep = t.dependency && t.dependency.kind !== "ready" ? `waits on ${t.dependency.reason ?? "a task"}` : "";
		return { key, title: t.title, who: `${t.agent ?? "?"} on ${t.host ?? "?"}`, when: dep || startOf(t.scheduled, today) || "now", link: taskLink(t) };
	});
	const reviewing = agents.reviewing.map((key) => {
		const t = tasks[key];
		return { key, title: t.title, who: t.reviewParent ? "the review" : "under agent review", link: taskLink(t) };
	});
	const recent = agents.recent.map((key) => {
		const t = tasks[key];
		return { key, title: t.title, state: t.state, harness: harnessOf(taskAgent(t)), line: t.headline?.text ?? "", when: t.headline?.at ? since(t.headline.at, now) : "", link: taskLink(t) };
	});
	const hosts = agents.hosts.filter((h) => h.ok).map((h) => h.host);
	const summary = `${working.length} at work${hosts.length ? ` on ${hosts.join(", ")}` : ""}`;
	const down = agents.hosts.filter((h) => !h.ok).map((h) => h.host);
	return { summary, needs, working, idle, queued, reviewing, recent, down };
}
