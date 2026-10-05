import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import UserQuestionService, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import StageController, { GOTO_STAGE, foldStage } from '@ai4rpg/dsh-stage-switch'
import { isAbsolute, join } from 'node:path'
import apply, { createTavernCardsStageConfig, tavernCardsSection } from '../src/index.ts'

/** Substantial design spec (passes the Phase 3 shell heuristic). */
const DESIGN_SPEC = `# Design Spec — Demo

## 项目定位
- 项目名称：Demo
- 形式：角色卡
- 主题：都市奇幻冒险，主角在现代城市中逐步发现隐藏的超常层面
- 体验目标：自由冒险与探索感，玩家通过选择推动剧情分支

## 世界观概念
半架空现代都市：表层是普通都市生活，里层存在由记忆凝聚成的异常空间。
`

class MemoryFs extends FileSystem {
  readonly files = new Map<string, string>()
  readonly writes: Array<{ path: string; content: string }> = []

  async resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget> {
    const absolute = isAbsolute(path) ? path : join(opts?.cwd ?? '/', path)
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
    const before = this.files.get(target.displayPath) ?? null
    this.files.set(target.displayPath, content)
    this.writes.push({ path: target.displayPath, content })
    return {
      operation: before === null ? 'create' : 'update',
      version: FsVersion('v1'),
      before,
      after: content,
    }
  }

  async editText(): Promise<never> {
    throw new Error('editText is not used in this test')
  }
}

async function agentWithSession(ctx: Context, id = 'agent-1', cwd = '/workspace'): Promise<Agent & { session: Session }> {
  const base = Session.create(SessionId(id))
  const session = cwd === undefined
    ? base
    : Session.create(SessionId(id), undefined, { ...base.header, cwd })
  const agent = {
    id: SessionId(id),
    session,
    options: {},
  } as unknown as Agent & { session: Session }
  let scoped!: Context
  await ctx.plugin(Object.assign((inner: Context) => { scoped = createScope(inner, agent).ctx }, {
    inject: ['tools'],
  }))
  ;(agent as { ctx?: Context }).ctx = scoped
  const agents = ctx.get('agents')
  if (agents === undefined) {
    ctx.emit('agent/created', { agent, source: 'startup' })
  } else {
    agents.enter(agent, undefined)
    await agents.announce(agent, 'startup')
  }
  return agent
}

async function preStep(ctx: Context, agent: Agent): Promise<void> {
  const events = agentEvents(ctx, agent)
  await events.waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

async function assembleFor(ctx: Context, agent: Agent) {
  return ctx.systemPrompt.assemble({ agent, scope: agent })
}

function openTurn(session: Session, turn = 0): void {
  session.append('turn/start', { turn })
}

let callCounter = 0
function callGoto(ctx: Context, agent: Agent, args: Record<string, unknown>) {
  return ctx.tools.execute({
    callId: ToolCallId(`call-${++callCounter}`),
    name: GOTO_STAGE,
    arguments: args,
    signal: new AbortController().signal,
    agent,
  })
}

const PLANNING = `
project:
  name: Demo
  form: charactercard
  mvu: false
  ui_mode: none
entries:
  - name: 世界设定
    type: 世界观
    path: 世界书/世界观/世界设定.yaml
first_messages:
  - output_path: 开场白/0.txt
`

const STATE = JSON.stringify({
  projectName: 'Demo',
  form: 'charactercard',
  mvu: false,
  entryManifest: {
    世界观: {
      世界设定: {
        abstract: 'x',
        path: '世界书/世界观/世界设定.yaml',
        strategy: { type: 'constant' },
        position: { type: 'before_character_definition', order: 1 },
      },
    },
  },
  first_messages: ['开场白/0.txt'],
})

async function setupWithReview(
  options: { selected?: string[]; custom?: string; initial?: string; full?: boolean } = {},
): Promise<{ ctx: Context; agent: Agent & { session: Session }; asked: AskUserQuestionRequest[] }> {
  const { selected = ['Approve'], custom, initial } = options
  const answer = { selected, custom }
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  // dsh 0.1.5: token-meter injects the mandatory session-projection seam.
  await ctx.plugin(SessionProjection)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(MemoryFs)
  const fs = ctx.get('fs') as MemoryFs
  const files: Record<string, string> = {
    '.cardrc.json': JSON.stringify({ projects: { Demo: { state_file: 'cards/Demo/tavern-cards-state.json', artifact: 'cards/Demo/Demo.png' } } }),
    'cards/Demo/design-spec.md': DESIGN_SPEC,
    'cards/Demo/创作规划.yaml': PLANNING,
    'cards/Demo/tavern-cards-state.json': STATE,
    'cards/Demo/世界书/世界观/世界设定.yaml': '正文',
    'cards/Demo/开场白/0.txt': '开场白',
  }
  for (const [path, content] of Object.entries(files)) {
    const target = await fs.resolve(path, { cwd: '/workspace' })
    fs.files.set(target.displayPath, content)
  }
  const asked: AskUserQuestionRequest[] = []
  // dsh 0.1.5 answerer seam: reviews are dispatched as a scoped waterfall
  // (`user-questions/request`) instead of a single registered provider, so the
  // test claims the request by returning an answer.
  ctx.on('user-questions/request', (request) => {
    asked.push(request)
    return Promise.resolve({ answers: [{ id: 'stage-review', ...answer }] })
  })
  // `full` defaults to true: the handoff/archive scenarios pin the threshold
  // to 0 (always full — the behavior the preset had before minHandoffTokens
  // existed). full:false uses the preset default so a fresh session takes
  // the light path (see the dedicated test).
  await ctx.plugin(StageController, createTavernCardsStageConfig({
    ...initial === undefined ? {} : { initial },
    minHandoffTokens: options.full === false ? undefined : 0,
  }))
  await ctx.plugin(apply)
  const agent = await agentWithSession(ctx, 'agent-1', '/workspace')
  return { ctx, agent, asked }
}

describe('Phase 3 integration: stage-switch + tavern-stages', () => {
  it('shows guidance when design is complete and runs an approved goto_stage switch', async () => {
    // route owns no artifact, so it can never complete and never renders
    // the stage-policy context; this scenario lands the session in design
    // (whose artifacts are all present in the fixture) by pinning `initial`
    // through the factory option. Completion eligibility is strictly
    // observation-driven, so one fs/observed event on the project's
    // design-spec gives the focus tracker its project; the composite
    // eligibility predicate then flips design-complete on the next pre-step
    // and renders guidance.
    const { ctx, agent, asked } = await setupWithReview({ initial: 'design' })
    const target = await (ctx.get('fs') as MemoryFs).resolve('cards/Demo/design-spec.md', { cwd: '/workspace' })
    ctx.emit('fs/observed', target, { kind: 'present', version: FsVersion('v1') }, { agent, name: 'read', arguments: {} })

    // The plugin refreshes before request assembly; design is complete.
    await preStep(ctx, agent)
    const assembly = await assembleFor(ctx, agent)
    const policy = assembly.contexts.find(context => context.name === 'stage:policy')
    expect(policy?.text).toBe(tavernCardsSection)

    // A full transition writes the handoff, reviews, and waits for boundary.
    openTurn(agent.session)
    const handoff = '# Planning handoff\n\n- design complete'
    const result = await callGoto(ctx, agent, { stage: 'planning', handoff })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected approved transition')
    expect(result.value).toMatchObject({ approved: true, stage: 'planning' })

    const fs = ctx.get('fs') as MemoryFs
    expect(fs.writes).toEqual([{ path: '/workspace/handoff/agent-1/planning.md', content: handoff }])
    expect(asked).toHaveLength(1)
    expect(asked[0]?.questions[0]?.options?.map(option => option.label)).toEqual(['Approve', 'Keep current stage'])

    // The switch is boundary-applied.
    expect(foldStage(agent.session.snapshotEvents())).toBeUndefined()
    await preStep(ctx, agent)
    expect(foldStage(agent.session.snapshotEvents())).toBe('planning')
  })

  it('stays in the current stage when the user rejects the review', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Keep current stage'], custom: 'revise the handoff' })
    openTurn(agent.session)
    const result = await callGoto(ctx, agent, { stage: 'planning', handoff: '# Planning handoff' })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; their feedback: revise the handoff' }])
    expect(foldStage(agent.session.snapshotEvents())).toBeUndefined()
  })

  it('stays in the current stage when the review is dismissed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(MemoryFs)
    const fs = ctx.get('fs') as MemoryFs
    for (const [path, content] of Object.entries({
      '.cardrc.json': JSON.stringify({ projects: { Demo: { state_file: 'cards/Demo/tavern-cards-state.json', artifact: 'cards/Demo/Demo.png' } } }),
      'cards/Demo/design-spec.md': DESIGN_SPEC,
      'cards/Demo/创作规划.yaml': PLANNING,
      'cards/Demo/tavern-cards-state.json': STATE,
      'cards/Demo/世界书/世界观/世界设定.yaml': '正文',
      'cards/Demo/开场白/0.txt': '开场白',
    })) {
      const target = await fs.resolve(path, { cwd: '/workspace' })
      fs.files.set(target.displayPath, content)
    }
    ctx.on('user-questions/request', () =>
      Promise.reject(new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')))
    await ctx.plugin(SessionProjection)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(StageController, createTavernCardsStageConfig({ minHandoffTokens: 0 }))
    await ctx.plugin(apply)
    const agent = await agentWithSession(ctx, 'agent-cancel', '/workspace')
    openTurn(agent.session)
    const result = await callGoto(ctx, agent, { stage: 'planning', handoff: '# Planning handoff' })
    expect(result.isError).toBe(true)
    // The stage-switch plugin maps ASK_CANCELLED to a named user-takeover failure.
    expect(result.content?.some(block => block.type === 'text' && block.text.includes('dismissed'))).toBe(true)
    expect(foldStage(agent.session.snapshotEvents())).toBeUndefined()
  })

  it('switches lightly on a fresh session with the default threshold (no handoff, no archive)', async () => {
    // The preset's default minHandoffTokens (10000) keeps a
    // session-start route→design jump on the light path — no handoff
    // document required, nothing archived, only the review and stage prompt.
    const { ctx, agent, asked } = await setupWithReview({ initial: 'route', full: false })

    openTurn(agent.session)
    // No handoff argument at all — a light transition must accept that.
    const result = await callGoto(ctx, agent, { stage: 'design' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected light transition to succeed')

    // The light review asks a plain approve question with no handoff detail.
    expect(asked).toHaveLength(1)
    expect(asked[0]?.questions[0]?.detail).toBeUndefined()
    // No handoff document was written.
    const fs = ctx.get('fs') as MemoryFs
    expect(fs.writes).toEqual([])

    // The switch is boundary-applied like a full one.
    expect(foldStage(agent.session.snapshotEvents())).toBeUndefined()
    await preStep(ctx, agent)
    expect(foldStage(agent.session.snapshotEvents())).toBe('design')
  })
})
