# Security headers — single host-agnostic source

Spec §5, rule 2 and spec §7. **This file is the only place the header set is authored.**
The deploy task projects it into whatever the chosen host actually supports:

| Host                       | Projection                                                              |
| -------------------------- | ----------------------------------------------------------------------- |
| Cloudflare Pages / Netlify | a `_headers` file — real response headers, the full set below           |
| GitHub Pages               | a `<meta http-equiv>` CSP subset **plus the documented gap list** below |

Do not scatter header strings into host config files, and do not add a CSP `<meta>` tag
to `index.html` without changing this file first. Keeping one source is what makes the
user's "decide the host at deploy time" deferral free (spec §5).

## The header set

```http
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Applies to every path. `dist/**` is static; there is no server, no cookie and no API.

## Why each one

- **CSP** — the game has zero runtime dependencies, no backend and no network calls, so
  the policy can be maximally tight rather than aspirational. `connect-src 'none'` is a
  strong, externally verifiable statement that the page cannot phone home;
  `script-src 'self'` holds because there is no inline JS anywhere; `img-src 'self' data:`
  holds because all art is flat geometry drawn in code (spec §8, decision 2).
  Adding any CDN script, font, analytics tag or image file breaks this and is a spec revision.
- **`frame-ancestors 'none'`** — nothing here should ever be framed. Preferred over the
  legacy `X-Frame-Options`, which is why a real response header matters.
- **HSTS** — set at the apex by the host; harmless and correct for a static HTTPS site.

## What GitHub Pages cannot deliver (spec §5)

GitHub Pages serves static files with no response-header control at all. Choosing it means
accepting, in writing:

- `frame-ancestors` — **unavailable** (ignored in a `<meta>` CSP). The site can be framed.
- `Permissions-Policy` — **unavailable**.
- `Strict-Transport-Security` — **unavailable** (GitHub sets its own on `github.io`).
- `X-Content-Type-Options`, `Referrer-Policy`, COOP/CORP — **unavailable**; `Referrer-Policy`
  has a `<meta name="referrer">` equivalent, the others do not.
- The CSP degrades to the `<meta http-equiv>` subset of the directives above.

That is a documented, accepted weakening, not a build change. Security Engineer should sign
off on this header set **conditionally for all three hosts** so the choice at deploy time
does not reopen the security review.

## Verification

Spec §6, item 6: `curl -sI <url>` output showing these headers actually arriving is part of
"deployed and verified". A header that is authored here but absent from that output is a
deploy bug, not a documentation nit.
