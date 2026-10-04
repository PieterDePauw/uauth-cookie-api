import { createHmac } from "node:crypto"

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/** Decode an RFC 4648 base32 string. Spaces, dashes and `=` padding are ignored; case-insensitive. */
export function decodeBase32(input: string): Buffer {
	const clean = input.toUpperCase().replace(/[\s=-]/g, "")
	const bytes: number[] = []
	let buffer = 0
	let bits = 0
	for (const char of clean) {
		const index = BASE32_ALPHABET.indexOf(char)
		if (index === -1) throw new TypeError(`Invalid base32 character "${char}" in TOTP secret`)
		buffer = (buffer << 5) | index
		bits += 5
		if (bits >= 8) {
			bits -= 8
			bytes.push((buffer >> bits) & 0xff)
		}
	}
	return Buffer.from(bytes)
}

/** RFC 6238 TOTP: HMAC-SHA1, 30 s step, `digits` digits (Entra uses 6). */
export function generateTotp(secret: string, timeMs: number = Date.now(), digits = 6): string {
	const counter = Buffer.alloc(8)
	counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / 30)))
	const hmac = createHmac("sha1", decodeBase32(secret)).update(counter).digest()
	const offset = hmac[hmac.length - 1]! & 0x0f
	const code = hmac.readUInt32BE(offset) & 0x7fffffff
	return String(code % 10 ** digits).padStart(digits, "0")
}

/** Seconds left in the current 30 s window. */
export function secondsLeftInWindow(timeMs: number = Date.now()): number {
	return 30 - (Math.floor(timeMs / 1000) % 30)
}
