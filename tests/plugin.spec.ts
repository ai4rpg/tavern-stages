import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import StageController from '@ai4rpg/dsh-stage-switch'
import { isAbsolute, join } from 'node:path'
import apply, {
  TAVERN_CARDS_PACKED,
  TAVERN_UI_COMPLETE_SECTION,
  PackLedger,
  tavernCardsStageConfig,
  tavernCardsStages,
  TavernCardsStatus,
} from '../src/index.ts'
import type { TavernCardsConfig } from '../src/index.ts'
import { seedStage } from './helpers/seed-stage.ts'

/** In-memory filesystem backend for plugin tests. */
class MemoryFs extends FileSystem {
  readonly files = new Map<string, string>()

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

  async listDir(target: FsTarget): Promise<FsDirEntry[]> {
    const prefix = `${target.displayPath}/`
    const children = new Map<string, 'file' | 'directory'>()
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (rest === '') continue
      const slash = rest.indexOf('/')
      if (slash === -1) children.set(rest, 'file')
      else children.set(rest.slice(0, slash), 'directory')
    }
    return [...children].map(([name, type]) => ({
      name,
      type,
      target: { targetKey: FsTargetKey(`key:${prefix}${name}`), displayPath: `${prefix}${name}` },
    }))
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

async function setupMemory(files: Record<string, string>): Promise<{ ctx: Context; fs: MemoryFs }> {
  const ctx = new Context()
  await ctx.plugin(MemoryFs)
  const fs = ctx.get('fs') as MemoryFs
  for (const [path, content] of Object.entries(files)) {
    const target = await fs.resolve(path, { cwd: '/workspace' })
    fs.files.set(target.displayPath, content)
  }
  return { ctx, fs }
}

function fakeAgent(ctx: Context, cwd: string): Agent & { session: Session } {
  const session = Session.create(SessionId('agent-1'), undefined, {
    cwd,
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: SessionId('agent-1'),
    createdAt: Date.now(),
  })
  const agent = {
    id: SessionId('agent-1'),
    session,
    options: {},
  } as unknown as Agent & { session: Session }
  return agent
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

async function assembleFor(ctx: Context, agent: Agent) {
  return ctx.systemPrompt.assemble({ agent, scope: agent })
}

async function preStep(ctx: Context, agent: Agent & { session: Session }): Promise<void> {
  const events = agentEvents(ctx, agent)
  const signal = new AbortController().signal
  await events.waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

async function setupPlugin(files: Record<string, string>): Promise<{ ctx: Context; fs: MemoryFs; agent: Agent & { session: Session } }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemoryFs)
  const fs = ctx.get('fs') as MemoryFs
  for (const [path, content] of Object.entries(files)) {
    const target = await fs.resolve(path, { cwd: '/workspace' })
    fs.files.set(target.displayPath, content)
  }
  // stage-switch 0.2.0 reads session stage records through the mandatory
  // session-projection seam, so the projection registry must be composed
  // before the stage controller (otherwise it stays pending and nothing here
  // composes).
  await ctx.plugin(SessionProjection)
  await ctx.plugin(StageController, tavernCardsStageConfig)
  await ctx.plugin(apply, {} as TavernCardsConfig)
  const agent = await agentWithSession(ctx, 'agent-1', '/workspace')
  return { ctx, fs, agent }
}

/**
 * Emit one `fs/observed` event on a project-owned path, the only input the
 * behavior-focus tracker consumes. Completion eligibility is strictly
 * observation-driven: without at least one such event the session has
 * no focus project and NO stage renders pressure, even when the workspace
 * files already look complete.
 */
async function observeProjectFile(
  ctx: Context,
  agent: Agent & { session: Session },
  project: string,
  tool: 'read' | 'write' = 'read',
): Promise<void> {
  const target = await (ctx.get('fs') as MemoryFs).resolve(`cards/${project}/design-spec.md`, { cwd: '/workspace' })
  ctx.emit('fs/observed', target, { kind: 'present', version: FsVersion('v1') }, { agent, name: tool, arguments: {} })
}

const CARD_RC = JSON.stringify({
  projects: {
    Demo: {
      state_file: 'cards/Demo/tavern-cards-state.json',
      artifact: 'cards/Demo/Demo.png',
    },
  },
})

const NON_MVU_PLANNING = `
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

const NON_MVU_STATE = JSON.stringify({
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

function completeNonMvuFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    '.cardrc.json': CARD_RC,
    'cards/Demo/design-spec.md': DESIGN_SPEC,
    'cards/Demo/创作规划.yaml': NON_MVU_PLANNING,
    'cards/Demo/tavern-cards-state.json': NON_MVU_STATE,
    'cards/Demo/世界书/世界观/世界设定.yaml': '世界设定正文',
    'cards/Demo/开场白/0.txt': '开场白正文',
    // Pack artifact stub: pack-gate fallback evidence for content/ui.
    'cards/Demo/Demo.png': '\x89PNG stub',
    ...overrides,
  }
}

/** Self-contained deployed replacement file (text status bar shape). */
const DEPLOYED_REGEX_HTML = [
  '```',
  '<body><div class="status-bar">状态栏: {{getvar::stat_data.状态.区域}} 与足够长的正文内容以越过占位阈值</div></body>',
  '```',
].join('\n')

/** Deployed CDN loader replacement file (frontend shape). */
const CDN_REGEX_HTML = [
  '```',
  '<body>',
  '<script>',
  '$(\'body\').load(\'https://testingcf.jsdelivr.net/gh/user/repo/dist/Demo/界面/状态栏/index.html\')',
  '</script>',
  '</body>',
  '```',
].join('\n')

/** Local preview loader replacement file — NOT deployed. */
const PREVIEW_REGEX_HTML = [
  '```',
  '<body>',
  '<script>',
  '$(\'body\').load(\'http://localhost:5500/dist/Demo/界面/状态栏/index.html\')',
  '</script>',
  '</body>',
  '```',
].join('\n')

function mvuState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    projectName: 'Demo',
    form: 'charactercard',
    mvu: true,
    zod: { schemaPath: 'schema.ts' },
    entryManifest: {
      世界观: {
        世界设定: {
          abstract: 'x',
          strategy: { type: 'constant' },
          position: { type: 'before_character_definition', order: 1 },
        },
      },
      MVU: {
        '[InitVar]请勿打开': { part: 'initvar', path: '世界书/变量/initvar.yaml', strategy: { type: 'constant' }, position: { type: 'at_depth', role: 'system', depth: 4, order: 2 } },
        '变量更新规则': { part: 'update_rules', path: '世界书/变量/变量更新规则.yaml', strategy: { type: 'constant' }, position: { type: 'at_depth', role: 'system', depth: 4, order: 3 } },
      },
    },
    first_messages: ['开场白/0.txt'],
    regex_scripts: { '状态栏界面': { replace_file: '正则/状态栏界面.html' } },
    ...overrides,
  })
}

function mvuPlanning(uiMode = 'text'): string {
  return `project:
  name: Demo
  form: charactercard
  mvu: true
  ui_mode: ${uiMode}
entries:
  - name: 世界设定
    type: 世界观
    path: 世界书/世界观/世界设定.yaml
first_messages:
  - output_path: 开场白/0.txt
`
}

describe('tavernCardsStageConfig', () => {
  it('exposes the merged workflow stages without packaging', () => {
    // route precedes the four artifact stages; the assertion reads the names
    // from `tavernCardsStages` (the same source the export derives from)
    // rather than restating them, so adding a stage doesn't ripple through it.
    expect(tavernCardsStageConfig.stages.map(stage => stage.name))
      .toEqual(tavernCardsStages.map(stage => stage.name))
    expect(tavernCardsStages[0].name).toBe('route')
    // route owns no artifact — it is the entry router — so the config omits
    // `initial` and lets StageController default to `stages[0].name`. The
    // assertion reads the default rather than restating 'route'.
    expect(tavernCardsStageConfig.initial ?? tavernCardsStages[0].name)
      .toBe(tavernCardsStages[0].name)
  })
})

describe('TavernCardsStatus', () => {
  it('marks design and planning complete from project files', async () => {
    const { ctx } = await setupMemory({
      '.cardrc.json': CARD_RC,
      'cards/Demo/design-spec.md': DESIGN_SPEC,
      'cards/Demo/创作规划.yaml': 'project: Demo\n',
    })
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'design')).toBe(true)
    expect(status.isComplete(agent, 'planning')).toBe(true)
    expect(status.isComplete(agent, 'content')).toBe(false)
  })

  it('derives the project directory from the registered state file, not a cards/ guess', async () => {
    // A multi-project workspace registers its state file a level deeper than
    // the `cards/{Project}` convention (`.cardrc.json` at the session cwd, the
    // project nested under a workspace folder). The analyzer must read the
    // artifacts beside that registered file: deriving the directory from
    // `dirname(state_file)` keeps every check pointed at the real project
    // folder, while guessing `cards/{Project}` reads `undefined` for all of
    // them, so no stage could ever register as complete and `stage:policy`
    // stayed silent for the whole session (live session ce7eef56: cwd one
    // level above the project, design/planning completion false throughout).
    const projectDir = '项目2，问道/cards/问道'
    const { ctx } = await setupMemory({
      '.cardrc.json': JSON.stringify({ projects: { 问道: { state_file: `${projectDir}/tavern-cards-state.json` } } }),
      [`${projectDir}/design-spec.md`]: DESIGN_SPEC,
      [`${projectDir}/创作规划.yaml`]: 'project: 问道\n',
    })
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'design')).toBe(true)
    expect(status.isComplete(agent, 'planning')).toBe(true)
  })

  it('keeps design incomplete for shell or placeholder design-specs', async () => {
    const { ctx } = await setupMemory({
      '.cardrc.json': CARD_RC,
      'cards/Demo/design-spec.md': '# Demo design',
      'cards/Demo/创作规划.yaml': 'project: Demo\n',
    })
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'design')).toBe(false)
  })

  it('does not mark planning complete while the plan has pending markers', async () => {
    const { ctx } = await setupMemory({
      '.cardrc.json': CARD_RC,
      'cards/Demo/design-spec.md': DESIGN_SPEC,
      'cards/Demo/创作规划.yaml': 'project: Demo\n# 待细化\n',
    })
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'planning')).toBe(false)
  })

  it('finds .cardrc.json from a nested session cwd', async () => {
    const { ctx } = await setupMemory(completeNonMvuFiles())
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace/nested/project')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'design')).toBe(true)
    expect(status.isComplete(agent, 'planning')).toBe(true)
  })

  it('keeps per-cwd status caches independent for resumed sessions', async () => {
    const { ctx } = await setupMemory(completeNonMvuFiles())
    const status = new TavernCardsStatus(ctx)
    const agentA = fakeAgent(ctx, '/workspace')
    const agentB = fakeAgent(ctx, '/other')
    await status.refresh(agentA)
    await status.refresh(agentB)

    expect(status.isComplete(agentA, 'design')).toBe(true)
    expect(status.isComplete(agentA, 'content')).toBe(true)
    expect(status.isComplete(agentB, 'design')).toBe(false)
    expect(status.isComplete(agentB, 'content')).toBe(false)
  })

  it('leaves every stage incomplete without a .cardrc.json', async () => {
    const { ctx } = await setupMemory({})
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'design')).toBe(false)
    expect(status.isComplete(agent, 'planning')).toBe(false)
    expect(status.isComplete(agent, 'content')).toBe(false)
    expect(status.isComplete(agent, 'ui')).toBe(false)
  })

  it('no longer auto-completes design/planning from state content alone (Phase 3)', async () => {
    // A manual project with state but neither design-spec nor planning doc:
    // the old hasStateContent fallback would mark design+planning complete;
    // Phase 3 removes it, so those stages stay open while content/ui are
    // judged on their own merits.
    const { ctx } = await setupMemory({
      '.cardrc.json': CARD_RC,
      'cards/Demo/tavern-cards-state.json': NON_MVU_STATE,
      'cards/Demo/世界书/世界观/世界设定.yaml': '世界设定正文',
      'cards/Demo/开场白/0.txt': '开场白正文',
      'cards/Demo/Demo.png': '\x89PNG stub',
    })
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'design')).toBe(false)
    expect(status.isComplete(agent, 'planning')).toBe(false)
    expect(status.isComplete(agent, 'content')).toBe(true)
    expect(status.isComplete(agent, 'ui')).toBe(true)
  })

  it('marks content complete when entries, configure, and opening are complete', async () => {
    const { ctx } = await setupMemory(completeNonMvuFiles())
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'content')).toBe(true)
    expect(status.isComplete(agent, 'ui')).toBe(true)
  })

  it('does not mark content complete until every planned entry is registered', async () => {
    const state = JSON.parse(NON_MVU_STATE) as { entryManifest: Record<string, Record<string, unknown>> }
    delete state.entryManifest['世界观']['世界设定']
    const { ctx } = await setupMemory(completeNonMvuFiles({
      'cards/Demo/tavern-cards-state.json': JSON.stringify(state),
    }))
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'content')).toBe(false)
  })

  it('does not mark content complete until configure has filled strategy/position', async () => {
    const state = JSON.parse(NON_MVU_STATE) as {
      entryManifest: Record<string, Record<string, { strategy?: unknown; position?: unknown }>>
    }
    delete state.entryManifest['世界观']['世界设定'].strategy
    delete state.entryManifest['世界观']['世界设定'].position
    const { ctx } = await setupMemory(completeNonMvuFiles({
      'cards/Demo/tavern-cards-state.json': JSON.stringify(state),
    }))
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'content')).toBe(false)
  })

  it('marks MVU content complete when core files, zod, and registered MVU entries exist', async () => {
    const { ctx } = await setupMemory(completeNonMvuFiles({
      'cards/Demo/创作规划.yaml': mvuPlanning(),
      'cards/Demo/tavern-cards-state.json': mvuState(),
      'cards/Demo/schema.ts': 'export const Schema = z.object({})',
      'cards/Demo/世界书/变量/initvar.yaml': '{}',
      'cards/Demo/世界书/变量/变量更新规则.yaml': 'rules: []',
      'cards/Demo/正则/状态栏界面.html': DEPLOYED_REGEX_HTML,
    }))
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'content')).toBe(true)
    expect(status.isComplete(agent, 'ui')).toBe(true)
  })

  it('requires EJS content when the plan declares EJS entries', async () => {
    const planning = NON_MVU_PLANNING + `
ejs:
  entries:
    - name: 世界设定
      complexity: 条目显隐
`
    const { ctx } = await setupMemory(completeNonMvuFiles({
      'cards/Demo/创作规划.yaml': planning,
      'cards/Demo/世界书/世界观/世界设定.yaml': '没有 EJS 的普通内容',
    }))
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'content')).toBe(false)

    const ejsFiles = completeNonMvuFiles({
      'cards/Demo/创作规划.yaml': planning,
      'cards/Demo/世界书/世界观/世界设定.yaml': '@@if getvar(\'stat_data.世界.当前区域\', { defaults: \'\' }).includes(\'华东区\')\n内容',
    })
    const ejsCtx = await setupMemory(ejsFiles)
    const ejsStatus = new TavernCardsStatus(ejsCtx.ctx)
    const ejsAgent = fakeAgent(ejsCtx.ctx, '/workspace')
    await ejsStatus.refresh(ejsAgent)

    expect(ejsStatus.isComplete(ejsAgent, 'content')).toBe(true)
  })

  it('judges ui by deployed 正则/ content rather than registered regex_scripts', async () => {
    // Preview (localhost) content keeps ui incomplete even with the script
    // registered and the artifact packed; deployed content completes it.
    const preview = completeNonMvuFiles({
      'cards/Demo/创作规划.yaml': mvuPlanning(),
      'cards/Demo/tavern-cards-state.json': mvuState(),
      'cards/Demo/schema.ts': 'export const Schema = z.object({})',
      'cards/Demo/世界书/变量/initvar.yaml': '{}',
      'cards/Demo/世界书/变量/变量更新规则.yaml': 'rules: []',
      'cards/Demo/正则/状态栏界面.html': PREVIEW_REGEX_HTML,
    })
    const previewCtx = await setupMemory(preview)
    const previewStatus = new TavernCardsStatus(previewCtx.ctx)
    const previewAgent = fakeAgent(previewCtx.ctx, '/workspace')
    await previewStatus.refresh(previewAgent)
    expect(previewStatus.isComplete(previewAgent, 'ui')).toBe(false)

    const deployed = completeNonMvuFiles({
      'cards/Demo/创作规划.yaml': mvuPlanning(),
      'cards/Demo/tavern-cards-state.json': mvuState(),
      'cards/Demo/schema.ts': 'export const Schema = z.object({})',
      'cards/Demo/世界书/变量/initvar.yaml': '{}',
      'cards/Demo/世界书/变量/变量更新规则.yaml': 'rules: []',
      'cards/Demo/正则/状态栏界面.html': CDN_REGEX_HTML,
    })
    const deployedCtx = await setupMemory(deployed)
    const deployedStatus = new TavernCardsStatus(deployedCtx.ctx)
    const deployedAgent = fakeAgent(deployedCtx.ctx, '/workspace')
    await deployedStatus.refresh(deployedAgent)
    expect(deployedStatus.isComplete(deployedAgent, 'ui')).toBe(true)
  })

  it('does not complete ui without a pack, and a pack event satisfies the gate', async () => {
    const files = completeNonMvuFiles({
      'cards/Demo/创作规划.yaml': mvuPlanning(),
      'cards/Demo/tavern-cards-state.json': mvuState(),
      'cards/Demo/schema.ts': 'export const Schema = z.object({})',
      'cards/Demo/世界书/变量/initvar.yaml': '{}',
      'cards/Demo/世界书/变量/变量更新规则.yaml': 'rules: []',
      'cards/Demo/正则/状态栏界面.html': DEPLOYED_REGEX_HTML,
    })
    // No artifact on disk: only the pack-event half of the gate remains.
    delete files['cards/Demo/Demo.png']
    const { ctx } = await setupMemory(files)
    const packs = new PackLedger()
    const status = new TavernCardsStatus(ctx, undefined, packs)
    const agent = fakeAgent(ctx, '/workspace')

    await status.refresh(agent)
    expect(status.isComplete(agent, 'content')).toBe(false)
    expect(status.isComplete(agent, 'ui')).toBe(false)

    packs.mark('/workspace', 'Demo')
    await status.refresh(agent)
    expect(status.isComplete(agent, 'content')).toBe(true)
    expect(status.isComplete(agent, 'ui')).toBe(true)
  })

  it('completes ui as skipped when no UI files exist and ui_mode is none', async () => {
    const { ctx } = await setupMemory(completeNonMvuFiles({
      'cards/Demo/创作规划.yaml': mvuPlanning('none'),
      'cards/Demo/tavern-cards-state.json': mvuState({ regex_scripts: undefined }),
    }))
    const status = new TavernCardsStatus(ctx)
    const agent = fakeAgent(ctx, '/workspace')
    await status.refresh(agent)

    expect(status.isComplete(agent, 'ui')).toBe(true)
  })

  it('collects off-standard UI files from the 正则 directory listing', async () => {
    // No replace_file reference at all; the directory scan must still pick
    // up a nonstandard UI file and require it to be deployed.
    const base = completeNonMvuFiles({
      'cards/Demo/创作规划.yaml': mvuPlanning('frontend'),
      'cards/Demo/tavern-cards-state.json': mvuState({ regex_scripts: undefined }),
      'cards/Demo/schema.ts': 'export const Schema = z.object({})',
      'cards/Demo/世界书/变量/initvar.yaml': '{}',
      'cards/Demo/世界书/变量/变量更新规则.yaml': 'rules: []',
    })
    const previewCtx = await setupMemory({ ...base, 'cards/Demo/正则/自定义仪表盘.html': PREVIEW_REGEX_HTML })
    const previewStatus = new TavernCardsStatus(previewCtx.ctx)
    const previewAgent = fakeAgent(previewCtx.ctx, '/workspace')
    await previewStatus.refresh(previewAgent)
    expect(previewStatus.isComplete(previewAgent, 'ui')).toBe(false)

    const doneCtx = await setupMemory({ ...base, 'cards/Demo/正则/自定义仪表盘.html': CDN_REGEX_HTML })
    const doneStatus = new TavernCardsStatus(doneCtx.ctx)
    const doneAgent = fakeAgent(doneCtx.ctx, '/workspace')
    await doneStatus.refresh(doneAgent)
    expect(doneStatus.isComplete(doneAgent, 'ui')).toBe(true)
  })
})

describe('apply', () => {
  it('registers a composite eligibility predicate through stage-switch', async () => {
    const { ctx, agent } = await setupPlugin(completeNonMvuFiles())

    // route is the entry router and owns no artifact, so it can never complete
    // and never renders the stage-policy context. Land the session in design
    // (whose artifacts are all present in the fixture) and give the focus
    // tracker one observation of the project, so the composite eligibility
    // predicate flips design-complete and the plugin renders the stage-policy
    // section.
    seedStage(agent.session, 'design')
    await observeProjectFile(ctx, agent, 'Demo')
    // The plugin refreshes status during pre-step before request assembly.
    await preStep(ctx, agent)

    const assembly = await assembleFor(ctx, agent)
    const policy = assembly.contexts.find(context => context.name === 'stage:policy')
    expect(policy?.text).toBe(tavernCardsStageConfig.section)
  })

  it('does not show switch guidance while the current stage is incomplete', async () => {
    const { ctx, agent } = await setupPlugin({
      '.cardrc.json': CARD_RC,
    })

    await preStep(ctx, agent)

    const assembly = await assembleFor(ctx, agent)
    const policy = assembly.contexts.find(context => context.name === 'stage:policy')
    expect(policy?.text).toBe('')
  })

  it('keeps stage pressure silent at stage entry before any project file is touched', async () => {
    // Regression: a fresh session on an already-complete single-project
    // workspace (the hands-on test that routed route→design and immediately
    // saw stage:policy) must not be told its stage is done before it has done
    // any work. The old single-project fallback checked the sole project's
    // files even with an empty focus buffer; completion is now strictly
    // observation-driven, so no observation → no pressure.
    const { ctx, agent } = await setupPlugin(completeNonMvuFiles())
    seedStage(agent.session, 'design')
    await preStep(ctx, agent)

    const assembly = await assembleFor(ctx, agent)
    const policy = assembly.contexts.find(context => context.name === 'stage:policy')
    expect(policy?.text).toBe('')

    // Once the session actually engages the project, the same files complete
    // design and the guidance renders.
    await observeProjectFile(ctx, agent, 'Demo')
    await preStep(ctx, agent)
    const engaged = await assembleFor(ctx, agent)
    expect(engaged.contexts.find(context => context.name === 'stage:policy')?.text)
      .toBe(tavernCardsStageConfig.section)
  })
})

describe('apply with behavior focus', () => {
  const DUAL_CARD_RC = JSON.stringify({
    projects: {
      Alpha: { state_file: 'cards/Alpha/tavern-cards-state.json' },
      Beta: { state_file: 'cards/Beta/tavern-cards-state.json' },
    },
  })

  function dualProjectFiles(): Record<string, string> {
    // Beta is fully past design; Alpha has nothing yet.
    return {
      '.cardrc.json': DUAL_CARD_RC,
      'cards/Beta/design-spec.md': DESIGN_SPEC,
      'cards/Beta/创作规划.yaml': 'project: Beta\n',
    }
  }

  it('reference reads of the other project do not steal focus from the project being written', async () => {
    const { ctx, agent } = await setupPlugin(dualProjectFiles())
    seedStage(agent.session, 'design')

    // Two writes to Alpha (5+5) versus three reference reads of Beta (2+2+2):
    // focus must stay on Alpha, so Beta's complete design must not render
    // pressure while Alpha's own design-spec is still missing.
    await observeProjectFile(ctx, agent, 'Alpha', 'write')
    await observeProjectFile(ctx, agent, 'Alpha', 'write')
    await observeProjectFile(ctx, agent, 'Beta')
    await observeProjectFile(ctx, agent, 'Beta')
    await observeProjectFile(ctx, agent, 'Beta')
    await preStep(ctx, agent)

    const assembly = await assembleFor(ctx, agent)
    expect(assembly.contexts.find(context => context.name === 'stage:policy')?.text).toBe('')

    // Focus really is Alpha (not merely absent): once Alpha's design-spec
    // exists, its own completion renders the section.
    const fs = ctx.get('fs') as MemoryFs
    const target = await fs.resolve('cards/Alpha/design-spec.md', { cwd: '/workspace' })
    fs.files.set(target.displayPath, DESIGN_SPEC)
    await preStep(ctx, agent)
    const done = await assembleFor(ctx, agent)
    expect(done.contexts.find(context => context.name === 'stage:policy')?.text)
      .toBe(tavernCardsStageConfig.section)
  })

  it('does not render design pressure from another project while focused on A', async () => {
    const { ctx, agent } = await setupPlugin(dualProjectFiles())
    seedStage(agent.session, 'design')

    // Focus lands on Alpha (writing Alpha's design-spec); Beta's complete
    // design must not complete design for the workspace.
    await observeProjectFile(ctx, agent, 'Alpha')
    await preStep(ctx, agent)

    const assembly = await assembleFor(ctx, agent)
    const policy = assembly.contexts.find(context => context.name === 'stage:policy')
    expect(policy?.text).toBe('')

    // Once Alpha's design-spec actually exists (with real content), design
    // completes for it.
    const fs = ctx.get('fs') as MemoryFs
    const target = await fs.resolve('cards/Alpha/design-spec.md', { cwd: '/workspace' })
    fs.files.set(target.displayPath, DESIGN_SPEC)
    await preStep(ctx, agent)
    const done = await assembleFor(ctx, agent)
    expect(done.contexts.find(context => context.name === 'stage:policy')?.text)
      .toBe(tavernCardsStageConfig.section)
  })

  it('renders completion for the focused project even when it is not the only complete one', async () => {
    const { ctx, agent } = await setupPlugin(dualProjectFiles())
    seedStage(agent.session, 'design')

    await observeProjectFile(ctx, agent, 'Beta')
    await preStep(ctx, agent)

    const assembly = await assembleFor(ctx, agent)
    expect(assembly.contexts.find(context => context.name === 'stage:policy')?.text)
      .toBe(tavernCardsStageConfig.section)
  })

  it('renders nothing in a multi-project workspace before any focused write', async () => {
    const { ctx, agent } = await setupPlugin(dualProjectFiles())
    seedStage(agent.session, 'design')

    await preStep(ctx, agent)

    const assembly = await assembleFor(ctx, agent)
    expect(assembly.contexts.find(context => context.name === 'stage:policy')?.text).toBe('')
  })
})

describe('apply with the pack gate and ui-complete guidance', () => {
  function mvuUiFiles(regexHtml: string): Record<string, string> {
    return {
      '.cardrc.json': CARD_RC,
      'cards/Demo/design-spec.md': '# Demo design',
      'cards/Demo/创作规划.yaml': mvuPlanning(),
      'cards/Demo/tavern-cards-state.json': mvuState(),
      'cards/Demo/schema.ts': 'export const Schema = z.object({})',
      'cards/Demo/世界书/变量/initvar.yaml': '{}',
      'cards/Demo/世界书/变量/变量更新规则.yaml': 'rules: []',
      'cards/Demo/正则/状态栏界面.html': regexHtml,
    }
  }

  function findContext(assembly: Awaited<ReturnType<typeof assembleFor>>, name: string) {
    return assembly.contexts.find(context => context.name === name)?.text ?? ''
  }

  it('emits the ui-complete section instead of generic urging once packed and deployed', async () => {
    const { ctx, agent } = await setupPlugin(mvuUiFiles(DEPLOYED_REGEX_HTML))
    seedStage(agent.session, 'ui')
    // Give the focus tracker its project so ui completion is judged on the
    // content + pack gate rather than on a missing focus.
    await observeProjectFile(ctx, agent, 'Demo')

    // Content deployed but never packed: no section at all.
    await preStep(ctx, agent)
    let assembly = await assembleFor(ctx, agent)
    expect(findContext(assembly, 'tavern-cards/ui-complete')).toBe('')
    expect(findContext(assembly, 'stage:policy')).toBe('')

    // A successful pack (model tool or slash) satisfies the gate.
    ctx.emit(TAVERN_CARDS_PACKED, { project: 'Demo', cwd: '/workspace', at: Date.now(), via: 'tool' })
    await preStep(ctx, agent)
    assembly = await assembleFor(ctx, agent)
    expect(findContext(assembly, 'tavern-cards/ui-complete')).toBe(TAVERN_UI_COMPLETE_SECTION)
    // ui never renders the generic advance section — it has no next stage.
    expect(findContext(assembly, 'stage:policy')).toBe('')
  })

  it('keeps ui incomplete while the 正则 file still loads the local preview server', async () => {
    const { ctx, agent } = await setupPlugin(mvuUiFiles(PREVIEW_REGEX_HTML))
    seedStage(agent.session, 'ui')
    await observeProjectFile(ctx, agent, 'Demo')

    ctx.emit(TAVERN_CARDS_PACKED, { project: 'Demo', cwd: '/workspace', at: Date.now(), via: 'tool' })
    await preStep(ctx, agent)

    const assembly = await assembleFor(ctx, agent)
    expect(findContext(assembly, 'tavern-cards/ui-complete')).toBe('')
    expect(findContext(assembly, 'stage:policy')).toBe('')
  })
})
