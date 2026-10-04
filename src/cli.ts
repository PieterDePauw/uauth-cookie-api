#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { CookieApiError, CredentialsRejectedError, MissingCredentialsError } from "./errors.js"
import { formatCookie, getOtrsCookie, getUcCookie } from "./get-cookie.js"
import { startCookieServer, type ServiceName } from "./server.js"

export { formatCookie }

const USAGE = `Usage: uauth-cookie <otrs|uc> [--format value|header|json] [--url URL] [--profile DIR] [--headful]
       uauth-cookie serve [--service otrs|uc]... [--host HOST] [--port PORT] [--interval SECONDS] [--profile DIR] [--headful]

otrs, uc: prints the OTRSAgentInterface (otrs) or OpenScapeUC (uc) cookie on stdout.
serve:    keeps the sessions alive and serves them on http://HOST:PORT/otrs and /uc (default 127.0.0.1:8787, every 120 s).
          Requires "Authorization: Bearer $COOKIE_SERVER_TOKEN" when that variable is set.
Credentials come from ENTRA_USERNAME, ENTRA_PASSWORD, ENTRA_TOTP_SECRET and, for uc, UC_USERNAME, UC_PASSWORD.

Exit codes: 0 ok, 1 other error, 2 missing credentials, 3 credentials rejected, 4 cookie not obtained.`

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
		options: {
			format: { type: "string", default: "value" },
			url: { type: "string" },
			profile: { type: "string" },
			headful: { type: "boolean", default: false },
			service: { type: "string", multiple: true },
			host: { type: "string" },
			port: { type: "string" },
			interval: { type: "string" },
			help: { type: "boolean", short: "h", default: false },
		},
	})
	const service = positionals[0]
	if (service === "serve" && !values.help && positionals.length === 1) return serve(values)
	if (values.help || (service !== "otrs" && service !== "uc") || positionals.length > 1) {
		;(values.help ? console.log : console.error)(USAGE)
		return values.help ? 0 : 1
	}
	const options = { url: values.url, profileDir: values.profile, headless: !values.headful }
	const cookie = service === "otrs" ? await getOtrsCookie(options) : await getUcCookie(options)
	console.log(formatCookie(cookie, values.format))
	return 0
}

type ServeFlags = { service?: string[] | undefined; host?: string | undefined; port?: string | undefined; interval?: string | undefined; profile?: string | undefined; headful: boolean }

/** Run the cookie server until SIGINT/SIGTERM. Progress goes to stderr. */
async function serve(flags: ServeFlags): Promise<number> {
	const services = flags.service ?? ["otrs", "uc"]
	const unknown = services.filter((name) => name !== "otrs" && name !== "uc")
	if (unknown.length > 0) {
		console.error(`Unknown --service ${unknown.join(", ")} (otrs or uc)\n\n${USAGE}`)
		return 1
	}
	const server = await startCookieServer({
		services: services as ServiceName[],
		host: flags.host,
		port: flags.port === undefined ? undefined : Number(flags.port),
		keepAliveMs: flags.interval === undefined ? undefined : Number(flags.interval) * 1000,
		profileDir: flags.profile,
		headless: !flags.headful,
		log: (line) => console.error(`${new Date().toISOString()} ${line}`),
	})
	await new Promise<void>((resolve) => {
		process.once("SIGINT", resolve)
		process.once("SIGTERM", resolve)
	})
	console.error("shutting down")
	await server.close()
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
