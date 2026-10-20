// The agents content loader: the plugin's only remaining subagent surface.
//
// dsh 0.2.1 owns delegation (the preset declares `provider: spawn` +
// `agentPreset` rows and one child preset per agent), so this package no
// longer registers providers. What it still owes the preset generator is the
// persona list: `loadTavernAgents()` reads every `agents/*.md` of the
// `@ai4rpg/tavern-agents` content package through `TAVERN_AGENTS_ROOT` (tests)
// or `createRequire` (profile).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTavernAgents } from '../src/subagents.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

afterEach(() => {
  vi.unstubAllEnvs()
})

// The real content package is deliberately absent from this repo's manifest (a
// published manifest must not carry `file:` specs), so a fresh clone resolves
// nothing and the no-package case is exercisable. A local
// `npm i --no-save <tavern-content>/tavern-agents` flips the two probes: the
// no-package case skips and the real-package smoke runs.
const tavernAgentsResolvable = (() => {
  try {
    createRequire(import.meta.url).resolve('@ai4rpg/tavern-agents/package.json')
    return true
  } catch {
    return false
  }
})()

describe('loadTavernAgents', () => {
  it('loads one descriptor per persona, sorted by file stem, skipping the LICENSE note', async () => {
    // The override replaces resolution entirely, so the fixture set is the
    // only source even on a checkout that also has the real content package.
    vi.stubEnv('TAVERN_AGENTS_ROOT', join(FIXTURES, 'agents'))

    const agents = await loadTavernAgents()

    expect(agents.map(agent => agent.name)).toEqual(['alpha-agent', 'fixture-agent'])
    expect(agents[0]!.description).toBe('Fixture persona pinning the agents-loader sort order; never shipped.')
    expect(agents[0]!.body).toBe('# alpha-agent\n\nFixture body: sorts before `fixture-agent.md`.\n')
    // The body is the text below the frontmatter; it becomes the child
    // preset's persona prefix, so it must not carry the frontmatter itself.
    expect(agents[1]!.body.startsWith('# fixture-agent')).toBe(true)
    expect(agents[1]!.body).toContain('references/rules-check.md')
    // LICENSE.md ships beside the personas and is not one of them.
    expect(agents.some(agent => agent.name === 'LICENSE')).toBe(false)
  })

  it('returns [] when the agents directory cannot be read', async () => {
    vi.stubEnv('TAVERN_AGENTS_ROOT', join(FIXTURES, 'agents-missing'))
    await expect(loadTavernAgents()).resolves.toEqual([])
  })

  it.skipIf(tavernAgentsResolvable)('returns [] when the content package is not resolvable', async () => {
    // No override: `createRequire` misses in a clean checkout. The preset
    // generator then declares no delegation rows instead of the mount failing.
    await expect(loadTavernAgents()).resolves.toEqual([])
  })

  it.skipIf(!tavernAgentsResolvable)('loads the four personas from the resolved content package', async () => {
    // Real-package smoke: the profile path (`createRequire`, no override).
    // Enabled locally with `npm i --no-save <tavern-content>/tavern-agents`.
    const agents = await loadTavernAgents()
    expect(agents.map(agent => agent.name).sort()).toEqual([
      'check-agent',
      'conversion-agent',
      'first-message-agent',
      'schema-agent',
    ])
    for (const agent of agents) {
      expect(agent.description.length).toBeGreaterThan(0)
      expect(agent.body.length).toBeGreaterThan(0)
      // The body becomes a persona prefix, which dsh interpolates strictly;
      // the content package's validator forbids `{{` and this smoke pins it.
      expect(agent.body).not.toContain('{{')
    }
  })
})
