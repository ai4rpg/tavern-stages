// Shared test infrastructure for the Loader-composition spec: a real
// cordis.yml composed through the Loader, with the same MemoryFs + Agent
// fixtures the assertions read. Split out of the spec so a second composition
// suite can import the same fixtures instead of forking them.
//
// The spec that imports this:
//   - tests/loader-composition.spec.ts — general Loader composition (plugin
//     load, stage eligibility, ui-complete)
//
// Helpers split out:
//   MemoryFs      — an in-memory dsh-fs FileSystem the composition writes to.
//   makeAgent     — a minimal Agent wired to a fresh session on the context.
//   preStep       — drives the agent/pre-step waterfall (stage-switch flush etc).
//   assembleFor   — thin wrapper around ctx.systemPrompt.assemble for the agent.

import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'

// Re-export the per-test root/context so each spec can clean up in afterEach
// without threading a shared module-level singleton through the composition
// loaders. Each spec owns its own `let root` / `let context`.
export { rm, mkdtemp, tmpdir, join }

export class MemoryFs extends FileSystem {
  readonly files = new Map<string, string>()

  async resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget> {
    const absolute = path.startsWith('/') ? path : join(opts?.cwd ?? '/', path)
    return { targetKey: FsTargetKey(`key:${absolute}`), displayPath: absolute }
  }

  processPath(target: FsTarget): string {
    return target.displayPath
  }

  fileUrl(target: FsTarget): string {
    return `file://${target.displayPath}`
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    return child.displayPath.startsWith(parent.displayPath)
  }

  async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const content = this.files.get(target.displayPath)
    if (content === undefined) return undefined
    return { version: FsVersion('v1'), type: 'file', size: content.length }
  }

  async lstat(): Promise<undefined> {
    return undefined
  }

  async readText(target: FsTarget): Promise<string> {
    const content = this.files.get(target.displayPath)
    if (content === undefined) throw new Error(`no such file: ${target.displayPath}`)
    return content
  }

  async streamText(): Promise<AsyncIterable<string>> {
    return (async function* () {})()
  }

  async readBytes(): Promise<Uint8Array> {
    return new Uint8Array()
  }

  async readByteRange(target: FsTarget, range: { offset: number; length: number }): Promise<Uint8Array> {
    const content = this.files.get(target.displayPath)
    if (content === undefined) throw new Error(`no such file: ${target.displayPath}`)
    return new TextEncoder().encode(content).subarray(range.offset, range.offset + range.length)
  }

  async listDir(): Promise<[]> {
    return []
  }

  async writeText(
    target: FsTarget,
    content: string,
    _expected?: FsWriteIntent,
  ): Promise<FsWriteOutcome> {
    this.files.set(target.displayPath, content)
    return {
      operation: 'create',
      version: FsVersion('v1'),
      before: null,
      after: content,
    }
  }

  async editText(): Promise<never> {
    throw new Error('editText is not used in this test')
  }
}

export function makeAgent(ctx: Context, id: string, cwd: string): Agent {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
  const scope = ctx.plugin(() => {})
  const value: Agent = {
    id: SessionId(id),
    options: {},
    session,
    inbox: {
      nextTurn: [],
      nextStep: [],
      splice() {},
      claimed() {},
    } as never,
    ctx: scope.ctx,
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

export async function preStep(ctx: Context, agent: Agent): Promise<void> {
  const events = agentEvents(ctx, agent)
  await events.waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

export async function assembleFor(ctx: Context, agent: Agent) {
  return ctx.systemPrompt.assemble({ agent, scope: agent })
}
