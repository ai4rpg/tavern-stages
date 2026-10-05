import { describe, expect, it } from 'vitest'
import {
  BehaviorFocus,
  cwdFromActor,
  FOCUS_READ_WEIGHT,
  FOCUS_WRITE_WEIGHT,
  focusWeightFromActor,
  projectFromPath,
} from '../src/focus.ts'

describe('projectFromPath', () => {
  it('extracts the project from cards/{Project}/ paths', () => {
    expect(projectFromPath('/workspace/cards/Demo/design-spec.md')).toBe('Demo')
    expect(projectFromPath('cards/Demo/正则/状态栏界面.html')).toBe('Demo')
    expect(projectFromPath('/workspace/cards/中文项目/创作规划.yaml')).toBe('中文项目')
    expect(projectFromPath('/workspace/cards/Demo')).toBe('Demo')
  })

  it('extracts the project from Windows backslash paths', () => {
    // displayPath is backend-decided; a Windows fs-local deployment emits `\`.
    expect(projectFromPath('C:\\Users\\admin\\dshcards\\cards\\以牙还牙\\design-spec.md')).toBe('以牙还牙')
    expect(projectFromPath('C:\\Users\\admin\\dshcards\\cards\\以牙还牙\\正则\\状态栏界面.html')).toBe('以牙还牙')
    expect(projectFromPath('C:\\Users\\admin\\dshcards\\cards\\以牙还牙')).toBe('以牙还牙')
    expect(projectFromPath('cards\\Demo\\创作规划.yaml')).toBe('Demo')
  })

  it('extracts the project from mixed-slash paths', () => {
    expect(projectFromPath('C:/Users/admin/dshcards/cards/以牙还牙/design-spec.md')).toBe('以牙还牙')
  })

  it('returns undefined outside a cards directory', () => {
    expect(projectFromPath('/workspace/README.md')).toBeUndefined()
    expect(projectFromPath('/workspace/template-app/src/Demo/界面/x.html')).toBeUndefined()
    expect(projectFromPath('C:\\Users\\admin\\dshcards\\README.md')).toBeUndefined()
    expect(projectFromPath('C:\\Users\\admin\\template-app\\src\\Demo\\界面\\x.html')).toBeUndefined()
  })
})

describe('BehaviorFocus', () => {
  it('returns the majority project and drops entries beyond the ring size', () => {
    const focus = new BehaviorFocus(3)
    focus.record('/w', 'A', 'cards/A/design-spec.md', FOCUS_READ_WEIGHT, 1)
    focus.record('/w', 'A', 'cards/A/创作规划.yaml', FOCUS_READ_WEIGHT, 2)
    focus.record('/w', 'B', 'cards/B/design-spec.md', FOCUS_READ_WEIGHT, 3)
    focus.record('/w', 'B', 'cards/B/创作规划.yaml', FOCUS_READ_WEIGHT, 4) // evicts the first A
    expect(focus.focusProject('/w')).toBe('B')
  })

  it('resolves weight ties to the most recent observation', () => {
    const focus = new BehaviorFocus()
    focus.record('/w', 'A', 'cards/A/x', FOCUS_READ_WEIGHT, 1)
    focus.record('/w', 'B', 'cards/B/x', FOCUS_READ_WEIGHT, 2)
    expect(focus.focusProject('/w')).toBe('B')
    focus.record('/w', 'A', 'cards/A/y', FOCUS_READ_WEIGHT, 3)
    expect(focus.focusProject('/w')).toBe('A')
  })

  it('weighs writes 2:5 so reference reads cannot steal focus', () => {
    const focus = new BehaviorFocus()
    // Two writes to A (5+5) outweigh three reference reads of B (2+2+2).
    focus.record('/w', 'A', 'cards/A/design-spec.md', FOCUS_WRITE_WEIGHT, 1)
    focus.record('/w', 'A', 'cards/A/创作规划.yaml', FOCUS_WRITE_WEIGHT, 2)
    focus.record('/w', 'B', 'cards/B/design-spec.md', FOCUS_READ_WEIGHT, 3)
    focus.record('/w', 'B', 'cards/B/创作规划.yaml', FOCUS_READ_WEIGHT, 4)
    focus.record('/w', 'B', 'cards/B/state.json', FOCUS_READ_WEIGHT, 5)
    expect(focus.focusProject('/w')).toBe('A')
  })

  it('flips to the new project after two genuine writes on a switch', () => {
    const focus = new BehaviorFocus()
    focus.record('/w', 'A', 'cards/A/x', FOCUS_WRITE_WEIGHT, 1)
    focus.record('/w', 'A', 'cards/A/y', FOCUS_WRITE_WEIGHT, 2)
    focus.record('/w', 'A', 'cards/A/z', FOCUS_READ_WEIGHT, 3)
    focus.record('/w', 'A', 'cards/A/w', FOCUS_READ_WEIGHT, 4)
    focus.record('/w', 'A', 'cards/A/v', FOCUS_READ_WEIGHT, 5)
    focus.record('/w', 'B', 'cards/B/x', FOCUS_WRITE_WEIGHT, 6)
    focus.record('/w', 'B', 'cards/B/y', FOCUS_WRITE_WEIGHT, 7)
    // Buffer: [A-read, A-read, A-read, B-write, B-write] → 6 vs 10.
    expect(focus.focusProject('/w')).toBe('B')
  })

  it('ignores observations outside the registered project set', () => {
    const focus = new BehaviorFocus()
    focus.record('/w', 'Ghost', 'cards/Ghost/x', 1)
    expect(focus.focusProject('/w', ['Demo'])).toBeUndefined()
    focus.record('/w', 'Demo', 'cards/Demo/x', 2)
    expect(focus.focusProject('/w', ['Demo'])).toBe('Demo')
  })

  it('keeps buffers independent per cwd and clears on demand', () => {
    const focus = new BehaviorFocus()
    focus.record('/w1', 'A', 'cards/A/x', 1)
    focus.record('/w2', 'B', 'cards/B/x', 1)
    expect(focus.focusProject('/w1')).toBe('A')
    expect(focus.focusProject('/w2')).toBe('B')
    focus.clear('/w1')
    expect(focus.focusProject('/w1')).toBeUndefined()
    focus.dispose()
    expect(focus.focusProject('/w2')).toBeUndefined()
  })
})

describe('cwdFromActor', () => {
  it('reads the session cwd from a tool-execution actor', () => {
    const actor = { agent: { session: { header: { cwd: '/workspace' } } } }
    expect(cwdFromActor(actor)).toBe('/workspace')
    expect(cwdFromActor(undefined)).toBeUndefined()
    expect(cwdFromActor({})).toBeUndefined()
  })
})

describe('focusWeightFromActor', () => {
  it('classifies write/edit and non-view editor commands as writes', () => {
    expect(focusWeightFromActor({ name: 'write', arguments: {} })).toBe(FOCUS_WRITE_WEIGHT)
    expect(focusWeightFromActor({ name: 'edit', arguments: {} })).toBe(FOCUS_WRITE_WEIGHT)
    expect(focusWeightFromActor({ name: 'str_replace_editor', arguments: { command: 'str_replace' } })).toBe(FOCUS_WRITE_WEIGHT)
    expect(focusWeightFromActor({ name: 'str_replace_editor', arguments: { command: 'create' } })).toBe(FOCUS_WRITE_WEIGHT)
  })

  it('classifies reads, editor views, and unknown actors as reads', () => {
    expect(focusWeightFromActor({ name: 'read', arguments: {} })).toBe(FOCUS_READ_WEIGHT)
    expect(focusWeightFromActor({ name: 'read_image', arguments: {} })).toBe(FOCUS_READ_WEIGHT)
    expect(focusWeightFromActor({ name: 'str_replace_editor', arguments: { command: 'view' } })).toBe(FOCUS_READ_WEIGHT)
    expect(focusWeightFromActor(undefined)).toBe(FOCUS_READ_WEIGHT)
    expect(focusWeightFromActor({ arguments: {} })).toBe(FOCUS_READ_WEIGHT)
  })
})
