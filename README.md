# @ai4rpg/dsh-tavern-stages

DSH plugin that brings the [tavern-cards](https://github.com/ai4rpg/tavern-cards) skill workflows into the standalone `@ai4rpg/dsh-stage-switch` plugin. The design decision record is [docs/DESIGN.md](docs/DESIGN.md).

English | [中文](README.zh.md)

> Note: this plugin and its stage-switch base are published under `@ai4rpg/*`. The tavern content (the agent preset, skills, and personas) ships in a separate GitHub repo, the [tavern content repo](https://github.com/ai4rpg/tavern-content), outside npm. The `@deepseek-ai/*` packages appearing in this repo are upstream DSH dependencies (`dsh-agent`, `dsh-fs`, `dsh-session`, etc.), separate from this plugin's namespace.

It covers the three tavern-cards workflows:

- `tavern-design`: narrative/design-spec stage
- `tavern-cards`: planning, creation, MVU/EJS/configure, opening messages
- `tavern-ui`: status bar / frontend UI work

## What ships here, and what ships separately

This package is the **plugin**: the stage config for `dsh-stage-switch`, the project-workspace tooling (`tavern_forge`, focus tracking, the completion predicate), and the persona loader the preset generator uses to build its delegation rows and child presets.

The **agent preset** (`tavern-standard`), the three tavern skill bodies, the main preset's persona text, and the four agent personas ship in the companion **tavern content repo** ([github.com/ai4rpg/tavern-content](https://github.com/ai4rpg/tavern-content); clone it to install). It holds the `@ai4rpg/dsh-tavern-preset` preset package beside the `@ai4rpg/tavern-agents` persona package. The preset declares `tavern-standard` and composes this plugin's exports into it; its own READMEs and install guide carry the deployment detail.

## What it provides

- Provides `tavernCardsStageConfig` / `createTavernCardsStageConfig()` for `dsh-stage-switch`.
- Registers one composite eligibility predicate reporting whether the **current** stage is complete.
- Judges completion for the **focused project** (the focus tracker follows recent `fs/observed` writes), with per-stage content checks; `content`/`ui` additionally require a successful `pack` (the pack gate).
- Reads `.cardrc.json`, `design-spec.md`, `创作规划.yaml`, and `tavern-cards-state.json`.
- Exposes the forge CLI to the model as one `tavern_forge` tool (pack = `command: 'pack'`) and to humans as `/tavern-forge` + `/tavern-pack`; `@ai4rpg/tavern-cards-forge` stays an external npm dependency.
- Exports `loadTavernAgents()` (and `TavernAgentDescriptor`) so the preset package's generator can declare, for every agent in the `@ai4rpg/tavern-agents` content package, one delegation row (`provider: spawn`, `agentPreset: tavern-child-<name>`) and one child preset, from a single source — the rows, the presets, and the persona content cannot drift.
- Leaves skill registration to the preset package: the CC BY-NC-SA skill bodies ship there, exposed through the official `skill-filesystem` row.

## Usage

```ts
import { apply, tavernCardsStageConfig } from '@ai4rpg/dsh-tavern-stages'
import StageController from '@ai4rpg/dsh-stage-switch'

await ctx.plugin(StageController, tavernCardsStageConfig)
await ctx.plugin(apply)
```

## Installation

Tavern context is **per-session**: it loads only in sessions started on the tavern agent preset. Sessions on any other preset get no `route` instruction, no `goto_stage`/`tavern_forge` tools, and no tavern skills. Preset selection comes with DSH's web UI.

```sh
dsh plugin --profile <name> add file:<absolute path to your tavern-content clone>/tavern-preset
```

This plugin ships on npm; the preset package installs from the cloned content repo by absolute path (`dsh plugin` accepts absolute specs only). The profile pulls this plugin from npm as the preset's dependency.

Requires dsh `0.2.1-rc.2` or newer on the 0.2 line: the package declares `engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`, which dsh's plugin manager checks before loading it.

> **Preset compatibility:** in preset deployments, this release requires the 0.2.0 preset package. The 0.1.0 preset still declares the retired `tavern:*` providers and `subagents.enabled`; it is not compatible with this plugin. Update or regenerate the preset before switching.

Preset selection, defaults, verification, and the snapshot semantics of an edited preset are deployment concerns of the content repo; its [`tavern-preset/docs/install-guide.md`](https://github.com/ai4rpg/tavern-content/blob/main/tavern-preset/docs/install-guide.md) covers them.

## Configuration

Embed programmatically as shown in Usage. In preset deployments, parameters (the stage-switch `language`, the per-tool `agentOptions`) are set on the preset's own rows; see the preset package's README ([`tavern-preset/README.md`](https://github.com/ai4rpg/tavern-content/blob/main/tavern-preset/README.md)).

## Forge CLI access

The forge CLI arrives as the external `@ai4rpg/tavern-cards-forge` dependency (published on npm; its bin ships via `dist/index.mjs`), resolved by pnpm/npm through `node_modules`.

When `@deepseek-ai/dsh-commands` is composed, the plugin registers:

- `/tavern-forge <command> [args]`: run any forge command (`init`, `configure`, `query`, `patch`, `pack`, ...)
- `/tavern-pack <project>`: convenience wrapper for `tavern-cards-forge pack`

Examples:

```text
/tavern-forge init Demo --mvu
/tavern-forge configure Demo
/tavern-forge pack Demo
/tavern-pack Demo
```

This keeps packaging available in every stage.

## Named subagents

The four agent personas (`check-agent`, `conversion-agent`, `schema-agent`, `first-message-agent`) live in the `@ai4rpg/tavern-agents` content repo package (CC BY-NC-SA, licensed separately from this MIT package). This plugin registers no delegation provider and mounts no delegation tool. `loadTavernAgents()` reads every persona (name, frontmatter description, body), and the preset package's generator turns that list into:

- one `@deepseek-ai/dsh-tool-subagent` row per agent, bound to dsh's official `spawn` provider (`provider: spawn`) with `agentPreset: tavern-child-<name>`, and
- one child agent preset per agent (`tavern-child-<name>`) whose `persona` prefix is the persona body and whose tool set is declared for that agent's task (the check preset is read-only; only the conversion preset carries `bash`).

Each tool hands focused work to a fresh-context child (e.g. "run check-agent on these entries") instead of the model reviewing its own output. Delegation is asynchronous: the tool returns an activation id immediately, and the child's final answer arrives as the parent's completion notification. Wait for the notification before continuing with work that depends on the result; the tool result carries no answer. Child sessions are real, resumable sessions: the host can send follow-up messages, and a child's recorded preset id is resolved again on resume. That is why `tavern-child-<name>` is a stability contract — renaming or deleting one breaks resume for sessions already recorded under it.

The child is an independent composition, not a copy of the parent context: its persona and tool set come from its own preset, which re-declares `agent-instructions` and the tavern skills (`skill-filesystem` with the same `customSkillDirs`, plus `tool-skill`). When a body references docs by a path relative to a tavern skill directory, the child calls the `skill` tool once for that skill; the response carries the skill's resource base path, so the child reads its docs from there.

### Per-tool models & reasoning effort

Tool children inherit the parent session's model route and, when the route is unchanged, its connection-level reasoning effort; the shipped rows leave `agentOptions` unset because models differ in the effort values they accept. Route, effort, and `maxTokens` are native fields on each `tool-subagent-*` row's `agentOptions`; the content repo's [`tavern-preset/README.md`](https://github.com/ai4rpg/tavern-content/blob/main/tavern-preset/README.md) shows how to pin them per tool.

### Disabling the delegation tools

The plugin has no delegation switch; the four `tool-subagent-*` rows and their child presets are the whole wiring. Disable or remove those rows in the preset to hide the tools.

## Dependencies

- `@ai4rpg/dsh-stage-switch`: `^0.2.1`, the stage machine this plugin extends. 0.2.1 accepts both the dsh 0.2.0 and 0.2.1 lines in its peer range; the 0.2.x line reads session stage records through the mandatory `session-projection` seam (composed by `dsh-base`) and carries the `language` row config (`en` default, `zh` for the Chinese review dialogs).
- `@ai4rpg/tavern-cards-forge`: `^0.1.0`, the external forge CLI whose bin ships in `dist/index.mjs`.
- `@ai4rpg/tavern-agents`: the content repo package carrying the four agent personas (CC BY-NC-SA). It stays outside this package's manifest, because a published package cannot depend on a `file:` spec; the personas reach the profile through the preset package's `file:../tavern-agents` dependency inside the tavern content repo, where `resolveAgentsDir()` finds them with `createRequire`.

stage-switch and forge are plain versioned npm dependencies; the profile's pnpm install makes them resolvable to preset rows. DSH profiles set `autoInstallPeers: false`, so a package that existed only as a peer would not be installed.

## License

MIT. The agent personas ship in `@ai4rpg/tavern-agents` and the three tavern skill bodies in `@ai4rpg/dsh-tavern-preset` (content-repo packages, outside npm); both are CC BY-NC-SA 4.0 (attribution, non-commercial, share-alike), synced from [ai4rpg/tavern-cards](https://github.com/ai4rpg/tavern-cards). This package is MIT-only.
