#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { CookieApiError, CredentialsRejectedError, MissingCredentialsError } from "./errors.js"
import { getOtrsCookie, getUcCookie, type SessionCookie } from "./get-cookie.js"

const USAGE = `Usage: uauth-cookie [otrs|uc] [--format value|header|json] [--url URL] [--profile DIR] [--headful]

Prints the OTRSAgentInterface (otrs) or OpenScapeUC (uc) cookie on stdout (format defaults to value).
Without a service it prints both, otrs first (format defaults to header; json gives { otrs, uc }; --url needs a service).
Credentials come from ENTRA_USERNAME, ENTRA_PASSWORD, ENTRA_TOTP_SECRET and, for uc, UC_USERNAME, UC_PASSWORD.

Exit codes: 0 ok, 1 other error, 2 missing credentials, 3 credentials rejected, 4 cookie not obtained.`

/** Render the cookie for stdout. */
export function formatCookie(cookie: SessionCookie, format: string): string {
	if (format === "value") return cookie.value
	if (format === "header") return cookie.header
	if (format === "json") return JSON.stringify(cookie, null, 2)
	throw new TypeError(`Unknown --format "${format}" (value, header or json)`)
}

/** Map an error to the documented exit code. */
export function getExitCode(error: unknown): number {
	if (error instanceof MissingCredentialsError) return 2
	if (error instanceof CredentialsRejectedError) return 3
	if (error instanceof CookieApiError) return 4
	return 1
}

export async function main(argv: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { format: { type: "string" }, url: { type: "string" }, profile: { type: "string" }, headful: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
	})
	const service = positionals[0]
	if (values.help || (service !== undefined && service !== "otrs" && service !== "uc") || positionals.length > 1 || (service === undefined && values.url !== undefined)) {
		;(values.help ? console.log : console.error)(USAGE)
		return values.help ? 0 : 1
	}
	const options = { url: values.url, profileDir: values.profile, headless: !values.headful }
	if (service !== undefined) {
		const cookie = service === "otrs" ? await getOtrsCookie(options) : await getUcCookie(options)
		console.log(formatCookie(cookie, values.format ?? "value"))
		return 0
	}
	// Both, one after the other: they share the browser profile, so the Entra sign-in from otrs carries over to uc.
	const cookies = { otrs: await getOtrsCookie(options), uc: await getUcCookie(options) }
	const format = values.format ?? "header"
	console.log(format === "json" ? JSON.stringify(cookies, null, 2) : Object.values(cookies).map((cookie) => formatCookie(cookie, format)).join("\n"))
	return 0
}

// Run only as the entry point (also through the node_modules/.bin symlink), not when imported by tests.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => (process.exitCode = code),
		(error: unknown) => {
			console.error(error instanceof Error ? `${error.name}: ${error.message}` : error)
			process.exitCode = getExitCode(error)
		}
	)
}
