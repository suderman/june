import assert from "node:assert/strict";
import { test } from "node:test";
import { highlight, languageOf } from "../src/highlight.ts";
import { replyParts } from "../src/artifact.ts";

test("copy blocks keep exact bodies, blank lines and Unicode, without typography or markup changes", () => {
	const body = '  const x = "<>&“quotes”—";\n\n\t// *literal* [[not a link]]\n';
	for (const [start, end] of [["#+begin_src js", "#+end_src"], ["```js", "```"], ["~~~~js", "~~~~"]]) {
		const parts = replyParts(`Before “this”.\n\n${start}\n${body}\n${end}\nAfter—this.`);
		assert.equal(parts[0]!.text, 'Before "this".\n\n');
		assert.equal(parts[1]!.text, body);
		assert.equal(parts[1]!.artifact, true);
		assert.equal(parts[1]!.lines!.map(l => l.map(t => t[1]).join("")).join("\n"), body);
		assert.equal(parts[2]!.text, "After, this.");
	}
	assert.deepEqual(replyParts("#+BEGIN_QUOTE\r\nHi,\r\n\r\n  Jon\r\n#+END_QUOTE"), [{ artifact: true, language: "text", text: "Hi,\r\n\r\n  Jon" }]);
	assert.deepEqual(replyParts("#+begin_example\n\n#+end_example\n"), [{ artifact: true, language: "text", text: "" }]);
});

test("copy blocks match their own closing delimiter, allow nested fences and survive streaming", () => {
	const nested = "```js\nx\n```";
	assert.equal(replyParts(`\`\`\`\`markdown\n${nested}\n\`\`\`\``)[0]!.text, nested);
	assert.equal(replyParts("#+begin_src org\n#+begin_example\nhello\n#+end_example\n#+end_src")[0]!.text, "#+begin_example\nhello\n#+end_example");
	const full = "Before\n#+begin_src js\nconst x = 1;\n\nconst y = 2;\n#+end_src\nAfter";
	for (let i = 0; i <= full.length; i++) {
		const parts = replyParts(full.slice(0, i));
		const artifact = parts.find(p => p.artifact);
		if (artifact) {
			assert.ok("const x = 1;\n\nconst y = 2;\n#+end_src\nAfter".startsWith(artifact.text));
			assert.equal(artifact.lines!.map(l => l.map(t => t[1]).join("")).join("\n"), artifact.text);
		}
	}
	assert.equal(replyParts("#+begin_src invented\n<plain>\n#+end_src")[0]!.lines, undefined);
	const huge = "x".repeat(200001);
	assert.deepEqual(replyParts(`#+begin_src js\n${huge}\n#+end_src`), [{ artifact: true, language: "js", text: huge }]);
});

test("code becomes lines of scoped tokens that keep every character, for a language highlight.js knows", () => {
	const nix = '{ pkgs, ... }:\n# enable it\n{ services.june.enable = true; x = "a<b&c"; }';
	const lit = highlight(nix, "nix")!;
	assert.equal(lit.language, "nix");
	assert.deepEqual(lit.lines.map((line) => line.map(([, text]) => text).join("")), nix.split("\n"), "nothing is lost or escaped");
	assert.deepEqual(lit.lines[1], [["comment", "# enable it"]]);
	assert.ok(lit.lines[2]!.some(([scope, text]) => scope === "string" && text === '"a<b&c"'));
	assert.ok(lit.lines[2]!.some(([scope, text]) => scope === "literal" && text === "true"));
});

test("a language is found by June's name or a file's extension, and anything unknown stays plain", () => {
	assert.equal(languageOf(".el"), "lisp");
	assert.equal(languageOf("sh"), "bash");
	assert.equal(languageOf(".nix"), "nix");
	assert.equal(languageOf("org"), "org");
	assert.equal(languageOf(""), undefined);
	assert.deepEqual(highlight("* heading", "org")!.lines, [[["section", "* heading"]]]);
	assert.equal(highlight("x", undefined), undefined);
});
