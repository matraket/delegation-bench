// On-disk judgment cache: one JSON file per hash of (cache key version, turn
// id, question prompt, answer, key, judge model, prompt version), so reruns
// never re-judge an unchanged answer.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Bump whenever the hashed material changes, so old entries are never reused under a new meaning. */
export const CACHE_KEY_VERSION = "cache-v2";

export function cacheKey({ turnId, answer, key, judgeModel, promptVersion }) {
	const material = JSON.stringify([CACHE_KEY_VERSION, turnId, key.prompt, answer, key.facts, key.forbidden, judgeModel, promptVersion]);
	return createHash("sha256").update(material).digest("hex");
}

export function createCache(dir) {
	const file = (key) => join(dir, key.slice(0, 2), `${key}.json`);
	return {
		dir,
		async get(key) {
			try {
				return JSON.parse(await readFile(file(key), "utf8"));
			} catch (error) {
				if (error.code === "ENOENT") return null;
				throw error;
			}
		},
		async set(key, value) {
			const target = file(key);
			await mkdir(join(dir, key.slice(0, 2)), { recursive: true });
			const temp = `${target}.${randomUUID()}.tmp`;
			await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
			await rename(temp, target);
		},
	};
}
