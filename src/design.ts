/**
 * design-stage content heuristics:
 * an existing design-spec.md only counts as complete when it carries real
 * design prose, not a copied section skeleton or placeholder shell.
 *
 * @module @ai4rpg/dsh-tavern-stages/design
 */

/** Placeholder tokens the design-guide template and draft specs leave behind. */
const PLACEHOLDER = /(\.\.\.|…|\[项目名\]|待补充|待填写|TBD|TODO)/gi

/**
 * Whether a design-spec.md has substantive content: at least
 * {@link MIN_PROSE_CHARS} characters outside headings, fences, and
 * placeholder tokens. Rejects empty files, heading-only skeletons, and
 * template copies whose every line is a label with nothing after it.
 */
export function isDesignSpecSubstantial(text: string, minProseChars = 80): boolean {
  let prose = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('```')) continue
    prose += line.replace(PLACEHOLDER, '').trim().length
  }
  return prose >= minProseChars
}
