/**
 * CORS origin allow-listing for the publisher backend. Pure + side-effect-free so
 * it is unit-testable (the server module itself starts Bun.serve on import).
 *
 * Patterns: exact origins (`https://hourglass.box`), `*` (any), or a
 * subdomain wildcard (`https://*.hourglass.box`) which matches every PR
 * preview subdomain but not the apex. The default accepts the apex, all preview
 * subdomains, and local dev — so preview deployments work without per-PR config.
 */

const DEFAULT_PATTERNS =
  'https://hourglass.box,https://*.hourglass.box,http://localhost:5173'

export function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? DEFAULT_PATTERNS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function isOriginAllowed(origin: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*') return true
    if (pattern.includes('://*.')) {
      const [scheme, host] = pattern.split('://*.')
      const suffix = `.${host}`
      return (
        origin.startsWith(`${scheme}://`) &&
        origin.endsWith(suffix) &&
        origin.length > scheme.length + 3 + suffix.length
      )
    }
    return origin === pattern
  })
}
