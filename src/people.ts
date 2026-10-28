// The user's rolodex, an Org file with one heading per person: who they are (:WHO:) and their addresses (:EMAIL:), so
// mail and other inputs can name a sender before June reads anything. The address book (khard) adds names for
// everyone else the user keeps a contact for.
import { readFileSync } from "node:fs";
import { type Run, runProcess } from "./tools/herdr.ts";

export type Known = { name: string; who?: string };

/** Email address to person, from the rolodex's :EMAIL: properties; a missing or unreadable file is empty. */
export function rolodex(file: string | undefined): Map<string, Known> {
	const people = new Map<string, Known>();
	if (file === undefined) return people;
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return people;
	}
	for (const entry of text.split(/^(?=\*+ )/m)) {
		const title = /^\*+ (.+?)(?:\s+:[\w@#%:]+:)?\s*$/m.exec(entry.split("\n")[0]!)?.[1];
		const drawer = /^\s*:PROPERTIES:\s*$([\s\S]*?)^\s*:END:\s*$/m.exec(entry)?.[1];
		if (title === undefined || drawer === undefined) continue;
		const property = (key: string) => new RegExp(`^\\s*:${key}:[ \\t]*(.*)$`, "mi").exec(drawer)?.[1]?.trim();
		const who = property("WHO");
		for (const address of (property("EMAIL") ?? "").split(/[\s,;]+/).filter((a) => a.includes("@")))
			people.set(address.toLowerCase(), { name: title, ...(who ? { who } : {}) });
	}
	return people;
}

/** Email address to name, from the address book; empty when khard is missing. */
export async function contacts(run: Run = runProcess): Promise<Map<string, string>> {
	const out = await run(["khard", "email", "--parsable"], 30_000).catch(() => "");
	const found = new Map<string, string>();
	for (const line of out.split("\n")) {
		const [address, name] = line.split("\t");
		if (address?.includes("@")) found.set(address.trim().toLowerCase(), name?.trim() ?? "");
	}
	return found;
}
