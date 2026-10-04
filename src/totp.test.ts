import { describe, expect, it } from "vitest"
import { decodeBase32, generateTotp, secondsLeftInWindow } from "./totp.js"

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890".
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

describe("decodeBase32", () => {
	it("decodes RFC 4648 base32, ignoring case, spaces and padding", () => {
		expect(decodeBase32("gezd gnbv gy3t qojq gezdgnbvgy3tqojq").toString()).toBe("12345678901234567890")
		expect(decodeBase32("MZXW6===").toString()).toBe("foo")
	})

	it("rejects characters outside the alphabet", () => {
		expect(() => decodeBase32("ABC1")).toThrow(/Invalid base32 character "1"/)
	})
})

describe("generateTotp", () => {
	it.each([
		[59, "94287082"],
		[1111111109, "07081804"],
		[1111111111, "14050471"],
		[1234567890, "89005924"],
		[2000000000, "69279037"],
		[20000000000, "65353130"],
	])("matches the RFC 6238 vector at T=%i", (seconds, code) => {
		expect(generateTotp(RFC_SECRET, seconds * 1000, 8)).toBe(code)
	})

	it("defaults to 6 digits", () => {
		expect(generateTotp(RFC_SECRET, 59_000)).toBe("287082")
	})
})

describe("secondsLeftInWindow", () => {
	it("counts down within the 30 s window", () => {
		expect(secondsLeftInWindow(0)).toBe(30)
		expect(secondsLeftInWindow(29_500)).toBe(1)
		expect(secondsLeftInWindow(31_000)).toBe(29)
	})
})
