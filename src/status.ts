/**
 * Tavern-cards project analyzer: reads the tavern-cards project files through
 * the async `ctx.fs` service and caches synchronous completion flags for the
 * stage-switch eligibility seam. Split out of `src/index.ts` so the
 * design/planning/content/ui heuristics are independently testable.
 *
 * @module @ai4rpg/dsh-tavern-stages/status
 */

import { Context } from '@deepseek-ai/cordis'
import { dirname } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { parse } from 'yaml'
import { BehaviorFocus } from './focus.ts'
import type { PackLedger } from './pack-ledger.ts'
import { isDesignSpecSubstantial } from './design.ts'
import { isDeployedRegexFile, isUiRegexFileName } from './ui.ts'
import { tavernCardsStages } from './stages.ts'

interface CardRcProject {
  readonly state_file?: string
  readonly artifact?: string
}

interface CardRc {
  readonly projects?: Readonly<Record<string, CardRcProject>>
}

interface EntryManifestLeaf {
  readonly path?: string
  readonly contents?: ReadonlyArray<{
    readonly content?: string
    readonly file?: string
  }>
  readonly part?: string
  readonly strategy?: unknown
  readonly position?: unknown
}

type EntryManifest = Readonly<Record<string, Readonly<Record<string, EntryManifestLeaf>>>>

interface TavernCardsState {
  readonly projectName?: string
  readonly form?: string
  readonly mvu?: boolean
  readonly entryManifest?: EntryManifest
  readonly first_messages?: readonly string[]
  readonly regex_scripts?: Readonly<Record<string, Readonly<{ replace_file?: string }> | undefined>>
  readonly extensions?: {
    readonly tavern_helper?: unknown
  }
  readonly zod?: {
    readonly schemaPath?: string
  }
}

interface PlanningEntry {
  readonly name?: string
  readonly type?: string
  readonly path?: string
}

interface PlanningEjsEntry {
  readonly name?: string
  readonly complexity?: string
  readonly condition?: string
}

interface PlanningFirstMessage {
  readonly output_path?: string
}

interface PlanningYaml {
  readonly project?: {
    readonly name?: string
    readonly form?: string
    readonly mvu?: boolean
    readonly ui_mode?: string
  }
  readonly entries?: readonly PlanningEntry[]
  readonly ejs?: {
    readonly entries?: readonly PlanningEjsEntry[]
  }
  readonly first_messages?: readonly PlanningFirstMessage[]
}

/**
 * Per-stage completion flags keyed by stage name. `analyzeProject` only ever
 * produces the four artifact-bearing stages; `route` is intentionally absent
 * (it owns no deliverable), so it defaults to false and route can never render
 * the `stage:policy` runtime-context — leaving it a pure entry router. Keying by
 * name (rather than a struct with literal fields) keeps the eligibility refresh
 * loop generic over `tavernCardsStages`, so adding an artifact stage touches the
 * analyzer and the stage list, not a parallel hardcoded field set.
 */
type ProjectCompletion = Record<string, boolean>

/**
 * Reads tavern-cards project files through the async `ctx.fs` service and
 * caches synchronous completion flags for the stage-switch eligibility seam.
 *
 * The eligibility predicate itself must stay synchronous, so all async I/O is
 * done in {@link refresh}, normally from an `agent/pre-step` listener before
 * request assembly.
 */
export class TavernCardsStatus {
  private readonly fs: FileSystem | undefined
  private readonly focus: BehaviorFocus | undefined
  private readonly packs: PackLedger | undefined
  private readonly logger: Context['logger'] | undefined
  private readonly cache = new Map<string, boolean>()
  /** Per-cwd cache of the project root directory found by findProjectRoot.
   * Avoids re-walking up to 32 levels on every pre-step. Invalidated when
   * the cached root's `.cardrc.json` stat fails (deleted or moved). */
  private readonly rootCache = new Map<string, string>()

  constructor(ctx: Context, focus?: BehaviorFocus, packs?: PackLedger) {
    this.fs = ctx.get('fs')
    this.focus = focus
    this.packs = packs
    this.logger = ctx.logger
  }

  /** Whether a stage is known complete for an agent's session cwd. */
  isComplete(agent: Agent, stage: string): boolean {
    const cwd = agent.session.header.cwd ?? ''
    return this.cache.get(this.key(cwd, stage)) ?? false
  }

  /** Clear all cached completion flags. */
  clear(): void {
    this.cache.clear()
    this.rootCache.clear()
  }

  /** Clear cached completion flags for one session cwd only. */
  clearCwd(cwd: string): void {
    const prefix = `${cwd}\0`
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
    this.rootCache.delete(cwd)
  }

  /** Dispose internal state. */
  dispose(): void {
    this.cache.clear()
    this.rootCache.clear()
  }

  /**
   * Re-read the tavern-cards project files for the agent's session cwd and
   * update the synchronous completion cache.
   */
  async refresh(agent: Agent): Promise<void> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined || this.fs === undefined) {
      // No cwd means no workspace to track; no fs means the analyzer is
      // inert. Either way, do NOT clear other sessions' caches (the old
      // `this.clear()` was a multi-session bug: one cwd-less agent would
      // nuke every session's completion cache every step).
      return
    }

    const projectRoot = await this.cachedProjectRoot(this.fs, cwd)
    if (projectRoot === undefined) {
      this.clearCwd(cwd)
      return
    }

    const cardRc = await this.readJson<CardRc>(this.fs, '.cardrc.json', projectRoot)
    const projects = cardRc?.projects ?? {}
    const names = Object.keys(projects)
    if (names.length === 0) {
      this.clearCwd(cwd)
      return
    }

    // Behavior-focus evaluation: completion feeds only from
    // the FOCUSED project, inferred from observed read/write traffic on
    // `cards/{Project}/…` paths. An empty focus buffer means the session has
    // not engaged any project yet — nothing is complete and no stage pressure
    // renders, even when files on disk already look done (a fresh session on
    // an already-complete workspace must not be told its stage is finished
    // before it has done any work; that misjudgment drove the premature
    // `stage:policy` right after a route→design switch).
    //
    // The single-project fallback survives only on the no-focus constructor
    // path, which production never takes (`apply` always composes
    // BehaviorFocus); it exists so the file-heuristic unit tests can exercise
    // `TavernCardsStatus` without observation plumbing. Production is strictly
    // observation-driven: no focus observations → no completion, matching the
    // multi-project rule ("with several projects and no recorded focus,
    // nothing is complete and no stage pressure renders").
    const focusProject = this.focus === undefined
      ? (names.length === 1 ? names[0] : undefined)
      : this.focus.focusProject(cwd, names)
    if (focusProject === undefined) {
      this.clearCwd(cwd)
      return
    }

    const statePath = projects[focusProject]?.state_file
      ?? `cards/${focusProject}/tavern-cards-state.json`
    // The project directory is the parent of the REGISTERED state file, not a
    // `cards/{Project}` guess: `state_file` may sit anywhere under the root
    // (a multi-project workspace like `项目2，问道/cards/问道/tavern-cards-
    // state.json` is one level deeper), and design-spec.md / 创作规划.yaml live
    // beside it. Guessing `cards/{Project}` makes every file check here read
    // `undefined`, so no stage could ever register as done and `stage:policy`
    // stayed silent for the whole session.
    const projectPath = dirname(statePath)
    // Pack gate inputs: a pack event this session (preferred), with the
    // declared artifact as a fallback for shell-packed projects. Artifact
    // paths default to the forge convention `<projectDir>/{P}.{png|json}`.
    const artifact = projects[focusProject]?.artifact
    const packGate = {
      observed: this.packs?.lastPack(cwd, focusProject) !== undefined,
      artifacts: artifact !== undefined && artifact !== ''
        ? [artifact]
        : [`${projectPath}/${focusProject}.png`, `${projectPath}/${focusProject}.json`],
    }
    const completion = await this.analyzeProject(this.fs, projectRoot, statePath, projectPath, packGate)

    // Driven off the configured stage list rather than restating stage
    // names. route is absent from each `ProjectCompletion` (it has no
    // artifact to detect), so it falls through to false — route is never
    // marked complete, never renders `stage:policy`, and is a pure entry
    // router. Adding a stage only touches `TAVERN_CARDS_STAGES`.
    for (const stage of tavernCardsStages) {
      this.setStage(cwd, stage.name, completion[stage.name] === true)
    }
  }

  private async findProjectRoot(fs: FileSystem, cwd: string): Promise<string | undefined> {
    let current = cwd
    for (let depth = 0; depth < 32; depth += 1) {
      const target = await this.resolveTarget(fs, '.cardrc.json', current)
      if (target !== undefined && await this.existsTarget(fs, target)) return current
      const parentTarget = await this.resolveTarget(fs, '..', current)
      if (parentTarget === undefined) return undefined
      const parentPath = parentTarget.displayPath
      if (parentPath === current) return undefined
      current = parentPath
    }
    return undefined
  }

  /** Cached {@link findProjectRoot}: reuse the last walk result per cwd,
   * re-walking only when the cached root's `.cardrc.json` disappears. Keeps
   * the same-turn semantics (a change in the file that was found still shows
   * up on the next refresh) while avoiding repeated 32-level walks. */
  private async cachedProjectRoot(fs: FileSystem, cwd: string): Promise<string | undefined> {
    const cached = this.rootCache.get(cwd)
    if (cached !== undefined) {
      const target = await this.resolveTarget(fs, '.cardrc.json', cached)
      if (target !== undefined && await this.existsTarget(fs, target)) return cached
      this.rootCache.delete(cwd)
    }
    const root = await this.findProjectRoot(fs, cwd)
    if (root !== undefined) this.rootCache.set(cwd, root)
    return root
  }

  private async analyzeProject(
    fs: FileSystem,
    cwd: string,
    statePath: string,
    projectPath: string,
    packGate: { observed: boolean; artifacts: readonly string[] },
  ): Promise<ProjectCompletion> {
    // `projectPath` is the parent of the project's registered state file —
    // every artifact this analyzer checks lives beside it.
    const designPath = `${projectPath}/design-spec.md`
    const planningPath = `${projectPath}/创作规划.yaml`

    const [designText, planningText, state] = await Promise.all([
      this.readText(fs, designPath, cwd),
      this.readText(fs, planningPath, cwd),
      this.readJson<TavernCardsState>(fs, statePath, cwd),
    ])

    const planning = planningText === undefined
      ? undefined
      : this.parseYaml(planningText)

    // The pack gate: a successful pack observed this session, or — as a
    // shell-pack fallback — the pack artifact already on disk (it is a forge
    // output, not a hand-written content file, so its existence is itself
    // pack evidence).
    const packOk = packGate.observed || await this.anyExists(fs, packGate.artifacts, cwd)

    const contentComplete = await this.isContentComplete(fs, cwd, projectPath, state, planning)
    const ui = await this.isUiComplete(fs, cwd, projectPath, state, planning, packOk)

    return {
      // The state-content fallback is gone — a spec that was never
      // written (or is still a heading/placeholder shell) keeps design open,
      // and a missing/unparseable planning doc keeps planning open. Manual
      // old projects lose the auto-skip; revisit via goto_stage instead.
      design: designText !== undefined && isDesignSpecSubstantial(designText),
      planning: planning !== undefined
        ? !planningText!.includes('待细化')
        : false,
      // Content complete is not enough: the pack gate must also be satisfied,
      // so a never-packed project never renders leave-this-stage pressure.
      content: contentComplete && packOk,
      ui,
    }
  }

  private async isContentComplete(
    fs: FileSystem,
    cwd: string,
    projectPath: string,
    state: TavernCardsState | undefined,
    planning: PlanningYaml | undefined,
  ): Promise<boolean> {
    if (state === undefined) return false
    if (!this.allPlannedEntriesRegistered(state, planning)) return false
    if (!await this.isTechnicalComplete(fs, cwd, projectPath, state, planning)) return false
    if (!await this.isOpeningComplete(fs, cwd, projectPath, state, planning)) return false
    return true
  }

  private allPlannedEntriesRegistered(
    state: TavernCardsState,
    planning: PlanningYaml | undefined,
  ): boolean {
    const planned = planning?.entries ?? []
    // Without a planning document (old/manual projects), fall back to
    // state-based inference: any existing registered entry is enough to
    // consider the registration check non-blocking.
    if (planned.length === 0) return this.hasAnyManifestEntries(state)
    for (const entry of planned) {
      if (entry.name === undefined) continue
      if (this.findManifestLeaf(state, entry.name) === undefined) return false
    }
    return true
  }

  private async isTechnicalComplete(
    fs: FileSystem,
    cwd: string,
    projectPath: string,
    state: TavernCardsState,
    planning: PlanningYaml | undefined,
  ): Promise<boolean> {
    if (state.mvu === true) {
      const schemaPath = state.zod?.schemaPath ?? 'schema.ts'
      const [schemaExists, initvarExists, updateRulesExists] = await Promise.all([
        this.exists(fs, `${projectPath}/${schemaPath}`, cwd),
        this.exists(fs, `${projectPath}/世界书/变量/initvar.yaml`, cwd),
        this.exists(fs, `${projectPath}/世界书/变量/变量更新规则.yaml`, cwd),
      ])
      const zodExists = state.zod !== undefined
      const mvuEntries = Object.values(state.entryManifest?.['MVU'] ?? {})
      const hasInitvar = mvuEntries.some(leaf => leaf.part === 'initvar')
      const hasUpdateRules = mvuEntries.some(leaf => leaf.part === 'update_rules')

      if (!(schemaExists && initvarExists && updateRulesExists && zodExists && hasInitvar && hasUpdateRules)) {
        return false
      }
    }

    const ejsEntries = planning?.ejs?.entries ?? []
    for (const ejsEntry of ejsEntries) {
      if (ejsEntry.name === undefined) continue
      const leaf = this.findManifestLeaf(state, ejsEntry.name)
      if (leaf === undefined) return false
      if (!await this.entryHasEjs(fs, cwd, projectPath, leaf)) return false
    }

    if (!this.isConfigured(state)) return false
    return true
  }

  private async entryHasEjs(
    fs: FileSystem,
    cwd: string,
    projectPath: string,
    leaf: EntryManifestLeaf,
  ): Promise<boolean> {
    const inlineEjs = leaf.contents?.some(fragment =>
      fragment.content !== undefined
      && (fragment.content.includes('@@if') || fragment.content.includes('<%')))
    if (inlineEjs) return true

    if (leaf.path !== undefined) {
      const text = await this.readText(fs, `${projectPath}/${leaf.path}`, cwd)
      return text !== undefined && (text.includes('@@if') || text.includes('<%'))
    }
    return false
  }

  private isConfigured(state: TavernCardsState): boolean {
    const leaves = Object.values(state.entryManifest ?? {}).flatMap(typeEntries =>
      Object.values(typeEntries))
    if (leaves.length === 0) return false
    return leaves.every(leaf => leaf.strategy !== undefined && leaf.position !== undefined)
  }

  private async isOpeningComplete(
    fs: FileSystem,
    cwd: string,
    projectPath: string,
    state: TavernCardsState,
    planning: PlanningYaml | undefined,
  ): Promise<boolean> {
    if (state.form === 'worldbook') return true
    if (state.form !== 'charactercard') return false

    const plannedPaths = (planning?.first_messages ?? [])
      .map(message => message.output_path)
      .filter((path): path is string => path !== undefined)

    if (plannedPaths.length > 0) {
      const allExist = await Promise.all(plannedPaths.map(async path => {
        if (!state.first_messages?.includes(path)) return false
        return this.exists(fs, `${projectPath}/${path}`, cwd)
      }))
      return allExist.every(Boolean)
    }

    const registered = state.first_messages ?? []
    if (registered.length === 0) return false
    const allExist = await Promise.all(registered.map(path =>
      this.exists(fs, `${projectPath}/${path}`, cwd)))
    return allExist.every(Boolean)
  }

  /**
   * ui completion: the `正则/` replacement files this
   * project's UI actually uses must all read as deployed content, and the pack
   * gate must be satisfied. Projects with no UI work to do (worldbook, non-MVU,
   * `ui_mode: none` with no UI files) skip the stage as complete. The old
   * `extensions.tavern_helper` / bare `regex_scripts` signals are gone: the
   * former is never registered, the latter is pre-registered before ui starts.
   */
  private async isUiComplete(
    fs: FileSystem,
    cwd: string,
    projectPath: string,
    state: TavernCardsState | undefined,
    planning: PlanningYaml | undefined,
    packOk: boolean,
  ): Promise<boolean> {
    if (state === undefined) return false
    if (state.form === 'worldbook') return true
    if (state.mvu !== true) return true

    const uiMode = planning?.project?.ui_mode
    const regexFiles = await this.collectUiRegexFiles(fs, cwd, projectPath, state)
    if (regexFiles.length === 0) {
      // No UI files at all: complete only when the plan says no UI is wanted.
      return uiMode === 'none'
    }

    const texts = await Promise.all(regexFiles.map(file =>
      this.readText(fs, `${projectPath}/${file}`, cwd)))
    if (!texts.every(text => text !== undefined && isDeployedRegexFile(text))) return false
    return packOk
  }

  /**
   * The open set of UI replacement files under `正则/`: paths referenced
   * by `regex_scripts[].replace_file` (definitive — the project registers what
   * it uses), plus every `正则/` entry whose name looks like a UI file (covers
   * standard names like 状态栏界面.html registered late and off-standard ones).
   */
  private async collectUiRegexFiles(
    fs: FileSystem,
    cwd: string,
    projectPath: string,
    state: TavernCardsState,
  ): Promise<string[]> {
    const files = new Set<string>()
    for (const script of Object.values(state.regex_scripts ?? {})) {
      const file = script?.replace_file
      if (file !== undefined && file.startsWith('正则/')) files.add(file)
    }

    const regexDir = await this.resolveTarget(fs, `${projectPath}/正则`, cwd)
    if (regexDir !== undefined) {
      try {
        const entries = await fs.listDir(regexDir)
        for (const entry of entries) {
          if (entry.type === 'file' && isUiRegexFileName(entry.name)) files.add(`正则/${entry.name}`)
        }
      } catch {
        // unreadable/missing directory: fall back to the referenced set
      }
    }
    return [...files]
  }

  private hasAnyManifestEntries(state: TavernCardsState): boolean {
    return Object.keys(state.entryManifest ?? {}).length > 0
  }

  private findManifestLeaf(state: TavernCardsState, name: string): EntryManifestLeaf | undefined {
    const manifest = state.entryManifest ?? {}
    for (const typeEntries of Object.values(manifest)) {
      if (Object.hasOwn(typeEntries, name)) return typeEntries[name]
    }
    return undefined
  }

  private parseYaml(text: string): PlanningYaml | undefined {
    try {
      return parse(text) as PlanningYaml
    } catch (error) {
      // A malformed planning doc silently reads as "not complete" and the
      // stage never advances with no visible cause; surface it for diagnosis.
      this.logger?.debug(
        'tavern-stages: planning YAML parse failed (planning judged incomplete): '
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  private setStage(cwd: string, stage: string, ready: boolean): void {
    this.cache.set(this.key(cwd, stage), ready)
  }

  private key(cwd: string, stage: string): string {
    return `${cwd}\0${stage}`
  }

  private async resolveTarget(fs: FileSystem, path: string, cwd: string): Promise<FsTarget | undefined> {
    try {
      return await fs.resolve(path, { cwd })
    } catch {
      return undefined
    }
  }

  private async existsTarget(fs: FileSystem, target: FsTarget): Promise<boolean> {
    try {
      return (await fs.stat(target)) !== undefined
    } catch {
      return false
    }
  }

  private async exists(fs: FileSystem, path: string, cwd: string): Promise<boolean> {
    const target = await this.resolveTarget(fs, path, cwd)
    return target === undefined ? false : this.existsTarget(fs, target)
  }

  private async anyExists(fs: FileSystem, paths: readonly string[], cwd: string): Promise<boolean> {
    const results = await Promise.all(paths.map(path => this.exists(fs, path, cwd)))
    return results.some(Boolean)
  }

  private async readText(fs: FileSystem, path: string, cwd: string): Promise<string | undefined> {
    try {
      const target = await fs.resolve(path, { cwd })
      return await fs.readText(target)
    } catch {
      return undefined
    }
  }

  private async readJson<T>(fs: FileSystem, path: string, cwd: string): Promise<T | undefined> {
    const text = await this.readText(fs, path, cwd)
    if (text === undefined) return undefined
    try {
      return JSON.parse(text) as T
    } catch {
      return undefined
    }
  }
}
