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

/** A placeholder clanker's colours by harness, until the art lands. */
export const HARNESS = {
	pi: { eye: "#1fa89a", band: "#2a8f84" },
	claude: { eye: "#f08a3e", band: "#d9692a" },
	codex: { eye: "#4a7fd4", band: "#355fa3" },
	agy: { eye: "#8b63d9", band: "#6a45b3" },
	opencode: { eye: "#4c9e5b", band: "#367842" },
	other: { eye: "#e0b419", band: "#b8911a" },
};

/** Harnesses and effort levels offered by the roster card editor. */
export const ROSTER_HARNESSES = ["claude", "codex", "pi", "opencode", "agy"];
export const ROSTER_EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];

/** The chip and clanker colours together, for clients that cannot read the constants directly (the phone). */
export function colours() {
	return { chips: CHIPS, harness: HARNESS, harnesses: ROSTER_HARNESSES, efforts: ROSTER_EFFORTS };
}

export function harnessOf(agent) {
	const raw = String(agent ?? "").toLowerCase().replace(/-code$/, "");
	const name = raw === "antigravity" ? "agy" : raw;
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
export function agendaView(agenda, pending, user) {
	if (!agenda) return { sections: [], counts: [], projects: [], today: "" };
	agenda = withPending(agenda, pending, user);
	const sections = [];
	if (agenda.overdue.length > 0)
		sections.push({ id: "overdue", title: `OVERDUE · ${agenda.overdue.length}`, alert: true, rows: agenda.overdue.map((e) => row(e, agenda, { overdue: true })) });
	const first = agenda.days[0];
	sections.push({ id: "today", title: `TODAY · ${dayHeading(agenda.today)}`, alert: false, rows: (first?.entries ?? []).map((e) => row(e, agenda, {})) });
	// The rest of the week; the phone's widget shows the agenda's later days too.
	const week = [];
	for (let i = 1; i < Math.min(agenda.days.length, 7); i++) {
		const day = agenda.days[i];
		const label = calendar(day.date).weekday;
		day.entries.forEach((e, j) => week.push(row(e, agenda, { day: j === 0 ? label : "" })));
	}
	if (week.length > 0) sections.push({ id: "week", title: "THIS WEEK", alert: false, rows: week });
	// A repeating task shows on every day with the same timestamp.
	for (const section of sections) uniqueKeys(section.rows);
	const counts = COUNT_ORDER.filter((s) => (agenda.counts[s] ?? 0) > 0).map((s) => ({ state: s, n: agenda.counts[s] }));
	// Every open task by state, dated or not, as a few rows with the rest a tap away; AUTO is the agents board's.
	const lists = LISTS.map(([state, title]) => {
		const rows = stateRows(agenda, state);
		return { state, title, n: rows.length, rows: rows.slice(0, PREVIEW), more: Math.max(0, rows.length - PREVIEW) };
	}).filter((l) => l.n > 0);
	const queued = Object.keys(agenda.tasks).filter((k) => agenda.tasks[k].state === "AUTO").length;
	const projects = agenda.projects.map((p) => ({
		file: p.file,
		title: p.title,
		counts: COUNT_ORDER.filter((s) => (p.counts[s] ?? 0) > 0).map((s) => ({ state: s, n: p.counts[s] })),
		link: `file:~/org/${p.file}`,
	}));
	return { sections, counts, lists, queued, projects, today: agenda.today };
}

/** The phone's lists stop on a repeated key, so a repeat gets #2, #3. */
function uniqueKeys(rows) {
	const seen = {};
	for (const r of rows) {
		const n = seen[r.key] = (seen[r.key] ?? 0) + 1;
		if (n > 1) r.key = `${r.key}#${n}`;
	}
	return rows;
}

/**
 * Where a task can go from each state, as Jon's states flow (2026-11-21): the moves a state picker offers, here, on the
 * phone's pages and in its widget. AUTO is a handoff (agent, host, start) wherever it appears. A protected file's
 * headings only go between TODO and DONE. The daemon allows these and their reverses, so an undo works (board-edit.ts).
 */
export const FLOW = {
	TODO: ["AUTO", "PROG", "HOLD", "DONE"],
	PROG: ["TODO", "EVAL", "HOLD", "DONE"],
	EVAL: ["TODO", "PROG", "AUTO", "HOLD", "DONE"],
	AUTO: ["TODO", "HOLD", "DONE"],
	HOLD: ["TODO", "PROG", "AUTO", "DONE"],
	DONE: ["TODO"],
};

export function nextStates(state, locked) {
	if (locked) return state === "TODO" ? ["DONE"] : state === "DONE" ? ["TODO"] : [];
	return FLOW[state] ?? [];
}

/** The lists under the agenda, in the order they want attention. */
export const LISTS = [["PROG", "IN PROGRESS"], ["EVAL", "IN REVIEW"], ["HOLD", "ON HOLD"], ["TODO", "TO DO"]];
const PREVIEW = 5;

/** The tasks in one state, for drilling into a count, newest file order kept. */
export function stateRows(agenda, state, pending, user) {
	if (!agenda) return [];
	agenda = withPending(agenda, pending, user);
	// The projects touched most recently first, each in its file's order, so a project's tasks stay together.
	const changed = {};
	for (const p of agenda.projects ?? []) changed[p.file] = p.changed ?? 0;
	const tasks = Object.keys(agenda.tasks).map((k) => agenda.tasks[k]).filter((t) => t.state === state);
	tasks.sort((a, b) => (changed[b.file] ?? 0) - (changed[a.file] ?? 0) || a.file.localeCompare(b.file) || a.line - b.line);
	return tasks.map((t) => {
		// Its dates, so a task without one shows as such.
		const when = [];
		if (t.deadline) when.push(`due ${startOf(t.deadline, agenda.today)}`);
		if (t.scheduled) when.push(`scheduled ${startOf(t.scheduled, agenda.today)}`);
		const overdue = (t.deadline && pickerStart(t.deadline, agenda.today).date < agenda.today) === true;
		return { key: t.key, task: t.key, state, plain: true, title: t.title, time: "", meta: [t.project].concat(when).join(" · "), overdue, link: taskLink(t) };
	});
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
	const day = dayWord(m[1], today);
	return m[2] ? `${day} ${m[2]}` : day;
}

/** Whole days from TODAY to DATE, both YYYY-MM-DD. */
function daysBetween(today, date) {
	const at = (d) => { const [y, m, n] = String(d).split("-").map(Number); return Date.UTC(y, m - 1, n); };
	return Math.round((at(date) - at(today)) / 86400000);
}

/** A date by a name it cannot be mistaken in: today, tomorrow or yesterday; a weekday within the coming week;
 * otherwise its month and day, with the year when it is not this one. */
export function dayWord(date, today) {
	if (!today) return calendar(date).weekday;
	const n = daysBetween(today, date);
	if (n === 0) return "today";
	if (n === 1) return "tomorrow";
	if (n === -1) return "yesterday";
	const c = calendar(date);
	if (n > 1 && n < 7) return c.weekday;
	return `${c.month} ${c.day}${date.slice(0, 4) === today.slice(0, 4) ? "" : ` ${date.slice(0, 4)}`}`;
}

/** The Org timestamp for a picker's "YYYY-MM-DD" or "YYYY-MM-DD HH:MM", as org-edit writes it. */
export function stampOf(when) {
	const m = /^(\d{4}-\d{2}-\d{2})(?: (\d{1,2}:\d{2}))?$/.exec(String(when ?? ""));
	if (!m) return undefined;
	return `<${m[1]} ${calendar(m[1]).weekday}${m[2] ? ` ${m[2].padStart(5, "0")}` : ""}>`;
}

/** A timestamp's date and time for a picker to start from: { date, time }, or today with no time. */
export function pickerStart(stamp, today) {
	const m = /(\d{4}-\d{2}-\d{2})(?: \S+)?(?: (\d{1,2}:\d{2}))?/.exec(String(stamp ?? ""));
	return m ? { date: m[1], time: m[2] ? m[2].padStart(5, "0") : "" } : { date: today, time: "" };
}

/** A month's days for a picker, as weeks of seven from Sunday: { date, day, inMonth, past, today }. */
export function monthDays(year, month, today) {
	const first = new Date(Date.UTC(year, month - 1, 1, 12));
	const start = first.getTime() - first.getUTCDay() * 86400000;
	const two = (n) => String(n).padStart(2, "0");
	const weeks = [];
	for (let w = 0; w < 6; w++) {
		const week = [];
		for (let d = 0; d < 7; d++) {
			const at = new Date(start + (w * 7 + d) * 86400000);
			const date = `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}`;
			week.push({ date, day: at.getUTCDate(), inMonth: at.getUTCMonth() === month - 1, past: today ? date < today : false, today: date === today });
		}
		if (w > 3 && !week.some((d) => d.inMonth)) break;
		weeks.push(week);
	}
	return { title: `${MONTHS[month - 1]} ${year}`, weeks };
}

/** Quick picks for a picker: today, tomorrow, next Monday, and a week from today. */
export function quickDays(today) {
	const [y, m, d] = String(today).split("-").map(Number);
	const two = (n) => String(n).padStart(2, "0");
	const day = (n) => { const at = new Date(Date.UTC(y, m - 1, d + n, 12)); return `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}`; };
	const toMonday = ((8 - new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()) % 7) || 7;
	const picks = [{ label: "today", date: day(0) }, { label: "tomorrow", date: day(1) }];
	if (toMonday > 1) picks.push({ label: "Mon", date: day(toMonday) });
	picks.push({ label: "in a week", date: day(7) });
	return picks;
}

/**
 * A task's outbox entry, as shell.qml pendingEdits and the phone's Link.pending keep it:
 * { applied: changes saved but not yet on the board, change: the one on its way, queue: those waiting behind it,
 *   done: saved and nothing waits }. Everything in it is drawn as made.
 */
export function entryChanges(entry) {
	if (!entry) return [];
	return [].concat(entry.applied ?? [], entry.change ? [entry.change] : [], entry.queue ?? []);
}

/** A change queued behind the one on its way: the same kind of change replaces the last queued one, so taps settle
 * on the last; replies all go. */
export function enqueue(queue, change) {
	const q = (queue ?? []).slice();
	const last = q[q.length - 1];
	if (last && last.action === change.action && change.action !== "reply") q[q.length - 1] = change;
	else q.push(change);
	return q;
}

/** What to send after CHANGE lands: the queue without state changes to where the task already is. */
export function nextQueued(change, queue) {
	let state = change?.action === "state" ? change.state : null;
	const rest = [];
	for (const c of queue ?? []) {
		if (c.action === "state" && c.state === state && rest.length === 0) continue;
		rest.push(c);
		if (c.action === "state") state = c.state;
	}
	return rest;
}

/** A task with its whole outbox entry applied, marked pending while anything is on its way. */
export function applyEntry(task, entry, user) {
	if (!task || !entry) return task;
	let t = task;
	for (const c of entryChanges(entry)) t = pendingTask(t, c, user, !entry.done);
	return t;
}

/** A task as it will be once the user's pending edit (board-edit.ts TaskEdit) lands, marked pending. */
export function pendingTask(task, change, user, busy) {
	if (!task || !change) return task;
	const t = Object.assign({}, task, { pending: busy !== false });
	switch (change.action) {
		case "state": t.state = change.state; break;
		case "assign":
			t.state = "AUTO";
			t.agent = change.agent;
			if (change.host) t.host = change.host;
			if (change.when) t.scheduled = stampOf(change.when) ?? t.scheduled;
			break;
		case "schedule":
		case "deadline": {
			const field = change.action === "schedule" ? "scheduled" : "deadline";
			if (change.when === "none") delete t[field];
			else t[field] = stampOf(change.when) ?? t[field];
			break;
		}
		case "title": t.title = change.title; break;
		case "reply":
			t.dialog = (task.dialog ?? []).concat([{ who: user || "You", at: "", text: change.text, sending: true }]);
			if (change.resume) t.state = "AUTO";
			break;
	}
	return t;
}

/** The page for the task a board names by KEY, with the user's edit on its way: what TaskDetail and the phone's
 * TaskPage draw. PENDING is { [key]: { change, done } }. */
export function taskPage(tasks, key, pending, user, today, now) {
	const t = findTask(tasks, key);
	if (!t) return null;
	return taskDetail(t, user, today, now, pending ? (pending[t.key] ?? pending[key]) : undefined);
}

/** A board's tasks with the user's pending edits, { [key]: { change } }, shown as made. */
function withPending(board, pending, user) {
	const keys = pending ? Object.keys(pending).filter((k) => k !== "seen" && entryChanges(pending[k]).length > 0) : [];
	if (!board || keys.length === 0) return board;
	const tasks = Object.assign({}, board.tasks);
	for (const key of keys) {
		const found = findTask(tasks, key);
		if (found) tasks[found.key] = applyEntry(found, pending[key], user);
	}
	return Object.assign({}, board, { tasks });
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
 * The roster cards from the agents board, shaped for both clients: status, drawn battery level and label, harness
 * colours, and the list of known hosts for the editor.
 */
export function rosterView(agents) {
	const list = agents && Array.isArray(agents.roster) ? agents.roster : [];
	const hostSet = {};
	const hosts = [];
	const addHost = (h) => {
		const name = String(h ?? "").trim();
		if (name && !hostSet[name]) {
			hostSet[name] = true;
			hosts.push(name);
		}
	};
	if (agents && agents.dispatch && Array.isArray(agents.dispatch.hosts)) {
		for (let i = 0; i < agents.dispatch.hosts.length; i++) addHost(agents.dispatch.hosts[i]);
	}
	if (agents && Array.isArray(agents.hosts)) {
		for (let i = 0; i < agents.hosts.length; i++) addHost(agents.hosts[i].host);
	}
	const cards = list.map((entry) => {
		const c = entry.card || {};
		addHost(c.host);
		const st = String(entry.status ?? "idle");
		const busy = st.indexOf("busy") === 0;
		const b = entry.battery;
		const hasLevel = b && typeof b.weekly === "number";
		const batteryLevel = hasLevel ? Math.max(0, Math.min(100, Math.round(b.weekly))) : -1;
		const resetWord = hasLevel ? (b.hours < 48 ? `${Math.round(b.hours)}h` : `${Math.round(b.hours / 24)}d`) : "";
		const batteryText = hasLevel ? `${batteryLevel}% · ${resetWord}` : (b && b.reason ? String(b.reason) : "");
		const batteryTone = !hasLevel ? "unknown" : batteryLevel >= 50 ? "high" : batteryLevel >= 20 ? "mid" : "low";
		const remoteQuota = b && typeof b.reason === "string" && b.reason.indexOf("quota is read on") === 0;
		const available = st === "idle" && (hasLevel || remoteQuota || !b);
		const statusLabel = st === "idle" ? "IDLE" : st.indexOf("working") >= 0 ? "WORKING" : busy ? "BUSY" : st === "invalid" ? "INVALID" : "OFFLINE";
		const spec = [c.host ?? "", c.harness ?? "", c.model ?? "", c.effort ?? ""].filter((s) => s !== "").join(" · ");
		return {
			slug: c.slug ?? "",
			name: c.name ?? "",
			host: c.host ?? "",
			harness: c.harness ?? "",
			clanker: harnessOf(c.harness),
			model: c.model ?? "",
			effort: c.effort ?? "",
			avatar: c.avatar ?? "",
			instructions: c.instructions ?? "",
			problems: Array.isArray(c.problems) ? c.problems : [],
			status: st,
			statusLabel: statusLabel,
			busy: busy,
			available: available,
			terminal: entry.terminal ?? "",
			batteryLevel: batteryLevel,
			batteryText: batteryText,
			batteryAccount: hasLevel && b.account ? String(b.account) : "",
			batteryTone: batteryTone,
			specLine: spec,
		};
	});
	if (hosts.length === 0) hosts.push("kit", "cog");
	return { cards: cards, hosts: hosts };
}

/**
 * The agents board as the clankers' room: what needs the user (most urgent first), who is working, who is idle, what
 * is queued and under agent review, what reported today, and the roster cards. `today` is YYYY-MM-DD for start times;
 * `user` signs the user's Dialog entries.
 */
export function agentsView(agents, now, today, user, pending) {
	if (!agents) return { summary: "", needs: [], working: [], idle: [], queued: [], reviewing: [], recent: [], down: [], roster: [], rosterHosts: ["kit", "cog"] };
	agents = withPending(agents, pending, user);
	const rv = rosterView(agents);
	const tasks = agents.tasks;
	// A review the user just opened is seen before the daemon says so.
	const seen = pending?.seen ?? [];
	const workerOf = (key) => agents.workers.find((w) => w.taskKey === key);
	const needs = agents.needs.filter((n) => n.kind === "blocked" || !seen.includes(n.task)).map((n) => {
		const task = n.task ? tasks[n.task] : undefined;
		if (n.kind === "blocked") {
			const w = agents.workers.find((x) => x.host === n.worker?.host && x.terminal === n.worker?.terminal);
			return {
				key: `blocked|${n.worker?.host}|${n.worker?.terminal}`, task: n.task ?? "", level: 1, kind: n.kind, label: "NEEDS PERMISSION",
				title: task?.title ?? w?.title ?? w?.cwd ?? "an agent", line: w?.title ?? "", harness: harnessOf(w?.agent),
				where: `${n.worker?.host} · ${n.worker?.terminal}`, action: "Open in Herdr", link: w?.herdrLink ?? null,
			};
		}
		const w = workerOf(n.task);
		return {
			key: `${n.kind}|${n.task}`, task: n.task, level: n.level, kind: n.kind,
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
			key: `${w.host}|${w.terminal}`, task: w.taskKey ?? "", harness: harnessOf(w.agent), status: w.status,
			title: task?.title ?? w.title ?? (place.length ? place[place.length - 1] : w.terminal),
			where: `${w.agent} · ${w.host}/${w.terminal}`, link: w.herdrLink ?? null,
		};
	};
	const working = agents.workers.filter((w) => w.status === "working").map(worker);
	const idle = agents.workers.filter((w) => w.status !== "working" && !blocked.has(`blocked|${w.host}|${w.terminal}`)).map(worker);
	const queued = agents.queued.map((key) => {
		const t = tasks[key];
		const dep = t.dependency && t.dependency.kind !== "ready" ? `waits on ${t.dependency.reason ?? "a task"}` : "";
		return { key, task: key, title: t.title, who: `${t.agent ?? "?"} on ${t.host ?? "?"}`, when: dep || startOf(t.scheduled, today) || "now", link: taskLink(t) };
	});
	const reviewing = agents.reviewing.map((key) => {
		const t = tasks[key];
		return { key, task: key, title: t.title, who: t.reviewParent ? "the review" : "under agent review", link: taskLink(t) };
	});
	const recent = agents.recent.map((key) => {
		const t = tasks[key];
		return { key, task: key, title: t.title, state: t.state, harness: harnessOf(taskAgent(t)), line: t.headline?.text ?? "", when: t.headline?.at ? since(t.headline.at, now) : "", link: taskLink(t) };
	});
	const hosts = agents.hosts.filter((h) => h.ok).map((h) => h.host);
	const summary = `${working.length} at work${hosts.length ? ` on ${hosts.join(", ")}` : ""}`;
	const down = agents.hosts.filter((h) => !h.ok).map((h) => h.host);
	for (const list of [needs, working, idle, queued, reviewing, recent]) uniqueKeys(list);
	return { summary, needs, working, idle, queued, reviewing, recent, down, roster: rv.cards, rosterHosts: rv.hosts };
}

/** Who wrote a Dialog entry, for how it is drawn: the user, June, the dispatcher, or an agent. */
export function dialogKind(who, user) {
	if (who === user) return "user";
	if (who === "June") return "june";
	if (who === "Dispatcher") return "dispatcher";
	return "agent";
}

/** An Org timestamp, "[2026-11-18 Wed 15:40]", as "Nov 18 15:40". */
export function stampShort(stamp) {
	const m = /(\d{4})-(\d{2})-(\d{2})(?: \S+)?(?: (\d{1,2}:\d{2}))?/.exec(String(stamp ?? ""));
	if (!m) return "";
	return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}${m[4] ? " " + m[4] : ""}`;
}

/**
 * One task's page: its state, title, where it is, what it waits on, who works it, its last report, the links that
 * open it in Emacs and its newest session in Herdr, and its Dialog as a conversation, oldest first.
 */
/** The task a board names by KEY, or the same heading under a new key: the dispatcher gives a task an ID when it
 * claims it, so FILE::*Path/Title becomes id:UUID while its page is open. */
export function findTask(tasks, key) {
	if (!tasks || !key) return null;
	if (tasks[key]) return tasks[key];
	for (const k in tasks) {
		const t = tasks[k];
		if (`${t.file}::*${(t.path ?? []).concat([t.title]).join("/")}` === key) return t;
	}
	return null;
}

/** A local "YYYY-MM-DD HH:MM", to compare with Org timestamps. */
function localStamp(ms) {
	const d = new Date(ms);
	const two = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** When a task handed to a clanker now would start: "now", or its SCHEDULED when that is still ahead. */
export function startsAt(task, today, now) {
	const m = /(\d{4}-\d{2}-\d{2})(?: \S+)?(?: (\d{1,2}:\d{2}))?/.exec(String(task?.scheduled ?? ""));
	if (!m) return "now";
	const at = `${m[1]} ${(m[2] ?? "00:00").padStart(5, "0")}`;
	return at > localStamp(now ?? Date.now()) ? startOf(task.scheduled, today) : "now";
}

export function taskDetail(task, user, today, now, pending) {
	if (!task) return null;
	task = applyEntry(task, pending, user);
	const sessions = task.sessions ?? [];
	const agent = taskAgent(task);
	const facts = [];
	if (agent) facts.push(task.host ? `${agent} on ${task.host}` : agent);
	if (task.scheduled) facts.push(`scheduled ${startOf(task.scheduled, today)}`);
	if (task.deadline) facts.push(`due ${startOf(task.deadline, today)}`);
	if (task.dependency && task.dependency.kind !== "ready") facts.push(`waits on ${task.dependency.reason ?? "a task"}`);
	if (task.review === "agent") facts.push("agent review");
	if (task.review === "none") facts.push("no review");
	return {
		key: task.key, title: task.title, state: task.state ?? "", project: task.project, file: task.file,
		protected: task.protected === true, host: task.host ?? "", agent, starts: startsAt(task, today, now),
		next: nextStates(task.state ?? "", task.protected === true),
		// While an edit is on its way, the page shows it as made and takes no other.
		busy: task.pending === true,
		scheduled: pickerStart(task.scheduled, today), deadline: pickerStart(task.deadline, today),
		hasScheduled: Boolean(task.scheduled), hasDeadline: Boolean(task.deadline),
		scheduledLabel: task.scheduled ? startOf(task.scheduled, today) : "", deadlineLabel: task.deadline ? startOf(task.deadline, today) : "",
		repeats: /[.+]\+?\d+[hdwmy]/.test(String(task.scheduled ?? "")),
		path: (task.path ?? []).join(" / "), facts: facts.join(" · "), headline: task.headline?.text ?? "",
		asked: task.asked !== undefined, harness: harnessOf(agent), emacs: taskLink(task),
		herdr: sessions.length ? sessions[sessions.length - 1] : null,
		dialog: (task.dialog ?? []).map((e, i) => ({ key: String(i), who: e.who || "note", kind: dialogKind(e.who, user), at: e.sending ? "sending…" : stampShort(e.at), text: e.text })),
	};
}
