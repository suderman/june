// The weekly tidy of the user's org-work runtime folders (project-org-tasks keeps a task's generated files under
// ORG_WORK/DOMAIN/PROJECT/YYYY-MM-DD-SLUG, outside the synced Org tree): a folder goes once every Org thread that names
// it is DONE or archived and closed at least `afterDays` ago. It stays while any thread naming it is open, while it
// closed more recently, while no thread names it at all, while a file in `keep` names it (such as the art's
// provenance notes), and while it holds a git copy with changes or commits no remote has. What went, and what waits
// for the user, is added to the record file. Review-loop snapshots (REVIEW-LOOP/TASK-ID/...) go with their task.
import { readdirSync, readFileSync, appendFileSync, mkdirSync, existsSync, statSync, lstatSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Logger } from "./runtime.ts";
import { type Run, runProcess } from "./tools/herdr.ts";

export type Verdict = "delete" | "open" | "recent" | "keep" | "unsaved" | "unlinked";
export type Folder = { dir: string; bytes: number; verdict: Verdict; threads: string[]; why?: string };

export type OrgWorkOptions = {
	/** ORG_WORK, such as ~/.local/state/org-work. */
	root: string;
	/** The Org tree whose threads name the folders. */
	org: string;
	afterDays: number;
	/** Files or directories whose mentions of a folder keep it. */
	keep: readonly string[];
	today: string;
	run?: Run;
};

type Thread = { state?: string; closed?: string; title: string; archived: boolean };
const OPEN = new Set(["TODO", "AUTO", "PROG", "EVAL", "HOLD"]);

/** Each folder under ROOT, with what the rules make of it. */
export async function survey(options: OrgWorkOptions): Promise<Folder[]> {
	const run = options.run ?? runProcess;
	const folders = listFolders(options.root);
	const named = await mentions(run, options.org, /org-work\/[^\s\]\)"'=]+/.source);
	const kept = new Set<string>();
	for (const place of options.keep.filter((p) => existsSync(p))) for (const m of await mentions(run, place, /org-work\/[^\s\]\)"'=]+/.source, false)) kept.add(prefix(m.text));
	const ids = await mentions(run, options.org, /^[ \t]*:ID:[ \t]+\S+/.source);
	const threadsOf = new Map<string, Thread[]>();
	const files = new Map<string, string[]>();
	const thread = (file: string, line: number): Thread | undefined => {
		let lines = files.get(file);
		if (!lines) files.set(file, (lines = readFileSync(file, "utf8").split("\n")));
		let i = line - 1;
		while (i >= 0 && !lines[i]!.startsWith("* ")) i--;
		if (i < 0) return undefined;
		const m = /^\* (?:(TODO|AUTO|PROG|EVAL|HOLD|DONE) )?(.*?)(?:\s+:[\w:@#%]+:)?\s*$/.exec(lines[i]!);
		const closed = lines.slice(i + 1, i + 4).map((l) => /CLOSED: \[(\d{4}-\d{2}-\d{2})/.exec(l)?.[1]).find(Boolean);
		return { ...(m?.[1] ? { state: m[1] } : {}), ...(closed ? { closed } : {}), title: (m?.[2] ?? "").slice(0, 80), archived: /\/archive(\/|\.org$)/.test(file) };
	};
	for (const m of named) {
		const t = thread(m.file, m.line);
		if (t) threadsOf.set(prefix(m.text), [...(threadsOf.get(prefix(m.text)) ?? []), t]);
	}
	const byId = new Map(ids.map((m) => [m.text.trim().split(/\s+/)[1]!, m]));
	return Promise.all(folders.map(async (dir): Promise<Folder> => {
		const path = join(options.root, dir);
		const bytes = size(path);
		const loop = /\/review-loop\/([^/]+)$/.exec(dir);
		let threads = threadsOf.get(dir) ?? [];
		if (loop) {
			const at = byId.get(loop[1]!);
			const t = at ? thread(at.file, at.line) : undefined;
			threads = t ? [t] : [];
		}
		const states = threads.filter((t) => t.state || t.archived);
		const names = states.map((t) => `${t.archived ? "archived" : t.state}${t.closed ? ` ${t.closed}` : ""} ${t.title}`);
		const base = { dir, bytes, threads: names };
		if (kept.has(dir)) return { ...base, verdict: "keep", why: "named by a kept file" };
		if (states.length === 0) return { ...base, verdict: "unlinked" };
		if (states.some((t) => !t.archived && OPEN.has(t.state ?? ""))) return { ...base, verdict: "open" };
		const closed = states.map((t) => t.closed).filter((c): c is string => c !== undefined).sort().at(-1);
		if (closed && days(closed, options.today) < options.afterDays) return { ...base, verdict: "recent", why: `closed ${closed}` };
		const unsaved = await unsavedGit(run, path);
		if (unsaved.length > 0) return { ...base, verdict: "unsaved", why: unsaved.join("; ") };
		return { ...base, verdict: "delete" };
	}));
}

/** Remove the folders SURVEY marks for deletion, and add what went and what waits to RECORD. */
export async function clean(options: OrgWorkOptions & { record?: string; log: Logger }): Promise<{ deleted: Folder[]; failed: Folder[]; waiting: Folder[] }> {
	const folders = await survey(options);
	const deleted: Folder[] = [];
	const failed: Folder[] = [];
	for (const folder of folders.filter((f) => f.verdict === "delete")) {
		const path = join(options.root, folder.dir);
		try {
			remove(path);
			deleted.push(folder);
		} catch (error) {
			failed.push({ ...folder, why: (error as Error).message.slice(0, 200) });
		}
	}
	const waiting = folders.filter((f) => f.verdict === "unsaved" || f.verdict === "unlinked");
	if (options.record && (deleted.length || failed.length)) {
		mkdirSync(dirname(options.record), { recursive: true });
		if (!existsSync(options.record)) writeFileSync(options.record, "#+TITLE: org-work cleanup record\n");
		const gb = (n: number) => (n / 1e9).toFixed(1);
		const lines = [`\n* ${options.today}: ${deleted.length} folders, ${gb(deleted.reduce((n, f) => n + f.bytes, 0))} GB`];
		for (const f of deleted) lines.push(`- =${f.dir}= (${gb(f.bytes)} GB): ${f.threads[0] ?? ""}`);
		for (const f of failed) lines.push(`- Not removed, =${f.dir}=: ${f.why}`);
		if (waiting.length) lines.push(`- Waiting for the user: ${waiting.length} (${waiting.filter((f) => f.verdict === "unsaved").length} with unsaved git work, ${waiting.filter((f) => f.verdict === "unlinked").length} named by no thread); =june org-work= lists them.`);
		appendFileSync(options.record, `${lines.join("\n")}\n`);
	}
	options.log.info("org_work_cleaned", { deleted: deleted.length, failed: failed.length, waiting: waiting.length });
	return { deleted, failed, waiting };
}

/** Once a week, from `day` at `at`, local time; a receipt keeps it once a week across restarts. */
export function createOrgWorkCleanup(options: { config: { day: string; at: string }; state: string; clean: () => Promise<unknown>; log: Logger; now?: () => Date; tickMs?: number }): { stop(): void } {
	const now = options.now ?? (() => new Date());
	const receipt = join(options.state, "org-work.json");
	const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(options.config.day);
	let busy = false;
	const tick = async () => {
		const at = now();
		const [h, m] = options.config.at.split(":").map(Number);
		if (busy || at.getDay() !== weekday || at.getHours() * 60 + at.getMinutes() < h! * 60 + m!) return;
		const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
		let last = "";
		try { last = String(JSON.parse(readFileSync(receipt, "utf8")).day ?? ""); } catch {}
		if (last >= day) return;
		busy = true;
		try {
			mkdirSync(options.state, { recursive: true });
			writeFileSync(receipt, `${JSON.stringify({ day })}\n`);
			await options.clean();
		} catch (error) {
			options.log.warn("org_work_clean_failed", { error: (error as Error).message.slice(0, 300) });
		} finally {
			busy = false;
		}
	};
	const timer = setInterval(() => void tick(), options.tickMs ?? 60_000);
	void tick();
	return { stop: () => clearInterval(timer) };
}

/** DOMAIN/PROJECT/FOLDER under ROOT, and each task's REVIEW-LOOP/TASK-ID. */
function listFolders(root: string): string[] {
	const out: string[] = [];
	const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
	for (const domain of dirs(root)) for (const project of dirs(join(root, domain))) for (const folder of dirs(join(root, domain, project))) {
		if (folder === "review-loop") for (const id of dirs(join(root, domain, project, folder))) out.push(`${domain}/${project}/${folder}/${id}`);
		else out.push(`${domain}/${project}/${folder}`);
	}
	return out.sort();
}

/** A mention's folder: org-work/DOMAIN/PROJECT/FOLDER, or REVIEW-LOOP/ID under it. */
function prefix(text: string): string {
	const parts = text.replace(/^org-work\//, "").split("/");
	return parts.slice(0, parts[2] === "review-loop" ? 4 : 3).join("/");
}

/** Each match of PATTERN under PLACE: file, line and text. Org files only unless ANY. */
async function mentions(run: Run, place: string, pattern: string, orgOnly = true): Promise<{ file: string; line: number; text: string }[]> {
	let out = "";
	try {
		out = await run(["rg", "-n", "--no-heading", "-o", ...(orgOnly ? ["-g", "*.org"] : []), "-g", "!*.sync-conflict-*", "--with-filename", pattern, place], 120_000);
	} catch (error) {
		// rg exits 1 when nothing matches.
		if ((error as { exitCode?: number }).exitCode !== 1) throw error;
	}
	return out.split("\n").filter(Boolean).map((l) => {
		const m = /^(.*?):(\d+):(.*)$/.exec(l)!;
		return { file: m[1]!, line: Number(m[2]), text: m[3]! };
	});
}

/** Git copies under PATH with changes, or commits on HEAD that no remote has. */
async function unsavedGit(run: Run, path: string): Promise<string[]> {
	const found: string[] = [];
	const walk = (p: string, depth: number) => {
		if (depth > 4) return;
		let entries;
		try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
		if (entries.some((e) => e.name === ".git")) found.push(p);
		for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && e.name !== ".git" && e.name !== "node_modules" && e.name !== "vendor") walk(join(p, e.name), depth + 1);
	};
	walk(path, 0);
	const bad: string[] = [];
	for (const repo of found) {
		const changed = (await run(["git", "-C", repo, "status", "--porcelain"], 60_000).catch(() => "")).split("\n").filter(Boolean).length;
		const loose = (await run(["git", "-C", repo, "log", "--oneline", "HEAD", "--not", "--remotes"], 60_000).catch(() => "")).split("\n").filter(Boolean).length;
		if (changed || loose) bad.push(`${relative(path, repo) || "."}: ${changed} changed, ${loose} unpushed`);
	}
	return bad;
}

function size(path: string): number {
	let total = 0;
	const walk = (p: string) => {
		let entries;
		try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const q = join(p, e.name);
			try {
				if (e.isDirectory() && !e.isSymbolicLink()) walk(q);
				else total += lstatSync(q).size;
			} catch {}
		}
	};
	walk(path);
	return total;
}

/** Remove PATH; directories the user owns but made read-only are made writable first. */
function remove(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch {
		const open = (p: string) => {
			try {
				if (statSync(p).isDirectory()) {
					chmodSync(p, 0o700);
					for (const e of readdirSync(p, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) open(join(p, e.name));
				}
			} catch {}
		};
		open(path);
		rmSync(path, { recursive: true, force: true });
	}
}

function days(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}
