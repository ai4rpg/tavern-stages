/**
 * Tavern-cards named subagent providers.
 *
 * Wires the four agent personas of the `@ai4rpg/tavern-agents` content
 * package (check / conversion / schema / first-message) to providers
 * registered on the host `subagents` registry.
 * The MODEL-FACING TOOLS are NOT mounted here: the preset's tavern group
 * carries one `@deepseek-ai/dsh-tool-subagent` row per agent, bound to the
 * provider name `tavern:<name>` — declarative, and per-preset tunable via
 * `agentOptions`,
 * `toolFilter`, and `maxDepth`. This module owns only the provider half, so
 * the model can delegate "run the check-agent on these entries" and get back
 * a fresh-context result instead of reviewing its own work.
 *
 * Provider design:
 * - **Body prepending** — the agent body travels as the first block of the
 *   child's initial prompt, never as a `persona` section. A `persona` section would
 *   shadow the host's `complete: true` minimal persona and drop the
 *   `complete` flag, letting runtime contexts leak into the child's first
 *   request. Leaving `persona` undefined lets the child inherit the host's
 *   clean minimal persona through the `composeFrom` scope chain. The
 *   tool-subagent rows MUST therefore keep `persona` unset.
 * - **Child route and effort are native since dsh 0.1.5.** `AgentOptions`
 *   gained `reasoningEffort` (beside `provider`/`model`/`maxTokens`), and the
 *   official `dsh-tool-subagent` row passes its configured `agentOptions`
 *   through `request.agentOptions`. The in-process driver resolves them via
 *   `resolveChildAgentOptions` into `agents.create`, and the agent loop reads
 *   `options.reasoningEffort` when composing each request — so forcing an
 *   effort is a declarative per-row change (`agentOptions: { reasoningEffort:
 *   max }`) with no plugin code. The old `agent/created` +
 *   `installModelSelection` injection that used to be the only reason for a
 *   custom provider is gone; this provider exists solely to prepend the body.
 * - **Skill directories are resolved, not looked up by the child.** The agent
 *   bodies reference docs as paths relative to a tavern skill directory (e.g.
 *   `references/rules-check.md` relative to the `tavern-cards` skill), so a
 *   child that only had the body would have to call the `skill` tool once just
 *   to learn where its own docs live. `start()` resolves the referenced skill
 *   directories through the `skills` registry and appends the absolute paths,
 *   so the body stays verbatim (upstream-synced, never edited) and the child
 *   goes straight to reading. The append is best-effort: with no `skills`
 *   service, an incomplete catalog, or a lookup failure the body ships
 *   unchanged and the child falls back to the `skill` tool.
 *
 * Each named agent owns its own provider (registered under `tavern:<name>`)
 * so the provider knows which body to prepend. The tool-subagent rows bind to
 * that provider name.
 *
 * **Idempotent registration.** `subagents.registerProvider` registers on the
 * service's own (process-lifetime) context and throws `DUPLICATE_PROVIDER`
 * for a reused name. Standing preset mounts re-run this module once per
 * preset id (tavern-standard, plus any preset-file edit
 * that starts a new generation), so the second mount must not re-register:
 * the check-then-register below shares the first mount's provider (same
 * packaged body, same process). A racing sibling mount between the check and
 * the register is absorbed by catching `DUPLICATE_PROVIDER`. Per-child
 * route/effort/maxTokens resolve per call from each row's `agentOptions`, so
 * the shared provider carries no per-mount configuration to reconcile.
 *
 * **Optional host capability.** The subagent packages
 * (`@deepseek-ai/dsh-subagent`, `-in-process-driver`) are declared as
 * **optional peer dependencies**. They are loaded with a dynamic `import()`
 * only when `subagents.enabled` is set, so a host that never enables
 * subagents does not need them installed and the plugin's base
 * stage/skill/forge features keep working. Type-only imports stay static
 * because TypeScript erases them at build time.
 *
 * The whole block is also gated on the host composing a `subagents` service:
 * `ctx.inject(['subagents', ...])` never fires without it, so even
 * `enabled: true` stays inert on a host without the spawn provider.
 *
 * @module @ai4rpg/dsh-tavern-stages/subagents
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tavernPrompts } from './prompts.ts'

/** Subagent tool configuration. */
export interface TavernSubagentOptions {
  /** Enable the four named delegation tools. Default `false`. */
  readonly enabled?: boolean
  /**
   * Provider name prefix registered on `ctx.subagents`. Each agent registers
   * under `<prefix>:<name>` (e.g. `tavern:check-agent`) so its tool can bind
   * to it. Default `tavern`.
   */
  readonly providerPrefix?: string
}

/** One loaded agent persona + its tool-subagent wiring. Exported because it is
 * the return shape of {@link loadTavernAgents}, which deployments (the tavern
 * preset generator in particular) consume to declare one `tool-subagent` row
 * per agent. */
export interface TavernAgentDescriptor {
  /** Tool and file stem, e.g. `check-agent`. */
  readonly name: string
  /** Frontmatter description; surfaces as the tool's `description` prefix. */
  readonly description: string
  /** Body below the frontmatter; prepended to the child's first prompt. */
  readonly body: string
}

/**
 * The personas are CC BY-NC-SA content and live in the dedicated content
 * package `@ai4rpg/tavern-agents`. This package publishes to npm, so the
 * content package is deliberately NOT its dependency (a published manifest
 * must not carry file: specs): the tavern content repo's preset package
 * depends on it instead (`file:../tavern-agents`, inside that self-contained
 * repo), pnpm hoists it into the profile's node_modules, and createRequire
 * finds it from here — the same hoisted graph the forge CLI
 * (`resolveForgeCli` in `src/forge.ts`) rides, as a direct dependency of
 * this package. `TAVERN_AGENTS_ROOT` overrides the resolved directory;
 * tests inject fixture agents through it. Undefined when the package cannot
 * be resolved: the caller degrades to the no-agents path instead of failing
 * the mount.
 */
function resolveAgentsDir(): string | undefined {
  const override = process.env.TAVERN_AGENTS_ROOT
  if (override !== undefined && override !== '') return override
  try {
    const packagePath = createRequire(import.meta.url).resolve('@ai4rpg/tavern-agents/package.json')
    return join(dirname(packagePath), 'agents')
  } catch {
    return undefined
  }
}

/** Frontmatter parser mirroring the agents contract documented in the
 * `@ai4rpg/tavern-agents` content package (`scripts/validate-agents.mjs`
 * there guards the real content against it). */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

function parseAgentFile(name: string, text: string): TavernAgentDescriptor | undefined {
  const match = FRONTMATTER_RE.exec(text)
  if (match === null) return undefined
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    fields[key] = value
  }
  const body = (match[2] ?? '').replace(/^\n+/, '')
  return {
    name,
    description: fields.description ?? '',
    body,
  }
}

async function loadAgents(): Promise<TavernAgentDescriptor[]> {
  const agentsDir = resolveAgentsDir()
  if (agentsDir === undefined) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(agentsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const descriptors: TavernAgentDescriptor[] = []
  for (const entry of entries) {
    // The LICENSE.md note ships beside the personas; it is not a persona.
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'LICENSE.md') continue
    const stem = entry.name.slice(0, -3)
    const text = await readFile(join(agentsDir, entry.name), 'utf8')
    const descriptor = parseAgentFile(stem, text)
    if (descriptor !== undefined) descriptors.push(descriptor)
  }
  return descriptors.sort((a, b) => a.name.localeCompare(b.name))
}

/** Load and parse every persona in the agents content package. Exposed for
 * tests and the preset generator. */
export async function loadTavernAgents(): Promise<readonly TavernAgentDescriptor[]> {
  return loadAgents()
}

/** One resolved tavern skill directory, for the path block appended to a child prompt. */
interface TavernSkillDir {
  readonly name: string
  readonly directory: string
}

/** Tavern skill identifier as the agent bodies write it (`tavern-cards`, ...). */
const TAVERN_SKILL_RE = /\b(tavern-[a-z0-9][a-z0-9-]*)\b/g

/**
 * The tavern skill names an agent body references. The bodies are synced from
 * upstream and are never edited, so instead of a hand-kept name list the
 * referenced skills are read out of the prose (`路径相对于 tavern-cards skill
 * 目录`) — a body that starts referencing another tavern skill resolves it
 * without plugin changes. `tavern_forge` cannot match (underscore, not
 * hyphen).
 */
function referencedTavernSkills(body: string): readonly string[] {
  const names = new Set<string>()
  for (const match of body.matchAll(TAVERN_SKILL_RE)) names.add(match[1]!)
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * Resolve the tavern skill directories an agent body references.
 *
 * Returns `[]` — never throws — when the `skills` service is absent, when the
 * catalog carries none of the referenced skills, or when discovery fails. A
 * child that gets `[]` ships the body verbatim and falls back to calling the
 * `skill` tool, which is the behavior before this lookup existed.
 */
async function resolveTavernSkillDirs(
  ctx: Context,
  body: string,
  parent: Agent,
  signal: AbortSignal,
): Promise<readonly TavernSkillDir[]> {
  const referenced = referencedTavernSkills(body)
  if (referenced.length === 0) return []
  // `ctx.get` returns undefined for an uncomposed service instead of throwing,
  // so a host-plane mount without skill rows degrades here. Type-imported, not
  // imported: `@deepseek-ai/dsh-skill` is a devDependency only.
  const registry = ctx.get('skills') as SkillRegistry | undefined
  if (registry === undefined) return []
  try {
    // The registry reads merge the global layer with the viewing agent's scope
    // chain, so `scope: parent` finds skills whether they were registered into
    // the preset's own layer or into the global one. An unscoped read sees the
    // global layer alone, which misses a scope-isolated preset mount — so the
    // spawning agent is always the safer viewer (the child would see the same
    // layers, but its identity does not exist yet inside `start`).
    const summaries = await registry.list({
      cwd: parent.session.header.cwd,
      signal,
      scope: parent,
    })
    const bases = new Map(summaries.map(summary => [summary.name, summary.resourceBase]))
    const dirs: TavernSkillDir[] = []
    for (const name of referenced) {
      const base = bases.get(name)
      // `directory` is the only resource base with a readable path: a `url`
      // base (a remote provider) and an `opaque` one have no local docs for
      // the child to read, so those skills are left for the `skill` tool.
      if (base?.kind === 'directory') dirs.push({ name, directory: base.path })
    }
    return dirs
  } catch {
    return []
  }
}

/** The path block appended to a child prompt; empty when nothing resolved. */
function renderSkillDirs(dirs: readonly TavernSkillDir[]): string {
  if (dirs.length === 0) return ''
  const copy = tavernPrompts.subagentSkillDirs
  const lines = dirs.map(dir =>
    copy.line.replaceAll('{skill}', dir.name).replaceAll('{dir}', dir.directory),
  )
  return [copy.heading, '', ...lines, '', copy.note].join('\n')
}

/**
 * One named tavern agent's spawn provider.
 *
 * Body prepend: the agent body travels as the first block of the child's
 * initial prompt, never as a `persona` section. A `persona` section would shadow the
 * host's `complete: true` minimal persona and drop the `complete` flag, letting
 * runtime contexts leak into the child's first request. Leaving `persona`
 * undefined lets the child inherit the host's clean minimal persona through
 * the `composeFrom` scope chain.
 *
 * Constructed lazily inside `applySubagents` after the dynamic import resolves
 * the driver. Tests import this class directly from the source module, which
 * keeps the static type-only imports above.
 */
export class TavernAgentProvider implements SubagentProvider {
  // All capability bits are natively supported by the in-process driver; we
  // declare them so callers can safely request any of them.
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  readonly inheritsParentContext = false

  private readonly startInProcessRun: typeof import('@deepseek-ai/dsh-subagent-in-process-driver')['startInProcessRun']

  /** The mount context, used to resolve tavern skill directories per spawn. */
  private readonly ctx: Context

  constructor(
    readonly name: string,
    private readonly body: string,
    deps: {
      readonly startInProcessRun: TavernAgentProvider['startInProcessRun']
      readonly ctx: Context
    },
  ) {
    this.startInProcessRun = deps.startInProcessRun
    this.ctx = deps.ctx
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    // Prepend the agent body to the child's prompt so the persona reads as
    // instructions rather than a system section that would shadow the host.
    const body = this.body.trim()
    // Resolve referenced tavern skill directories so the child can read docs
    // by absolute path without first calling the `skill` tool. Best-effort: an
    // empty result leaves the body verbatim.
    const dirs = await resolveTavernSkillDirs(this.ctx, body, request.parent, request.signal)
    const text = dirs.length > 0
      ? `${body}\n\n${renderSkillDirs(dirs)}`
      : body
    const prompt: ContentBlock[] = text.length > 0
      ? [{ type: 'text', text }, ...request.prompt]
      : request.prompt
    return this.startInProcessRun({ ...request, prompt }, {})
  }

  prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    // Tavern agents are one-shot today (the continuable worldbuilding agent is
    // a later phase). A continuable start would reach this method; refuse it
    // loudly rather than silently dropping the persona body.
    void request
    return Promise.reject(new Error(
      'tavern-stages subagent provider does not support continuable children yet',
    ))
  }
}

/**
 * Apply the subagent provider block. Inert unless `subagents.enabled` is set,
 * and does nothing observable until the host also composes a `subagents`
 * service. The subagent packages are loaded with a dynamic `import()` so a
 * host that never enables subagents does not need them installed.
 *
 * Only PROVIDERS are registered here; the model-facing tools live as
 * `@deepseek-ai/dsh-tool-subagent` rows in the preset's tavern group, bound
 * to `tavern:<name>`. Registration is
 * idempotent so multiple standing preset mounts in one process share one
 * provider per name instead of throwing `DUPLICATE_PROVIDER`.
 */
export function applySubagents(ctx: Context, options: TavernSubagentOptions | undefined): void {
  if (options?.enabled !== true) return
  ctx.inject(['subagents'], async (subCtx: Context) => {
    const prefix = options.providerPrefix ?? 'tavern'

    const descriptors = await loadAgents()
    if (descriptors.length === 0) {
      subCtx.logger.warn('tavern-stages subagents enabled but no agents/*.md found; skipping provider registration')
      return
    }

    // Dynamic import: the subagent packages are optional peer deps. A host
    // that never sets `subagents.enabled` never reaches this line and does
    // not need them installed. If `enabled: true` was set but the host
    // failed to install them, degrade to a warn instead of letting the
    // inject callback reject — the plugin's base stage/skill/forge features
    // keep working.
    let startInProcessRun: typeof import('@deepseek-ai/dsh-subagent-in-process-driver')['startInProcessRun']
    try {
      ({ startInProcessRun } = await import('@deepseek-ai/dsh-subagent-in-process-driver'))
    } catch (error) {
      subCtx.logger.warn(
        'tavern-stages subagents enabled but the optional subagent packages are not installed; '
        + `skipping provider registration: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    for (const descriptor of descriptors) {
      const providerName = `${prefix}:${descriptor.name}`
      // Idempotent registration: standing preset mounts re-run this module
      // once per preset id (and again after a preset-file edit starts a new
      // generation), but the `subagents` registry is a process singleton and
      // `registerProvider` is process-lifetime — a reused name must be
      // shared, not re-registered.
      if (subCtx.subagents.getProvider(providerName) !== undefined) {
        subCtx.logger.info(
          `tavern-stages subagent provider "${providerName}" already registered; sharing it across preset mounts`,
        )
        continue
      }
      const provider = new TavernAgentProvider(
        providerName,
        descriptor.body,
        { startInProcessRun, ctx: subCtx },
      )
      try {
        subCtx.subagents.registerProvider(provider)
      } catch (error) {
        // A racing sibling mount may have registered the same name between
        // the check and the register; the provider is equivalent (same
        // packaged body), so share it.
        if (error instanceof Error && (error as { code?: string }).code === 'DUPLICATE_PROVIDER') {
          subCtx.logger.warn(
            `tavern-stages subagent provider "${providerName}" registered by a racing mount; sharing it`,
          )
          continue
        }
        throw error
      }
    }
  })
}
