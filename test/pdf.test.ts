import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { saveFiles } from "../src/inbox.ts";
import { createCodingExtension } from "../src/tools/coding.ts";
import { ask, openTestDaemon, tempDir } from "./helpers.ts";

const run = promisify(execFile);

// Two text pages and a blank page, with no document-generation dependency.
function fixture(): Buffer {
	const streams = ["BT /F1 18 Tf 72 720 Td (June PDF probe page one) Tj ET", "BT /F1 18 Tf 72 720 Td (June PDF probe page two) Tj ET", ""];
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
		...[7, 8, 9].map((content) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents ${content} 0 R >>`),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		...streams.map((stream) => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [i, object] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
	pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
	pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf);
}

test("Poppler reads an inbox PDF without modifying it, selects pages, and reports invalid input", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const data = fixture();
	const [file] = await saveFiles(join(tmp.dir, "inbox"), "pdf-probe", [{ name: "PDF probe's pages.pdf", mimeType: "application/pdf", data: data.toString("base64") }]);
	const path = file!.path;
	const info = await run("pdfinfo", [path]);
	assert.match(info.stdout, /Pages:\s+3/);
	for (let i = 0; i < 2; i++) {
		const text = await run("pdftotext", ["-layout", path, "-"]);
		assert.match(text.stdout, /June PDF probe page one[\s\S]*June PDF probe page two/);
		assert.equal(text.stderr, "");
	}
	const second = await run("pdftotext", ["-f", "2", "-l", "2", path, "-"]);
	assert.match(second.stdout, /page two/);
	assert.doesNotMatch(second.stdout, /page one/);
	const blank = await run("pdftotext", ["-f", "3", "-l", "3", path, "-"]);
	assert.equal(blank.stdout.trim(), "", "no extracted text does not prove there is readable text");
	assert.deepEqual(await readFile(path), data);
	const invalid = join(tmp.dir, "invalid.pdf");
	await writeFile(invalid, "not a PDF");
	await assert.rejects(run("pdftotext", [invalid, "-"]), /Command failed/);
	await assert.rejects(run("pdftotext", [join(tmp.dir, "missing.pdf"), "-"]), /Command failed/);
});

test("June's bash tool returns real PDF text to the model", async (t) => {
	const tmp = await tempDir();
	t.after(tmp.cleanup);
	const [file] = await saveFiles(join(tmp.dir, "inbox"), "pdf-bash-probe", [{ name: "PDF probe's pages.pdf", mimeType: "application/pdf", data: fixture().toString("base64") }]);
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: `pdftotext -layout '${file!.path.replaceAll("'", "'\\''")}' -` })], { stopReason: "toolUse" }),
		(ctx) => {
			const result = JSON.stringify(ctx.messages.at(-1));
			assert.doesNotMatch(result, /"isError":true/);
			assert.match(result, /June PDF probe page one/);
			assert.match(result, /June PDF probe page two/);
			return fauxAssistantMessage("Read both pages.");
		},
	]);
	const daemon = await openTestDaemon({ ...tmp, faux, extensions: [createCodingExtension()] });
	t.after(() => daemon.close());
	assert.equal((await ask(tmp.paths.socket, "Read the PDF probe.")).text, "Read both pages.");
});
