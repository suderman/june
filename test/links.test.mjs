import assert from "node:assert/strict";
import { test } from "node:test";
import { linkKind, markup } from "../overlay/strip.mjs";

const herdr = "herdr:kit/claude:af748c8e-1d51-43b5-89c9-20cf5b7adb73@w4Z:p39";

test("only web pages and stamped herdr sessions are links a click opens", () => {
	assert.equal(linkKind("https://example.com/a?b=1"), "web");
	assert.equal(linkKind("http://kit:8080/"), "web");
	assert.equal(linkKind(herdr), "herdr");
	assert.equal(linkKind("herdr:kit/pi:01a1b773-ab2d-7241-b463-6da5ad4d8827"), "herdr", "the pane is optional");
	for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "herdr:kit/claude:not-a-session", "herdr:kit/claude:af748c8e-1d51-43b5-89c9-20cf5b7adb73;rm -rf ~", "herdr:Kit$(id)/claude:af748c8e-1d51-43b5-89c9-20cf5b7adb73", "https://a b"])
		assert.equal(linkKind(bad), null, bad);
});

test("June's links become anchors, in Markdown or Org form, and anything else keeps only its label", () => {
	assert.equal(markup("see [the docs](https://example.com/a_b_c?x=1&y=2) now"), 'see <a href="https://example.com/a_b_c?x=1&amp;y=2">the docs</a> now', "the address survives the stress passes and is escaped");
	assert.equal(markup(`step in: [[${herdr}][claude@kit]]`), `step in: <a href="${herdr}">claude@kit</a>`);
	assert.equal(markup(`[pane](${herdr})`), `<a href="${herdr}">pane</a>`);
	assert.equal(markup("[secrets](file:///etc/passwd)"), "secrets");
	assert.equal(markup('[x](https://a.b/"onclick=)'), "x", "a quote cannot break out of the attribute");
	assert.equal(markup("**bold** and [it](https://a.b/**c**)"), '<span style="font-weight:800">bold</span> and <a href="https://a.b/**c**">it</a>');
	assert.equal(markup("<b>raw</b>"), "&lt;b&gt;raw&lt;/b&gt;", "still nothing she writes injects markup");
});
