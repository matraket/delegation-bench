// On-disk judgment cache: one JSON file per hash of (turn id, answer, key,
// judge model, prompt version), so reruns never re-judge an unchanged answer.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function cacheKey({ turnId, answer, key, judgeModel, promptVersion }) {
	const material = JSON.stringify([turnId, answer, key.facts, key.forbidden, judgeModel, promptVersion]);
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
