/** Base class, so callers can catch everything this package throws with one `instanceof`. */
export class CookieApiError extends Error {
	override name = "CookieApiError"
}

/** A login was needed but a credential is missing (Entra or UC). Nothing was submitted. */
export class MissingCredentialsError extends CookieApiError {
	override name = "MissingCredentialsError"
	constructor(readonly variables: string[]) {
		super(`Login required but credentials are missing: set ${variables.join(", ")}`)
	}
}

/** Entra or the UC dialog showed an error after a submit. Thrown on the first banner so a typo can't lock the account; do not retry blindly. */
export class CredentialsRejectedError extends CookieApiError {
	override name = "CredentialsRejectedError"
	constructor(readonly where: "entra" | "uc", detail: string) {
		super(`${where === "entra" ? "Microsoft Entra" : "OpenScape UC"} rejected the credentials${detail ? `: ${detail}` : ""}`)
	}
}

/** The login did not finish, or the cookie never appeared, before the deadline. */
export class CookieTimeoutError extends CookieApiError {
	override name = "CookieTimeoutError"
	constructor(message: string, readonly url: string) {
		super(`${message} (last URL: ${url})`)
	}
}
