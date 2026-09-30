import { StringDecoder } from "node:string_decoder";

// Strict JSONL framing for the pi RPC protocol (rpc.md "Framing"): records are
// split on LF only, with one optional preceding CR stripped. Node's readline
// is not used because it also splits on U+2028/U+2029, which are valid inside
// JSON strings. Buffer chunks go through a StringDecoder so a multi-byte
// character split across chunks is decoded correctly.
export class JsonLines {
	#buffer = "";
	#decoder = new StringDecoder("utf8");
	#onRecord;
	#onInvalid;

	constructor(onRecord, onInvalid = () => {}) {
		this.#onRecord = onRecord;
		this.#onInvalid = onInvalid;
	}

	push(chunk) {
		this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
		let cut;
		while ((cut = this.#buffer.indexOf("\n")) !== -1) {
			const raw = this.#buffer.slice(0, cut);
			this.#buffer = this.#buffer.slice(cut + 1);
			this.#emit(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
		}
	}

	/** Flush a final record that had no trailing LF. */
	end() {
		this.#buffer += this.#decoder.end();
		const rest = this.#buffer;
		this.#buffer = "";
		this.#emit(rest.endsWith("\r") ? rest.slice(0, -1) : rest);
	}

	#emit(line) {
		if (line.trim().length === 0) return;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			this.#onInvalid(line);
			return;
		}
		this.#onRecord(record);
	}
}

/** One LF-terminated JSON record. */
export function encodeRecord(record) {
	return `${JSON.stringify(record)}\n`;
}
