import { mkdirSync } from "node:fs"
import { chromium, type BrowserContext, type Page } from "patchright"

export type BrowserOptions = {
	/** Chromium user-data dir. Keeps the Entra SSO cookies between runs, so most runs skip the MFA prompt. */
	profileDir: string
	/** Default true. */
	headless?: boolean | undefined
}

export type OpenBrowser = { context: BrowserContext; page: Page; close: () => Promise<void> }

/**
 * Runs in the page before any site script. Headless Chromium has no authenticator, and a WebAuthn prompt renders outside the DOM where nothing can answer it, so tell Entra there is
 * no platform authenticator and make any passkey request fail the way a cancelled dialog does. Entra then offers password + code. Must stay self-contained (it is serialised).
 */
function disablePasskeys(): void {
	if (typeof PublicKeyCredential !== "undefined") {
		PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => false
		PublicKeyCredential.isConditionalMediationAvailable = async () => false
	}
	const credentials = typeof navigator === "undefined" ? undefined : navigator.credentials
	if (credentials) {
		const get = credentials.get.bind(credentials)
		credentials.get = (options) => (options?.publicKey ? Promise.reject(new DOMException("No passkey here", "NotAllowedError")) : get(options))
	}
}

/** Launch patchright's Chromium (patched against the usual automation tells) with a persistent profile. The caller must `close()`. */
export async function openBrowser({ profileDir, headless = true }: BrowserOptions): Promise<OpenBrowser> {
	mkdirSync(profileDir, { recursive: true })
	const context = await chromium.launchPersistentContext(profileDir, {
		channel: "chromium",
		headless,
		locale: "en-US",
		timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
		viewport: { width: 1920, height: 1080 },
		args: ["--disable-blink-features=AutomationControlled"],
		handleSIGINT: false,
		handleSIGTERM: false,
		handleSIGHUP: false,
	})
	await context.addInitScript(disablePasskeys)
	const page = context.pages()[0] ?? (await context.newPage())
	return { context, page, close: () => closeQuietly(context) }
}

/**
 * Close without letting the pages say goodbye: a web client may send a logout request (beacon, fetch) as it unloads, which would end the very session
 * whose cookies we just handed out. Abort every request first, then close.
 */
async function closeQuietly(context: BrowserContext): Promise<void> {
	await context.route("**/*", (route) => route.abort()).catch(() => undefined)
	await context.close().catch(() => undefined)
}
