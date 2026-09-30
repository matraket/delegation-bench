import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_PROFILES, selectProfiles, weightedCost } from "../lib/weights.mjs";

const tokens = { input: 190, cacheRead: 530, cacheWrite: 60, output: 25 };

test("api profile weights cache reads at 0.1, cache writes at 1.25 and output at 5", () => {
	assert.deepEqual(BUILTIN_PROFILES.api, { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 });
	assert.equal(weightedCost(tokens, BUILTIN_PROFILES.api), 443);
});

test("nan profile counts cache reads 1:1 and ignores cache writes", () => {
	assert.deepEqual(BUILTIN_PROFILES.nan, { input: 1, cacheRead: 1, cacheWrite: 0, output: 1 });
	assert.equal(weightedCost(tokens, BUILTIN_PROFILES.nan), 745);
});

test("default selection reports both built-in profiles", () => {
	assert.deepEqual(Object.keys(selectProfiles()), ["api", "nan"]);
});

test("custom weights from JSON are added as the custom profile unless named", () => {
	const profiles = selectProfiles(undefined, '{"input":2,"cacheRead":0,"cacheWrite":0,"output":0}');
	assert.deepEqual(Object.keys(profiles), ["api", "nan", "custom"]);
	assert.equal(weightedCost(tokens, profiles.custom), 380);
	const named = selectProfiles(["mine"], '{"name":"mine","input":0,"cacheRead":0,"cacheWrite":0,"output":10}');
	assert.deepEqual(Object.keys(named), ["mine"]);
	assert.equal(weightedCost(tokens, named.mine), 250);
});

test("profile selection rejects unknown names and incomplete custom weights", () => {
	assert.throws(() => selectProfiles(["nope"]), /unknown weight profile: nope/);
	assert.throws(() => selectProfiles(undefined, '{"input":1}'), /cacheRead/);
	assert.throws(() => selectProfiles(undefined, "not json"), /--weights/);
});

test("a custom profile may not reuse a built-in profile name", () => {
	for (const reserved of Object.keys(BUILTIN_PROFILES)) {
		const json = JSON.stringify({ name: reserved, input: 1, cacheRead: 1, cacheWrite: 1, output: 1 });
		assert.throws(() => selectProfiles(undefined, json), new RegExp(`--weights name "${reserved}" is reserved for the built-in profile`));
		assert.throws(() => selectProfiles([reserved], json), /is reserved for the built-in profile/);
	}
});

test("an explicit but empty profile selection is rejected", () => {
	assert.throws(() => selectProfiles([]), /--profile selects no weight profiles/);
	assert.throws(() => selectProfiles([], '{"input":1,"cacheRead":1,"cacheWrite":1,"output":1}'), /--profile selects no weight profiles/);
});

test("prototype keys are not weight profiles", () => {
	for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
		assert.throws(() => selectProfiles([name]), new RegExp(`unknown weight profile: ${name}`));
	}
});
