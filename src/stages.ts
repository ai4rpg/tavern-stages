/**
 * Tavern-cards stage definitions and the ready-to-use stage-switch config
 * preset. Split out of `src/index.ts` so the project analyzer
 * (`src/status.ts`) can iterate the stage list without a circular import.
 *
 * @module @ai4rpg/dsh-tavern-stages/stages
 */

import type { StageConfig, StageDefinition } from '@ai4rpg/dsh-stage-switch'
import { tavernPrompts } from './prompts.ts'

/** The stage definitions used by the preset. The first stage is the initial
 * one (StageController defaults `initial` to `stages[0].name`).
 *
 * Declared as a literal-preservation tuple (`as const satisfies`) so the
 * `name` literals flow into {@link TavernCardsStageName}; eligibility and
 * builder defaults iterate {@link tavernCardsStages} rather than restating
 * the stage names. The instruction copy comes from {@link tavernPrompts}
 * (`src/prompts.json`, the single editable source — see `scripts/prompts.mjs`),
 * so editing stage wording never touches code. */
export const TAVERN_CARDS_STAGES = [
  {
    name: 'route' as const,
    instruction: tavernPrompts.stages.route,
  },
  {
    name: 'design' as const,
    instruction: tavernPrompts.stages.design,
  },
  {
    name: 'planning' as const,
    instruction: tavernPrompts.stages.planning,
  },
  {
    name: 'content' as const,
    instruction: tavernPrompts.stages.content,
  },
  {
    name: 'ui' as const,
    instruction: tavernPrompts.stages.ui,
  },
] as const satisfies readonly StageDefinition[]

/** Stage names used by the tavern workflow preset.

Derived from {@link TAVERN_CARDS_STAGES} above, so adding a stage there extends
the union without restating the names here. */
export type TavernCardsStageName = (typeof TAVERN_CARDS_STAGES)[number]['name']

/** Default `minHandoffTokens` for the preset.
 *
 * 10000 keeps session-start entry jumps (route → design/planning/…, surface
 * is the stage prompt plus one user request) on the light path — no handoff
 * document, no archive — while any transition after real stage work (whose
 * discussions and tool outputs alone exceed this) stays a full transition.
 * Deployments wanting the old always-full behavior pass 0.
 *
 * Using a threshold requires the host to compose `@deepseek-ai/dsh-token-meter`;
 * stage-switch fails goto_stage at transition time without it. */
export const TAVERN_MIN_HANDOFF_TOKENS = 10000

/** A ready-to-use stage-switch config preset for the tavern workflow. */
export const tavernCardsStageConfig: StageConfig = {
  // Spread to mutably satisfy StageConfig.stages. route is first, and we omit
  // `initial` so StageController defaults to `stages[0].name` (route) rather
  // than restating a stage name here — adding a stage keeps route first, or
  // reorders the array to change the entry point, both with no extra edits.
  stages: [...TAVERN_CARDS_STAGES],
  minHandoffTokens: TAVERN_MIN_HANDOFF_TOKENS,
  section: tavernPrompts.section,
}

/**
 * Dedicated ui-complete guidance, rendered instead of
 * the generic advance-urging section — ui has no next stage, so the advice is
 * to return to route and stand by, with the same anti-premature hedging.
 * Copy from {@link tavernPrompts} (`src/prompts.json`).
 */
export const TAVERN_UI_COMPLETE_SECTION = tavernPrompts.uiComplete

/** The stage list from {@link tavernCardsStageConfig}. */
export const tavernCardsStages: StageDefinition[] = tavernCardsStageConfig.stages.slice()

/** The switch-guidance section template from {@link tavernCardsStageConfig}. */
export const tavernCardsSection = tavernCardsStageConfig.section

/** Options accepted by {@link createTavernCardsStageConfig}. */
export interface TavernCardsStageConfigOptions {
  /** Override the initial stage; defaults to the first included stage. */
  readonly initial?: string
  /** Handoff directory passed through to `dsh-stage-switch`. */
  readonly handoffDir?: string
  /** Token threshold passed through to `dsh-stage-switch`; defaults to
   * {@link TAVERN_MIN_HANDOFF_TOKENS}. Pass 0 to force full transitions. */
  readonly minHandoffTokens?: number
  /** Restrict the preset to a subset of the tavern stages. */
  readonly include?: readonly TavernCardsStageName[]
}

/**
 * Build a `dsh-stage-switch` config from the tavern workflow preset.
 *
 * Use this when composing the two plugins in code, or copy the equivalent YAML
 * into a `cordis.yml` deployment.
 */
export function createTavernCardsStageConfig(
  options: TavernCardsStageConfigOptions = {},
): StageConfig {
  const stages = options.include === undefined
    ? TAVERN_CARDS_STAGES.slice()
    : TAVERN_CARDS_STAGES.filter(stage =>
      options.include!.includes(stage.name as TavernCardsStageName))
  // Omit `initial` when not pinned — StageController defaults to
  // `stages[0].name` (route), so switching the entry stage means reordering
  // `TAVERN_CARDS_STAGES`, not editing a stage name here.
  return {
    stages,
    section: tavernCardsSection,
    minHandoffTokens: options.minHandoffTokens ?? TAVERN_MIN_HANDOFF_TOKENS,
    ...options.initial === undefined ? {} : { initial: options.initial },
    ...options.handoffDir === undefined ? {} : { handoffDir: options.handoffDir },
  }
}
