/**
 * Prompt loader: reads `src/prompts.json` (the single editable source for all
 * tavern-stages model-facing copy) and overlays it on the embedded defaults.
 *
 * The JSON is resolved relative to the module so both the source tree
 * (`src/prompts.ts` → sibling `prompts.json`) and the built package
 * (`lib/prompts.js` → `../src/prompts.json`, `src` ships in `files`) find it.
 * When no JSON is present — a stale installed copy before reinstall — the
 * embedded {@link DEFAULT_TAVERN_PROMPTS} keep the plugin fully functional;
 * `tests/prompts.spec.ts` pins the overlay to the embedded copy so the two
 * cannot drift silently.
 *
 * @module @ai4rpg/dsh-tavern-stages/prompts
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_TAVERN_PROMPTS, type TavernPrompts } from './prompts.defaults.ts'

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return overlay
  if (typeof overlay !== 'object' || overlay === null || Array.isArray(overlay)) return overlay
  const out: Record<string, unknown> = { ...base as Record<string, unknown> }
  for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
    out[key] = deepMerge(out[key], value)
  }
  return out
}

/** Candidate JSON paths, in preference order (source tree first). */
function promptJsonCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    join(here, 'prompts.json'),
    join(here, '..', 'src', 'prompts.json'),
  ]
}

/**
 * Read the effective prompts: the embedded defaults overlaid with
 * `src/prompts.json` when it is readable. The JSON wins on every key it
 * carries, so a complete JSON fully replaces the defaults.
 */
export function readTavernPrompts(): TavernPrompts {
  for (const candidate of promptJsonCandidates()) {
    try {
      const overlay = JSON.parse(readFileSync(candidate, 'utf8')) as unknown
      return deepMerge(DEFAULT_TAVERN_PROMPTS, overlay) as TavernPrompts
    } catch {
      // Try the next candidate; with none readable the defaults stand.
    }
  }
  return DEFAULT_TAVERN_PROMPTS
}

/** The effective prompts for this process, read once at module load. */
export const tavernPrompts: TavernPrompts = readTavernPrompts()

export type { TavernPrompts } from './prompts.defaults.ts'
