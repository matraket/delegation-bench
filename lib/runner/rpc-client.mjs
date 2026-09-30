import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { encodeRecord, JsonLines } from "./jsonl.mjs";

// Minimal pi RPC client over a child process. Every record in both directions
// is appended to logPath as {t, dir: "out"|"in", record}; stderr goes to
// stderrPath verbatim (it is diagnostics, never protocol data).
export class RpcClient {
	#options;
	#child;
	#log;
	#stderr;
	#nextId = 1;
	#pending = new Map();
	#listeners = new Set();
	#exit;

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
		const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.#child = child;
		this.#exit = new Promise((resolve) => {
			child.on("exit", (code, signal) => resolve({ code, signal }));
			child.on("error", (error) => resolve({ code: null, signal: null, error: error.message }));
		});
		this.#exit.then((info) => {
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

	/** Close stdin (orderly shutdown), then kill the child if it does not exit in time. */
	async close({ graceMs = 10_000 } = {}) {
		if (!this.#child) return undefined;
		this.#child.stdin.end();
		const timer = setTimeout(() => this.#child.kill("SIGTERM"), graceMs);
		const info = await this.#exit;
		clearTimeout(timer);
		await Promise.all([this.#log, this.#stderr].filter(Boolean).map((stream) => new Promise((resolve) => stream.end(resolve))));
		return info;
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
