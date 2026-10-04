# uauth-cookie-api

Get two session cookies from UGent services behind Microsoft Entra ID:

| Service           | Function        | Cookie               | Default URL                                 |
| ----------------- | --------------- | -------------------- | ------------------------------------------- |
| OTRS (Znuny)      | `getOtrsCookie` | `OTRSAgentInterface` | `https://otrsdict.ugent.be/znuny/index.pl`  |
| OpenScape UC      | `getUcCookie`   | `OpenScapeUC`        | `https://uc.ugent.be/`                      |

Each call opens a headless Chromium ([patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)) on a persistent profile, goes to the service, signs in to Entra (username, password, TOTP) only if the service bounces there, finishes any service-specific step, reads the cookie and closes the browser. The profile keeps the Entra "stay signed in" cookie, so most runs skip the MFA prompt entirely.

This package is standalone: it does not depend on or share code with `uauth`.

## Install

Node 22.18+ and pnpm.

```bash
pnpm install
pnpm browsers          # downloads patchright's Chromium, once per machine
cp .env.example .env   # fill in the credentials
```

As a dependency: `"uauth-cookie-api": "github:PieterDePauw/uauth-cookie-api"` (plus `onlyBuiltDependencies: ["uauth-cookie-api"]` for pnpm 10, so `prepack` can build `dist/`).

## Library

```ts
import { getOtrsCookie, getUcCookie } from "uauth-cookie-api"

const otrs = await getOtrsCookie()
console.log(otrs.value) // the OTRSAgentInterface value

const uc = await getUcCookie()
await fetch("https://uc.ugent.be/owc-servlets/rules", { headers: { cookie: uc.header } })
```

Both return a `SessionCookie`:

| Field                      | Meaning                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `name`, `value`            | The cookie.                                                           |
| `domain`, `path`           | Its scope.                                                            |
| `expires`                  | Unix seconds, or `undefined` for a session cookie.                    |
| `httpOnly`, `secure`       | Its flags.                                                            |
| `header`                   | `name=value`, ready for a `Cookie:` header.                           |
| `signedIn`                 | `true` if this call had to sign in to Entra.                          |

Options (all optional):

| Option        | Default                                         | Notes                                                                                   |
| ------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `entra`       | `ENTRA_USERNAME`, `ENTRA_PASSWORD`, `ENTRA_TOTP_SECRET` | Per field. Only needed when the profile's Entra session has expired.             |
| `uc`          | `UC_USERNAME`, `UC_PASSWORD`                    | `getUcCookie` only: the UC account for OpenScape's own login dialog.                    |
| `url`         | `OTRS_URL` / `UC_URL`, then the table above     |                                                                                         |
| `profileDir`  | `COOKIE_PROFILE_DIR`, then `.cookie-profile`    | Chromium profile. Protect it like a browser profile.                                    |
| `headless`    | `true`                                          |                                                                                         |
| `timeoutMs`   | `120000`                                        | Whole call.                                                                             |
| `env`         | `process.env`                                   | Where the fallbacks are read from.                                                      |

Calls on the same `profileDir` run one after the other within a process (Chromium locks the profile). Other services can be added with `getCookie(target, options)` and a `Target` (`{ name, url, cookieName, afterSso? }`).

## CLI

```bash
pnpm build
node --env-file=.env dist/cli.js otrs                  # prints the OTRSAgentInterface value
node --env-file=.env dist/cli.js uc --format header    # prints OpenScapeUC=…
node --env-file=.env dist/cli.js uc --format json --headful
```

```
uauth-cookie <otrs|uc> [--format value|header|json] [--url URL] [--profile DIR] [--headful]
```

Only the cookie goes to stdout. Exit codes: `0` ok, `1` other error, `2` missing credentials, `3` credentials rejected, `4` cookie not obtained.

## How it works

1. **Browser.** patchright Chromium, persistent profile, `en-US`, host timezone (so the TOTP and browser clocks agree), and an init script that tells Entra there is no passkey authenticator, so it offers password + code instead of a WebAuthn prompt nothing can answer headless.
2. **Bounce detection.** After loading the service the URL is watched for up to 3 s, because services often render their own page first and then redirect to Microsoft.
3. **Entra.** A loop that looks at what Entra shows and acts on it: username, password, verification code (waits for a fresh 30 s window when the current one is about to run out), account picker, method pickers (always the code, never the Authenticator push), "Stay signed in?" → Yes. Entra's full-page passkey bridge is declined by redirecting it to its own `cancelUrl`.
4. **Service step.** OTRS needs none. For UC, the web client's `.loginDialog` is filled with the UC account if it appears, then the page calls `/owc-servlets/rules`, which mints `OpenScapeUC` and proves the session works.
5. **Cookie.** The browser's cookies for the service URL are polled until the named one appears.

**Lockout safety.** The first error banner Entra shows (wrong username, password or code) aborts with `CredentialsRejectedError`, and the same screen is never submitted more than three times in a row, so a typo in `.env` cannot trip the tenant's smart lockout. Do not retry `CredentialsRejectedError` automatically.

## Errors

All extend `CookieApiError`.

| Error                      | When                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| `MissingCredentialsError`  | A login is needed and a variable is missing (`variables` lists them).           |
| `CredentialsRejectedError` | Entra or the UC dialog rejected the credentials (`where`: `"entra"` / `"uc"`).  |
| `CookieTimeoutError`       | The login or the cookie did not complete before `timeoutMs`.                    |
| `CookieApiError`           | The UC session check (`/owc-servlets/rules`) did not answer 2xx.                |

## Development

```bash
pnpm typecheck
pnpm test        # vitest; no browser needed
pnpm build
```
