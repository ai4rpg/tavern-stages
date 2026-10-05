import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/index.ts'
import type { TavernCardsConfig } from '../src/index.ts'

function fakeAgent(ctx: Context): Agent {
  const session = Session.create(SessionId('commands-agent'), undefined, {
    cwd: '/workspace',
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: SessionId('commands-agent'),
    createdAt: Date.now(),
  })
  const scope = ctx.plugin(() => {})
  const agent = {
    id: SessionId('commands-agent'),
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
  return agent
}

describe('forge commands', () => {
  it('registers /tavern-forge and /tavern-pack when dsh-commands is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(apply, {} as TavernCardsConfig)
    const agent = fakeAgent(ctx)

    const names = ctx.commands.list(agent).map(command => command.name)
    expect(names).toEqual(expect.arrayContaining(['tavern-forge', 'tavern-pack']))

    // rc.8 routes composer image attachments through slash commands, adding a
    // readonly `images` param before the abort signal: execute(agent, line,
    // images, signal). A plain invocation passes an empty array.
    const result = await ctx.commands.execute(agent, '/tavern-pack', [], new AbortController().signal)
    expect(result?.result).toEqual({
      kind: 'error',
      text: 'Usage: /tavern-pack <project>',
    })

    await ctx.fiber.dispose()
  })
})
