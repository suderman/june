import assert from "node:assert/strict";
import { test } from "node:test";
import { highlight, languageOf } from "../src/highlight.ts";

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
	assert.equal(languageOf("org"), undefined);
	assert.equal(languageOf(""), undefined);
	assert.equal(highlight("* heading", "org"), undefined);
	assert.equal(highlight("x", undefined), undefined);
});
