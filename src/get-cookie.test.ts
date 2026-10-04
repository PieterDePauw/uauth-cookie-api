import type { BrowserContext, Page } from "patchright"
import { describe, expect, it, vi } from "vitest"
import { CookieTimeoutError, MissingCredentialsError } from "./errors.js"
import { getCookie, getOtrsCookie, resolveEntraCredentials, runExclusive, waitForSsoBounce, type Dependencies } from "./get-cookie.js"
import { otrsTarget } from "./targets.js"

const OTRS = "https://otrsdict.ugent.be/znuny/index.pl"
const ENTRA = "https://login.microsoftonline.com/tenant/oauth2/authorize"
const ENV = { ENTRA_USERNAME: "a@ugent.be", ENTRA_PASSWORD: "pw", ENTRA_TOTP_SECRET: "GEZDGNBV" }

type FakeCookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Lax" }

/** A page whose URL follows `urlsAfterGoto` one step per `waitForTimeout`, and a context that serves `cookies` once `cookiesReady()` holds. */
function createFakeBrowser({ urlsAfterGoto, cookies, cookiesReady = () => true }: { urlsAfterGoto: string[]; cookies: FakeCookie[]; cookiesReady?: () => boolean }) {
	let current = "about:blank"
	let pending: string[] = []
	const page = {
		url: () => current,
		goto: vi.fn(async () => {
			pending = [...urlsAfterGoto]
			current = pending.shift() ?? current
		}),
		waitForTimeout: vi.fn(async () => {
			current = pending.shift() ?? current
		}),
		waitForLoadState: vi.fn(async () => undefined),
		setUrl: (url: string) => {
			current = url
			pending = []
		},
	}
	const context = { cookies: vi.fn(async () => (cookiesReady() ? cookies : [])) }
	const close = vi.fn(async () => undefined)
	return { page, context, close, open: vi.fn(async () => ({ page: page as unknown as Page, context: context as unknown as BrowserContext, close })) }
}

const otrsCookie: FakeCookie = { name: "OTRSAgentInterface", value: "abc123", domain: "otrsdict.ugent.be", path: "/znuny/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }

describe("getCookie", () => {
	it("returns the cookie without signing in when the profile's SSO session is still valid", async () => {
		const fake = createFakeBrowser({ urlsAfterGoto: [OTRS], cookies: [otrsCookie] })
		const signIn = vi.fn()
		const cookie = await getCookie(otrsTarget(), { env: {}, profileDir: "p1" }, { open: fake.open, signIn } as Dependencies)
		expect(cookie).toEqual({ name: "OTRSAgentInterface", value: "abc123", domain: "otrsdict.ugent.be", path: "/znuny/", expires: undefined, httpOnly: true, secure: true, header: "OTRSAgentInterface=abc123", signedIn: false })
		expect(signIn).not.toHaveBeenCalled()
		expect(fake.context.cookies).toHaveBeenCalledWith(OTRS)
		expect(fake.close).toHaveBeenCalledOnce()
	})

	it("signs in through Entra after a delayed bounce and reads the cookie set afterwards", async () => {
		let signedIn = false
		const fake = createFakeBrowser({ urlsAfterGoto: [OTRS, OTRS, ENTRA], cookies: [{ ...otrsCookie, expires: 1_900_000_000 }], cookiesReady: () => signedIn })
		const signIn = vi.fn(async (page: Page) => {
			signedIn = true
			;(page as unknown as { setUrl: (url: string) => void }).setUrl(`${OTRS}?Action=AgentDashboard`)
			return ["username"]
		})
		const cookie = await getCookie(otrsTarget(), { env: ENV, profileDir: "p2" }, { open: fake.open, signIn })
		expect(signIn).toHaveBeenCalledWith(fake.page, { username: "a@ugent.be", password: "pw", totpSecret: "GEZDGNBV" }, expect.any(Number))
		expect(cookie).toMatchObject({ value: "abc123", expires: 1_900_000_000, signedIn: true })
	})

	it("fails before signing in when Entra credentials are missing, and still closes the browser", async () => {
		const fake = createFakeBrowser({ urlsAfterGoto: [ENTRA], cookies: [] })
		const signIn = vi.fn()
		await expect(getCookie(otrsTarget(), { env: { ENTRA_USERNAME: "a@ugent.be" }, profileDir: "p3" }, { open: fake.open, signIn } as Dependencies)).rejects.toThrow(MissingCredentialsError)
		expect(signIn).not.toHaveBeenCalled()
		expect(fake.close).toHaveBeenCalledOnce()
	})

	it("times out when the cookie never appears", async () => {
		const fake = createFakeBrowser({ urlsAfterGoto: [OTRS], cookies: [] })
		await expect(getCookie(otrsTarget(), { env: {}, profileDir: "p4", timeoutMs: 0 }, { open: fake.open, signIn: vi.fn() } as Dependencies)).rejects.toThrow(CookieTimeoutError)
	})

	it("runs the target's afterSso hook before reading the cookie", async () => {
		let hookRan = false
		const fake = createFakeBrowser({ urlsAfterGoto: ["https://uc.ugent.be/"], cookies: [{ ...otrsCookie, name: "OpenScapeUC" }], cookiesReady: () => hookRan })
		const target = {
			name: "uc",
			url: "https://uc.ugent.be/",
			cookieName: "OpenScapeUC",
			afterSso: async () => {
				hookRan = true
			},
		}
		const cookie = await getCookie(target, { env: {}, profileDir: "p5", timeoutMs: 0 }, { open: fake.open, signIn: vi.fn() } as Dependencies)
		expect(cookie.name).toBe("OpenScapeUC")
	})
})

describe("getOtrsCookie", () => {
	it("adds the cookie value as an X-OTRS-Header-SessionID header", async () => {
		const fake = createFakeBrowser({ urlsAfterGoto: [OTRS], cookies: [otrsCookie] })
		const cookie = await getOtrsCookie({ env: {}, profileDir: "p6" }, { open: fake.open, signIn: vi.fn() } as Dependencies)
		expect(cookie).toMatchObject({ name: "OTRSAgentInterface", value: "abc123", headers: { "X-OTRS-Header-SessionID": "abc123" } })
	})
})

describe("waitForSsoBounce", () => {
	it("is false once the URL stays off Microsoft long enough", async () => {
		const fake = createFakeBrowser({ urlsAfterGoto: [OTRS], cookies: [] })
		await fake.page.goto()
		expect(await waitForSsoBounce(fake.page as unknown as Page)).toBe(false)
		expect(fake.page.waitForTimeout).toHaveBeenCalledTimes(5)
	})

	it("is true for a redirect that lands on Microsoft after the service's own page", async () => {
		const fake = createFakeBrowser({ urlsAfterGoto: [OTRS, `${OTRS}?Action=Login`, ENTRA], cookies: [] })
		await fake.page.goto()
		expect(await waitForSsoBounce(fake.page as unknown as Page)).toBe(true)
	})
})

describe("resolveEntraCredentials", () => {
	it("prefers options over env, per field", () => {
		expect(resolveEntraCredentials({ password: "opt" }, ENV)).toEqual({ username: "a@ugent.be", password: "opt", totpSecret: "GEZDGNBV" })
	})

	it("names every missing variable", () => {
		expect(() => resolveEntraCredentials(undefined, { ENTRA_PASSWORD: "x" })).toThrow("set ENTRA_USERNAME, ENTRA_TOTP_SECRET")
	})
})

describe("runExclusive", () => {
	it("serialises tasks per key, even after a failure, and runs other keys in parallel", async () => {
		const order: string[] = []
		let releaseFirst = () => {}
		const first = runExclusive("a", () => new Promise<void>((resolve) => (releaseFirst = resolve)).then(() => order.push("a1")))
		const failing = runExclusive("a", async () => {
			order.push("a2")
			throw new Error("boom")
		})
		const third = runExclusive("a", async () => order.push("a3"))
		await runExclusive("b", async () => order.push("b1"))
		expect(order).toEqual(["b1"])
		releaseFirst()
		await first
		await expect(failing).rejects.toThrow("boom")
		await third
		expect(order).toEqual(["b1", "a1", "a2", "a3"])
	})
})
