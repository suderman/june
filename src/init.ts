// `june init`: a fresh June's personal files from the templates, with the user's name filled in. Existing files are
// never touched. The name is written into the files rather than substituted on every read, because June edits
// MEMORY.org and HEARTBEAT.org by quoting their text, which must match what is on disk.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "./config.ts";

export const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));

/** Each file created, or left as it was, by its path. */
export function init(p: Pick<Paths, "config" | "data">, name: string, templates = TEMPLATES): { path: string; created: boolean }[] {
	if (!name.trim()) throw new Error("a name is needed: june init NAME, or user.name in config.json");
	const results: { path: string; created: boolean }[] = [];
	for (const [dir, file] of [
		[p.data, "SOUL.org"],
		[p.data, "MEMORY.org"],
		[p.data, "HEARTBEAT.org"],
		[p.config, "config.json"],
	] as const) {
		const path = join(dir, file);
		if (existsSync(path)) {
			results.push({ path, created: false });
			continue;
		}
		mkdirSync(dir, { recursive: true });
		// In JSON the name is escaped as a string's contents.
		const filled = file === "config.json" ? JSON.stringify(name.trim()).slice(1, -1) : name.trim();
		writeFileSync(path, readFileSync(join(templates, file), "utf8").replaceAll("{{name}}", filled));
		results.push({ path, created: true });
	}
	return results;
}
