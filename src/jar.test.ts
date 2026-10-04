import { describe, expect, it } from "vitest"
import { applySetCookies, cookieHeaderFor, type JarCookie } from "./jar.js"

const NOW = 1_800_000_000_000
const base = { expires: -1, httpOnly: true, secure: true }
const jar: JarCookie[] = [
	{ ...base, name: "OTRSAgentInterface", value: "otrs", domain: "otrsdict.ugent.be", path: "/znuny/" },
	{ ...base, name: "mod_auth_openidc_session", value: "oidc", domain: "otrsdict.ugent.be", path: "/" },
	{ ...base, name: "wide", value: "w", domain: ".ugent.be", path: "/" },
	{ ...base, name: "other", value: "x", domain: "uc.ugent.be", path: "/" },
	{ ...base, name: "old", value: "o", domain: "otrsdict.ugent.be", path: "/", expires: NOW / 1000 - 1 },
]

describe("cookieHeaderFor", () => {
	it("sends what a browser would: matching domain and path, not expired", () => {
		expect(cookieHeaderFor(jar, "https://otrsdict.ugent.be/znuny/index.pl", NOW)).toBe("OTRSAgentInterface=otrs; mod_auth_openidc_session=oidc; wide=w")
		expect(cookieHeaderFor(jar, "https://otrsdict.ugent.be/znunyx", NOW)).toBe("mod_auth_openidc_session=oidc; wide=w")
		expect(cookieHeaderFor(jar, "http://otrsdict.ugent.be/", NOW)).toBe("")
	})
})

describe("applySetCookies", () => {
	it("replaces a value, adds new cookies with the default path, and deletes on Max-Age=0", () => {
		const next = applySetCookies(jar, "https://otrsdict.ugent.be/znuny/index.pl", ["mod_auth_openidc_session=fresh; Path=/; Secure; HttpOnly", "added=1", "wide=; Domain=ugent.be; Path=/; Max-Age=0"], NOW)
		expect(next.find((cookie) => cookie.name === "mod_auth_openidc_session")).toMatchObject({ value: "fresh", path: "/", secure: true })
		expect(next.find((cookie) => cookie.name === "added")).toMatchObject({ value: "1", domain: "otrsdict.ugent.be", path: "/znuny" })
		expect(next.some((cookie) => cookie.name === "wide")).toBe(false)
		expect(next.filter((cookie) => cookie.name === "mod_auth_openidc_session")).toHaveLength(1)
	})

	it("reads Max-Age and Expires into Unix seconds", () => {
		const next = applySetCookies([], "https://uc.ugent.be/", ["a=1; Max-Age=60", "b=2; Expires=Wed, 01 Jan 2031 00:00:00 GMT"], NOW)
		expect(next.map((cookie) => cookie.expires)).toEqual([NOW / 1000 + 60, Date.UTC(2031, 0, 1) / 1000])
	})
})
