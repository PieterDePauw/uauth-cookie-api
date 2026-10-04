import type { Locator, Page, Route } from "patchright"
import { CookieTimeoutError, CredentialsRejectedError } from "./errors.js"
import { generateTotp, secondsLeftInWindow } from "./totp.js"

export type EntraCredentials = { username: string; password: string; totpSecret: string }

/** One Entra screen: how to recognise it and what to do on it. */
export type EntraScreen = {
	name: string
	locate: (page: Page) => Locator
	/** Only act while this is visible too (for buttons Microsoft reuses on several screens). */
	guard?: (page: Page) => Locator
	act: (target: Locator, page: Page) => Promise<void>
}

const MICROSOFT_LOGIN_HOST = /^login\.(microsoftonline|microsoft|live)\.com$/i
const PASSKEY_PATH = /\/(bridge\/)?fido\b/i
const MAX_SAME_SCREEN = 3
const MAX_PASSKEY_DECLINES = 3
const ACTION_TIMEOUT_MS = 10_000

/** True when `url` is on one of Microsoft's login hosts. */
export function isMicrosoftLogin(url: string): boolean {
	const parsed = URL.parse(url)
	return parsed !== null && MICROSOFT_LOGIN_HOST.test(parsed.hostname)
}

/** Entra's full-page passkey bridge auto-starts WebAuthn and stalls headless; its `cancelUrl` is the "user declined" path back to the password flow. */
export function getPasskeyCancelUrl(url: string): string | undefined {
	const parsed = URL.parse(url)
	if (parsed === null || !PASSKEY_PATH.test(parsed.pathname)) return undefined
	return parsed.searchParams.get("cancelUrl") ?? undefined
}

async function typeAndSubmit(target: Locator, value: string): Promise<void> {
	await target.fill(value, { timeout: ACTION_TIMEOUT_MS })
	await target.press("Enter", { timeout: ACTION_TIMEOUT_MS })
}

async function click(target: Locator): Promise<void> {
	await target.click({ timeout: ACTION_TIMEOUT_MS })
}

/** The Entra screens, in priority order: the first visible one wins each tick. */
export function buildEntraScreens(credentials: EntraCredentials): EntraScreen[] {
	const anotherWay = /^(sign in another way|use another method|use a different method)$/i
	return [
		{
			// Entra re-renders the form in place with one of these banners after a wrong username, password or code. Stop at once rather than resubmit into a lockout.
			name: "error-banner",
			locate: (page) => page.locator("#usernameError, #passwordError, #idSpan_SAOTCC_Error_OTC"),
			act: async (target) => {
				throw new CredentialsRejectedError("entra", (await target.innerText().catch(() => "")).trim())
			},
		},
		{ name: "username", locate: (page) => page.locator('input[type="email"]'), act: (target) => typeAndSubmit(target, credentials.username) },
		{ name: "password", locate: (page) => page.locator('input[type="password"]'), act: (target) => typeAndSubmit(target, credentials.password) },
		{
			name: "verification-code",
			locate: (page) => page.locator('input[name="otc"], #idTxtBx_SAOTCC_OTC'),
			act: async (target, page) => {
				// A code typed with a second to spare can expire on the way to the server: wait for the next window.
				const left = secondsLeftInWindow()
				if (left < 3) await page.waitForTimeout(left * 1000 + 200)
				await typeAndSubmit(target, generateTotp(credentials.totpSecret))
			},
		},
		{
			// Account picker: the tile holds the address as its own text node; match it exactly so jan@ never picks jan.peeters@.
			name: "account-tile",
			locate: (page) => page.locator("#tilesHolder [role='button'], #tilesHolder button").filter({ has: page.getByText(credentials.username, { exact: true }) }),
			act: click,
		},
		{ name: "other-account", locate: (page) => page.getByRole("button", { name: /use another account/i }).or(page.getByRole("link", { name: /use another account/i })), act: click },
		{
			// "Verify your identity": pick the code option, never the Authenticator push (listed first, would wait for a phone).
			name: "pick-code-method",
			locate: (page) => page.locator("[role='button'], button, [role='listitem']").filter({ hasText: /verification code/i }),
			act: click,
		},
		{ name: "pick-password-method", locate: (page) => page.locator("[role='button'], button, [role='listitem'], a").filter({ hasText: /use (my |a )?password/i }), act: click },
		{ name: "sign-in-another-way", locate: (page) => page.locator("#signInAnotherWay, #signInAnotherWayBtn").or(page.getByRole("link", { name: anotherWay })), act: click },
		{
			// "Stay signed in?" → Yes, so the profile keeps a long-lived Entra cookie and later runs skip MFA. #idSIButton9 is reused elsewhere, hence the heading guard.
			name: "stay-signed-in",
			locate: (page) => page.locator("#idSIButton9"),
			guard: (page) => page.getByRole("heading", { name: /stay signed in/i }),
			act: click,
		},
	]
}

async function isVisible(locator: Locator): Promise<boolean> {
	return locator.isVisible().catch(() => false)
}

async function findScreen(page: Page, screens: EntraScreen[]): Promise<{ screen: EntraScreen; target: Locator } | undefined> {
	const targets = screens.map((screen) => screen.locate(page).first())
	const visible = await Promise.all(targets.map(isVisible))
	for (const [index, screen] of screens.entries()) {
		if (!visible[index]) continue
		if (screen.guard && !(await isVisible(screen.guard(page).first()))) continue
		return { screen, target: targets[index]! }
	}
	return undefined
}

/**
 * Drive the Entra sign-in on `page` until it leaves Microsoft's login hosts. Returns the screens acted on.
 * @throws {CredentialsRejectedError} on Entra's first error banner.
 * @throws {CookieTimeoutError} past `deadline`, or when the same screen keeps coming back without progress.
 */
export async function signInWithEntra(page: Page, credentials: EntraCredentials, deadline: number, screens: EntraScreen[] = buildEntraScreens(credentials)): Promise<string[]> {
	const acted: string[] = []
	let declines = 0
	const isPasskeyBridge = (url: URL) => getPasskeyCancelUrl(url.href) !== undefined
	const declinePasskey = async (route: Route) => {
		const cancelUrl = getPasskeyCancelUrl(route.request().url())
		if (cancelUrl === undefined || !route.request().isNavigationRequest() || declines >= MAX_PASSKEY_DECLINES) return route.fallback()
		declines++
		acted.push("decline-passkey")
		return route.fulfill({ status: 302, headers: { location: cancelUrl } })
	}
	await page.route(isPasskeyBridge, declinePasskey)

	let previous = ""
	let repeats = 0
	try {
		while (isMicrosoftLogin(page.url())) {
			if (Date.now() > deadline) throw new CookieTimeoutError(`Entra sign-in did not finish (screens: ${acted.join(" → ") || "none"})`, page.url())
			const found = await findScreen(page, screens)
			if (found === undefined) {
				await page.waitForTimeout(100)
				continue
			}
			const key = `${found.screen.name} ${page.url()}`
			repeats = key === previous ? repeats + 1 : 1
			previous = key
			if (repeats > MAX_SAME_SCREEN) throw new CookieTimeoutError(`Entra keeps showing "${found.screen.name}" after ${MAX_SAME_SCREEN} attempts`, page.url())
			try {
				await found.screen.act(found.target, page)
			} catch (error) {
				if (error instanceof CredentialsRejectedError) throw error
				continue // Entra re-rendered mid-action; look again.
			}
			acted.push(found.screen.name)
			await found.target.waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS }).catch(() => undefined)
		}
		return acted
	} finally {
		await page.unroute(isPasskeyBridge, declinePasskey).catch(() => undefined)
	}
}

