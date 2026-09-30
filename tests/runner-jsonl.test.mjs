import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonLines, encodeRecord } from "../lib/runner/jsonl.mjs";

function collect() {
	const records = [];
	const invalid = [];
	const lines = new JsonLines((record) => records.push(record), (line) => invalid.push(line));
	return { lines, records, invalid };
}

test("splits records only on LF and strips one preceding CR", () => {
	const { lines, records } = collect();
	lines.push('{"a":1}\r\n{"b":2}\n');
	assert.deepEqual(records, [{ a: 1 }, { b: 2 }]);
});

test("reassembles a record split across chunks, including inside CRLF", () => {
	const { lines, records } = collect();
	lines.push('{"type":"agent');
	assert.deepEqual(records, []);
	lines.push('_settled"}\r');
	assert.deepEqual(records, []);
	lines.push('\n{"x":');
	lines.push("3}\n");
	assert.deepEqual(records, [{ type: "agent_settled" }, { x: 3 }]);
});

test("keeps U+2028 and U+2029 inside JSON strings (not record boundaries)", () => {
	const { lines, records } = collect();
	lines.push(`${JSON.stringify({ text: "a b c" })}\n`);
	assert.deepEqual(records, [{ text: "a b c" }]);
});

test("decodes a multi-byte UTF-8 character split across Buffer chunks", () => {
	const { lines, records } = collect();
	const bytes = Buffer.from(`${JSON.stringify({ text: "ñ€" })}\n`, "utf8");
	const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte euro sign
	lines.push(bytes.subarray(0, cut));
	lines.push(bytes.subarray(cut));
	assert.deepEqual(records, [{ text: "ñ€" }]);
});

test("reports unparseable lines, skips blank ones, and flushes a final record on end", () => {
	const { lines, records, invalid } = collect();
	lines.push("not json\n\n");
	lines.push('{"last":true}');
	lines.end();
	assert.deepEqual(invalid, ["not json"]);
	assert.deepEqual(records, [{ last: true }]);
});

test("encodeRecord writes one LF-terminated JSON object", () => {
	assert.equal(encodeRecord({ type: "get_state", id: "r1" }), '{"type":"get_state","id":"r1"}\n');
});
