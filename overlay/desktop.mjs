// What the desktop says about how June should behave and look: mako's do-not-disturb mode and the portal's colour
// scheme, both read over D-Bus with busctl. The shell polls them; this module reads busctl's replies and builds its
// calls. QML imports it and test/overlay.test.mjs runs it under Node, so it is plain JavaScript as QML's engine knows
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
