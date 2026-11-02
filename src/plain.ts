// June's typography as Jon reads it: what a keyboard types. Models reach for curly quotes and em dashes whatever her
// voice rules say, so her replies pass through this on the way to the terminal and patter.

/** Straight quotes and apostrophes, and a comma where an em dash was. En dashes stay: they mark ranges. */
export function plain(text: string): string {
	return text
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[ \t]*—[ \t]*/g, ", ")
		.replace(/^, /gm, "");
}

