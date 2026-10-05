// Named-subagent inheritance: the child inherits the host prompt, the
// provider only prepends the body.
//
// Both share the same keyless harness: a declared fixture preset carrying a
// `complete: true` minimal persona (mimicking anchored-standard; declared
// inline by tests/helpers/preset-fixtures.ts), a MockAdapter that records the
// model-visible request, and the standard in-process spawn provider.
//
// The tavern-stages named providers are thin body-prepending shells
// (body prepending only): child route and reasoning-effort overrides are NATIVE
// since dsh 0.1.5 — `AgentOptions` carries `reasoningEffort`, the official
// `dsh-tool-subagent` row forwards its configured `agentOptions` through
// `request.agentOptions`, and the in-process driver resolves them via
// `resolveChildAgentOptions` into `agents.create` (the agent loop reads
// `options.reasoningEffort` at request composition). No `installModelSelection`
// injection is involved anywhere.
//
// Point 1 asserts that native path: a request carrying
// `agentOptions.reasoningEffort` produces a child request with that effort.
// Point 2 asserts the child's assembled system prompt is exactly the one
// inherited complete persona section (persona left undefined).

import { afterEach, describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { snapshotSubagentDescriptor, type SubagentRun } from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { MockAdapter, textResponse, reasoningSupport } from './helpers/mock-adapter.ts'
import { ANCHORED_PERSONA, declareAnchoredPreset, mountPresetRoster } from './helpers/preset-fixtures.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

/** A host carrying the preset roster. */
async function setupHost(): Promise<{ ctx: Context; adapter: MockAdapter; parent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountPresetRoster(ctx, 'anchored')
  await declareAnchoredPreset(ctx)

  const adapter = new MockAdapter(
    [textResponse('child done')],
    reasoningSupport('high'),
  )
  ctx.llm.registerAdapter(['mock'], adapter)

  const handle = await ctx.agents.create({
    sessionId: SessionId('parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'anchored'),
  })

  return { ctx, adapter, parent: handle.agent }
}

function spawnRequest(parent: Agent, agentOptions?: Record<string, unknown>): Parameters<typeof startInProcessRun>[0] {
  return {
    label: 'child task',
    prompt: [{ type: 'text' as const, text: 'child task' }],
    parent,
    signal: new AbortController().signal,
    descriptor: snapshotSubagentDescriptor({
      mode: 'one-shot' as const,
      provider: 'spawn',
      label: 'child task',
    }),
    // `request.agentOptions` is what the official tool-subagent row forwards
    // after merging its configured `agentOptions` (dsh 0.1.5).
    ...agentOptions !== undefined ? { agentOptions } : {},
  } as unknown as Parameters<typeof startInProcessRun>[0]
}

describe('verification point 1: agentOptions.reasoningEffort flows through the driver natively', () => {
  it('the child request carries the requested reasoningEffort without installModelSelection', async () => {
    const { adapter, parent } = await setupHost()

    const run: SubagentRun = await startInProcessRun(
      spawnRequest(parent, { reasoningEffort: ReasoningEffortId('high') }),
      {},
    )
    try {
      const result = await run.result
      expect(result.stopReason).toBe('completed')

      // adapter.requests holds every GenerateOptions the adapter received.
      // The parent never runs a turn; this is the child's single request.
      const childRequest = adapter.requests.at(-1)
      expect(childRequest?.reasoningEffort).toBe('high')
    } finally {
      await run.dispose()
    }
  })
})

describe('verification point 2: persona undefined inherits the complete minimal persona', () => {
  it('the child system prompt is exactly the one inherited complete persona section', async () => {
    const { ctx, parent } = await setupHost()

    const run = await startInProcessRun(spawnRequest(parent), {})
    try {
      await run.result

      const child = run.localAgent
      expect(child).toBeDefined()
      const assembly = await ctx.systemPrompt.assemble({ agent: child!, scope: child! })
      // complete:true drops every other section — only the inherited persona survives.
      expect(assembly.sections).toHaveLength(1)
      // dsh 0.1.5 renamed the section: persona text is now the `prefix` slot.
      expect(assembly.sections[0]!.name).toBe('deployment:persona-prefix')
      expect(assembly.sections[0]!.text).toContain(ANCHORED_PERSONA)
    } finally {
      await run.dispose()
    }
  })

  it('a non-empty persona shadows the inherited complete persona (negative control)', async () => {
    const { ctx, parent } = await setupHost()

    // A child with an explicit persona installs a NON-complete
    // `deployment:persona-prefix` section that shadows the inherited complete one.
    const request = {
      ...spawnRequest(parent),
      persona: 'You are a specialized conversion agent.',
    }
    const run = await startInProcessRun(request, {})
    try {
      await run.result

      const child = run.localAgent
      expect(child).toBeDefined()
      const assembly = await ctx.systemPrompt.assemble({ agent: child!, scope: child! })
      // The complete flag is dropped: the scoped section wins by name, but it
      // is not complete, so other inherited sections survive alongside it.
      expect(assembly.sections.some(section => section.text.includes('specialized conversion agent'))).toBe(true)
      expect(assembly.sections.some(section => section.text.includes(ANCHORED_PERSONA))).toBe(false)
    } finally {
      await run.dispose()
    }
  })
})
