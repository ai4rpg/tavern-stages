/**
 * ui-stage content heuristics: a
 * `正则/` replacement file counts as deployed only when it no longer references
 * the local preview server and carries a real payload (CDN/self-host loader or
 * self-contained HTML).
 *
 * @module @ai4rpg/dsh-tavern-stages/ui
 */

/**
 * Strip the pure code-fence marker lines the skill keeps at the top and bottom
 * of `正则/*.html` files; the payload between them is what gets injected.
 */
export function stripCodeFences(text: string): string {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[0].trim() === '```') lines.shift()
  if (lines.length > 0 && lines[lines.length - 1].trim() === '```') lines.pop()
  return lines.join('\n')
}

/**
 * Whether a `正则/` replacement file's content reads as deployed:
 * - empty / placeholder shell → false
 * - local preview loader (localhost / 127.0.0.1, Live Server ports) → false
 * - CDN / self-host loader (https) → true
 * - self-contained HTML payload (text status bar, inline compiled product) → true
 */
export function isDeployedRegexFile(text: string): boolean {
  const body = stripCodeFences(text).trim()
  if (body.length < 40) return false
  if (/localhost|127\.0\.0\.1/i.test(body)) return false
  if (/https:\/\//i.test(body)) return true
  return /<[a-z!][^>]*>/i.test(body)
}

/**
 * Whether a `正则/` entry name looks like a UI replacement file. The set stays
 * open (standard-flow names plus anything html/txt) because projects may have
 * off-standard frontend needs.
 */
export function isUiRegexFileName(name: string): boolean {
  return name.includes('界面') || /\.html?$/i.test(name) || /\.txt$/i.test(name)
}
