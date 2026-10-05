# @ai4rpg/dsh-tavern-stages

DSH plugin that brings the [tavern-cards](https://github.com/ai4rpg/tavern-cards) skill workflows into the standalone `@ai4rpg/dsh-stage-switch` plugin. The design decision record is [docs/DESIGN.md](docs/DESIGN.md).

English | [中文](README.zh.md)

> Note: this plugin and its stage-switch base are published under `@ai4rpg/*`. The tavern content (the agent preset, the three tavern skills, the persona prose, and the four subagent personas) ships in a separate GitHub repo, the [tavern content repo](https://github.com/ai4rpg/tavern-content), outside npm. The `@deepseek-ai/*` packages appearing in this repo are upstream DSH dependencies (`dsh-agent`, `dsh-fs`, `dsh-session`, etc.), separate from this plugin's namespace.

It covers the three tavern-cards workflows:

- `tavern-design`: narrative/design-spec stage
- `tavern-cards`: planning, creation, MVU/EJS/configure, opening messages
- `tavern-ui`: status bar / frontend UI work

## What ships here, and what ships separately

This package is the **plugin**: the stage config for `dsh-stage-switch`, the project-workspace tooling (`tavern_forge`, focus tracking, the completion predicate), and the named-subagent providers.

The **agent preset** (`tavern-standard`), the three tavern skill bodies, the persona prose, and the four subagent personas ship in the companion **tavern content repo** ([github.com/ai4rpg/tavern-content](https://github.com/ai4rpg/tavern-content); clone it, since it stays off npm). It holds the `@ai4rpg/dsh-tavern-preset` preset package beside the `@ai4rpg/tavern-agents` persona package. The preset declares `tavern-standard` and composes this plugin's exports into it; **installing that package is the normal install path**, pulling this plugin in as a dependency. Its own READMEs and install guide carry the deployment detail.

## What it provides

- Provides `tavernCardsStageConfig` / `createTavernCardsStageConfig()` for `dsh-stage-switch`.
- Registers one composite eligibility predicate reporting whether the **current** stage is complete.
- Judges completion for the **focused project** (the focus tracker follows recent `fs/observed` writes), with per-stage content checks; `content`/`ui` additionally require a successful `pack` (the pack gate).
- Reads `.cardrc.json`, `design-spec.md`, `创作规划.yaml`, and `tavern-cards-state.json`.
- Exposes the forge CLI to the model as one `tavern_forge` tool (pack = `command: 'pack'`) and to humans as `/tavern-forge` + `/tavern-pack`; `@ai4rpg/tavern-cards-forge` stays an external npm dependency.
- Exports `loadTavernAgents()` (and `TavernAgentDescriptor`) so the preset package's generator can declare one `tool-subagent` row per persona in the `@ai4rpg/tavern-agents` content package, from the same source the providers register from.
- Leaves skill registration to the preset package: the CC BY-NC-SA skill bodies ship there, exposed through the official `skill-filesystem` row.

## Usage

```ts
import { apply, tavernCardsStageConfig } from '@ai4rpg/dsh-tavern-stages'
import StageController from '@ai4rpg/dsh-stage-switch'

await ctx.plugin(StageController, tavernCardsStageConfig)
await ctx.plugin(apply)
```

## Installation

Tavern context is **per-session**: it loads only in sessions started on the tavern agent preset, so sessions on any other preset stay tavern-free (free of the route instruction, the `goto_stage`/`tavern_forge` tools, and the tavern skills). Preset selection comes with DSH's web UI.

```sh
dsh plugin --profile <name> add file:<absolute path to your tavern-content clone>/tavern-preset
```

This plugin ships on npm; the preset package installs from the cloned content repo by absolute path (`dsh plugin` accepts absolute specs only). The profile pulls this plugin from npm as the preset's dependency, and the preset's own `file:` dependency brings the persona content package along.

Preset selection, defaults, verification, and the snapshot semantics of an edited preset are deployment concerns of the content repo; its [`tavern-preset/docs/install-guide.md`](https://github.com/ai4rpg/tavern-content/blob/main/tavern-preset/docs/install-guide.md) covers them.

## Configuration

Embed programmatically as shown in Usage. In preset deployments, parameters (the stage-switch `language`, the per-tool `agentOptions`, `subagents.enabled`) are set on the preset's own rows; see the preset package's README ([`tavern-preset/README.md`](https://github.com/ai4rpg/tavern-content/blob/main/tavern-preset/README.md)).

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

The four agent personas (`check-agent`, `conversion-agent`, `schema-agent`, `first-message-agent`) live in the `@ai4rpg/tavern-agents` content package (CC BY-NC-SA, licensed separately from this MIT package). The plugin registers one provider per persona as `tavern:<name>`. The model-visible tools are declarative: the preset's tavern group carries one `@deepseek-ai/dsh-tool-subagent` row per agent, bound to those providers. Each tool lets the model hand focused work to a fresh-context child agent (e.g. "run check-agent on these entries") instead of reviewing its own output.

`loadTavernAgents()` reads every persona (name, frontmatter description, body) so the preset generator declares those rows from the same source the providers register from; the two cannot drift.

Providers register when `subagents.enabled` is set **and** the host composes a `subagents` service with a spawn-capable provider. `dsh-base` already composes `@deepseek-ai/dsh-subagent-spawn-in-process` (`providerName: spawn`) on every standard profile, so they are active out of the box in a tavern preset session; the shipped preset sets `subagents.enabled: true`.

### Child prompt inheritance

Children inherit the host's system prompt. The agent body is prepended to the child's first user message, leaving the `persona` section to the host, so the host persona stays in place. The shipped `tavern-standard` base carries the full official persona rather than a `complete: true` minimal one; that is acceptable: the child's task arrives as the prepended body, and stage-switch skips the stage-prompt injection for subagent sessions. In a tavern session, write project files with the tracked editor tools (`write`/`edit`, plus `str_replace_editor` where the base mounts it): they emit `fs/observed`, which feeds the project-focus tracker behind `stage:policy`; file writes made through `bash` bypass that tracking. The provider also appends the absolute directories of the tavern skills a body references, so a child can read its `references/` docs directly, saving a `skill` lookup.

See `docs/DESIGN.md` decision 7 for the full rationale (inheritance, effort resolution, the one-shot-only stance).

### Per-tool models & reasoning effort

Tool children inherit the session's model route and (by default) its connection-level reasoning effort; the shipped rows leave `agentOptions` unset because models differ in the effort values they accept. Route, effort, and `maxTokens` are native `AgentOptions` on each `tool-subagent-*` row; the content repo's [`tavern-preset/README.md`](https://github.com/ai4rpg/tavern-content/blob/main/tavern-preset/README.md) shows how to pin them per tool.

### Code

```ts
await ctx.plugin(apply, {
  subagents: {
    enabled: true,
  },
})
```

## Dependencies

- `@ai4rpg/dsh-stage-switch`: `^0.2.0`, the stage machine this plugin extends. 0.2.0 reads session stage records through the mandatory `session-projection` seam (composed by `dsh-base`) and carries the `language` row config (`en` default, `zh` for the Chinese review dialogs).
- `@ai4rpg/tavern-cards-forge`: `^0.1.0`, the external forge CLI whose bin ships in `dist/index.mjs`.
- `@ai4rpg/tavern-agents`: the content package carrying the four named-subagent personas (CC BY-NC-SA). It stays outside this package's manifest, since published manifests carry versioned specs only; the personas reach the profile through the preset package's `file:../tavern-agents` dependency inside the tavern content repo, where `resolveAgentsDir()` finds them with `createRequire`.

stage-switch and forge are plain versioned npm dependencies; the profile's pnpm install makes them resolvable to preset rows.

## License

MIT. The named-subagent personas ship in the `@ai4rpg/tavern-agents` and the three tavern skill bodies in `@ai4rpg/dsh-tavern-preset` (content-repo packages, outside npm); both are CC BY-NC-SA 4.0 (attribution, non-commercial, share-alike), synced from [ai4rpg/tavern-cards](https://github.com/ai4rpg/tavern-cards). This package is MIT-only.
