import { describe, expect, it } from 'vitest'
import { isDesignSpecSubstantial } from '../src/design.ts'

/** Section skeleton straight from the design-guide reference template. */
const TEMPLATE_SHELL = `# Design Spec — [项目名]

## 项目定位
- 项目名称：...
- 形式：角色卡 / 独立世界书
- 主题：...
- 体验目标：...

## 世界观概念
...

## 角色方向
...

## SFW / NSFW
...
`

const SUBSTANTIAL = `# Design Spec — Demo

## 项目定位
- 项目名称：Demo
- 形式：角色卡
- 主题：都市奇幻冒险，主角在现代城市中逐步发现隐藏的超常层面，日常与异常交织
- 体验目标：自由冒险与探索感，玩家通过选择推动剧情分支

## 世界观概念
半架空现代都市：表层是普通都市生活，里层存在由记忆凝聚成的异常空间。
`

describe('isDesignSpecSubstantial', () => {
  it('rejects empty and heading-only files', () => {
    expect(isDesignSpecSubstantial('')).toBe(false)
    expect(isDesignSpecSubstantial('\n\n  \n')).toBe(false)
    expect(isDesignSpecSubstantial('# Demo design\n## 项目定位\n')).toBe(false)
  })

  it('rejects template skeletons whose values are all placeholders', () => {
    expect(isDesignSpecSubstantial(TEMPLATE_SHELL)).toBe(false)
    expect(isDesignSpecSubstantial('## 定位\n- 主题：待补充\n- 体验目标：TODO\n')).toBe(false)
  })

  it('accepts a spec with real design prose', () => {
    expect(isDesignSpecSubstantial(SUBSTANTIAL)).toBe(true)
  })
})
