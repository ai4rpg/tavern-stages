/**
 * Tavern-cards agent content loader.
 *
 * Loads the four agent personas of the `@ai4rpg/tavern-agents` content
 * package (check / conversion / schema / first-message) and exposes them to
 * the preset generator: {@link loadTavernAgents} returns one
 * {@link TavernAgentDescriptor} (name, frontmatter description, body) per
 * persona from the single directory the personas ship in.
 *
 * **The plugin registers no subagent provider and mounts no delegation tool.**
 * dsh 0.2.1 owns delegation: the tavern preset declares one
 * `@deepseek-ai/dsh-tool-subagent` row per agent bound to the official `spawn`
 * provider (`provider: spawn`) with `agentPreset: tavern-child-<name>`, plus a
 * child preset per agent whose `persona` prefix is the body below. The child
 * therefore runs as an independent composition — persona and tool set from its
 * preset — and the tool returns an activation id while the final answer
 * arrives as the parent's completion notification. Identity is preset
 * composition, not a provider hook: a 0.2.1 local provider contributes only
 * the creation input, with no seam to prepend text to a child's first prompt.
 *
 * **`{{` is load-bearing.** A body becomes a persona `prefix`, which dsh
 * interpolates strictly, so an agent body must not contain template macros.
 * The `@ai4rpg/tavern-agents` validator enforces that on the content side.
 *
 * Resolution: the personas are CC BY-NC-SA content and live in the dedicated
 * content package `@ai4rpg/tavern-agents`. This package publishes to npm, so
 * the content package is deliberately NOT its dependency (a published manifest
 * must not carry file: specs): the tavern content repo's preset package
 * depends on it instead (`file:../tavern-agents`, inside that self-contained
 * repo), pnpm hoists it into the profile's node_modules, and createRequire
 * finds it from here — the same hoisted graph the forge CLI
 * (`resolveForgeCli` in `src/forge.ts`) rides, as a direct dependency of
 * this package. `TAVERN_AGENTS_ROOT` overrides the resolved directory;
 * tests inject fixture agents through it. An unresolvable package or an
 * unreadable directory yields `[]` instead of throwing: the caller (the preset
 * generator) then declares no delegation rows.
 *
 * @module @ai4rpg/dsh-tavern-stages/subagents
 */

import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** One loaded agent persona. Exported because it is the return shape of
 * {@link loadTavernAgents}, which deployments (the tavern preset generator in
 * particular) consume to declare one `tool-subagent` row and one child preset
 * per agent. */
export interface TavernAgentDescriptor {
  /** Tool and file stem, e.g. `check-agent`. */
  readonly name: string
  /** Frontmatter description. The preset generator copies it into the child
   * preset's roster description — `dsh-tool-subagent` has no per-row
   * description, so this text never reaches a tool description. */
  readonly description: string
  /** Body below the frontmatter; becomes the child preset's `persona.prefix`. */
  readonly body: string
}

/**
 * The personas are CC BY-NC-SA content and live in the dedicated content
 * package `@ai4rpg/tavern-agents`. This package publishes to npm, so the
 * content package is deliberately NOT its dependency (a published manifest
 * must not carry file: specs): the tavern content repo's preset package
 * depends on it instead (`file:../tavern-agents`, inside that self-contained
 * repo), pnpm hoists it into the profile's node_modules, and createRequire
 * finds it from here. `TAVERN_AGENTS_ROOT` overrides the resolved directory;
 * tests inject fixture agents through it. Undefined when the package cannot
 * be resolved: the caller degrades to the no-agents path instead of failing.
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
 * tests and the preset generator; the plugin itself registers nothing from
 * this list. */
export async function loadTavernAgents(): Promise<readonly TavernAgentDescriptor[]> {
  return loadAgents()
}
