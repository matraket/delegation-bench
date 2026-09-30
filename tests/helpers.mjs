import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const SHELL_HOME = join(FIXTURES, "shell-home");
export const PI_HOME = join(FIXTURES, "pi-home");
export const AGENT_HOMES = [SHELL_HOME, PI_HOME];
export const PARENT_PATH = join(SHELL_HOME, "sessions", "--tmp-proj--", "2026-01-01T00-00-00-000Z_parent-0001.jsonl");
export const CHILD1_PATH = join(SHELL_HOME, "gentle-agents", "sessions", "2026-01-01T00-00-03-000Z_child-0001.jsonl");
export const CHILD2_PATH = join(SHELL_HOME, "gentle-agents", "sessions", "2026-01-01T00-01-35-000Z_child-0002.jsonl");
export const SOLO_PATH = join(PI_HOME, "sessions", "--tmp-other--", "2026-01-02T00-00-00-000Z_solo-0002.jsonl");
