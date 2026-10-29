import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPeople } from "../src/people.ts";

const rolodex = `#+TITLE: People

Relationships are relative to Alex.

* Family
** Household
*** Sam Rivera
:PROPERTIES:
:WHO: Alex's son
:END:
- 2026-10-01: Known as Sammy. Source: Alex.

*** Robin Rivera :partner:
:PROPERTIES:
:WHO: Alex's partner
:END:
Runs a bakery from home. Loves early mornings.

- 2026-10-02: Opened the bakery. Source: Alex.

* Work
** Kim Park
:PROPERTIES:
:WHO: Alex's client
:EMAIL: kim@client.test
:END:
`;

test("a note lands after a person's last note, dated and sourced, and nothing else changes", () => {
	const out = applyPeople(rolodex, "2026-10-28", [{ name: "Sam Rivera", notes: ["Said he wants to be a map maker\nor a hockey player"] }]);
	assert.equal(
		out,
		rolodex.replace(
			"- 2026-10-01: Known as Sammy. Source: Alex.\n",
			"- 2026-10-01: Known as Sammy. Source: Alex.\n- 2026-10-28: Said he wants to be a map maker or a hockey player. Source: June's journal, 2026-10-28.\n",
		),
	);
});

test("a summary goes right under the drawer: replaced when there is one, added when there is none", () => {
	const replaced = applyPeople(rolodex, "2026-10-28", [{ name: "Robin Rivera", summary: "Runs a bakery from home and just hired help." }]);
	assert.equal(replaced, rolodex.replace("Runs a bakery from home. Loves early mornings.", "Runs a bakery from home and just hired help."), "tags on the heading do not stop a match");
	const added = applyPeople(rolodex, "2026-10-28", [{ name: "sam rivera", summary: "Eight, into hockey and maps." }]);
	assert.equal(added, rolodex.replace(":WHO: Alex's son\n:END:\n", ":WHO: Alex's son\n:END:\nEight, into hockey and maps.\n\n"), "case does not stop a match either");
});

test("a person with only a drawer gets a summary, a blank line, and notes, and the file still ends cleanly", () => {
	const out = applyPeople(rolodex, "2026-10-28", [{ name: "Kim Park", summary: "A client who runs a clinic.", notes: ["Mentioned her daughter started university!"] }]);
	assert.ok(
		out.endsWith(":EMAIL: kim@client.test\n:END:\nA client who runs a clinic.\n\n- 2026-10-28: Mentioned her daughter started university! Source: June's journal, 2026-10-28.\n"),
		out,
	);
});

test("notes before the next heading keep the blank line between them", () => {
	const out = applyPeople(rolodex, "2026-10-28", [{ name: "Robin Rivera", notes: ["Baked forty loaves."] }]);
	assert.match(out, /Source: Alex\.\n- 2026-10-28: Baked forty loaves\. Source: June's journal, 2026-10-28\.\n\n\* Work\n/);
});

test("someone new goes under New, created at the end when missing, and empty updates change nothing", () => {
	const once = applyPeople(rolodex, "2026-10-28", [
		{ name: "Pat Lee", who: "Sam's hockey coach", summary: "Coaches Sam's team.", notes: ["Moved Sam up a line."] },
		{ name: "Kim Park", summary: null, notes: [] },
	]);
	assert.ok(
		once.endsWith(":END:\n\n* New\n** Pat Lee\n:PROPERTIES:\n:WHO: Sam's hockey coach\n:END:\nCoaches Sam's team.\n\n- 2026-10-28: Moved Sam up a line. Source: June's journal, 2026-10-28.\n"),
		once,
	);
	const twice = applyPeople(once, "2026-10-29", [{ name: "Jo Lee", who: "Pat's wife", notes: ["Brought oranges."] }]);
	assert.match(twice, /Source: June's journal, 2026-10-28\.\n\n\*\* Jo Lee\n:PROPERTIES:\n:WHO: Pat's wife\n:END:\n- 2026-10-29: Brought oranges\./);
	assert.equal(applyPeople(rolodex, "2026-10-28", [{ name: "Sam Rivera", summary: null, notes: [" "] }]), rolodex);
});
