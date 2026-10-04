export { getCookie, getOtrsCookie, getUcCookie, type CookieOptions, type OtrsCookieOptions, type PartialEntraCredentials, type SessionCookie, type UcCookieOptions } from "./get-cookie.js"
export { otrsTarget, ucTarget, DEFAULT_OTRS_URL, DEFAULT_UC_URL, type PartialUcCredentials, type Target, type UcCredentials } from "./targets.js"
export type { EntraCredentials } from "./entra.js"
export { CookieApiError, CookieTimeoutError, CredentialsRejectedError, MissingCredentialsError } from "./errors.js"
