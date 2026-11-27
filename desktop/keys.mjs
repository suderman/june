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
export function helpSections(surface, column) {
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
		: {
			title: column === "agents" ? "Agents board" : "Projects board",
			rows: [
				["[ / ]", column === "agents" ? "hosts / clankers / activity" : "agenda / tasks / projects"],
				["j k / n p", "scroll down / up"],
				["N / P", "page down / up"],
				["Z", "bottom ↔ top"],
				["t / e", "open Herdr / Emacs"],
				["q / Esc", "close open sheet"],
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
		if (text === "h" || text === "p" || key === "Left" || key === "PageUp") return { action: "previewPrev" };
		if (text === "l" || text === "n" || key === "Right" || key === "PageDown") return { action: "previewNext" };
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
