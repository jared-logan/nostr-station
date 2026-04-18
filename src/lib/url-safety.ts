/**
 * URL sanitization for dashboard-bound payloads.
 *
 * Relay events carry attacker-controlled strings (kind-30617 `web` tag,
 * kind-0 `picture` field, …) that eventually land inside `<a href>` or
 * `<img src>` attributes in the dashboard. HTML-escape alone is not
 * enough — it makes `javascript:alert(1)` safe as text content, but the
 * string is still a runnable script when the browser treats it as a URL.
 *
 * Defense posture: server-side allowlist before the payload crosses into
 * the JSON response. Clients keep their usual escapeHtml pass for
 * attribute context; this helper is the complementary scheme gate.
 */

/**
 * Returns `input` unchanged if it parses as a URL with an http(s) scheme,
 * otherwise `null`. `null` is the contract — callers render it as an
 * absent field rather than a dead link, and the client UI already
 * handles that (e.g. `r.web ? <a href>… : ''`).
 *
 * Rejected shapes include `javascript:`, `data:`, `vbscript:`, `file:`,
 * `ftp:`, protocol-relative `//host`, bare paths, and anything with
 * leading whitespace (a classic scheme-poisoning trick — some renderers
 * strip the whitespace before following the link).
 */
export function safeHttpUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}
