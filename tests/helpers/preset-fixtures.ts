/**
 * Declarative fixture presets for the subagent tests.
 *
 * dsh 0.2.0 replaced directory-discovered presets with declared ones: a preset
 * is an `@deepseek-ai/dsh-agent-preset` row whose `plugins` list IS the
 * composition, and `@deepseek-ai/dsh-agent-preset-registry` is the roster
 * service. The compositions that used to live in per-preset
 * `agent.cordis.yml` files under `tests/fixtures/presets` are declared inline
 * here.
 *
 * `anchored` mimics ONLY the anchored-standard *persona condition* the
 * inheritance tests need: a `complete: true` section with the minimal persona
 * text, so a child that joins it with `request.persona = undefined` inherits
 * that section through the `composeFrom` scope chain. It deliberately omits
 * tool-catalog filters and runtime-context gates — those do not affect persona
 * inheritance, which is what these tests assert.
 *
 * `instructions` is the same preset plus the real `dsh-agent-instructions`
 * row, so a child can resolve workspace instruction files.
 *
 * @module tests/helpers/preset-fixtures
 */

import type { Context } from '@deepseek-ai/cordis'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'

/** The minimal persona text the `complete: true` fixture section carries. */
export const ANCHORED_PERSONA = 'You are a helpful software engineer assistant.'

/** The `dsh-persona` row both fixtures mount first.
 *
 * `prefix` is the current key (dsh 0.1.5 renamed `text` → `prefix`); a row left
 * on `text` fails the whole preset mount. */
const personaRow = {
  name: '@deepseek-ai/dsh-persona',
  config: { prefix: ANCHORED_PERSONA, complete: true, includeRuntimeContext: false },
}

/** Mount the preset roster with `defaultId` as its default preset. */
export async function mountPresetRoster(ctx: Context, defaultId: string): Promise<void> {
  await ctx.plugin(AgentPresetRegistry, { default: defaultId })
}

/** Declare the minimal `complete: true` persona preset (id `anchored`). */
export async function declareAnchoredPreset(ctx: Context): Promise<void> {
  await ctx.plugin(AgentPreset, { id: 'anchored', plugins: [personaRow] })
}

/** Declare the `anchored` composition plus the real agent-instructions row (id `instructions`). */
export async function declareInstructionsPreset(ctx: Context): Promise<void> {
  await ctx.plugin(AgentPreset, {
    id: 'instructions',
    plugins: [
      personaRow,
      { name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    ],
  })
}
