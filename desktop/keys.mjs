// Modal keyboard navigation for June's desktop client (mini overlay, full overlay, windowed app): INSERT vs NORMAL
// toggled by Tab, hjkl + n/p + N/P + Z (toggle bottom/top) + [ / ] sub-sections + SPC leader + ? cheatsheet,
// aligned with Jon's custom Meow Emacs bindings. Plain JS (QML engine safe: no Array.prototype.at, Object.hasOwn,
// or object spread).

export const COLUMNS = ["agents", "chat", "projects"];
export const AGENT_SECTIONS = ["hosts", "clankers", "activity"];
export const PROJECT_SECTIONS = ["agenda", "tasks", "projects"];

/** Moves column focus left (-1) or right (+1), clamped to the three columns (agents, chat, projects). */
export function stepColumn(current, delta) {
	const i = COLUMNS.indexOf(current);
	const from = i >= 0 ? i : 1;
	const next = Math.max(0, Math.min(COLUMNS.length - 1, from + delta));
	return COLUMNS[next];
}

/** Cycles a board's sub-sections cleanly with wrap-around for `[` (-1) and `]` (+1). */
export function cycleSection(sections, current, delta) {
	if (!Array.isArray(sections) || sections.length === 0) return current;
	const i = sections.indexOf(current);
	const from = i >= 0 ? i : 0;
	return sections[(from + delta + sections.length) % sections.length];
}

/** Jon's Emacs `Z`: jump to bottom; if already at bottom, jump to top instead. */
export function nextZTarget(atBottom) {
	return atBottom ? "top" : "bottom";
}

/** Clamps a stepped row cursor into [0, length - 1], returning 0 for empty lists. */
export function stepCursor(length, current, delta) {
	if (!length || length <= 0) return 0;
	const base = typeof current === "number" && !isNaN(current) ? current : 0;
	return Math.max(0, Math.min(length - 1, base + delta));
}

/** Steps an ISO YYYY-MM-DD date string by `days` using UTC so local DST never skips a day. */
export function stepIsoDate(iso, days) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
	if (!m) return String(iso ?? "");
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
	const y = String(d.getUTCFullYear()).padStart(4, "0");
	const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
	const da = String(d.getUTCDate()).padStart(2, "0");
	return y + "-" + mo + "-" + da;
}

/** Single-key mnemonics for Org task state transitions in TaskDetail's `s` quick-pick. */
export const STATE_KEY_MAP = [
	["TODO", "t"],
	["AUTO", "a"],
	["EVAL", "e"],
	["HOLD", "h"],
	["DONE", "d"],
	["CANCELLED", "c"],
];

/** Returns allowed single-key state transitions for a TaskDetail page. */
export function taskStateOptions(detail, locked, assignable, hasRequeue) {
	const next = Array.isArray(detail && detail.next) ? detail.next : [];
	const states = [];
	for (let i = 0; i < next.length; i++) {
		const s = next[i];
		if (locked || s !== "AUTO") states.push({ state: s, isRequeue: false });
	}
	if (assignable && hasRequeue) states.push({ state: "AUTO", isRequeue: true });
	const out = [];
	const used = {};
	for (let i = 0; i < states.length; i++) {
		const st = states[i].state;
		let key = "";
		for (let j = 0; j < STATE_KEY_MAP.length; j++) {
			if (STATE_KEY_MAP[j][0] === st) { key = STATE_KEY_MAP[j][1]; break; }
		}
		if (!key) key = st.slice(0, 1).toLowerCase();
		if (used[key]) continue;
		used[key] = true;
		out.push({ key: key, state: st, isRequeue: states[i].isRequeue });
	}
	return out;
}

/** Flat ordered list of keyboard-selectable rows on the Agents board for the current mode. */
export function agentsItems(view, mode, opts) {
	const v = view || {};
	const o = opts || {};
	const out = [];
	if (mode === "hosts") {
		const hosts = v.hosts || [];
		for (let i = 0; i < hosts.length; i++) {
			out.push({ kind: "host", key: "host:" + hosts[i].host, host: hosts[i].host });
		}
		return out;
	}
	if (mode === "clankers") {
		const cards = o.rosterSort === "leaderboard" ? (v.rosterLeaderboard || []) : (v.roster || []);
		for (let i = 0; i < cards.length; i++) {
			out.push({ kind: "clanker", key: "clanker:" + cards[i].slug, slug: cards[i].slug });
		}
		return out;
	}
	const needs = v.needs || [];
	for (let i = 0; i < needs.length; i++) {
		out.push({ kind: "need", key: "need:" + i, task: needs[i].task || "", link: needs[i].link || "" });
	}
	const working = v.working || [];
	for (let i = 0; i < working.length; i++) {
		out.push({ kind: "working", key: "work:" + i, task: working[i].task || "", link: working[i].link || "" });
	}
	const queued = v.queued || [];
	const shownQ = o.queueOpen ? queued : queued.slice(0, 3);
	for (let i = 0; i < shownQ.length; i++) {
		out.push({ kind: "queued", key: "q:" + i, task: shownQ[i].task || "", link: shownQ[i].link || "" });
	}
	if (queued.length > 3) out.push({ kind: "toggleQueue", key: "toggle:queue" });
	const reviewing = v.reviewing || [];
	for (let i = 0; i < reviewing.length; i++) {
		out.push({ kind: "reviewing", key: "rev:" + i, task: reviewing[i].task || "", link: reviewing[i].link || "" });
	}
	const idle = v.idle || [];
	if (idle.length > 0) out.push({ kind: "toggleIdle", key: "toggle:idle" });
	if (o.idleOpen) {
		for (let i = 0; i < idle.length; i++) {
			out.push({ kind: "idle", key: "idle:" + i, task: idle[i].task || "", link: idle[i].link || "" });
		}
	}
	const recent = (v.recent || []).slice(0, 6);
	for (let i = 0; i < recent.length; i++) {
		out.push({ kind: "recent", key: "rec:" + i, task: recent[i].task || "", link: recent[i].link || "" });
	}
	return out;
}

/** Flat ordered list of keyboard-selectable rows on the Projects board for the current mode. */
export function projectsItems(view, mode, drillRows) {
	const v = view || {};
	const out = [];
	if (mode === "agenda") {
		const sections = v.sections || [];
		for (let si = 0; si < sections.length; si++) {
			const rows = sections[si].rows || [];
			for (let ri = 0; ri < rows.length; ri++) {
				out.push({ kind: "agenda", key: "ag:" + si + ":" + ri, entry: rows[ri] });
			}
		}
		return out;
	}
	if (mode === "tasks") {
		const lists = v.lists || [];
		for (let li = 0; li < lists.length; li++) {
			const l = lists[li];
			out.push({ kind: "stateHeader", key: "sh:" + l.state, state: l.state, more: l.more || 0 });
			const rows = l.rows || [];
			for (let ri = 0; ri < rows.length; ri++) {
				out.push({ kind: "task", key: "tk:" + l.state + ":" + ri, state: l.state, more: l.more || 0, entry: rows[ri] });
			}
		}
		return out;
	}
	if (mode === "state") {
		const rows = drillRows || [];
		for (let i = 0; i < rows.length; i++) {
			out.push({ kind: "drill", key: "dr:" + i, entry: rows[i] });
		}
		return out;
	}
	if (mode === "projects") {
		const projs = v.projects || [];
		for (let i = 0; i < projs.length; i++) {
			out.push({ kind: "project", key: "pr:" + i, link: projs[i].link || "" });
		}
	}
	return out;
}

/** Starting mode when opening June: INSERT for talking, NORMAL when opening straight to a board or past history. */
export function initialNormalMode({ tab, narrow, past }) {
	if (past) return true;
	if (narrow && tab && tab !== "chat") return true;
	return false;
}

/** Extracts plain copyable text from a composed panel object (prefers an artifact's literal body, then June's beats). */
export function panelCopyText(panel) {
	if (!panel || !Array.isArray(panel.elements)) return "";
	for (let i = 0; i < panel.elements.length; i++) {
		const e = panel.elements[i];
		if (e && e.artifact && typeof e.artifact.text === "string" && e.artifact.text !== "") return e.artifact.text;
	}
	const june = [];
	for (let i = 0; i < panel.elements.length; i++) {
		const e = panel.elements[i];
		if (e && e.kind === "june" && typeof e.text === "string" && e.text.trim() !== "") june.push(e.text.trim());
	}
	if (june.length > 0) return june.join("\n\n");
	for (let i = 0; i < panel.elements.length; i++) {
		const e = panel.elements[i];
		if (e && e.kind === "user" && typeof e.text === "string" && e.text.trim() !== "") return e.text.trim();
	}
	return "";
}

/** Extracts actionable targets (artifacts, file cards, Org/Markdown links) from a composed panel for DWIM RET / hints. */
export function panelActions(panel, attachedBase) {
	const out = [];
	if (!panel || !Array.isArray(panel.elements)) return out;
	const seenUrl = {};
	const addUrl = (url, label) => {
		const u = String(url ?? "").trim();
		if (!u || seenUrl[u]) return;
		seenUrl[u] = true;
		out.push({ kind: "link", url: u, label: label || u });
	};
	for (let i = 0; i < panel.elements.length; i++) {
		const e = panel.elements[i];
		if (!e) continue;
		if (e.artifact) out.push({ kind: "artifact", artifact: e.artifact, label: e.artifact.title || e.artifact.language || "artifact" });
		if (e.kind === "user" && Array.isArray(e.files)) {
			for (let j = 0; j < e.files.length; j++) {
				const f = e.files[j];
				if (f && !f.expired && attachedBase) {
					out.push({
						kind: "file",
						item: { kind: f.preview || "file", url: attachedBase + panel.id + "/file/" + f.n, name: f.name || "file", mimeType: f.type || "" },
						label: f.name || "file",
					});
				}
			}
		}
		if (typeof e.text === "string" && e.text !== "") {
			const orgRe = /\[\[([^\[\]]+)\](?:\[([^\[\]]*)\])?\]/g;
			let m;
			while ((m = orgRe.exec(e.text)) !== null) addUrl(m[1], m[2] || m[1]);
			const mdRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
			while ((m = mdRe.exec(e.text)) !== null) addUrl(m[2], m[1]);
		}
	}
	return out;
}

/** Entries shown in the compact SPC leader bar (Which-Key style). */
export const LEADER_HINTS = [
	{ key: "q", label: "do not disturb" },
	{ key: "c", label: "comic / console" },
	{ key: "d", label: "dark / light" },
	{ key: "l", label: "live June" },
	{ key: "a", label: "attach file" },
	{ key: "r", label: "refresh" },
	{ key: "t", label: "Herdr" },
	{ key: "e", label: "Emacs" },
	{ key: "?", label: "cheatsheet" },
];

/** Context-aware cheatsheet sections for `?`. */
export function helpSections(surface, column, sheet) {
	if (surface === "mini") {
		return [
			{
				title: "Mini June · NORMAL",
				rows: [
					["Tab / i / a", "back to Insert"],
					["k / p / z", "expand full overlay"],
					["RET", "open link or expand"],
					["c", "copy newest reply"],
					["1–9", "visit working clanker"],
					["SPC", "leader toggles"],
					["q / Esc", "dismiss mini June"],
				],
			},
		];
	}
	if (sheet === "task") {
		return [
			{
				title: "Task docket",
				rows: [
					["s", "change state (t/a/e/h/d)"],
					["r", "reply in Dialog"],
					["w / W", "schedule / deadline"],
					["A", "assign / hand off"],
					["R", "rename title"],
					["o", "fold / unfold Dialog"],
					["e / t", "open in Emacs / Herdr"],
					["u / c", "undo edit / copy"],
					["j k / Z", "scroll / bottom ↔ top"],
					["q / Esc", "close docket"],
				],
			},
		];
	}
	if (sheet === "host" || sheet === "roster" || sheet === "deploy") {
		const rows = sheet === "host"
			? [
				["j k / n p", "select harness / session"],
				["RET", "deploy harness / open session"],
				["Z", "bottom ↔ top"],
				["q / Esc", "close host page"],
			]
			: sheet === "roster"
				? [
					["d / RET", "visit or deploy clanker"],
					["e", "edit clanker card"],
					["j k / Z", "scroll / bottom ↔ top"],
					["q / Esc", "close card"],
				]
				: [
					["j k / n p", "select folder"],
					["RET", "deploy there / type path"],
					["q / Esc", "back"],
				];
		return [{ title: sheet === "host" ? "Host page" : sheet === "roster" ? "Clanker card" : "Deploy picker", rows: rows }];
	}
	const nav = [
		["Tab / i / a", "Insert mode"],
		["h / l", "left / right column"],
		["1 / 2 / 3", "agents / chat / projects"],
		["[ / ]", "cycle sub-sections"],
		["j k / n p", "step down / up"],
		["N / P", "page down / up"],
		["Z", "bottom ↔ top"],
		["z", surface === "overlay" ? "shrink to mini June" : "toggle settings"],
		["SPC", "leader toggles"],
		["q / Esc", "step back / dismiss"],
	];
	const ctx = column === "chat"
		? {
			title: "Chat strip",
			rows: [
				["k / p", "older panel"],
				["j / n", "newer panel"],
				["RET", "open artifact / link"],
				["c", "copy focused panel"],
				["/", "search history"],
				["d", "calendar & search"],
				["< / >", "prev / next day"],
				["T", "back to today"],
			],
		}
		: column === "agents"
			? {
				title: "Agents board",
				rows: [
					["[ / ]", "hosts / clankers / activity"],
					["j k / n p", "move row cursor"],
					["RET", "open docket / card / host"],
					["o", "direct link / toggle idle/queue"],
					["C / S", "new clanker / sort (clankers)"],
					["t / e", "open Herdr / Emacs"],
					["q / Esc", "close sheet"],
				],
			}
			: {
				title: "Projects board",
				rows: [
					["[ / ]", "agenda / tasks / projects"],
					["j k / n p", "move row cursor"],
					["RET", "open task / drill / project"],
					["o", "drill into state (tasks)"],
					["e / t", "open Emacs / Herdr"],
					["q / Esc", "close sheet / back"],
				],
			};
	return [{ title: "Navigation", rows: nav }, ctx];
}

/**
 * Pure key dispatcher for NORMAL mode.
 * `ev` is `{ key, text, shift, ctrl, alt }` (where `key` is a logical name like "Tab", "Escape", "Return", "Space",
 * or single-character text from Qt's KeyEvent). Returns `{ action, ... }` or `null` if unhandled.
 */
export function dispatchNormalKey(ev, ctx) {
	const key = String(ev.key ?? "");
	const text = String(ev.text ?? "");
	const shift = Boolean(ev.shift);
	const ctrl = Boolean(ev.ctrl);
	const alt = Boolean(ev.alt);
	const surface = ctx.surface || "window";
	const column = ctx.column || "chat";

	// Let Alt+* / Ctrl+* shortcuts pass through unless explicitly handled (Ctrl+N/P handled by window shortcuts too).
	if (alt || ctrl) return null;

	// Cheatsheet closes on ?, Esc, q, or Space.
	if (ctx.helpOpen) {
		if (key === "Escape" || text === "?" || text === "q" || key === "Space" || text === " ") return { action: "closeHelp" };
		return { action: "noop" };
	}

	// SPC leader dispatch.
	if (ctx.leader) {
		if (key === "Escape" || key === "Space" || text === " ") return { action: "cancelLeader" };
		if (text === "q") return { action: "toggleQuiet" };
		if (text === "c") return { action: "toggleLook" };
		if (text === "d") return { action: "cycleScheme" };
		if (text === "l") return { action: "toggleLive" };
		if (text === "a") return { action: "attach" };
		if (text === "r") return { action: "refresh" };
		if (text === "t") return { action: "openApp", app: "terminal" };
		if (text === "e") return { action: "openApp", app: "editor" };
		if (text === "?") return { action: "openHelp" };
		return { action: "cancelLeader" };
	}

	// Preview modal takes precedence when open.
	if (ctx.previewOpen) {
		if (key === "Escape" || text === "q") return { action: "closePreview" };
		if (text === "h" || key === "Left") return { action: "previewPrev" };
		if (text === "l" || key === "Right") return { action: "previewNext" };
		if (text === "j" || text === "n" || key === "Down") return { action: "previewScroll", delta: 1 };
		if (text === "k" || text === "p" || key === "Up") return { action: "previewScroll", delta: -1 };
		if (text === "N" || key === "PageDown") return { action: "previewPage", delta: 1 };
		if (text === "P" || key === "PageUp") return { action: "previewPage", delta: -1 };
		if (text === "Z" || (shift && key === "Z")) return { action: "previewBottomTop" };
		if (text === "c") return { action: "previewCopy" };
		if (text === "e" || text === "o") return { action: "previewExternal" };
		return { action: "noop" };
	}

	// Universal NORMAL keys.
	if (key === "Tab" || text === "i" || text === "a") return { action: "enterInsert" };
	if (key === "Space" || text === " ") return { action: "openLeader" };
	if (text === "?") return { action: "toggleHelp" };
	if (key === "Escape" || text === "q") return { action: "back" };

	// Mini June NORMAL mode.
	if (surface === "mini") {
		if (text === "k" || text === "p" || text === "z" || key === "Up") return { action: "expandOverlay" };
		if (text === "c") return { action: "copyNewest" };
		if (key === "Return" || key === "Enter") return { action: "activateNewest" };
		if (text >= "1" && text <= "9") return { action: "visitShelf", index: Number(text) - 1 };
		return null;
	}

	// Overlay & Window NORMAL mode.
	if (text === "h" || key === "Left") return { action: "moveColumn", delta: -1 };
	if (text === "l" || key === "Right") return { action: "moveColumn", delta: 1 };
	if (text === "1") return { action: "setColumn", column: "agents" };
	if (text === "2") return { action: "setColumn", column: "chat" };
	if (text === "3") return { action: "setColumn", column: "projects" };
	if (text === "[") return { action: "cycleSection", delta: -1 };
	if (text === "]") return { action: "cycleSection", delta: 1 };
	if (text === "z") return { action: "tradeSize" };
	if (text === "Z" || (shift && key === "Z")) return { action: "toggleBottomTop" };
	if (text === "j" || text === "n" || key === "Down") return { action: "step", delta: 1 };
	if (text === "k" || text === "p" || key === "Up") return { action: "step", delta: -1 };
	if (text === "N" || key === "PageDown") return { action: "page", delta: 1 };
	if (text === "P" || key === "PageUp") return { action: "page", delta: -1 };
	if (key === "Return" || key === "Enter") return { action: "activate" };
	if (text === "o") return { action: "fold" };
	if (text === "c") return { action: "copy" };
	if (text === "/") return { action: "search" };
	if (text === "d") return { action: "calendar" };
	if (text === "<") return { action: "stepDay", delta: -1 };
	if (text === ">") return { action: "stepDay", delta: 1 };
	if (text === "T") return { action: "today" };
	if (text === "u") return { action: "undo" };
	if (text === "t") return { action: "openApp", app: "terminal" };
	if (text === "e") return { action: "openApp", app: "editor" };
	return null;
}
