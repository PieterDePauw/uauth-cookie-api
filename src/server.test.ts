import { afterEach, describe, expect, it, vi } from "vitest"
import { CredentialsRejectedError } from "./errors.js"
import type { BrowserSession } from "./get-cookie.js"
import { createSessionKeeper, startCookieServer, type CookieServer, type ServerDependencies } from "./server.js"
import { otrsTarget, ucTarget, type Target } from "./targets.js"

const OTRS = "https://otrsdict.ugent.be/znuny/index.pl"
const base = { expires: -1, httpOnly: true, secure: true }

function otrsSession(value = "otrs1"): BrowserSession {
	return {
		url: OTRS,
		cookie: { name: "OTRSAgentInterface", value, domain: "otrsdict.ugent.be", path: "/znuny/", expires: undefined, httpOnly: true, secure: true, header: `OTRSAgentInterface=${value}`, signedIn: true },
		jar: [
			{ ...base, name: "OTRSAgentInterface", value, domain: "otrsdict.ugent.be", path: "/znuny/" },
			{ ...base, name: "mod_auth_openidc_session", value: "oidc", domain: "otrsdict.ugent.be", path: "/" },
		],
		userAgent: "Mozilla/5.0 Test",
	}
}

function answer(status: number, body = "", headers: Record<string, string> = {}): Response {
	return new Response(status >= 300 && status < 400 ? null : body, { status, headers })
}

function setup(responses: Response[] = [], login?: (target: Target) => Promise<BrowserSession>) {
	let logins = 0
	const dependencies: ServerDependencies = {
		login: vi.fn(login ?? (async () => otrsSession(`otrs${++logins}`))),
		fetch: vi.fn(async () => responses.shift() ?? answer(200, "<html>dashboard</html>")),
	}
	const keeper = createSessionKeeper(new Map([["otrs", otrsTarget()]]), dependencies)
	return { keeper, dependencies }
}

describe("createSessionKeeper", () => {
	it("signs in once with the browser and then serves the kept session without touching the service", async () => {
		const { keeper, dependencies } = setup()
		expect((await keeper.get("otrs")).cookie.value).toBe("otrs1")
		expect((await keeper.get("otrs")).cookie.value).toBe("otrs1")
		expect(dependencies.login).toHaveBeenCalledOnce()
		expect(dependencies.fetch).not.toHaveBeenCalled()
	})

	it("keeps the session alive over HTTP with every cookie and the browser's User-Agent, and takes rotated cookies", async () => {
		const { keeper, dependencies } = setup([answer(200, "ok", { "set-cookie": "OTRSAgentInterface=rotated; Path=/znuny/; Secure; HttpOnly" })])
		await keeper.get("otrs")
		await keeper.keepAlive()
		expect(dependencies.login).toHaveBeenCalledOnce()
		const [url, init] = vi.mocked(dependencies.fetch).mock.calls[0]!
		expect(url).toBe(OTRS)
		expect(init).toMatchObject({ redirect: "manual", headers: { cookie: "OTRSAgentInterface=otrs1; mod_auth_openidc_session=oidc", "user-agent": "Mozilla/5.0 Test" } })
		expect(keeper.status().otrs).toMatchObject({ ok: true, error: undefined })
		expect((await keeper.get("otrs")).jar.find((cookie) => cookie.name === "OTRSAgentInterface")).toMatchObject({ value: "rotated" })
	})

	it("signs in again when the proxy redirects to Microsoft", async () => {
		const { keeper, dependencies } = setup([answer(302, "", { location: "https://login.microsoftonline.com/x" })])
		await keeper.get("otrs")
		await keeper.keepAlive()
		expect(dependencies.login).toHaveBeenCalledTimes(2)
		expect((await keeper.get("otrs")).cookie.value).toBe("otrs2")
	})

	it("signs in again when OTRS answers with its own login page", async () => {
		const { keeper, dependencies } = setup([answer(200, '<div id="LoginBox" class="LoginBox">')])
		await keeper.get("otrs")
		await keeper.keepAlive()
		expect(dependencies.login).toHaveBeenCalledTimes(2)
	})

	it("keeps the session through a server error, reports it, and checks again on the next request", async () => {
		const { keeper, dependencies } = setup([answer(502)])
		await keeper.get("otrs")
		await keeper.keepAlive()
		expect(dependencies.login).toHaveBeenCalledOnce()
		expect(keeper.status().otrs).toMatchObject({ ok: false, error: expect.stringContaining("answered 502") })
		expect((await keeper.get("otrs")).cookie.value).toBe("otrs1")
		expect(dependencies.fetch).toHaveBeenCalledTimes(2)
		expect(keeper.status().otrs?.ok).toBe(true)
	})

	it("backs off after a failed sign-in instead of launching the browser on every request", async () => {
		vi.useFakeTimers({ toFake: ["Date"] })
		try {
			let fail = true
			const { keeper, dependencies } = setup([], async () => {
				if (fail) throw new Error("Chromium crashed")
				return otrsSession()
			})
			await expect(keeper.get("otrs")).rejects.toThrow("Chromium crashed")
			await expect(keeper.get("otrs")).rejects.toThrow("Chromium crashed")
			expect(dependencies.login).toHaveBeenCalledOnce()
			fail = false
			vi.advanceTimersByTime(30_001)
			expect((await keeper.get("otrs")).cookie.value).toBe("otrs1")
			expect(dependencies.login).toHaveBeenCalledTimes(2)
		} finally {
			vi.useRealTimers()
		}
	})

	it("stops signing in for good once Entra rejects the credentials", async () => {
		const { keeper, dependencies } = setup([], async () => {
			throw new CredentialsRejectedError("entra", "Your password is incorrect")
		})
		await expect(keeper.get("otrs")).rejects.toThrow(CredentialsRejectedError)
		await keeper.keepAlive()
		await expect(keeper.get("otrs", { fresh: true })).rejects.toThrow(CredentialsRejectedError)
		expect(dependencies.login).toHaveBeenCalledOnce()
		expect(keeper.status().otrs?.error).toMatch(/CredentialsRejectedError/)
	})
})

describe("startCookieServer", () => {
	let server: CookieServer | undefined
	afterEach(async () => {
		await server?.close()
		server = undefined
	})

	async function start(token?: string) {
		const login = vi.fn(async (target: Target) => (target.name === "otrs" ? otrsSession() : { ...otrsSession(), url: "https://uc.ugent.be/" }))
		server = await startCookieServer({ env: {}, port: 0, token, keepAliveMs: 3_600_000, services: ["otrs"] }, { login, fetch: vi.fn(async () => answer(200)) })
		return { url: server.url, login }
	}

	it("serves the session as JSON with ready-to-use request headers", async () => {
		const { url } = await start()
		const response = await fetch(`${url}/otrs`)
		expect(response.status).toBe(200)
		expect(response.headers.get("cache-control")).toBe("no-store")
		expect(await response.json()).toMatchObject({
			name: "OTRSAgentInterface",
			value: "otrs1",
			headers: { cookie: "OTRSAgentInterface=otrs1; mod_auth_openidc_session=oidc", "user-agent": "Mozilla/5.0 Test", "X-OTRS-Header-SessionID": "otrs1" },
		})
	})

	it("serves plain-text formats", async () => {
		const { url } = await start()
		expect(await (await fetch(`${url}/otrs?format=value`)).text()).toBe("otrs1\n")
		expect(await (await fetch(`${url}/otrs?format=header`)).text()).toBe("OTRSAgentInterface=otrs1\n")
		expect(await (await fetch(`${url}/otrs?format=cookie`)).text()).toBe("OTRSAgentInterface=otrs1; mod_auth_openidc_session=oidc\n")
		expect((await fetch(`${url}/otrs?format=xml`)).status).toBe(400)
	})

	it("reports health and 404s services it does not keep", async () => {
		const { url } = await start()
		await fetch(`${url}/otrs`)
		const health = await fetch(`${url}/health`)
		expect(health.status).toBe(200)
		expect(await health.json()).toMatchObject({ services: { otrs: { ok: true } } })
		expect((await fetch(`${url}/uc`)).status).toBe(404)
		expect((await fetch(`${url}/otrs`, { method: "POST" })).status).toBe(405)
	})

	it("requires the bearer token when one is set", async () => {
		const { url } = await start("s3cret")
		expect((await fetch(`${url}/otrs`)).status).toBe(401)
		expect((await fetch(`${url}/otrs`, { headers: { authorization: "Bearer nope" } })).status).toBe(401)
		expect((await fetch(`${url}/otrs`, { headers: { authorization: "Bearer s3cret" } })).status).toBe(200)
	})

	it("refuses foreign Host headers (DNS rebinding)", async () => {
		const { url } = await start()
		const { request } = await import("node:http")
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const req = request(`${url}/otrs`, { headers: { host: "evil.example:8787" } }, (response) => {
				response.resume()
				resolve(response.statusCode)
			})
			req.on("error", reject)
			req.end()
		})
		expect(status).toBe(403)
	})

	it("signs in at startup, before any request", async () => {
		const { login } = await start()
		await vi.waitFor(() => expect(login).toHaveBeenCalledOnce())
	})
})

describe("ucTarget", () => {
	it("keeps alive through /owc-servlets/rules", () => {
		expect(ucTarget({}, "https://uc.ugent.be/").keepAliveUrl).toBe("https://uc.ugent.be/owc-servlets/rules")
	})
})
