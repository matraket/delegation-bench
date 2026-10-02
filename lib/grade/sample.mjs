// Blind calibration sample and judge-versus-reference agreement.
import { pearson, sum } from "../report/stats.mjs";

/** mulberry32: small deterministic PRNG for a reproducible sample. */
export function seededRandom(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const SAMPLE_SCHEMA = "delegation-bench.calibration-sample/v1";

/**
 * Seeded random sample of non-empty answers for independent grading. Each
 * entry holds only the question, the answer and the key, with empty verdicts
 * to fill in; no run, arm, model or cost field. The filled file is a valid
 * reference for computeAgreement (joined by sampleId = answer hash).
 */
export function sampleBlind(answers, size, seed) {
	const unique = [...new Map(answers.filter((a) => a.answer.trim()).map((a) => [a.answerKey, a])).values()];
	unique.sort((x, y) => (x.answerKey < y.answerKey ? -1 : x.answerKey > y.answerKey ? 1 : 0));
	const random = seededRandom(seed);
	for (let i = unique.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		[unique[i], unique[j]] = [unique[j], unique[i]];
	}
	return {
		schema: SAMPLE_SCHEMA,
		seed,
		size: Math.min(size, unique.length),
		instructions: "For each entry, set supported (true or false) on every fact the answer states in any wording, present (true or false) on every forbidden claim the answer makes, and language (en, es or other) for the prose of the answer. Judge only from the answer text.",
		entries: unique.slice(0, size).map((a) => ({
			sampleId: a.answerKey,
			turnId: a.turnId,
			question: a.key.prompt,
			answer: a.answer,
			facts: a.key.facts.map((f) => ({ id: f.id, text: f.text, supported: null })),
			forbidden: a.key.forbidden.map((f) => ({ id: f.id, text: f.text, present: null })),
			language: null,
		})),
	};
}

export const SAMPLE_JUDGMENTS_SCHEMA = "delegation-bench.sample-judgments/v1";

const keyItems = (items) => (items ?? []).map(({ id, text }) => ({ id, text }));

/**
 * Answers to judge from a blind sample file, shaped like collectAnswers
 * output. The key is rebuilt from the sample's question, facts and forbidden
 * claims (verdict fields dropped), so cache keys and judge messages match the
 * full grading run of the same answers. No run metadata exists in a sample.
 */
export function sampleToAnswers(sample) {
	if (sample?.schema !== SAMPLE_SCHEMA || !Array.isArray(sample.entries)) throw new Error(`not a calibration sample (expected schema ${SAMPLE_SCHEMA})`);
	return sample.entries.map((e) => ({
		batch: "sample",
		meta: { runId: null, arm: null, model: null, replicate: null, kind: null },
		turnId: e.turnId,
		turnIndex: null,
		turnStatus: null,
		prompt: e.question,
		answer: e.answer,
		answerKey: e.sampleId,
		key: { turnId: e.turnId, questionId: null, size: null, followup: null, prompt: e.question, facts: keyItems(e.facts), forbidden: keyItems(e.forbidden) },
	}));
}

/**
 * The sample with the judge's verdicts filled in (one entry per sampleId, in
 * sample order; `records` are gradeAnswers output for sampleToAnswers(sample)).
 * A failed answer keeps null verdicts and its short error. The file is valid on
 * either side of computeAgreement.
 */
export function sampleJudgments(sample, records, { judgeModel, promptVersion }) {
	return {
		schema: SAMPLE_JUDGMENTS_SCHEMA,
		judgeModel,
		promptVersion,
		seed: sample.seed ?? null,
		entries: sample.entries.map((e, i) => {
			const r = records[i];
			const verdict = (list, id, flag) => list?.find((x) => x.id === id)?.[flag] ?? null;
			return {
				sampleId: e.sampleId,
				turnId: e.turnId,
				question: e.question,
				answer: e.answer,
				facts: (e.facts ?? []).map((f) => ({ id: f.id, text: f.text, supported: verdict(r.facts, f.id, "supported") })),
				forbidden: (e.forbidden ?? []).map((f) => ({ id: f.id, text: f.text, present: verdict(r.forbidden, f.id, "present") })),
				language: r.language,
				source: r.judge.source,
				error: r.error,
			};
		}),
	};
}

const entriesOf = (data) => (Array.isArray(data) ? data : data?.entries ?? []);
const idOf = (entry) => entry.sampleId ?? entry.answerKey;
const complete = (entry) => Array.isArray(entry.facts) && entry.facts.every((f) => typeof f.supported === "boolean");
const scoreOf = (entry) => (entry.facts.length ? entry.facts.filter((f) => f.supported).length / entry.facts.length : 0);

/** Cohen's kappa for two boolean series; null when undefined. */
function kappa(pairs) {
	if (!pairs.length) return null;
	const n = pairs.length;
	const po = pairs.filter(([a, b]) => a === b).length / n;
	const pa = pairs.filter(([a]) => a).length / n;
	const pb = pairs.filter(([, b]) => b).length / n;
	const pe = pa * pb + (1 - pa) * (1 - pb);
	return pe === 1 ? null : (po - pe) / (1 - pe);
}

/**
 * Agreement between judge results (grades.jsonl records) and a reference
 * (a filled sample file, or records with answerKey). Only answers present in
 * both with complete fact verdicts are compared.
 */
export function computeAgreement(judgeData, referenceData) {
	const judged = new Map(entriesOf(judgeData).filter(complete).map((e) => [idOf(e), e]));
	const reference = entriesOf(referenceData);
	const factPairs = [];
	const forbiddenPairs = [];
	const scores = [];
	const disagreements = [];
	let languageAgree = 0;
	let languageCompared = 0;
	let ungraded = 0;
	let missing = 0;
	for (const ref of reference) {
		if (!complete(ref)) {
			ungraded += 1;
			continue;
		}
		const judge = judged.get(idOf(ref));
		if (!judge) {
			missing += 1;
			continue;
		}
		for (const fact of ref.facts) {
			const verdict = judge.facts.find((f) => f.id === fact.id)?.supported;
			if (typeof verdict !== "boolean") continue;
			factPairs.push([verdict, fact.supported]);
			if (verdict !== fact.supported) disagreements.push({ sampleId: idOf(ref), turnId: ref.turnId ?? judge.turnId ?? null, kind: "fact", id: fact.id, judge: verdict, reference: fact.supported });
		}
		for (const claim of ref.forbidden ?? []) {
			const verdict = (judge.forbidden ?? []).find((f) => f.id === claim.id)?.present;
			if (typeof verdict !== "boolean" || typeof claim.present !== "boolean") continue;
			forbiddenPairs.push([verdict, claim.present]);
			if (verdict !== claim.present) disagreements.push({ sampleId: idOf(ref), turnId: ref.turnId ?? judge.turnId ?? null, kind: "forbidden", id: claim.id, judge: verdict, reference: claim.present });
		}
		if (ref.language && judge.language) {
			languageCompared += 1;
			if (ref.language === judge.language) languageAgree += 1;
		}
		scores.push([scoreOf(judge), scoreOf(ref)]);
	}
	const agreeCount = (pairs) => pairs.filter(([a, b]) => a === b).length;
	return {
		answers: scores.length,
		ungradedReference: ungraded,
		missingFromJudge: missing,
		facts: { compared: factPairs.length, agree: agreeCount(factPairs), rate: factPairs.length ? agreeCount(factPairs) / factPairs.length : null, kappa: kappa(factPairs) },
		forbidden: { compared: forbiddenPairs.length, agree: agreeCount(forbiddenPairs), rate: forbiddenPairs.length ? agreeCount(forbiddenPairs) / forbiddenPairs.length : null },
		score: {
			pearson: pearson(scores.map(([j]) => j), scores.map(([, r]) => r)),
			meanAbsDiff: scores.length ? sum(scores.map(([j, r]) => Math.abs(j - r))) / scores.length : null,
		},
		language: { compared: languageCompared, agree: languageAgree },
		disagreements,
	};
}
