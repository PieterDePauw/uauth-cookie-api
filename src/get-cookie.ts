import type { BrowserContext, Page } from "patchright"
import { openBrowser, type OpenBrowser } from "./browser.js"
import { isMicrosoftLogin, signInWithEntra, type EntraCredentials } from "./entra.js"
import { CookieTimeoutError, MissingCredentialsError } from "./errors.js"
import type { JarCookie } from "./jar.js"
import { DEFAULT_OTRS_URL, DEFAULT_UC_URL, otrsTarget, ucTarget, type PartialUcCredentials, type Target } from "./targets.js"

/** Entra credentials as gathered from options; missing fields fall back to env. */
export type PartialEntraCredentials = { [K in keyof EntraCredentials]?: string | undefined }

export type CookieOptions = {
	/** Entra account. Each missing field falls back to ENTRA_USERNAME / ENTRA_PASSWORD / ENTRA_TOTP_SECRET. Only used when the profile's SSO session has expired. */
	entra?: PartialEntraCredentials | undefined
	/** Browser profile dir. Falls back to COOKIE_PROFILE_DIR, then `.cookie-profile`. */
	profileDir?: string | undefined
	/** Default true. */
	headless?: boolean | undefined
	/** Whole-call deadline. Default 120 000 ms. */
	timeoutMs?: number | undefined
	/** Where the fallbacks are read from. Default `process.env`. */
	env?: Record<string, string | undefined> | undefined
}

export type OtrsCookieOptions = CookieOptions & {
	/** Default OTRS_URL, then https://otrsdict.ugent.be/znuny/index.pl. */
	url?: string | undefined
}

export type UcCookieOptions = CookieOptions & {
	/** Default UC_URL, then https://uc.ugent.be/. */
	url?: string | undefined
	/** The UC account for OpenScape's own login dialog. Each missing field falls back to UC_USERNAME / UC_PASSWORD. */
	uc?: PartialUcCredentials | undefined
}

export type SessionCookie = {
	name: string
	value: string
	domain: string
	path: string
	/** Unix seconds, or undefined for a session cookie. */
	expires: number | undefined
	httpOnly: boolean
	secure: boolean
	/** `name=value`, ready for a `Cookie:` header. */
	header: string
	/** Whether this call had to sign in to Entra (false: the profile's SSO session was still valid). */
	signedIn: boolean
}

/** What `getOtrsCookie` returns: the cookie plus the header OTRS accepts the same session ID in. */
export type OtrsSessionCookie = SessionCookie & {
	/** `{ "X-OTRS-Header-SessionID": <OTRSAgentInterface value> }`, ready to spread into request headers. */
	headers: { "X-OTRS-Header-SessionID": string }
}

/** Test seam. */
export type Dependencies = { open: (options: { profileDir: string; headless: boolean }) => Promise<OpenBrowser>; signIn: typeof signInWithEntra }

export const DEFAULT_TIMEOUT_MS = 120_000
const defaultDependencies: Dependencies = { open: openBrowser, signIn: signInWithEntra }

/** Get the `OTRSAgentInterface` cookie of the OTRS agent interface, with its value also as an `X-OTRS-Header-SessionID` header. */
export async function getOtrsCookie(options: OtrsCookieOptions = {}, dependencies: Dependencies = defaultDependencies): Promise<OtrsSessionCookie> {
	const env = options.env ?? process.env
	return withOtrsHeaders(await getCookie(otrsTarget(options.url ?? env.OTRS_URL ?? DEFAULT_OTRS_URL), options, dependencies))
}

/** Add the header OTRS accepts the same session ID in. */
export function withOtrsHeaders(cookie: SessionCookie): OtrsSessionCookie {
	return { ...cookie, headers: { "X-OTRS-Header-SessionID": cookie.value } }
}

/** Get the `OpenScapeUC` cookie of the OpenScape UC web client. */
export function getUcCookie(options: UcCookieOptions = {}): Promise<SessionCookie> {
	const env = options.env ?? process.env
	return getCookie(ucTarget(resolveUcCredentials(options.uc, env), options.url ?? env.UC_URL ?? DEFAULT_UC_URL), options)
}

/** UC credentials from options, then env, per field. */
export function resolveUcCredentials(partial: PartialUcCredentials | undefined, env: Record<string, string | undefined>): PartialUcCredentials {
	return { username: partial?.username ?? env.UC_USERNAME, password: partial?.password ?? env.UC_PASSWORD }
}

/** Land on `target.url` signed in (via Entra if needed), run the target's hook, and return its session cookie. */
export async function getCookie(target: Target, options: CookieOptions = {}, dependencies: Dependencies = defaultDependencies): Promise<SessionCookie> {
	return (await getSession(target, options, dependencies)).cookie
}

/** Everything a plain HTTP client needs to act as the browser on the service: the cookie, every cookie the browser holds for it, and its User-Agent. */
export type BrowserSession = {
	/** The service URL the session was obtained for (`target.url`). */
	url: string
	cookie: SessionCookie
	/** All of the browser's cookies for `target.url` and `target.keepAliveUrl`, including the reverse proxy's own session cookie (mod_auth_openidc). */
	jar: JarCookie[]
	/** The browser's User-Agent, sent along so the service sees the same client. */
	userAgent: string
}

/** Like `getCookie`, but also returns the browser's whole cookie jar for the service and its User-Agent. */
export function getSession(target: Target, options: CookieOptions = {}, dependencies: Dependencies = defaultDependencies): Promise<BrowserSession> {
	const env = options.env ?? process.env
	const profileDir = resolveProfileDir(options, env)
	// One Chromium per profile at a time: a second launch on the same dir fails on the profile lock.
	return runExclusive(profileDir, async () => {
		const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
		const browser = await dependencies.open({ profileDir, headless: options.headless ?? true })
		try {
			const cookie = await readCookieSignedIn(browser, target, () => resolveEntraCredentials(options.entra, env), deadline, dependencies.signIn)
			const urls = [...new Set([target.url, target.keepAliveUrl ?? target.url])]
			const jar = (await browser.context.cookies(urls)).map(({ name, value, domain, path, expires, httpOnly, secure }) => ({ name, value, domain, path, expires, httpOnly, secure }))
			const userAgent = await browser.page.evaluate(() => navigator.userAgent)
			return { url: target.url, cookie, jar, userAgent }
		} finally {
			await browser.close()
		}
	})
}

export function resolveProfileDir(options: CookieOptions, env: Record<string, string | undefined>): string {
	return options.profileDir ?? env.COOKIE_PROFILE_DIR ?? ".cookie-profile"
}

/** Navigate `page` to the target, sign in to Entra if it bounces there, run the target's hook and read the cookie. Also how the server keeps a session alive. */
export async function readCookieSignedIn(browser: Pick<OpenBrowser, "page" | "context">, target: Target, credentials: () => EntraCredentials, deadline: number, signIn: Dependencies["signIn"]): Promise<SessionCookie> {
	const { page, context } = browser
	await goto(page, target.url, deadline)
	let signedIn = false
	if (await waitForSsoBounce(page)) {
		await signIn(page, credentials(), deadline)
		signedIn = true
		// Entra posts back to the service, which may hop through its own callback before landing.
		await page.waitForLoadState("domcontentloaded").catch(() => undefined)
		if (await waitForSsoBounce(page)) throw new CookieTimeoutError("Still on Microsoft after signing in", page.url())
	}
	await target.afterSso?.(page)
	const cookie = await waitForCookie(context, page, target, deadline)
	return { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, expires: cookie.expires > 0 ? cookie.expires : undefined, httpOnly: cookie.httpOnly, secure: cookie.secure, header: `${cookie.name}=${cookie.value}`, signedIn }
}

/** Render a cookie as its bare value, a `name=value` header pair or JSON. */
export function formatCookie(cookie: SessionCookie, format: string): string {
	if (format === "value") return cookie.value
	if (format === "header") return cookie.header
	if (format === "json") return JSON.stringify(cookie, null, 2)
	throw new TypeError(`Unknown format "${format}" (value, header or json)`)
}

/** `page.goto` that tolerates the navigation being replaced by an SSO redirect (net::ERR_ABORTED). */
async function goto(page: Page, url: string, deadline: number): Promise<void> {
	try {
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(1, Math.min(30_000, deadline - Date.now())) })
	} catch (error) {
		if (!(error instanceof Error && error.message.includes("net::ERR_ABORTED"))) throw error
	}
}

/**
 * Services often load their own page first and only then redirect to Microsoft (script or auto-submitted form), so "not on Microsoft right after goto"
 * proves nothing. Watch the URL until it reaches Microsoft (true) or stays put for 500 ms (false), at most 3 s.
 */
export async function waitForSsoBounce(page: Page, pollMs = 100, quietMs = 500, maxMs = 3_000): Promise<boolean> {
	let last = page.url()
	let quiet = 0
	for (let waited = 0; waited < maxMs; waited += pollMs) {
		if (isMicrosoftLogin(last)) return true
		await page.waitForTimeout(pollMs)
		const now = page.url()
		quiet = now === last ? quiet + pollMs : 0
		last = now
		if (quiet >= quietMs) break
	}
	return isMicrosoftLogin(last)
}

type ContextCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number]

/** Poll the browser for the target's cookie (as it would be sent to `target.url`) until it shows up or the deadline passes. */
async function waitForCookie(context: BrowserContext, page: Page, target: Target, deadline: number): Promise<ContextCookie> {
	for (;;) {
		const cookie = (await context.cookies(target.url)).find((candidate) => candidate.name === target.cookieName && candidate.value !== "")
		if (cookie) return cookie
		if (Date.now() > deadline) throw new CookieTimeoutError(`No ${target.cookieName} cookie for ${target.url}`, page.url())
		await page.waitForTimeout(250)
	}
}

/** Entra credentials from options, then env. Called only when a sign-in is actually needed, so a warm profile works without them. */
export function resolveEntraCredentials(partial: PartialEntraCredentials | undefined, env: Record<string, string | undefined>): EntraCredentials {
	const username = partial?.username ?? env.ENTRA_USERNAME
	const password = partial?.password ?? env.ENTRA_PASSWORD
	const totpSecret = partial?.totpSecret ?? env.ENTRA_TOTP_SECRET
	if (username && password && totpSecret) return { username, password, totpSecret }
	const missing = [!username && "ENTRA_USERNAME", !password && "ENTRA_PASSWORD", !totpSecret && "ENTRA_TOTP_SECRET"].filter((name) => typeof name === "string")
	throw new MissingCredentialsError(missing)
}

const queues = new Map<string, Promise<unknown>>()

/** Run `task` after every earlier task for the same `key` has settled. */
export function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve()
	const result = previous.catch(() => undefined).then(task)
	const tail = result.catch(() => undefined)
	queues.set(key, tail)
	void tail.then(() => {
		if (queues.get(key) === tail) queues.delete(key)
	})
	return result
}
