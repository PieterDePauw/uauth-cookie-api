import { describe, expect, it, vi } from "vitest"
import { formatCookie, getExitCode, main } from "./cli.js"
import { CookieApiError, CookieTimeoutError, CredentialsRejectedError, MissingCredentialsError } from "./errors.js"
import type { SessionCookie } from "./get-cookie.js"

const cookie: SessionCookie = { name: "OpenScapeUC", value: "v", domain: "uc.ugent.be", path: "/", expires: undefined, httpOnly: true, secure: true, header: "OpenScapeUC=v", signedIn: false }

describe("formatCookie", () => {
	it("prints the value, the header pair or JSON", () => {
		expect(formatCookie(cookie, "value")).toBe("v")
		expect(formatCookie(cookie, "header")).toBe("OpenScapeUC=v")
		expect(JSON.parse(formatCookie(cookie, "json"))).toMatchObject({ name: "OpenScapeUC", value: "v" })
		expect(() => formatCookie(cookie, "xml")).toThrow(/Unknown --format/)
	})
})

describe("getExitCode", () => {
	it("maps errors to the documented codes", () => {
		expect(getExitCode(new MissingCredentialsError(["UC_USERNAME"]))).toBe(2)
		expect(getExitCode(new CredentialsRejectedError("uc", ""))).toBe(3)
		expect(getExitCode(new CookieTimeoutError("x", "u"))).toBe(4)
		expect(getExitCode(new CookieApiError("x"))).toBe(4)
		expect(getExitCode(new Error("x"))).toBe(1)
	})
})

describe("main", () => {
	it("prints usage and fails on an unknown service", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		expect(await main(["jira"])).toBe(1)
		expect(error).toHaveBeenCalledWith(expect.stringContaining("Usage: uauth-cookie <otrs|uc>"))
		error.mockRestore()
	})

	it("prints usage on --help", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		expect(await main(["--help"])).toBe(0)
		log.mockRestore()
	})
})
