import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import apply, {
  TAVERN_FORGE,
  TAVERN_CARDS_PACKED,
  packProjectFromArgs,
  type TavernCardsPackedPayload,
  type TavernCardsConfig,
} from '../src/index.ts'

const FAKE_FORGE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-forge.mjs')

function fakeAgent(ctx: Context, cwd = process.cwd()): Agent {
  const session = Session.create(SessionId('forge-agent'), undefined, {
    cwd,
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: SessionId('forge-agent'),
    createdAt: Date.now(),
  })
  const scope = ctx.plugin(() => {})
  return {
    id: SessionId('forge-agent'),
    session,
    options: {},
    ctx: scope.ctx,
    status: 'idle' as const,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
}

async function withForgeRuntime(withCommands = false): Promise<Context> {
  const ctx = new Context()
  // ToolRuntime.inject = ['systemPrompt'] — required before tools attaches.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (withCommands) await ctx.plugin(CommandRuntime)
  await ctx.plugin(apply, {} as TavernCardsConfig)
  return ctx
}

describe('packProjectFromArgs', () => {
  it('returns the first non-flag token', () => {
    expect(packProjectFromArgs(['Demo'])).toBe('Demo')
    expect(packProjectFromArgs(['--output', 'out.png', 'Demo'])).toBe('Demo')
    expect(packProjectFromArgs(['Demo', '--output', 'out.png'])).toBe('Demo')
    expect(packProjectFromArgs(['--out=out.png', 'Demo'])).toBe('Demo')
    expect(packProjectFromArgs(['--force'])).toBeUndefined()
  })
})

describe('tavern_forge tool', () => {
  const previousCli = process.env.TAVERN_CARDS_FORGE_CLI

  beforeEach(() => {
    process.env.TAVERN_CARDS_FORGE_CLI = FAKE_FORGE
  })

  afterEach(() => {
    if (previousCli === undefined) delete process.env.TAVERN_CARDS_FORGE_CLI
    else process.env.TAVERN_CARDS_FORGE_CLI = previousCli
  })

  it('registers tavern_forge and does not register tavern_pack', async () => {
    const ctx = await withForgeRuntime()

    expect(ctx.tools.get(TAVERN_FORGE)).toBeDefined()
    expect(ctx.tools.get('tavern_pack')).toBeUndefined()

    await ctx.fiber.dispose()
  })

  it('emits tavern-cards/packed after a successful pack tool call', async () => {
    const ctx = await withForgeRuntime()
    const agent = fakeAgent(ctx)

    const packed: TavernCardsPackedPayload[] = []
    ctx.on(TAVERN_CARDS_PACKED, (payload) => { packed.push(payload) })

    const result = await ctx.tools.execute({
      callId: ToolCallId('call-pack'),
      name: TAVERN_FORGE,
      arguments: { command: 'pack', args: ['Demo'] },
      signal: new AbortController().signal,
      agent,
    })

    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(packed).toHaveLength(1)
    expect(packed[0]).toMatchObject({
      project: 'Demo',
      cwd: process.cwd(),
      via: 'tool',
    })

    await ctx.fiber.dispose()
  })

  it('does not emit packed for non-pack commands', async () => {
    const ctx = await withForgeRuntime()
    const agent = fakeAgent(ctx)

    const packed: TavernCardsPackedPayload[] = []
    ctx.on(TAVERN_CARDS_PACKED, (payload) => { packed.push(payload) })

    const result = await ctx.tools.execute({
      callId: ToolCallId('call-init'),
      name: TAVERN_FORGE,
      arguments: { command: 'init', args: ['Demo'] },
      signal: new AbortController().signal,
      agent,
    })

    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(packed).toHaveLength(0)

    await ctx.fiber.dispose()
  })

  it('emits packed from /tavern-pack slash success', async () => {
    const ctx = await withForgeRuntime(true)
    const agent = fakeAgent(ctx)

    const packed: TavernCardsPackedPayload[] = []
    ctx.on(TAVERN_CARDS_PACKED, (payload) => { packed.push(payload) })

    const result = await ctx.commands.execute(
      agent,
      '/tavern-pack Demo',
      [],
      new AbortController().signal,
    )
    expect(result?.result, JSON.stringify(result?.result)).toMatchObject({ kind: 'success' })
    expect(packed).toHaveLength(1)
    expect(packed[0]).toMatchObject({
      project: 'Demo',
      via: 'command',
    })

    await ctx.fiber.dispose()
  })
})
