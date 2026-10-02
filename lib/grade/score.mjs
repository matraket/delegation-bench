// Derived score of one validated judgment.

export function scoreJudgment(judgment) {
	const supported = judgment.facts.filter((f) => f.supported).length;
	const totalFacts = judgment.facts.length;
	const forbiddenPresent = judgment.forbidden.filter((f) => f.present).map((f) => f.id);
	return {
		supported,
		totalFacts,
		score: totalFacts ? supported / totalFacts : 0,
		forbiddenPresent,
		fullyCorrect: totalFacts > 0 && supported === totalFacts && forbiddenPresent.length === 0,
	};
}
