// What the desktop says about how June should behave and look: mako's do-not-disturb mode and the portal's colour
// scheme, both read over D-Bus with busctl. The shell polls them; this module reads busctl's replies and builds its
// calls. QML imports it and test/desktop.test.mjs runs it under Node, so it is plain JavaScript as QML's engine knows
// it: no Array.prototype.at, Object.hasOwn, or object spread. See "Do not disturb and dark mode" in docs/interfaces.org.

/** mako's mode that holds notifications back; June keeps to it too. */
export const DND_MODE = "do-not-disturb";

/** busctl arguments that read mako's modes. */
export const MODES_CALL = ["busctl", "--user", "call", "org.freedesktop.Notifications", "/fr/emersion/Mako", "fr.emersion.Mako", "ListModes"];

/** busctl arguments that read the portal's colour scheme. */
export const SCHEME_CALL = ["busctl", "--user", "call", "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Settings", "ReadOne", "ss", "org.freedesktop.appearance", "color-scheme"];

/** mako's modes from busctl's reply (`as 2 "default" "do-not-disturb"`); null when the reply is not one. */
export function parseModes(text) {
	const m = /^as (\d+)((?: "[^"]*")*)\s*$/.exec(String(text).trim());
	if (!m) return null;
	const modes = [];
	const re = /"([^"]*)"/g;
	let next;
	while ((next = re.exec(m[2])) !== null) modes.push(next[1]);
	return modes.length === Number(m[1]) ? modes : null;
}

/** Whether mako is holding notifications back. */
export function quietIn(modes) {
	return Array.isArray(modes) && modes.includes(DND_MODE);
}

/** busctl arguments that set mako's modes to `modes` with do-not-disturb turned `on` or off. */
export function setQuietCall(modes, on) {
	const kept = (modes ?? ["default"]).filter((m) => m !== DND_MODE);
	const next = on ? kept.concat([DND_MODE]) : kept;
	return ["busctl", "--user", "call", "org.freedesktop.Notifications", "/fr/emersion/Mako", "fr.emersion.Mako", "SetModes", "as", String(next.length)].concat(next);
}

/** The portal's colour scheme from busctl's reply (`v u 1`): "dark", "light", or null for no preference or no reply. */
export function parseScheme(text) {
	const m = /^v u (\d+)\s*$/.exec(String(text).trim());
	if (!m) return null;
	return m[1] === "1" ? "dark" : m[1] === "2" ? "light" : null;
}

/** The schemes a device can choose: follow the system, or hold to one. */
export const SCHEMES = ["system", "dark", "light"];

/** Whether to draw dark: the device's choice, else the system's; light when the system has no preference. */
export function isDark(choice, system) {
	if (choice === "dark") return true;
	if (choice === "light") return false;
	return system === "dark";
}

/** Minimum logical dimensions (px) for the windowed June strip to count as usable rather than squeezed tiny. */
export const MIN_USABLE_WINDOW_WIDTH = 320;
export const MIN_USABLE_WINDOW_HEIGHT = 360;

/** Hyprland events that can change whether June's window is visible on a shown workspace. */
export const HYPR_REFRESH_EVENTS = [
	"openwindow",
	"closewindow",
	"movewindow",
	"movewindowv2",
	"workspace",
	"workspacev2",
	"focusedmon",
	"focusedmonv2",
	"activespecial",
	"activespecialv2",
	"fullscreen",
	"togglegroup",
	"changegroupactive",
	"moveintogroup",
	"moveoutofgroup",
	"monitoradded",
	"monitoraddedv2",
	"monitorremoved",
	"monitorremovedv2",
];

/** Whether a windowed June strip at `width` × `height` logical pixels is large enough to read and use. */
export function isUsableWindowSize(width, height) {
	return Number(width) >= MIN_USABLE_WINDOW_WIDTH && Number(height) >= MIN_USABLE_WINDOW_HEIGHT;
}

/** Normalizes a Hyprland window address to include its `0x` prefix; empty string when absent. */
export function hyprAddress(address) {
	const raw = String(address ?? "").trim();
	if (!raw) return "";
	return raw.startsWith("0x") ? raw : `0x${raw}`;
}

/** Hyprland IPC dispatch argument to focus a window by address, matching hyprlua or standard Hyprland. */
export function focusWindowDispatch(address, usingLua) {
	const addr = hyprAddress(address);
	if (!addr) return "";
	return usingLua ? `hl.dsp.focus({ window = "address:${addr}" })` : `focuswindow address:${addr}`;
}

/** Finds this June client's StripWindow among Hyprland toplevel snapshots, preferring exact PID match. */
export function findJuneToplevel(toplevels, pid, appId) {
	const list = Array.isArray(toplevels) ? toplevels : [];
	if (Number(pid) > 0) {
		const byPid = list.filter((t) => Number(t.pid) === Number(pid));
		if (byPid.length > 0) return byPid.find((t) => t.title === "June") ?? byPid[0];
	}
	const wantApp = String(appId ?? "");
	return list.find((t) => t.title === "June" && (wantApp === "" || t.appId === wantApp || t.className === wantApp)) ?? null;
}

/**
 * Whether June's windowed client is visibly shown at a usable size on any currently displayed workspace (multi-monitor
 * aware), along with its normalized Hyprland address when known. Falls back to `windowFocused` outside Hyprland.
 */
export function juneWindowVisibility({ windowShown, windowWidth, windowHeight, windowFocused, pid, appId, monitors, toplevels }) {
	if (!windowShown || !isUsableWindowSize(windowWidth, windowHeight)) return { visible: false, address: "" };
	const mons = Array.isArray(monitors) ? monitors : [];
	if (mons.length === 0) return { visible: Boolean(windowFocused), address: "" };
	const tl = findJuneToplevel(toplevels, pid, appId);
	if (!tl) return { visible: Boolean(windowFocused), address: "" };
	const address = hyprAddress(tl.address);
	if (tl.mapped === false || tl.hidden === true) return { visible: false, address };
	const activeRegular = [];
	const activeSpecial = [];
	for (let i = 0; i < mons.length; i++) {
		const m = mons[i];
		if (Number(m.activeWorkspaceId) > 0) activeRegular.push(Number(m.activeWorkspaceId));
		if (Number(m.specialWorkspaceId) !== 0 && !isNaN(Number(m.specialWorkspaceId))) activeSpecial.push(Number(m.specialWorkspaceId));
	}
	const wsId = Number(tl.workspaceId);
	const onShownWorkspace = wsId < 0 ? activeSpecial.includes(wsId) : wsId > 0 ? activeRegular.includes(wsId) || tl.workspaceActive === true : tl.workspaceActive === true;
	if (!onShownWorkspace) return { visible: false, address };
	if (tl.workspaceHasFullscreen && !tl.fullscreen) return { visible: false, address };
	return { visible: true, address };
}

/** Valid tab names for narrow desktop views: chat (formerly strip), agents, and projects. */
export const TABS = ["agents", "chat", "projects"];

/** Normalizes a tab name from IPC or state, mapping the legacy "strip" alias to "chat". */
export function normalizeTab(name) {
	if (name === "strip") return "chat";
	return TABS.includes(name) ? name : null;
}

/**
 * Shell command to focus or launch a desktop companion app ("terminal" for Herdr, "editor" for Emacs), respecting
 * optional JUNE_DESKTOP_TERMINAL / JUNE_DESKTOP_EDITOR overrides. Exits promptly so Process never stays busy.
 */
/**
 * The argv that shows a deployed session in the Herdr app on this desktop, as `herdr-link jump` shows one: the app is
 * started if it is not running; a terminal hidden from it (no herdr.space label) joins the space it shows; the window
 * comes forward; the agent is focused. HOST and TERMINAL are where it runs (kit, t7); one on another host is HOST/t7
 * to this machine's hc. Arguments go to the script as $1 and $2, never into its text.
 */
export function showDeployedCommand(host, terminal) {
	const script = [
		'here=$(hostname -s 2>/dev/null || hostname); [ "$1" = "$here" ] && a="$2" || a="$1/$2"',
		'if ! herdr-app status >/dev/null 2>&1; then setsid -f herdr-app >/dev/null 2>&1 </dev/null; i=0; while [ $i -lt 40 ] && ! herdr-app status >/dev/null 2>&1; do sleep 0.25; i=$((i+1)); done; fi',
		'space=$(herdr-app status 2>/dev/null | sed -n \'s/^  "space": "\\([^"]*\\)".*/\\1/p\')',
		'if [ -n "$space" ] && ! hc get --json "$a" 2>/dev/null | grep -q \'"herdr.space"\'; then hc label "$a" "herdr.space=$space" >/dev/null 2>&1; fi',
		'hyprctl dispatch \'hl.dsp.focus({ window = "class:herdr-app" })\' >/dev/null 2>&1 || hyprctl dispatch focuswindow "class:^herdr-app$" >/dev/null 2>&1',
		'herdr-app do agent.focus --terminal "$a"',
	].join("\n");
	return ["sh", "-c", script, "june-show", String(host), String(terminal)];
}

export function appLaunchCommand(app, env) {
	const overrides = env || {};
	if (app === "terminal") {
		const custom = String(overrides.JUNE_DESKTOP_TERMINAL || "").trim();
		if (custom) return ["sh", "-c", `setsid -f ${custom} >/dev/null 2>&1 </dev/null`];
		return [
			"sh",
			"-c",
			'if command -v hyprctl >/dev/null && hyprctl clients 2>/dev/null | grep -q "class: herdr-app"; then hyprctl dispatch \'hl.dsp.focus({ window = "class:herdr-app" })\' >/dev/null 2>&1 || hyprctl dispatch focuswindow "class:^herdr-app$" >/dev/null 2>&1; elif command -v herdr-app >/dev/null; then setsid -f herdr-app >/dev/null 2>&1 </dev/null; else setsid -f kitty >/dev/null 2>&1 </dev/null; fi',
		];
	}
	if (app === "editor") {
		const custom = String(overrides.JUNE_DESKTOP_EDITOR || "").trim();
		if (custom) return ["sh", "-c", `setsid -f ${custom} >/dev/null 2>&1 </dev/null`];
		return [
			"sh",
			"-c",
			'if command -v hyprctl >/dev/null && hyprctl clients 2>/dev/null | grep -q "class: emacs"; then hyprctl dispatch \'hl.dsp.focus({ window = "class:emacs" })\' >/dev/null 2>&1 || hyprctl dispatch focuswindow "class:^emacs$" >/dev/null 2>&1; elif command -v emacsclient >/dev/null; then emacsclient -c -n >/dev/null 2>&1 </dev/null; else setsid -f emacs >/dev/null 2>&1 </dev/null; fi',
		];
	}
	return null;
}
