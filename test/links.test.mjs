import assert from "node:assert/strict";
import { test } from "node:test";
import { emacsCall, linkKind, markup } from "../overlay/strip.mjs";

const herdr = "herdr:kit/claude:af748c8e-1d51-43b5-89c9-20cf5b7adb73@w4Z:p39";

test("only web pages and stamped herdr sessions are links a click opens", () => {
	assert.equal(linkKind("https://example.com/a?b=1"), "web");
	assert.equal(linkKind("http://kit:8080/"), "web");
	assert.equal(linkKind(herdr), "herdr");
	assert.equal(linkKind("herdr:kit/pi:01a1b773-ab2d-7241-b463-6da5ad4d8827"), "herdr", "the pane is optional");
	assert.equal(linkKind("file:~/org/work/x/x.org::*A heading"), "file");
	assert.equal(linkKind("file:/home/jon/src/suderman/june/README.org"), "file");
	for (const bad of ["javascript:alert(1)", "file:relative.org", "file:~/org/a\nb.org", "herdr:kit/claude:not-a-session", "herdr:kit/claude:af748c8e-1d51-43b5-89c9-20cf5b7adb73;rm -rf ~", "herdr:Kit$(id)/claude:af748c8e-1d51-43b5-89c9-20cf5b7adb73", "https://a b"])
		assert.equal(linkKind(bad), null, bad);
});

test("June's links become anchors, in Markdown or Org form, and anything else keeps only its label", () => {
	assert.equal(markup("see [the docs](https://example.com/a_b_c?x=1&y=2) now"), 'see <a href="https://example.com/a_b_c?x=1&amp;y=2">the docs</a> now', "the address survives the stress passes and is escaped");
	assert.equal(markup(`step in: [[${herdr}][claude@kit]]`), `step in: <a href="${herdr}">claude@kit</a>`);
	assert.equal(markup(`[pane](${herdr})`), `<a href="${herdr}">pane</a>`);
	assert.equal(markup("[[file:~/org/todo.org::*Call the dentist][the dentist]]"), '<a href="file:~/org/todo.org::*Call the dentist">the dentist</a>', "Org's form lets a heading have spaces");
	assert.equal(markup("here's the [clipboard task](file:~/org/work/suderman/june/june.org::*Prefer Jon's approved June clipboard art)."), `here's the <a href="file:~/org/work/suderman/june/june.org::*Prefer Jon's approved June clipboard art">clipboard task</a>.`, "June writes file links in Markdown's form too, spaces and all");
	assert.equal(markup("[secrets](ftp://example.com/x)"), "secrets");
	assert.equal(markup('[x](https://a.b/"onclick=)'), "x", "a quote cannot break out of the attribute");
	assert.equal(markup("**bold** and [it](https://a.b/**c**)"), '<span style="font-weight:800">bold</span> and <a href="https://a.b/**c**">it</a>');
	assert.equal(markup("<b>raw</b>"), "&lt;b&gt;raw&lt;/b&gt;", "still nothing she writes injects markup");
});

test("a file link becomes an emacsclient call whose path and search are only ever Lisp strings", () => {
	assert.deepEqual(emacsCall("file:~/org/todo.org::*Call the dentist"), ["emacsclient", "-r", "-n", "--eval", '(suderman/june-open "~/org/todo.org" "*Call the dentist")']);
	assert.deepEqual(emacsCall("file:~/org/notes.org").at(-1), '(suderman/june-open "~/org/notes.org" "")');
	assert.equal(emacsCall('file:~/org/a.org::x") (shell-command "rm') .at(-1), '(suderman/june-open "~/org/a.org" "x\\") (shell-command \\"rm")', "a quote stays inside the string");
	assert.equal(emacsCall("file:/tmp/a.org::two::colons").at(-1), '(suderman/june-open "/tmp/a.org" "two::colons")');
});

test("a link's words take the colour the strip gives them", () => {
	assert.equal(markup("see [[https://a.ca][A]]", { link: "color:#5470b8" }), 'see <a href="https://a.ca"><span style="color:#5470b8">A</span></a>');
});

test("code in a balloon can read as a terminal, padded inside its dark background", () => {
	assert.equal(markup("edit =/etc/nixos/flake.nix= now", { code: "T", codePad: true }), 'edit <span style="T">&nbsp;/etc/nixos/flake.nix&nbsp;</span> now');
	assert.equal(markup("edit =/etc/nixos/flake.nix= now", { code: "T" }), 'edit <span style="T">/etc/nixos/flake.nix</span> now', "no padding unless asked");
});

test("markup of no words is nothing, not an error", () => {
	assert.equal(markup(undefined), "");
	assert.equal(markup(null), "");
});
