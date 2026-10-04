import { createHash, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { CookieApiError, CookieTimeoutError, CredentialsRejectedError, MissingCredentialsError } from "./errors.js"
import { formatCookie, getSession, resolveUcCredentials, withOtrsHeaders, type BrowserSession, type CookieOptions, type SessionCookie } from "./get-cookie.js"
import { applySetCookies, cookieHeaderFor } from "./jar.js"
import { DEFAULT_OTRS_URL, DEFAULT_UC_URL, otrsTarget, ucTarget, type PartialUcCredentials, type Target } from "./targets.js"

export type ServiceName = "otrs" | "uc"

export type CookieServerOptions = CookieOptions & {
	/** Which sessions to keep. Default both. */
	services?: ServiceName[] | undefined
	/** Default OTRS_URL, then https://otrsdict.ugent.be/znuny/index.pl. */
	otrsUrl?: string | undefined
	/** Default UC_URL, then https://uc.ugent.be/. */
	ucUrl?: string | undefined
	/** UC account for OpenScape's own login dialog. Each missing field falls back to UC_USERNAME / UC_PASSWORD. */
	uc?: PartialUcCredentials | undefined
	/** Default COOKIE_SERVER_HOST, then 127.0.0.1. */
	host?: string | undefined
	/** Default COOKIE_SERVER_PORT, then 8787. 0 picks a free port. */
	port?: number | undefined
	/** When set (default COOKIE_SERVER_TOKEN), every request needs `Authorization: Bearer <token>`. */
	token?: string | undefined
	/** How often each session is touched over plain HTTP. Default COOKIE_KEEPALIVE_SECONDS, then 120 s (mod_auth_openidc drops a session after 300 s idle by default). */
	keepAliveMs?: number | undefined
	/** Progress lines (sign-ins, expiries, errors). Default: silent. */
	log?: ((line: string) => void) | undefined
}

/** Test seam: how a session is obtained with the browser, and how keep-alive requests go out. */
export type ServerDependencies = { login: (target: Target) => Promise<BrowserSession>; fetch: typeof fetch }

export type ServiceStatus = { ok: boolean; signedInAt: number | undefined; checkedAt: number | undefined; expires: number | undefined; error: string | undefined }

/** One kept session per service: touched over HTTP on a timer, re-created with the browser only when the service says it is gone. */
export type SessionKeeper = {
	/** The current session. `fresh` checks it with the service first (and signs in again if it is gone). */
	get: (name: ServiceName, options?: { fresh?: boolean }) => Promise<BrowserSession>
	/** Touch every session once; sign in again where one has expired. Never throws. */
	keepAlive: () => Promise<void>
	status: () => Record<string, ServiceStatus>
}

type ServiceState = { target: Target; session?: BrowserSession | undefined; signedInAt?: number; checkedAt?: number; error?: Error | undefined; signInFailedAt?: number | undefined }

const DEFAULT_PORT = 8787
const DEFAULT_KEEPALIVE_MS = 120_000
const KEEPALIVE_TIMEOUT_MS = 30_000
/** After a failed sign-in, requests get that error back for this long instead of each launching the browser again. */
const SIGN_IN_BACKOFF_MS = 30_000

/** The named cookie as it currently stands in the jar (the keep-alive may have replaced its value), or undefined once it is gone or expired. */
function currentCookie(session: BrowserSession, now: number): SessionCookie | undefined {
	const { cookie } = session
	const stored = session.jar.find((candidate) => candidate.name === cookie.name && candidate.path === cookie.path)
	if (stored === undefined || stored.value === "" || (stored.expires > 0 && stored.expires * 1000 <= now)) return undefined
	return { ...cookie, value: stored.value, expires: stored.expires > 0 ? stored.expires : undefined, header: `${cookie.name}=${stored.value}` }
}

export function createSessionKeeper(targets: Map<ServiceName, Target>, dependencies: ServerDependencies, log: (line: string) => void = () => {}): SessionKeeper {
	const states = new Map<ServiceName, ServiceState>([...targets].map(([name, target]) => [name, { target }]))
	const queues = new Map<ServiceName, Promise<unknown>>()
	// Entra said no: stop signing in until restart, so a bad password cannot be retried into a lockout.
	let rejected: CredentialsRejectedError | undefined

	function exclusive<T>(name: ServiceName, task: () => Promise<T>): Promise<T> {
		const result = (queues.get(name) ?? Promise.resolve()).catch(() => undefined).then(task)
		queues.set(name, result.catch(() => undefined))
		return result
	}

	function stateOf(name: ServiceName): ServiceState {
		const state = states.get(name)
		if (state === undefined) throw new CookieApiError(`Service "${name}" is not kept by this server`)
		return state
	}

	async function signIn(name: ServiceName, state: ServiceState): Promise<BrowserSession> {
		if (rejected) throw rejected
		if (state.error && state.signInFailedAt !== undefined && Date.now() - state.signInFailedAt < SIGN_IN_BACKOFF_MS) throw state.error
		log(`${name}: signing in with the browser`)
		try {
			const session = await dependencies.login(state.target)
			const now = Date.now()
			Object.assign(state, { session, signedInAt: now, checkedAt: now, error: undefined, signInFailedAt: undefined })
			log(`${name}: signed in${session.cookie.signedIn ? " (through Entra)" : ""}`)
			return session
		} catch (error) {
			state.error = error instanceof Error ? error : new Error(String(error))
			state.signInFailedAt = Date.now()
			if (error instanceof CredentialsRejectedError) rejected = error
			log(`${name}: sign-in failed: ${state.error.message}`)
			throw error
		}
	}

	/** One authenticated request to the keep-alive URL. True when the session is still alive; also takes any rotated cookies. */
	async function touch(state: ServiceState, session: BrowserSession): Promise<boolean> {
		const url = state.target.keepAliveUrl ?? state.target.url
		const response = await dependencies.fetch(url, {
			redirect: "manual",
			headers: { cookie: cookieHeaderFor(session.jar, url), "user-agent": session.userAgent, accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
			signal: AbortSignal.timeout(KEEPALIVE_TIMEOUT_MS),
		})
		session.jar = applySetCookies(session.jar, url, response.headers.getSetCookie())
		const { status } = response
		// A redirect means the reverse proxy sends us to Microsoft; 401/403 means the service itself no longer knows the session.
		if ((status >= 300 && status < 400) || status === 401 || status === 403) {
			await response.body?.cancel()
			return false
		}
		if (status < 200 || status >= 300) {
			await response.body?.cancel()
			throw new CookieApiError(`Keep-alive GET ${url} answered ${status}`)
		}
		const body = await response.text()
		return !(state.target.isLoginPage?.(body) ?? false) && currentCookie(session, Date.now()) !== undefined
	}

	/** Make sure `name` has a live session: touch it, and sign in again if it is gone. */
	async function check(name: ServiceName, state: ServiceState): Promise<BrowserSession> {
		const { session } = state
		if (session === undefined) return signIn(name, state)
		let alive: boolean
		try {
			alive = await touch(state, session)
		} catch (error) {
			// The service or the network hiccuped; keep the session and try again next round.
			state.error = error instanceof Error ? error : new Error(String(error))
			log(`${name}: keep-alive failed: ${state.error.message}`)
			throw error
		}
		if (alive) {
			Object.assign(state, { checkedAt: Date.now(), error: undefined })
			return session
		}
		log(`${name}: session expired`)
		state.session = undefined
		return signIn(name, state)
	}

	return {
		get: (name, { fresh = false } = {}) => {
			const state = stateOf(name)
			return exclusive(name, async () => {
				if (rejected) throw rejected
				if (!fresh && state.session && state.error === undefined && currentCookie(state.session, Date.now())) return state.session
				return check(name, state)
			})
		},
		keepAlive: async () => {
			await Promise.all([...states].map(([name, state]) => exclusive(name, () => check(name, state)).catch(() => undefined)))
		},
		status: () =>
			Object.fromEntries(
				[...states].map(([name, state]) => {
					const cookie = state.session && currentCookie(state.session, Date.now())
					const error = rejected ?? state.error
					return [name, { ok: cookie !== undefined && error === undefined, signedInAt: state.signedInAt, checkedAt: state.checkedAt, expires: cookie?.expires, error: error && `${error.name}: ${error.message}` }]
				})
			),
	}
}

export type CookieServer = {
	/** Base URL, e.g. http://127.0.0.1:8787. */
	url: string
	keeper: SessionKeeper
	/** Stop the keep-alive and the HTTP server. Waits for a sign-in in progress. */
	close: () => Promise<void>
}

/**
 * Serve kept sessions on a local HTTP port. Each service is signed in to once with the browser; afterwards a plain HTTP request every `keepAliveMs` keeps the
 * session alive, and the browser only starts again when the service reports the session gone (proxy idle or max age, OTRS logout, ...).
 *
 * `GET /otrs`, `GET /uc`: the session as JSON (`?format=value|header|cookie` for plain text, `?fresh=1` to check it first). `GET /health`: per-service status.
 */
export async function startCookieServer(options: CookieServerOptions = {}, dependencies?: Partial<ServerDependencies>): Promise<CookieServer> {
	const env = options.env ?? process.env
	const log = options.log ?? (() => {})
	const targets = new Map<ServiceName, Target>()
	for (const name of options.services ?? ["otrs", "uc"]) {
		if (name === "otrs") targets.set(name, otrsTarget(options.otrsUrl ?? env.OTRS_URL ?? DEFAULT_OTRS_URL))
		else if (name === "uc") targets.set(name, ucTarget(resolveUcCredentials(options.uc, env), options.ucUrl ?? env.UC_URL ?? DEFAULT_UC_URL))
		else throw new TypeError(`Unknown service "${String(name)}" (otrs or uc)`)
	}
	const keeper = createSessionKeeper(targets, { login: dependencies?.login ?? ((target) => getSession(target, options)), fetch: dependencies?.fetch ?? fetch }, log)
	const host = options.host ?? env.COOKIE_SERVER_HOST ?? "127.0.0.1"
	const port = options.port ?? Number(env.COOKIE_SERVER_PORT ?? DEFAULT_PORT)
	const keepAliveMs = options.keepAliveMs ?? (env.COOKIE_KEEPALIVE_SECONDS ? Number(env.COOKIE_KEEPALIVE_SECONDS) * 1000 : DEFAULT_KEEPALIVE_MS)
	if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError(`Invalid port: ${port}`)
	if (!(keepAliveMs > 0)) throw new TypeError(`Invalid keep-alive interval: ${keepAliveMs} ms`)
	const token = options.token ?? env.COOKIE_SERVER_TOKEN

	const server = createServer((request, response) => {
		handle(request, response, { keeper, token, host }).catch((error: unknown) => sendError(response, error))
	})
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, host, () => {
			server.off("error", reject)
			resolve()
		})
	})
	const address = server.address() as AddressInfo
	const url = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`
	log(`listening on ${url}, keeping ${[...targets.keys()].join(", ")} alive every ${Math.round(keepAliveMs / 1000)} s`)

	// Sign in right away, then keep alive on a timer that never overlaps itself.
	let timer: NodeJS.Timeout | undefined
	let closed = false
	let round = keeper.keepAlive()
	const schedule = () => {
		if (!closed) timer = setTimeout(() => void (round = keeper.keepAlive().finally(schedule)), keepAliveMs)
	}
	void round.finally(schedule)

	return {
		url,
		keeper,
		close: async () => {
			closed = true
			clearTimeout(timer)
			await new Promise<void>((resolve) => {
				server.close(() => resolve())
				server.closeAllConnections()
			})
			await round
		},
	}
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

function sameSecret(given: string, expected: string): boolean {
	const digest = (value: string) => createHash("sha256").update(value).digest()
	return timingSafeEqual(digest(given), digest(expected))
}

async function handle(request: IncomingMessage, response: ServerResponse, { keeper, token, host }: { keeper: SessionKeeper; token: string | undefined; host: string }): Promise<void> {
	// Refuse other Host names: a web page that DNS-rebinds its own name to 127.0.0.1 could otherwise read the cookies.
	const requestHost = (request.headers.host ?? "").replace(/:\d+$/, "").toLowerCase()
	if (!LOCAL_HOSTS.has(requestHost) && requestHost !== host.toLowerCase()) return send(response, 403, { error: "ForbiddenHost", message: `Host "${requestHost}" not allowed` })
	if (token !== undefined && !sameSecret(request.headers.authorization ?? "", `Bearer ${token}`)) return send(response, 401, { error: "Unauthorized", message: "Missing or wrong bearer token" })
	if (request.method !== "GET") return send(response, 405, { error: "MethodNotAllowed", message: "Only GET" })
	const url = new URL(request.url ?? "/", "http://localhost")
	const name = url.pathname.replace(/^\/|\/$/g, "")
	if (name === "health") {
		const services = keeper.status()
		return send(response, Object.values(services).every((service) => service.ok) ? 200 : 503, { services })
	}
	if ((name !== "otrs" && name !== "uc") || !(name in keeper.status())) return send(response, 404, { error: "NotFound", message: `No service at /${name}` })
	const format = url.searchParams.get("format") ?? "json"
	if (!["json", "value", "header", "cookie"].includes(format)) return send(response, 400, { error: "BadRequest", message: `Unknown format "${format}" (json, value, header or cookie)` })
	const fresh = ["1", "true"].includes(url.searchParams.get("fresh") ?? "")
	const session = await keeper.get(name, { fresh })
	const body = describeSession(name, session)
	if (format === "json") return send(response, 200, body)
	if (format === "cookie") return send(response, 200, body.headers.cookie)
	return send(response, 200, formatCookie(body, format))
}

/** The session as served: the named cookie, plus request headers that reproduce the browser (every cookie, its User-Agent, OTRS's session header). */
export function describeSession(name: ServiceName, session: BrowserSession, now = Date.now()) {
	const cookie = currentCookie(session, now) ?? session.cookie
	const headers: Record<string, string> = { cookie: cookieHeaderFor(session.jar, session.url, now), "user-agent": session.userAgent }
	if (name === "otrs") Object.assign(headers, withOtrsHeaders(cookie).headers)
	return { ...cookie, headers }
}

function statusFor(error: unknown): number {
	if (error instanceof CookieTimeoutError) return 504
	if (error instanceof MissingCredentialsError || error instanceof CredentialsRejectedError) return 503
	if (error instanceof CookieApiError) return 502
	return 500
}

function sendError(response: ServerResponse, error: unknown): void {
	const { name, message } = error instanceof Error ? error : { name: "Error", message: String(error) }
	if (!response.headersSent) send(response, statusFor(error), { error: name, message })
	else response.destroy()
}

function send(response: ServerResponse, status: number, body: unknown): void {
	const text = typeof body === "string" ? `${body}\n` : `${JSON.stringify(body, null, 2)}\n`
	response.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store" })
	response.end(text)
}

