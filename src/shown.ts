// What June showed with her show tool, as her tool result names it: one `[shown {...}]` line per file. Pure, so the
// fold, the daemon's file route and the tool share it.

/** What June showed: a saved copy in the inbox, its type, and for a snippet its language. */
export type Shown = { name: string; mimeType: string; size: number; path: string; language?: string };

const LINE = /^\[shown (\{.*\})\]$/;

/** The files a show result names, from its text; anything else in it is ignored. */
export function shownFiles(text: string): Shown[] {
	const out: Shown[] = [];
	for (const line of text.split("\n")) {
		const match = LINE.exec(line.trim());
		if (!match) continue;
		try {
			const s = JSON.parse(match[1]!) as Partial<Shown>;
			if (typeof s.name === "string" && typeof s.mimeType === "string" && typeof s.size === "number" && typeof s.path === "string")
				out.push({ name: s.name, mimeType: s.mimeType, size: s.size, path: s.path, ...(typeof s.language === "string" ? { language: s.language } : {}) });
		} catch {}
	}
	return out;
}
