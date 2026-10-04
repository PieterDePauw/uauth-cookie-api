/** A cookie as the browser stores it (the shape of patchright's `context.cookies()`). `expires` is Unix seconds, or -1 for a session cookie. */
export type JarCookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean }

function isExpired(cookie: JarCookie, now: number): boolean {
	return cookie.expires > 0 && cookie.expires * 1000 <= now
}

function domainMatches(cookieDomain: string, host: string): boolean {
	const domain = cookieDomain.replace(/^\./, "").toLowerCase()
	return host === domain || host.endsWith(`.${domain}`)
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
	if (requestPath === cookiePath) return true
	return requestPath.startsWith(cookiePath) && (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/")
}

/** The cookies a browser would send to `url`, ready for a `Cookie:` header. */
export function cookieHeaderFor(jar: JarCookie[], url: string, now = Date.now()): string {
	const { hostname, pathname, protocol } = new URL(url)
	return jar
		.filter((cookie) => !isExpired(cookie, now) && (!cookie.secure || protocol === "https:") && domainMatches(cookie.domain, hostname.toLowerCase()) && pathMatches(cookie.path, pathname))
		.map((cookie) => `${cookie.name}=${cookie.value}`)
		.join("; ")
}

/** RFC 6265 default-path: the request path up to (not including) its last `/`. */
function defaultPath(pathname: string): string {
	const end = pathname.lastIndexOf("/")
	return end <= 0 ? "/" : pathname.slice(0, end)
}

/** Apply a response's `Set-Cookie` lines to `jar` (new value, new expiry, or deletion), as the browser would. Returns a new jar. */
export function applySetCookies(jar: JarCookie[], url: string, setCookies: string[], now = Date.now()): JarCookie[] {
	const { hostname, pathname } = new URL(url)
	let next = [...jar]
	for (const line of setCookies) {
		const [pair = "", ...attributes] = line.split(";")
		const separator = pair.indexOf("=")
		if (separator <= 0) continue
		const cookie: JarCookie = { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim(), domain: hostname, path: defaultPath(pathname), expires: -1, httpOnly: false, secure: false }
		let maxAge: number | undefined
		for (const attribute of attributes) {
			const [rawKey = "", ...rest] = attribute.split("=")
			const key = rawKey.trim().toLowerCase()
			const value = rest.join("=").trim()
			if (key === "path" && value.startsWith("/")) cookie.path = value
			else if (key === "domain" && value) cookie.domain = `.${value.replace(/^\./, "")}`
			else if (key === "max-age" && /^-?\d+$/.test(value)) maxAge = Number(value)
			else if (key === "expires" && !Number.isNaN(Date.parse(value))) cookie.expires = Math.floor(Date.parse(value) / 1000)
			else if (key === "httponly") cookie.httpOnly = true
			else if (key === "secure") cookie.secure = true
		}
		if (maxAge !== undefined) cookie.expires = maxAge <= 0 ? 0 : Math.floor(now / 1000) + maxAge
		const sameDomain = (other: JarCookie) => other.domain.replace(/^\./, "") === cookie.domain.replace(/^\./, "")
		next = next.filter((other) => !(other.name === cookie.name && other.path === cookie.path && sameDomain(other)))
		if (cookie.expires !== 0 && !isExpired(cookie, now)) next.push(cookie)
	}
	return next
}
