// Product-layer tests for the tavern-stages subagent provider.
//
// The provider exists solely to prepend the agent body to the child's first
// prompt — never as a `persona` section, which would override the host's
// complete minimal persona and leak runtime contexts. Child route / reasoning-effort /
// maxTokens overrides are NATIVE since dsh 0.1.5 — `reasoningEffort` is in
// `AgentOptions`, and the in-process driver resolves `request.agentOptions`
// via `resolveChildAgentOptions` into `agents.create`, so a tool-subagent
// row's `agentOptions` reaches the child's requests without any plugin-side
// injection. `subagent-inheritance.spec.ts` verifies the same native driver
// mechanism at the driver level; these tests exercise the actual
// `TavernAgentProvider` end-to-end.
//
// Reuses the same keyless harness shape as the inheritance tests: a fixture
// preset with a `complete: true` minimal persona, a MockAdapter recording the
// child request, and direct `provider.start()` invocation.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SubagentRuntime, { snapshotSubagentDescriptor, type SubagentRun } from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { MockAdapter, textResponse, reasoningSupport } from './helpers/mock-adapter.ts'
import { declareAnchoredPreset, mountPresetRoster } from './helpers/preset-fixtures.ts'
import { applySubagents, TavernAgentProvider, loadTavernAgents } from '../src/subagents.ts'
import { tavernPrompts } from '../src/prompts.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

// The real `@ai4rpg/tavern-agents` content package is deliberately absent
// from this repo's manifest (a published manifest must not carry `file:`
// specs), so a fresh clone resolves nothing and the real-package smoke
// test skips. Re-enable it locally with
// `npm i --no-save <tavern-content>/tavern-agents`.
const tavernAgentsResolvable = (() => {
  try {
    createRequire(import.meta.url).resolve('@ai4rpg/tavern-agents/package.json')
    return true
  } catch {
    return false
  }
})()
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

// A preset-scope hook runs inside `agents.create`'s setup callback on the
// context the fixture preset is mounted into, so anything it registers lands
// in the same scope the parent agent sees.
type SetupOptions = {
  /** Compose the real `SkillRegistry`; `false` for the missing-service path. */
  readonly skills?: boolean
  readonly hook?: (agentCtx: Context) => void | Promise<void>
}

async function setupHost(options?: SetupOptions): Promise<{ ctx: Context; adapter: MockAdapter; parent: Agent }> {
  const { skills = true, hook } = options ?? {}
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // The real skill registry: the tavern preset ships its three skill bodies
  // via a `skill-filesystem` row, so the provider's lookup must resolve them
  // through the layered registry rather than a hardcoded path.
  if (skills) await ctx.plugin(SkillRegistry)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountPresetRoster(ctx, 'anchored')
  await declareAnchoredPreset(ctx)

  const adapter = new MockAdapter([textResponse('child done')], reasoningSupport('high'))
  ctx.llm.registerAdapter(['mock'], adapter)

  const handle = await ctx.agents.create({
    sessionId: SessionId('parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => {
      await ctx.agentPresets.mount(agentCtx, 'anchored')
      if (hook !== undefined) await hook(agentCtx)
    },
  })

  return { ctx, adapter, parent: handle.agent }
}

function startRequest(parent: Agent, agentOptions?: Record<string, unknown>) {
  return {
    label: 'check task',
    prompt: [{ type: 'text' as const, text: 'review these entries' }],
    parent,
    signal: new AbortController().signal,
    descriptor: snapshotSubagentDescriptor({
      mode: 'one-shot' as const,
      provider: 'tavern:check-agent',
      label: 'check task',
    }),
    // `request.agentOptions` is exactly what the official tool-subagent row
    // forwards after merging its configured `agentOptions` (dsh 0.1.5).
    ...agentOptions !== undefined ? { agentOptions } : {},
  } as unknown as Parameters<TavernAgentProvider['start']>[0]
}

/** The child request's first user message, text blocks joined. */
function firstUserText(adapter: MockAdapter): string {
  const messages = adapter.requests.at(-1)!.messages
  const firstUser = messages.find(message => message.role === 'user')
  return firstUser!.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

describe('TavernAgentProvider', () => {
  it('prepends the agent body to the child prompt so the model sees the persona instructions', async () => {
    // No `skills` service at all — a host that never composed one. The spawn
    // must still work, with the body shipped verbatim.
    const { ctx, adapter, parent } = await setupHost({ skills: false })
    const provider = new TavernAgentProvider(
      'tavern:check-agent',
      '# check-agent\n\nYou are the reviewer.',
      { startInProcessRun, ctx },
    )

    const run: SubagentRun = await provider.start(startRequest(parent))
    try {
      await run.result

      const childRequest = adapter.requests.at(-1)
      expect(childRequest).toBeDefined()
      // The first user message should contain the body text, followed by the
      // caller's prompt. Both blocks land in the same user message.
      const text = firstUserText(adapter)
      expect(text).toContain('You are the reviewer.')
      expect(text).toContain('review these entries')
      // This host composes no `skills` service, so the lookup must degrade to
      // the body verbatim instead of failing the spawn.
      expect(text).not.toContain(tavernPrompts.subagentSkillDirs.heading)
    } finally {
      await run.dispose()
    }
  })

  it('leaves the body verbatim when no referenced tavern skill resolves to a directory', async () => {
    // The registry is composed but carries no tavern skill — a host-plane
    // mount, or a preset that ships no `skills/` directory. The block must not
    // appear at all rather than listing a partial or empty path set.
    const { ctx, adapter, parent } = await setupHost({ hook: (agentCtx) => {
      const registry = agentCtx.get('skills')
      if (registry === undefined) throw new Error('skills service not composed')
      registry.register({
        name: 'worldbuilding-notes',
        description: 'not a tavern skill',
        source: 'custom',
        content: '# worldbuilding-notes',
        resourceBase: { kind: 'directory' as const, path: '/skills/worldbuilding-notes/' },
      })
    }})

    const body = '# check-agent\n\n路径相对于 tavern-cards skill 目录'
    const provider = new TavernAgentProvider(
      'tavern:check-agent',
      body,
      { startInProcessRun, ctx },
    )

    const run = await provider.start(startRequest(parent))
    try {
      await run.result
      const text = firstUserText(adapter)
      expect(text).toContain(body)
      expect(text).not.toContain(tavernPrompts.subagentSkillDirs.heading)
      expect(text).not.toContain('worldbuilding-notes')
    } finally {
      await run.dispose()
    }
  })

  it('resolves tavern skills through the real layered registry', async () => {
    // Registers the skills the way the tavern preset does — from the context
    // the preset is mounted into, so the lookup goes through the real
    // `SkillRegistry` instead of a stub. `list({ scope: parent })` is what the
    // provider asks: reads always merge the global layer, and a scoped read
    // additionally walks the viewing agent's scope chain.
    const cardsDir = '/profile/node_modules/@ai4rpg/dsh-tavern-preset/skills/tavern-cards/'
    const designDir = '/profile/node_modules/@ai4rpg/dsh-tavern-preset/skills/tavern-design/'
    const { ctx, adapter, parent } = await setupHost({ hook: (agentCtx) => {
      const registry = agentCtx.get('skills')
      if (registry === undefined) throw new Error('skills service not composed')
      registry.register({
        name: 'tavern-cards',
        description: 'tavern-cards skill body',
        source: 'custom',
        content: '# tavern-cards',
        resourceBase: { kind: 'directory' as const, path: cardsDir },
      })
      registry.register({
        name: 'tavern-design',
        description: 'tavern-design skill body',
        source: 'custom',
        content: '# tavern-design',
        resourceBase: { kind: 'directory' as const, path: designDir },
      })
      // A remote provider would expose a base with no readable path; that
      // skill gets no line and keeps using the `skill` tool.
      registry.register({
        name: 'tavern-ui',
        description: 'tavern-ui skill body',
        source: 'custom',
        content: '# tavern-ui',
        resourceBase: { kind: 'opaque' as const, description: 'no local path' },
      })
    }})

    // Sanity: the scoped read must see all three, which is what the provider asks.
    const listed = await ctx.get('skills')!.list({ cwd: parent.session.header.cwd, scope: parent })
    expect(listed.map(skill => skill.name).sort()).toEqual(['tavern-cards', 'tavern-design', 'tavern-ui'])

    // A compact synthetic body exercising all three outcome classes in one
    // spawn: `tavern-cards`/`tavern-design` resolve to directories (path
    // lines) while `tavern-ui` resolves to an opaque base (no line). The real
    // `agents/*.md` bodies reference exactly one skill each and never an
    // opaque one, so only a synthetic body can cover the exclusion here.
    const provider = new TavernAgentProvider(
      'tavern:check-agent',
      ['# check-agent', '',
       '读取 `references/rules-check.md`（路径相对于 tavern-cards skill 目录）；',
       '`tavern-design`、`tavern-ui` 的文档同样相对于各自 skill 目录。'].join('\n'),
      { startInProcessRun, ctx },
    )

    const run = await provider.start(startRequest(parent))
    try {
      await run.result
      const text = firstUserText(adapter)
      // Expected lines derived from the single prompt source, so the renderer
      // and the copy cannot drift from each other in the test either.
      const lineFor = (skill: string, dir: string) =>
        tavernPrompts.subagentSkillDirs.line.replaceAll('{skill}', skill).replaceAll('{dir}', dir)
      expect(text).toContain(lineFor('tavern-cards', cardsDir))
      expect(text).toContain(lineFor('tavern-design', designDir))
      // `tavern-ui` is referenced but its base is `opaque`, so no path line.
      expect(text).not.toContain(lineFor('tavern-ui', ''))
      // The body is prepended verbatim; the block follows it in one text block.
      expect(text.indexOf('# check-agent')).toBeLessThan(text.indexOf(tavernPrompts.subagentSkillDirs.heading))
      expect(text).toContain('review these entries')
    } finally {
      await run.dispose()
    }
  })

  it('passes the row agentOptions.reasoningEffort through to the child request natively', async () => {
    const { ctx, adapter, parent } = await setupHost()
    const provider = new TavernAgentProvider('tavern:check-agent', '# check-agent', { startInProcessRun, ctx })

    // What a preset row becomes after merging: `agentOptions: {
    // reasoningEffort: high }` → `request.agentOptions`. The driver resolves
    // it into agents.create and the agent loop applies options.reasoningEffort
    // — no installModelSelection injection anywhere.
    const run = await provider.start(startRequest(parent, { reasoningEffort: ReasoningEffortId('high') }))
    try {
      await run.result
      const childRequest = adapter.requests.at(-1)
      expect(childRequest?.reasoningEffort).toBe('high')
    } finally {
      await run.dispose()
    }
  })

  it('does not force an effort when the request carries no agentOptions (follows defaults)', async () => {
    const { ctx, adapter, parent } = await setupHost()
    const provider = new TavernAgentProvider('tavern:check-agent', '# check-agent', { startInProcessRun, ctx })

    const run = await provider.start(startRequest(parent))
    try {
      await run.result
      // The parent's options carry no effort, and the request adds none: the
      // child request must not be forced to `max` (models differ in which
      // effort values they accept; forcing one can error).
      const childRequest = adapter.requests.at(-1)
      expect(childRequest?.reasoningEffort).toBeUndefined()
    } finally {
      await run.dispose()
    }
  })

  it('leaves persona undefined so the child inherits the host complete minimal persona', async () => {
    const { ctx, parent } = await setupHost()
    const provider = new TavernAgentProvider('tavern:check-agent', '# check-agent', { startInProcessRun, ctx })

    const run = await provider.start(startRequest(parent))
    try {
      await run.result
      const child = run.localAgent
      expect(child).toBeDefined()
      const assembly = await ctx.systemPrompt.assemble({ agent: child!, scope: child! })
      // complete:true keeps exactly one section — the inherited minimal persona.
      expect(assembly.sections).toHaveLength(1)
      // dsh 0.1.5 renamed the section: persona text is now the `prefix` slot.
      expect(assembly.sections[0]!.name).toBe('deployment:persona-prefix')
      expect(assembly.sections[0]!.text).toContain('You are a helpful software engineer assistant.')
    } finally {
      await run.dispose()
    }
  })
})

describe('loadTavernAgents', () => {
  it.skipIf(!tavernAgentsResolvable)('loads the four personas from the resolved agents content package', async () => {
    const agents = await loadTavernAgents()
    const names = agents.map(agent => agent.name).sort()
    expect(names).toEqual(['check-agent', 'conversion-agent', 'first-message-agent', 'schema-agent'])
    for (const agent of agents) {
      expect(agent.description.length).toBeGreaterThan(0)
      expect(agent.body.length).toBeGreaterThan(0)
    }
  })
})

describe('agents content resolution', () => {
  // The personas live in the `@ai4rpg/tavern-agents` content package,
  // resolved from the profile graph: the preset package's `file:` dependency
  // puts it into the profile's node_modules. `TAVERN_AGENTS_ROOT` is the
  // injection seam: it replaces the resolution entirely, so a fixture
  // directory can drive the provider registration without the real package.
  it('honors TAVERN_AGENTS_ROOT and registers providers from the fixture directory', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SubagentRuntime)
    vi.stubEnv('TAVERN_AGENTS_ROOT', join(FIXTURES, 'agents'))
    try {
      applySubagents(ctx, { enabled: true })
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
        if (ctx.subagents.list().includes('tavern:fixture-agent')) break
      }
      expect(ctx.subagents.list()).toContain('tavern:fixture-agent')
      // The override replaces the resolution: the real package's providers
      // must not appear alongside the fixture's.
      expect(ctx.subagents.list()).not.toContain('tavern:check-agent')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('degrades to no providers when the agents directory cannot be read', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SubagentRuntime)
    vi.stubEnv('TAVERN_AGENTS_ROOT', join(FIXTURES, 'agents-missing'))
    try {
      applySubagents(ctx, { enabled: true })
      // Give the inject callback time to run: it must take the warn-and-
      // skip path, leaving the registry empty rather than throwing.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(ctx.subagents.list()).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('applySubagents idempotency', () => {
  it('shares one provider per name across repeated registrations instead of throwing DUPLICATE_PROVIDER', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    // A host-plane subagents registry: one instance shared by every mount,
    // whose provider registrations are process-lifetime. `ctx.plugin` supplies
    // the runtime's required `maxDepth` / `maxActiveSubagents` config defaults.
    await ctx.plugin(SubagentRuntime)

    // Fixture personas via TAVERN_AGENTS_ROOT: this repo carries no `file:`
    // devDependency for the content package, so the idempotency property is
    // driven by the fixture — a standing preset mount and a preset-file edit
    // each run applySubagents against the same registry.
    vi.stubEnv('TAVERN_AGENTS_ROOT', join(FIXTURES, 'agents'))
    try {
      applySubagents(ctx, { enabled: true })
      applySubagents(ctx, { enabled: true })

      const expected = ['tavern:fixture-agent']
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      if (expected.every(name => ctx.subagents.list().includes(name))) break
    }
      const list = ctx.subagents.list()
      for (const name of expected) {
        expect(list.filter(entry => entry === name), `${name} registered exactly once`).toHaveLength(1)
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
