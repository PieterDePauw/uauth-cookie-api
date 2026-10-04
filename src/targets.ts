import type { Page } from "patchright"
import { CookieApiError, CredentialsRejectedError, MissingCredentialsError } from "./errors.js"

export type UcCredentials = { username: string; password: string }

/** UC credentials as gathered from options and env; checked only when the dialog actually shows. */
export type PartialUcCredentials = { [K in keyof UcCredentials]?: string | undefined }

/** A service behind Entra whose own session cookie we want. */
export type Target = {
	name: string
	/** Where to land authenticated. The cookie is read for this URL, so its path matters. */
	url: string
	cookieName: string
	/** Runs on the landed page after the Entra step, before the cookie is read. */
	afterSso?: (page: Page) => Promise<void>
	/** What `serve` requests (plain HTTP, no browser) to keep the session alive. Default `url`. */
	keepAliveUrl?: string
	/** True when a 2xx keep-alive answer is the service's own login page, i.e. the session is gone. */
	isLoginPage?: (body: string) => boolean
}

export const DEFAULT_OTRS_URL = "https://otrsdict.ugent.be/znuny/index.pl"
export const DEFAULT_UC_URL = "https://uc.ugent.be/"

/** OTRS (Znuny) agent interface. Use the /znuny/ path: /otrs/ answers 301 and the cookie is scoped to /znuny/. */
export function otrsTarget(url: string = DEFAULT_OTRS_URL): Target {
	return { name: "otrs", url, cookieName: "OTRSAgentInterface", isLoginPage: (body) => body.includes('id="LoginBox"') }
}

/**
 * OpenScape UC. After Entra the web client shows its own `.loginDialog` that takes the UC account; `OpenScapeUC` only exists once that is done and the
 * first `/owc-servlets/*` call answers, so the hook fills the dialog when shown and then calls `/owc-servlets/rules` from the page, which both mints the
 * cookie and proves it works.
 */
export function ucTarget(credentials: PartialUcCredentials, url: string = DEFAULT_UC_URL): Target {
	return { name: "uc", url, cookieName: "OpenScapeUC", afterSso: (page) => completeUcLogin(page, credentials, url), keepAliveUrl: new URL("/owc-servlets/rules", url).href }
}

async function completeUcLogin(page: Page, credentials: PartialUcCredentials, url: string): Promise<void> {
	const dialog = page.locator(".loginDialog.in")
	const shown = await dialog
		.waitFor({ state: "visible", timeout: 5_000 })
		.then(() => true)
		.catch(() => false)
	if (shown) {
		const { username, password } = credentials
		if (!username || !password) throw new MissingCredentialsError([!username && "UC_USERNAME", !password && "UC_PASSWORD"].filter((name) => typeof name === "string"))
		await dialog.locator("#username").fill(username)
		await dialog.locator("#password").fill(password)
		await dialog.locator(".loginButton").click()
		const closed = await dialog
			.waitFor({ state: "hidden", timeout: 30_000 })
			.then(() => true)
			.catch(() => false)
		if (!closed) throw new CredentialsRejectedError("uc", (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").trim())
	}
	const rulesUrl = new URL("/owc-servlets/rules", url).href
	const status = await page.evaluate(async (target) => (await fetch(target, { credentials: "include", redirect: "manual" })).status, rulesUrl)
	if (status < 200 || status >= 300) throw new CookieApiError(`OpenScape UC session check failed: GET ${rulesUrl} answered ${status}`)
}
