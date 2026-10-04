import { describe, expect, it } from "vitest"
import { buildEntraScreens, getPasskeyCancelUrl, isMicrosoftLogin } from "./entra.js"

describe("isMicrosoftLogin", () => {
	it.each(["https://login.microsoftonline.com/tenant/oauth2/authorize", "https://login.microsoft.com/x", "https://LOGIN.LIVE.COM/"])("is true for %s", (url) => {
		expect(isMicrosoftLogin(url)).toBe(true)
	})

	it.each(["https://otrsdict.ugent.be/znuny/index.pl", "https://login.ugent.be/", "https://evil.example/login.microsoftonline.com", "not a url"])("is false for %s", (url) => {
		expect(isMicrosoftLogin(url)).toBe(false)
	})
})

describe("getPasskeyCancelUrl", () => {
	it("returns the decoded cancelUrl of the passkey bridge", () => {
		const cancel = "https://login.microsoftonline.com/common/reprocess?ctx=abc"
		expect(getPasskeyCancelUrl(`https://login.microsoft.com/tenant/bridge/fido?cancelUrl=${encodeURIComponent(cancel)}`)).toBe(cancel)
		expect(getPasskeyCancelUrl(`https://login.microsoft.com/common/fido/get?cancelUrl=${encodeURIComponent(cancel)}`)).toBe(cancel)
	})

	it("is undefined for other pages or a bridge without cancelUrl", () => {
		expect(getPasskeyCancelUrl("https://login.microsoftonline.com/common/login?cancelUrl=x")).toBeUndefined()
		expect(getPasskeyCancelUrl("https://login.microsoft.com/tenant/bridge/fido")).toBeUndefined()
		expect(getPasskeyCancelUrl("::")).toBeUndefined()
	})
})

describe("buildEntraScreens", () => {
	it("checks the error banner first and only acts on the KMSI button behind its heading", () => {
		const screens = buildEntraScreens({ username: "a@ugent.be", password: "p", totpSecret: "GEZDGNBV" })
		expect(screens.map((screen) => screen.name)).toEqual(["error-banner", "username", "password", "verification-code", "account-tile", "other-account", "pick-code-method", "pick-password-method", "sign-in-another-way", "stay-signed-in"])
		expect(screens.find((screen) => screen.name === "stay-signed-in")?.guard).toBeTypeOf("function")
	})
})
