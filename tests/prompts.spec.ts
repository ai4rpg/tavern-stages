import { describe, expect, it } from 'vitest'
import { tavernPrompts } from '../src/prompts.ts'
import { DEFAULT_TAVERN_PROMPTS } from '../src/prompts.defaults.ts'

/**
 * Guards for the prompt single source: `src/prompts.json` is the one editable
 * copy of every model-facing string this plugin owns, and
 * `src/prompts.defaults.ts` is its generated embedded fallback.
 */
describe('prompt single source', () => {
  it('pins the loaded src/prompts.json overlay to the embedded defaults', () => {
    // scripts/prompts.mjs sync regenerates src/prompts.defaults.ts from
    // src/prompts.json. A hand edit to either without re-syncing must fail
    // here: the JSON is the single editable source, and the embedded copy is
    // what a stale install (no JSON yet) falls back to.
    expect(tavernPrompts).toEqual(DEFAULT_TAVERN_PROMPTS)
  })

  it('carries the stage-policy prefix like the sibling policy sections', () => {
    // sandbox:policy reads "Current DSH file policy: …", approval:policy
    // "Approval policy: …"; stage:policy follows the same shape so the model
    // reads it as one more current-state policy in the runtime snapshot.
    expect(tavernPrompts.section).toMatch(/^Current stage policy:/)
  })

  it('carries no subagent skill-directory block', () => {
    // The block fed the body-prepending provider, which dsh 0.2.1 removed:
    // children are preset compositions now and read their docs through the
    // `skill` tool. Keep the key from creeping back as dead copy.
    expect('subagentSkillDirs' in tavernPrompts).toBe(false)
  })

  it('tells the model that delegation results arrive asynchronously', () => {
    // dsh 0.2.1 delegation returns an activation id and delivers the answer
    // through the parent's completion notification. The skills carry the same
    // rule; this stage:policy sentence is the fallback for a session that
    // never reads them.
    expect(tavernPrompts.section).toContain('completion notification')
  })
})
