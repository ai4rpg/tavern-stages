import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import '@deepseek-ai/cordis-plugin-loader'
import '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import StageController from '@ai4rpg/dsh-stage-switch'
import { TAVERN_CARDS_PACKED, TAVERN_UI_COMPLETE_SECTION, tavernCardsStageConfig } from '../src/index.ts'
import * as TavernCards from '../src/index.ts'
import { MemoryFs, makeAgent, preStep, assembleFor, mkdtemp, rm } from './helpers/loader-composition.ts'
import { seedStage } from './helpers/seed-stage.ts'

// Shared fixtures (MemoryFs, makeAgent, preStep, assembleFor) live in
// tests/helpers/loader-composition.ts, which this is the only consumer of.

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(files: Record<string, string>): Promise<{ ctx: Context; agent: Agent }> {
  root = await mkdtemp(join(tmpdir(), 'tavern-stages-loader-'))
  const configPath = join(root, 'cordis.yml')
  const stageRows = tavernCardsStageConfig.stages
    .map(stage => `      - name: ${stage.name}\n        instruction: ${JSON.stringify(stage.instruction)}`)
    .join('\n')
  // route owns no artifact and is the first stage, so the preset omits
  // `initial` and lets StageController default to `stages[0].name`. Emit the
  // line only when the preset pins one, so we never write the YAML token
  // `undefined` (which YAML reads as the string "undefined").
  const initialRow = tavernCardsStageConfig.initial === undefined
    ? ''
    : `    initial: ${JSON.stringify(tavernCardsStageConfig.initial)}`
  const handoffRow = tavernCardsStageConfig.minHandoffTokens === undefined
    ? ''
    : `    minHandoffTokens: ${tavernCardsStageConfig.minHandoffTokens}`
  await writeFile(configPath, [
    "- name: 'test:memory-fs'",
    "- name: '@deepseek-ai/dsh-session'",
    // dsh 0.1.5: dsh-token-meter (and the agent loop) inject the mandatory
    // session-projection seam, so the registration alone is not enough.
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-token-meter'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- id: stage-switch",
    "  name: '@ai4rpg/dsh-stage-switch'",
    '  config:',
    '    stages:',
    stageRows,
    `    section: ${JSON.stringify(tavernCardsStageConfig.section)}`,
    handoffRow,
    initialRow,
    "- name: '@ai4rpg/dsh-tavern-stages'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader, {})
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test:memory-fs', MemoryFs],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjection],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@ai4rpg/dsh-stage-switch', StageController],
    ['@ai4rpg/dsh-tavern-stages', TavernCards],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()

  const fs = context.get('fs') as MemoryFs
  for (const [path, content] of Object.entries(files)) {
    const target = await fs.resolve(path, { cwd: root })
    fs.files.set(target.displayPath, content)
  }

  const agent = makeAgent(context, 'loader-agent', root)
  return { ctx: context, agent }
}

describe('real Loader composition through cordis.yml', () => {
  it('loads the tavern-stages plugin and shows stage guidance when the current stage is complete', { timeout: 60_000 }, async () => {
    const { ctx, agent } = await loadComposition({
      '.cardrc.json': JSON.stringify({
        projects: {
          Demo: {
            state_file: 'cards/Demo/tavern-cards-state.json',
            artifact: 'cards/Demo/Demo.png',
          },
        },
      }),
      'cards/Demo/design-spec.md': [
        '# Design Spec — Demo',
        '',
        '## 项目定位',
        '- 项目名称：Demo',
        '- 形式：角色卡',
        '- 主题：都市奇幻冒险，主角在现代城市中逐步发现隐藏的超常层面，日常与异常交织',
        '- 体验目标：自由冒险与探索感，玩家通过选择推动剧情分支',
        '',
        '## 世界观概念',
        '半架空现代都市：表层是普通都市生活，里层存在由记忆凝聚成的异常空间。',
        '',
      ].join('\n'),
      'cards/Demo/创作规划.yaml': 'project: Demo\n',
    })

    // route owns no artifact, so it can never complete and never renders
    // the stage-policy context; land the session in design (whose
    // design-spec.md is present in the fixture). Completion eligibility is
    // strictly observation-driven, so feed the focus tracker one
    // fs/observed event on the project path before the pre-step; the
    // composite eligibility predicate then flips design-complete and renders
    // the section.
    seedStage(agent.session, 'design')
    const fs = ctx.get('fs') as MemoryFs
    const specTarget = await fs.resolve('cards/Demo/design-spec.md', { cwd: root })
    ctx.emit('fs/observed', specTarget, { kind: 'present', version: FsVersion('v1') }, { agent, name: 'read', arguments: {} })
    await preStep(ctx, agent)

    const assembly = await assembleFor(ctx, agent)
    const policy = assembly.contexts.find(context => context.name === 'stage:policy')
    expect(policy?.text).toBe(tavernCardsStageConfig.section)

    // Phase 0: model catalog exposes tavern_forge only (pack is command=pack).
    expect(ctx.tools.get('tavern_forge'), 'tavern_forge should be model-visible').toBeDefined()
    expect(ctx.tools.get('tavern_pack'), 'tavern_pack must not be registered').toBeUndefined()

    // The preset's minHandoffTokens requires the token-meter service; assert
    // the real composition provides it so goto_stage works at all.
    expect(ctx.get('tokenMeter'), 'tokenMeter should be composed for minHandoffTokens').toBeDefined()
  })

  it('gates the model-visible ui-complete section on deployed 正则 content plus a pack event', { timeout: 60_000 }, async () => {
    const deployedBody = [
      '```',
      '<body><div class="status-bar">状态栏: {{getvar::stat_data.状态.区域}} 与足够长的正文内容以越过占位阈值</div></body>',
      '```',
    ].join('\n')
    const previewBody = [
      '```',
      '<body>',
      '<script>',
      '$(\'body\').load(\'http://localhost:5500/dist/Demo/界面/状态栏/index.html\')',
      '</script>',
      '</body>',
      '```',
    ].join('\n')
    const state = JSON.stringify({
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
    })
    const planning = [
      'project:',
      '  name: Demo',
      '  form: charactercard',
      '  mvu: true',
      '  ui_mode: text',
      'entries:',
      '  - name: 世界设定',
      '    type: 世界观',
      '    path: 世界书/世界观/世界设定.yaml',
      'first_messages:',
      '  - output_path: 开场白/0.txt',
      '',
    ].join('\n')
    const { ctx, agent } = await loadComposition({
      '.cardrc.json': JSON.stringify({
        projects: {
          Demo: { state_file: 'cards/Demo/tavern-cards-state.json' },
        },
      }),
      'cards/Demo/design-spec.md': [
        '# Design Spec — Demo',
        '',
        '## 项目定位',
        '- 项目名称：Demo',
        '- 形式：角色卡',
        '- 主题：都市奇幻冒险，主角在现代城市中逐步发现隐藏的超常层面，日常与异常交织',
        '- 体验目标：自由冒险与探索感，玩家通过选择推动剧情分支',
        '',
        '## 世界观概念',
        '半架空现代都市：表层是普通都市生活，里层存在由记忆凝聚成的异常空间。',
        '',
      ].join('\n'),
      'cards/Demo/创作规划.yaml': planning,
      'cards/Demo/tavern-cards-state.json': state,
      'cards/Demo/schema.ts': 'export const Schema = z.object({})',
      'cards/Demo/世界书/世界观/世界设定.yaml': '世界设定正文',
      'cards/Demo/世界书/变量/initvar.yaml': '{}',
      'cards/Demo/世界书/变量/变量更新规则.yaml': 'rules: []',
      'cards/Demo/开场白/0.txt': '开场白正文',
      'cards/Demo/正则/状态栏界面.html': previewBody,
    })

    seedStage(agent.session, 'ui')
    // Give the focus tracker its project so ui completion is judged on the
    // content + pack gate rather than on a missing focus.
    const uiFs = ctx.get('fs') as MemoryFs
    const uiSpec = await uiFs.resolve('cards/Demo/design-spec.md', { cwd: root })
    ctx.emit('fs/observed', uiSpec, { kind: 'present', version: FsVersion('v1') }, { agent, name: 'read', arguments: {} })
    // Preview content: even a successful pack must not complete ui.
    ctx.emit(TAVERN_CARDS_PACKED, { project: 'Demo', cwd: root, at: Date.now(), via: 'tool' })
    await preStep(ctx, agent)
    let assembly = await assembleFor(ctx, agent)
    expect(assembly.contexts.find(context => context.name === 'tavern-cards/ui-complete')?.text ?? '')
      .toBe('')

    // Switch the same file to deployed content: the dedicated section appears
    // and the generic advance section stays suppressed on ui.
    const fs = ctx.get('fs') as MemoryFs
    const target = await fs.resolve('cards/Demo/正则/状态栏界面.html', { cwd: root })
    fs.files.set(target.displayPath, deployedBody)
    await preStep(ctx, agent)
    assembly = await assembleFor(ctx, agent)
    expect(assembly.contexts.find(context => context.name === 'tavern-cards/ui-complete')?.text ?? '')
      .toBe(TAVERN_UI_COMPLETE_SECTION)
    expect(assembly.contexts.find(context => context.name === 'stage:policy')?.text ?? '')
      .toBe('')
  })

})

