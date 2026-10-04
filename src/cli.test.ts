import { describe, expect, it, vi } from "vitest"
import { formatCookie, getExitCode, main } from "./cli.js"

vi.mock("./get-cookie.js", () => ({
	getOtrsCookie: vi.fn(async () => ({ name: "OTRSAgentInterface", value: "o", header: "OTRSAgentInterface=o" })),
	getUcCookie: vi.fn(async () => ({ name: "OpenScapeUC", value: "u", header: "OpenScapeUC=u" })),
}))
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
		expect(error).toHaveBeenCalledWith(expect.stringContaining("Usage: uauth-cookie [otrs|uc]"))
		error.mockRestore()
	})

	it("prints one service's value by default", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		expect(await main(["uc"])).toBe(0)
		expect(log).toHaveBeenCalledWith("u")
		log.mockRestore()
	})

	it("prints both cookies as headers without a service", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		expect(await main([])).toBe(0)
		expect(log).toHaveBeenCalledWith("OTRSAgentInterface=o\nOpenScapeUC=u")
		log.mockRestore()
	})

	it("prints both cookies as one JSON object", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		expect(await main(["--format", "json"])).toBe(0)
		expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ otrs: { value: "o" }, uc: { value: "u" } })
		log.mockRestore()
	})

	it("rejects --url without a service", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		expect(await main(["--url", "https://x"])).toBe(1)
		error.mockRestore()
	})

	it("prints usage on --help", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		expect(await main(["--help"])).toBe(0)
		log.mockRestore()
	})
})
