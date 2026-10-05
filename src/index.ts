/**
 * DSH plugin bringing the tavern-design / tavern-cards / tavern-ui workflows
 * into `dsh-stage-switch` (published as `@ai4rpg/dsh-stage-switch`).
 *
 * The plugin does not replace stage-switch. It provides:
 * - {@link tavernCardsStageConfig}, a ready-to-use stage-switch config matching
 *   the main tavern workflow (the tavern content repo's preset package
 *   composes it into a preset row);
 * - one composite eligibility predicate that tells stage-switch whether the
 *   *current* stage is complete, based on the tavern-cards project files.
 *
 * @module @ai4rpg/dsh-tavern-stages
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import { applySubagents } from './subagents.ts'
import type { TavernSubagentOptions } from './subagents.ts'
import { applyForgeTool, emitPacked, runForge, TAVERN_CARDS_PACKED } from './forge.ts'
import { BehaviorFocus, cwdFromActor, focusWeightFromActor, projectFromPath } from './focus.ts'
import { PackLedger } from './pack-ledger.ts'
import { TavernCardsStatus } from './status.ts'
import { tavernPrompts } from './prompts.ts'
import { TAVERN_UI_COMPLETE_SECTION } from './stages.ts'

export {
  TAVERN_FORGE,
  TAVERN_CARDS_PACKED,
  runForge,
  packProjectFromArgs,
} from './forge.ts'
export type { TavernCardsPackedPayload } from './forge.ts'
export {
  BehaviorFocus,
  projectFromPath,
  cwdFromActor,
  focusWeightFromActor,
  FOCUS_READ_WEIGHT,
  FOCUS_WRITE_WEIGHT,
} from './focus.ts'
export { PackLedger } from './pack-ledger.ts'
export { loadTavernAgents } from './subagents.ts'
export type { TavernAgentDescriptor, TavernSubagentOptions } from './subagents.ts'
export { isDesignSpecSubstantial } from './design.ts'
export { isDeployedRegexFile, isUiRegexFileName, stripCodeFences } from './ui.ts'
export { TavernCardsStatus } from './status.ts'
export {
  TAVERN_CARDS_STAGES,
  TAVERN_MIN_HANDOFF_TOKENS,
  tavernCardsStageConfig,
  TAVERN_UI_COMPLETE_SECTION,
  tavernCardsStages,
  tavernCardsSection,
  createTavernCardsStageConfig,
} from './stages.ts'
export type { TavernCardsStageName, TavernCardsStageConfigOptions } from './stages.ts'

/** Placeholder plugin config; reserved for project-root/cardrc overrides later. */
export interface TavernCardsConfig {
  /** Reserved for future per-deployment overrides. */
  readonly projectRoots?: string[]
  /**
   * Named subagent providers (one per `agents/*.md`), registered on
   * the host `subagents` registry under `tavern:<name>`. Opt-in: defaults to
   * disabled, and even when enabled it stays inert until the host composes a
   * `subagents` service (e.g. `dsh-subagent-spawn-in-process`). The
   * model-facing tools are NOT mounted by the plugin: the preset's tavern
   * group carries one `@deepseek-ai/dsh-tool-subagent` row per agent bound
   * to these providers.
   * Registration is idempotent across preset mounts (see `src/subagents.ts`).
   */
  readonly subagents?: TavernSubagentOptions
}

/**
 * Apply the @ai4rpg/dsh-tavern-stages plugin.
 *
 * The plugin refreshes the file-based status cache before each accepted step,
 * then registers one composite eligibility predicate with `ctx.stage`.
 */
export function apply(ctx: Context, config: TavernCardsConfig = {}): void {
  // Skill registration belongs to the tavern content repo's preset package:
  // it ships the three skill bodies in its own skills/ directory and points its
  // `skill-filesystem` row's customSkillDirs at it (official cordis pattern).
  // This package supplies the stage config, the project tools, and the named-subagent
  // providers a preset composes.
  //
  // Named subagent tools (check / conversion / schema / first-message). Inert
  // unless `config.subagents.enabled` is set AND the host composes a
  // `subagents` service; `ctx.inject` defers registration until then.
  applySubagents(ctx, config.subagents)

  // Model-facing forge tool. Pack is `command: 'pack'` — no separate
  // `tavern_pack` tool. Human slash commands below stay as shortcuts.
  applyForgeTool(ctx)

  // Expose the external forge CLI as human commands. Packaging is a recurring
  // preview/verification action, so it stays available in every stage.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'tavern-forge',
      description: tavernPrompts.commands.tavernForge,
      input: { hint: '<command> [args]' },
      handler: async ({ agent, rawInput, signal }) => {
        const args = rawInput.trim().split(/\s+/).filter(Boolean)
        if (args.length === 0) {
          return { kind: 'error', text: 'Usage: /tavern-forge <command> [args]' }
        }
        try {
          const cwd = agent.session.header.cwd
          const stdout = await runForge(args, cwd, signal)
          emitPacked(commandCtx, args, cwd, 'command')
          return { kind: 'success', text: stdout.trim() || 'tavern-cards-forge completed.' }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })

    commandCtx.commands.register({
      name: 'tavern-pack',
      description: tavernPrompts.commands.tavernPack,
      input: { hint: '<project>' },
      handler: async ({ agent, rawInput, signal }) => {
        const project = rawInput.trim()
        if (project === '') {
          return { kind: 'error', text: 'Usage: /tavern-pack <project>' }
        }
        try {
          const cwd = agent.session.header.cwd
          const forgeArgs = ['pack', project] as const
          const stdout = await runForge(forgeArgs, cwd, signal)
          emitPacked(commandCtx, forgeArgs, cwd, 'command')
          return { kind: 'success', text: stdout.trim() || `Packed ${project}.` }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  })

  // Both services must be present before the status reader is created: `fs`
  // supplies the async file reads and `stage` supplies the eligibility seam.
  ctx.inject(['stage', 'fs', 'systemPrompt'], (stageCtx) => {
    const focus = new BehaviorFocus()
    const packs = new PackLedger()
    const status = new TavernCardsStatus(stageCtx, focus, packs)

    // Behavior focus: record successful observations of
    // project-owned paths, weighted write-heavy (2:5) so reference reads of
    // another project cannot steal focus from the project being written.
    // Contractually a synchronous recorder — no await, no throws.
    //
    // Input sources (harness contract): only the tool-fs read/write/edit/
    // read_image tools and dsh-tool-str-replace-editor emit `fs/observed`
    // (with the tool execution as actor). bash (incl. the persistent shell)
    // and the forge CLI child process never emit — so a session that does
    // all its file work through bash accumulates no focus observations, and
    // `stage:policy` then stays silent in ANY workspace (no reliable project
    // attribution — an empty focus buffer renders no pressure, so a
    // fresh session on an already-complete project is not told its stage is
    // done before it has done any work). The stage guidance therefore steers
    // project-file writes to the tracked editor tools (str_replace_editor /
    // write / edit) rather than bash.
    stageCtx.on('fs/observed', (target, observation, actor) => {
      if (observation.kind !== 'present') return
      const cwd = cwdFromActor(actor)
      const project = projectFromPath(target.displayPath)
      if (cwd === undefined || project === undefined) return
      focus.record(cwd, project, target.displayPath, focusWeightFromActor(actor))
    })

    // Pack ledger: successful packs via the model tool or slash
    // commands emit `tavern-cards/packed`; the ledger is the session-time half
    // of the content/ui pack gate.
    stageCtx.on(TAVERN_CARDS_PACKED, ({ project, cwd, at }) => {
      if (cwd !== undefined) packs.mark(cwd, project, at)
    })

    // Session-end cleanup: drop per-cwd state for a disposed session so a
    // long-lived process does not accumulate focus/pack/status entries for
    // every cwd visited (BehaviorFocus/PackLedger would grow unboundedly;
    // their per-cwd clear() had no production caller before this). A fresh
    // session on the same cwd starts with empty state, matching the
    // observation-driven design (no focus → no completion pressure).
    stageCtx.on('session/disposed', (session) => {
      const cwd = session.header.cwd
      if (cwd === undefined) return
      focus.clear(cwd)
      packs.clear(cwd)
      status.clearCwd(cwd)
    })

    // Refresh before request assembly so the synchronous eligibility predicate
    // sees file changes made by earlier tool calls in the same turn.
    stageCtx.on('agent/pre-step', async ({ agent }, next) => {
      await status.refresh(agent)
      return next()
    })

    // ui never renders the generic advance-urging section (it has no next
    // stage); its completion is announced by the dedicated context below.
    stageCtx.stage.registerEligibility((agent) => {
      const stage = stageCtx.stage.current(agent.session)
      if (stage === 'ui') return false
      return status.isComplete(agent, stage)
    })

    // ui-complete guidance: visible only while the session is in the ui
    // stage and the focused project reads as done. Returning to
    // route clears it, and route itself never renders stage pressure.
    //
    // order 117 sits immediately after stage-switch's `stage:policy`
    // (order 116, see @ai4rpg/dsh-stage-switch src/index.ts): the generic
    // advance-urging section for ui (which has no next stage) must never
    // render, and this dedicated section takes its place. Keep 117 > 116.
    stageCtx.systemPrompt.context({
      name: 'tavern-cards/ui-complete',
      order: 117,
      text: (context) => {
        if (context.agent === undefined) return ''
        const agent = context.agent
        if (stageCtx.stage.current(agent.session) !== 'ui') return ''
        return status.isComplete(agent, 'ui') ? TAVERN_UI_COMPLETE_SECTION : ''
      },
    })

    stageCtx.effect(() => () => {
      status.dispose()
      focus.dispose()
      packs.dispose()
    })
  })
}

export default apply
