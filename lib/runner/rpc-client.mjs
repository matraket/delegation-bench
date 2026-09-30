import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { encodeRecord, JsonLines } from "./jsonl.mjs";

// Minimal pi RPC client over a child process. Every record in both directions
// is appended to logPath as {t, dir: "out"|"in", record}; stderr goes to
// stderrPath verbatim (it is diagnostics, never protocol data).
//
// On POSIX the launcher starts detached, so it leads a new process group that
// pi (spawned by the launcher without detaching) joins. Shutdown signals go to
// that whole group. Gentle Shell starts each subagent child detached in its
// own group, owned and stopped by pi; a SIGKILL of pi cannot run that cleanup.

export const CLOSE_DEFAULTS = Object.freeze({ graceMs: 10_000, termGraceMs: 5_000, killWaitMs: 5_000 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RpcClient {
	#options;
	#child;
	#log;
	#stderr;
	#nextId = 1;
	#pending = new Map();
	#listeners = new Set();
	#exit;
	#group;
	#onProcessExit;

	constructor({ command, args, cwd, env, logPath, stderrPath }) {
		this.#options = { command, args, cwd, env, logPath, stderrPath };
		this.invalidLines = 0;
	}

	get pid() {
		return this.#child?.pid;
	}

	/** Resolves with {code, signal} when the child exits. */
	get exited() {
		return this.#exit;
	}

	async start() {
		const { command, args, cwd, env, logPath, stderrPath } = this.#options;
		this.#log = logPath ? createWriteStream(logPath, { flags: "a" }) : undefined;
		this.#stderr = stderrPath ? createWriteStream(stderrPath, { flags: "a" }) : undefined;
		const detached = process.platform !== "win32";
		const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached });
		this.#child = child;
		this.#group = detached && Number.isInteger(child.pid) && child.pid > 0 ? child.pid : undefined;
		this.#exit = new Promise((resolve) => {
			child.on("exit", (code, signal) => resolve({ code, signal }));
			child.on("error", (error) => resolve({ code: null, signal: null, error: error.message }));
		});
		// If the runner itself exits first, ask the group to stop (a detached
		// group gets no terminal signal). Synchronous, so SIGTERM only.
		if (this.#group) {
			this.#onProcessExit = () => this.#signalGroup("SIGTERM");
			process.once("exit", this.#onProcessExit);
		}
		this.#exit.then((info) => {
			if (this.#onProcessExit) process.off("exit", this.#onProcessExit);
			for (const { reject } of this.#pending.values()) reject(new Error(`pi exited before responding (code ${info.code}, signal ${info.signal})`));
			this.#pending.clear();
			for (const listener of this.#listeners) listener({ type: "__exit", ...info });
		});
		const lines = new JsonLines(
			(record) => this.#receive(record),
			() => {
				this.invalidLines += 1;
			},
		);
		child.stdout.on("data", (chunk) => lines.push(chunk));
		child.stdout.on("end", () => lines.end());
		child.stderr.on("data", (chunk) => this.#stderr?.write(chunk));
		// A closed stdin (the child exited) must not crash the runner.
		child.stdin.on("error", () => {});
		await new Promise((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
	}

	/** Subscribe to every record without an awaited response id. Returns an unsubscribe function. */
	onRecord(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Write one record without waiting for a response. */
	send(record) {
		this.#write(record);
	}

	/** Send a command and resolve with its response record (success or failure). */
	request(type, fields = {}, { timeoutMs = 30_000 } = {}) {
		const id = `bench-${this.#nextId++}`;
		const record = { id, type, ...fields };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`no response to ${type} within ${timeoutMs} ms`));
			}, timeoutMs);
			this.#pending.set(id, {
				resolve: (response) => {
					clearTimeout(timer);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.#write(record);
		});
	}

	/**
	 * Orderly shutdown with bounded escalation; never waits without a limit.
	 * 1. close stdin and wait graceMs; 2. SIGTERM the process group and wait
	 * termGraceMs; 3. SIGKILL the group and wait killWaitMs. Then any group
	 * member that outlived the launcher gets the same SIGTERM/SIGKILL steps.
	 * Resolves with {code, signal, error?, ended, group, waitedMs}:
	 * ended is "exited" (stdin EOF was enough), "sigterm", "sigkill", or
	 * "unresponsive" (no exit event even after SIGKILL); group is "none-left",
	 * "terminated", "killed", "survived" (still present after SIGKILL) or
	 * "not-applicable" (no process group, for example on Windows).
	 */
	async close(options = {}) {
		if (!this.#child) return undefined;
		const { graceMs, termGraceMs, killWaitMs } = { ...CLOSE_DEFAULTS, ...options };
		const startedAt = Date.now();
		this.#child.stdin.end();
		let ended = "exited";
		let info = await this.#waitExit(graceMs);
		if (!info) {
			ended = "sigterm";
			this.#signal("SIGTERM");
			info = await this.#waitExit(termGraceMs);
		}
		if (!info) {
			ended = "sigkill";
			this.#signal("SIGKILL");
			info = await this.#waitExit(killWaitMs);
		}
		if (!info) ended = "unresponsive";
		const group = await this.#reapGroup(termGraceMs, killWaitMs);
		await Promise.all([this.#log, this.#stderr].filter(Boolean).map((stream) => new Promise((resolve) => stream.end(resolve))));
		return { code: null, signal: null, ...info, ended, group, waitedMs: Date.now() - startedAt };
	}

	async #waitExit(ms) {
		let timer;
		const timeout = new Promise((resolve) => {
			timer = setTimeout(() => resolve(undefined), ms);
		});
		const info = await Promise.race([this.#exit, timeout]);
		clearTimeout(timer);
		return info;
	}

	/** Signal the process group when there is one, else the child alone. */
	#signal(signal) {
		if (this.#signalGroup(signal)) return;
		try {
			this.#child.kill(signal);
		} catch {
			// Already gone.
		}
	}

	#signalGroup(signal) {
		if (!this.#group) return false;
		try {
			process.kill(-this.#group, signal);
			return true;
		} catch {
			return false;
		}
	}

	/** True while any process remains in the group (signal 0 only probes). */
	#groupAlive() {
		if (!this.#group) return false;
		try {
			process.kill(-this.#group, 0);
			return true;
		} catch (error) {
			return error.code === "EPERM";
		}
	}

	async #groupGoneWithin(ms) {
		const until = Date.now() + ms;
		while (this.#groupAlive()) {
			if (Date.now() >= until) return false;
			await sleep(25);
		}
		return true;
	}

	async #reapGroup(termGraceMs, killWaitMs) {
		if (!this.#group) return "not-applicable";
		if (!this.#groupAlive()) return "none-left";
		this.#signalGroup("SIGTERM");
		if (await this.#groupGoneWithin(termGraceMs)) return "terminated";
		this.#signalGroup("SIGKILL");
		return (await this.#groupGoneWithin(killWaitMs)) ? "killed" : "survived";
	}

	#write(record) {
		this.#logRecord("out", record);
		if (this.#child?.stdin.writable) this.#child.stdin.write(encodeRecord(record));
	}

	#receive(record) {
		this.#logRecord("in", record);
		if (record?.type === "response" && typeof record.id === "string" && this.#pending.has(record.id)) {
			const pending = this.#pending.get(record.id);
			this.#pending.delete(record.id);
			pending.resolve(record);
			return;
		}
		for (const listener of this.#listeners) listener(record);
	}

	#logRecord(dir, record) {
		this.#log?.write(`${JSON.stringify({ t: Date.now(), dir, record })}\n`);
	}
}
