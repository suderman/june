// Token colours shared by artifact balloons and attachment previews. Only token text becomes HTML, always escaped.
export const palette = {
	comment: "#9aa3b8", quote: "#9aa3b8", doctag: "#9aa3b8",
	keyword: "#c792ea", "selector-tag": "#c792ea", operator: "#89ddff", punctuation: "#89ddff",
	string: "#c3e88d", regexp: "#c3e88d", addition: "#c3e88d", char: "#c3e88d", subst: "#e4e8f2",
	number: "#f78c6c", literal: "#f78c6c", symbol: "#f78c6c", bullet: "#f78c6c",
	title: "#82aaff", section: "#82aaff", name: "#82aaff", function: "#82aaff",
	type: "#ffcb6b", built_in: "#ffcb6b", class: "#ffcb6b", params: "#ffcb6b",
	attr: "#89ddff", attribute: "#89ddff", variable: "#89ddff", property: "#89ddff", "template-variable": "#89ddff", tag: "#89ddff",
	meta: "#9aa3b8", deletion: "#ff8f80"
};
export function html(lines) {
	const escape = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const line = tokens => tokens.map(([scope, text]) => palette[scope] ? '<span style="color:' + palette[scope] + '">' + escape(text) + '</span>' : escape(text)).join("");
	return '<pre style="font-family:monospace">' + lines.map(line).join("\n") + '</pre>';
}

/** Limit work as well as height. The source stays on the artifact for preview and copy. */
export function excerpt(artifact) {
	const text = artifact.text.slice(0, 1600).split("\n").slice(0, 8).join("\n");
	let left = text.length;
	const lines = artifact.lines ? [] : null;
	if (lines) for (const line of artifact.lines) {
		const tokens = [];
		for (const [scope, body] of line) {
			if (left <= 0) break;
			const take = body.slice(0, left);
			tokens.push([scope, take]);
			left -= take.length;
		}
		lines.push(tokens);
		if (left <= 0) break;
		left--;
	}
	return { text, lines, truncated: text.length < artifact.text.length };
}
