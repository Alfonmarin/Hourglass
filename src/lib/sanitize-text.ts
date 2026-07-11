/**
 * Neutralize free-form text that originates outside our trust boundary (an
 * ERC-20's `symbol`/`name`, a user-typed organization label) before it is put
 * into a pinned document or an Intuition atom label. Two hazards: injection
 * (markup rendered by any UI that displays the graph) and unbounded length
 * (a document that overflows IPFS's single-block boundary breaks a precomputed
 * CID). The function is pure and deterministic — the same input always yields
 * the same output, so it is safe to apply on both sides of a salt computation.
 */

/**
 * Strip control characters (C0/C1) and the HTML-significant characters
 * `< > & " '`, then cap to `maxChars` code points. Iterating by code point
 * avoids splitting surrogate pairs, so the result is always valid UTF-8 and
 * deterministic.
 */
export function cleanDisplayText(value: string, maxChars: number): string {
  const kept: string[] = []
  for (const ch of value) {
    if (kept.length >= maxChars) break
    const code = ch.codePointAt(0) ?? 0
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f)
    const isHtmlSignificant = ch === '<' || ch === '>' || ch === '&' || ch === '"' || ch === "'"
    if (isControl || isHtmlSignificant) continue
    kept.push(ch)
  }
  return kept.join('').trim()
}
