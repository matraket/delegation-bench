// Crude reply-language heuristic from the T6 prototype: a text is Spanish when
// it has more common Spanish words than common English words.
const SPANISH = /\b(el|la|los|las|que|para|con|una|por|como|está|también|función|archivo|cuando)\b/gi;
const ENGLISH = /\b(the|and|that|with|for|this|is|are|when|file|function|which)\b/gi;

/** "es" or "en" for a non-empty text, null for an empty one. */
export function detectLanguage(text) {
	if (!text || !text.trim()) return null;
	return (text.match(SPANISH)?.length ?? 0) > (text.match(ENGLISH)?.length ?? 0) ? "es" : "en";
}
