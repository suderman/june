// Devices allowed on the WebSocket listener: a name and a token each. The file keeps only the SHA-256 of each token, which
// is enough for 32 random bytes. Only the daemon writes it (see "Devices and the handshake" in docs/architecture.org).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Device = { name: string; createdAt: string; sha256: string };

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class Devices {
	readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	/** Read on every use, so the file stays the one record; it is tiny. A missing file is no devices. */
	list(): Device[] {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const parsed = JSON.parse(text) as { devices?: Device[] };
		if (!Array.isArray(parsed.devices)) throw new Error(`${this.file}: no devices list`);
		return parsed.devices;
	}

	/** A new device; the token is returned once and never stored. */
	add(name: string, now = new Date()): { device: Device; token: string } {
		if (!NAME.test(name)) throw new Error("A device name is lowercase letters, digits, and hyphens, at most 32");
		const devices = this.list();
		if (devices.some((d) => d.name === name)) throw new Error(`Device ${name} already exists; revoke it first`);
		const token = randomBytes(32).toString("base64url");
		const device = { name, createdAt: now.toISOString(), sha256: hash(token) };
		this.#save([...devices, device]);
		return { device, token };
	}

	revoke(name: string): void {
		const devices = this.list();
		if (!devices.some((d) => d.name === name)) throw new Error(`No device named ${name}`);
		this.#save(devices.filter((d) => d.name !== name));
	}

	/** The device a token belongs to, or undefined. Every device is compared, in constant time each. */
	verify(token: unknown): string | undefined {
		if (typeof token !== "string" || token === "") return undefined;
		const given = Buffer.from(hash(token), "hex");
		let found: string | undefined;
		for (const device of this.list()) {
			const stored = Buffer.from(device.sha256, "hex");
			if (stored.length === given.length && timingSafeEqual(given, stored)) found ??= device.name;
		}
		return found;
	}

	/** 0600, replaced atomically. */
	#save(devices: Device[]): void {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const temp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ devices }, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, this.file);
	}
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
