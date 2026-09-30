import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../lib/runner/rpc-client.mjs";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const FAST_CLOSE = { graceMs: 100, termGraceMs: 200, killWaitMs: 2000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startFake(extraEnv = {}) {
	const dir = await mkdtemp(join(tmpdir(), "bench-rpc-"));
	const home = join(dir, "home");
	const pidFile = join(dir, "grandchild.pid");
	const client = new RpcClient({
		command: process.execPath,
		args: [FAKE_PI, "--home", home, "--", "--mode", "rpc", "--session-dir", join(home, "sessions", "bench")],
		cwd: dir,
		env: { ...process.env, ...extraEnv, ...(extraEnv.FAKE_PI_GRANDCHILD ? { FAKE_PI_GRANDCHILD: pidFile } : {}) },
	});
	await client.start();
	return { client, pidFile };
}

async function grandchildPid(pidFile) {
	const until = Date.now() + 3000;
	while (!existsSync(pidFile) && Date.now() < until) await sleep(10);
	return Number(await readFile(pidFile, "utf8"));
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== "ESRCH";
	}
}

// A killed process can stay a zombie until init reaps it; poll briefly.
async function gone(pid, ms = 3000) {
	const until = Date.now() + ms;
	while (alive(pid) && Date.now() < until) await sleep(20);
	return !alive(pid);
}

test("close reports an orderly exit when closing stdin is enough", { timeout: 10_000 }, async () => {
	const { client } = await startFake();
	const info = await client.close(FAST_CLOSE);
	assert.equal(info.ended, "exited");
	assert.equal(info.code, 0);
	assert.equal(info.group, "none-left");
	assert.ok(info.waitedMs >= 0 && info.waitedMs < 2000);
});

test("close escalates from SIGTERM to SIGKILL for the whole process group and never hangs", { timeout: 10_000 }, async () => {
	const { client, pidFile } = await startFake({ FAKE_PI_STUBBORN: "1", FAKE_PI_GRANDCHILD: "1" });
	const pid = await grandchildPid(pidFile);
	assert.ok(alive(pid));
	const info = await client.close(FAST_CLOSE);
	assert.equal(info.ended, "sigkill");
	assert.equal(info.signal, "SIGKILL");
	assert.ok(await gone(pid), "the grandchild in the launcher's process group must be killed too");
});

test("close kills group members that outlive a launcher which exited on its own", { timeout: 10_000 }, async () => {
	const { client, pidFile } = await startFake({ FAKE_PI_GRANDCHILD: "1" });
	const pid = await grandchildPid(pidFile);
	const info = await client.close(FAST_CLOSE);
	assert.equal(info.ended, "exited");
	assert.equal(info.group, "killed");
	assert.ok(await gone(pid));
});
