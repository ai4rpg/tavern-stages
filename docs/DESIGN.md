# Design: @ai4rpg/dsh-tavern-stages

## Problem

The tavern-cards repository provides three coding-agent skills for writing SillyTavern cards. We want those workflows to run inside DeepSeek Harness as a DSH plugin, using `@ai4rpg/dsh-stage-switch` as the stage-collaboration backbone.

This package is the plugin half. The companion GitHub-only tavern content repo (outside npm) ships the per-session agent preset `@ai4rpg/dsh-tavern-preset`, which carries the CC BY-NC-SA skill bodies and the main persona text, plus `@ai4rpg/tavern-agents` with the four agent personas (decision 8).

## Decisions

### 1. Stages match user workflow, not every tool step

The tavern stage config uses five stages:

- `route` — owns no artifact; classifies the user's request and forwards it to the owning stage (entry router; the implicit initial stage)
- `design` — tavern-design produces `design-spec.md`, and direction changes stay here even after the spec exists
- `planning` — tavern-cards aligns requirements and writes `创作规划.yaml`
- `content` — merged entries + MVU/EJS/configure + opening messages; detail tweaks to an already-planned entry land here, not in `design`
- `ui` — text status bar or tavern-ui frontend work

`route` exists because the AI used to sit in `design` by default and treat every request, even a detail tweak to an already-planned artifact, as design work. Routing the request up front keeps `design` for direction/spec work and sends concrete edits to the stage that owns the artifact. Adding `route` as the first stage makes it the implicit initial stage (StageController defaults to `stages[0].name`); route owns no deliverable, so it is never marked complete and never injects the `stage:policy` section, leaving it a pure entry router.

Packaging is not a stage: it is a recurring preview/verification action exposed through `/tavern-forge` and `/tavern-pack`.

### 2. One composite eligibility predicate

`dsh-stage-switch` shows the switch guidance while *any* registered eligibility predicate returns true. Registering one predicate per stage would therefore let any completed stage make the guidance appear in every stage, so the plugin registers a single predicate:

```ts
(agent) => status.isComplete(agent, ctx.stage.current(agent.session))
```

### 3. Synchronous predicate with async file refresh

`registerEligibility` is synchronous. File-system reads are async. The plugin refreshes a per-cwd cache during `agent/pre-step` before request assembly, and the predicate only reads that cache.

### 4. Completion = focused-project content checks + pack gate

Completion is judged for the **focused project**, not the workspace. The focus tracker (`BehaviorFocus`, `src/focus.ts`) infers the current project from recent `fs/observed` write/edit events on paths that carry a `cards/<project>/` segment; writes outweigh reference reads (5 to 2), so a write beats reads of other projects. This replaced an earlier workspace-level OR that urged a stage switch whenever a *different* project looked complete.

Per stage the plugin runs a content check on the focused project, and `content`/`ui` add a **pack gate**: content alone leaves the stage open until `pack` succeeds (`PackLedger`, `src/pack-ledger.ts`):

- `design` — `design-spec.md` exists **and is substantial**: real design prose, not a copied section skeleton or placeholder shell (`src/design.ts`)
- `planning` — `创作规划.yaml` exists without `# 待细化`
- `content` — planned entries registered (or state-inferred for old projects), MVU core files + `state.zod` + MVU manifest entries (when `mvu: true`), EJS entries carry `@@if` / EJS syntax (when planned), all manifest entries have `strategy` and `position` (configure has run), opening messages registered — **and the pack gate is satisfied**
- `ui` — projects with no UI work (worldbook / non-MVU / `ui_mode: none` with no UI files) count complete; otherwise every `正则/` replacement file the UI uses must read as deployed content (no local preview references, a real CDN/self-host payload — `src/ui.ts`) **and the pack gate is satisfied**

Artifact paths are resolved from the focused project's **registered `state_file` parent**, not a `cards/{Project}` guess: a multi-project workspace may place the project directory one level deeper, and guessing made every file check read `undefined`, leaving every stage permanently incomplete. A project with no registered `state_file` still falls back to the `cards/{Project}/` convention.

Old manual projects lose the auto-skip: a never-written spec or a missing planning doc keeps the stage open, and the model revisits via `goto_stage` instead.

### 5. Skills ship with the preset package, forge is an external model tool

The three skill bodies are CC BY-NC-SA content distributed by the tavern content repo's preset package (`@ai4rpg/dsh-tavern-preset`, outside npm) in its own `skills/` directory; its `skill-filesystem` row points there via `customSkillDirs`, so the official `dsh-tool-skill` catalog/loader exposes them. Skill registration is left to that package: this plugin's tarball (MIT) carries code only, and a preset-less deployment mounts its own `skill-filesystem` row pointing at a skills copy it supplies.

`@ai4rpg/tavern-cards-forge` is an external npm dependency (`^0.1.0`, resolved by pnpm/npm) and reaches the model as **one `tavern_forge` tool** (`src/forge.ts`) with `command` + `args: string[]`; packing is `command: 'pack'`, with a separate `tavern_pack` model tool deliberately left out. A successful pack emits the `tavern-cards/packed` event that satisfies the content/ui pack gate (decision 4). Human slash commands `/tavern-forge` and `/tavern-pack` stay as shortcuts. The skill bodies' own command examples use the same tool-call form (`tavern_forge({ command, args })`), rewritten by the preset package's sync script.

### 6. Installed as a dependency of the preset, no bundle patch

The plugin ships no `dsh.bundle.patch`: there is no host-plane row set to install or flip on. The normal install path is the preset package, installed by absolute path from a clone of the tavern content repo (`dsh plugin --profile <name> add file:<clone>/tavern-preset`; the preset package stays off npm because a published manifest cannot carry its `file:` persona dependency). It pulls this plugin (its dependency) in together with `@ai4rpg/dsh-stage-switch` and `@ai4rpg/tavern-cards-forge`, and per-session composition comes from the declared agent preset (decision 8). Programmatic embedders compose the plugin directly from the exports. The rows that bind model-facing delegation tools to dsh's `spawn` provider, and the child presets that give each child its persona, live in the preset package, so a deployment without the preset has no tavern surface at all. The disabled host-plane fallback that used to carry these rows for preset-less deployments was retired deliberately: the preset is the only supported deployment path.

### 7. Named subagents: declared as `spawn` + `agentPreset`, one child preset per agent

The four agents of the `@ai4rpg/tavern-agents` content package (check / conversion / schema / first-message) become model-visible delegation tools **by default**: the tavern preset composes one `@deepseek-ai/dsh-tool-subagent` row per agent (`provider: spawn`, `agentPreset: tavern-child-<name>`) plus one child agent preset per agent, all generated from `loadTavernAgents()`, so the rows, the presets, and the persona content cannot drift. This plugin registers no delegation provider and carries no delegation config: it supplies the persona loader and the stage/forge surface.

**Why this shape.** dsh 0.2.1 runs delegation through its own providers, and a local provider contributes only the creation input: the child is created and composed by the subagent service. An external provider cannot wrap a local child either — the service rejects any run whose id is already held by a local agent or session, so "external provider, local agent" is not a representable shape. Body prepending, the previous provider's only job, therefore has no seam. **Composition replaces it:** the child preset's `persona` prefix is the agent body, and its `plugins` list is that agent's tool set.

Consequences of moving agent identity into preset composition:

- **The child is an independent composition.** It no longer inherits the parent's persona or conversation context; its preset re-declares `agent-instructions`, `tool-fs`/`tool-fs-search`, the skill rows, and compaction. Stage rows are not part of a child preset, so a child gets no `goto_stage` guidance and no tavern stage policy.
- **Permission narrowing is declarative.** The check preset turns `tool-fs` writes off (`write: false`, `edit: false`) because that agent only reports; the conversion preset is the only one that carries `bash`/`pwsh` (its body runs a validation script). Everything else gets read/search/skill tools only.
- **Delegation is asynchronous.** Every call returns an activation id; the child's final answer arrives as the parent's completion notification. Skills that orchestrate serial work must wait for the notification rather than reading the tool result.
- **Child preset ids are a cold-resume contract.** `tavern-child-<name>` is recorded by child sessions; renaming or deleting one prevents those sessions from resuming. The content package's persona rule (add, never rename or delete) extends to these ids.
- **Skill discovery moved from the provider to the `skill` tool.** The child preset still mounts `skill-filesystem` with the same `customSkillDirs` and `tool-skill`, so referenced docs remain reachable through the returned resource base path. The old provider-appended absolute-path block and the `subagentSkillDirs` prompt key are gone; the accepted cost is one lookup per referenced skill (see README, “Named subagents”).
- **`{{` is load-bearing.** A body becomes a persona prefix, which dsh interpolates strictly, so a `{{…}}` macro in an agent body breaks the child's system prompt. The content package's validator enforces this; the guard is now functional, not advisory.
- **Effort and route stay native.** Child route and reasoning effort are set through each delegation row's `agentOptions` (merged over the parent route); the shipped rows leave it unset, so children follow the parent session route and, when the route is unchanged, its reasoning effort. Models differ in which effort values they accept, and forcing `max` can error on some. No plugin code participates.
- **Recommended base for the parent session: the official `standard` preset.** It supplies the `spawn` provider, the standard file/search/shell tools on the host's global fs, and the tavern workflow tools. Child presets are derived from it but keep only the rows their agent needs. In the parent session, project-file writes belong to the tracked editor tools (`write`/`edit` from `tool-fs`, plus `str_replace_editor` where the base mounts it): they emit `fs/observed`, which feeds the project-focus tracker behind `stage:policy`. `bash` redirection is for commands — its file writes are not tracked as project activity.
- **Four internal presets appear in the roster.** dsh 0.2.1 has no hidden flag, so they are named and described as internal child presets and ordered after the main preset; they are not meant for user sessions.

There is no delegation toggle in the UI: the preset ships the four delegation rows and their child presets. To turn delegation off, remove or disable those rows.

### 8. Per-session deployment: a declared preset, shipped by the content repo

Tavern context is scoped per session, not per process. Without this, a host-wide mount injects the route stage instruction into every first step, keeps `goto_stage`/`tavern_forge` in every tool catalog, and lists the tavern skills and delegation tools in every session — the plugin then pollutes every non-card task on the profile (the complaint that motivated this design).

A preset is now **declared**, not discovered: it is one `@deepseek-ai/dsh-agent-preset` row inside a profile patch whose `config.plugins` is the child composition, and `@deepseek-ai/dsh-agent-preset-registry` is the roster service (`ctx.agentPresets`, `mount(agentCtx, id?)`). The tavern preset is shipped by `@ai4rpg/dsh-tavern-preset`, the preset folder of the content repo, installed by path and outside npm; the web UI already ships preset selection, so neither package builds UI. Consequences:

- **The preset is derived, not retyped.** The preset package's generator takes the official `standard` composition and composes the tavern group from this package's exports — the stage-switch row's config is `tavernCardsStageConfig`, and the four delegation rows plus their child presets come from `loadTavernAgents()`. The group is appended, so upgrading this plugin moves the preset with it; the group keeps `isolate: { stage: true }` (below). The child presets are separate `@deepseek-ai/dsh-agent-preset` declarations, not rows of this group.
- **The group carries `isolate: { stage: true }`.** `StageController` publishes the `stage` service; a preset row publishing into the root realm is rejected at mount, and tavern-stages consumes `ctx.stage`, so the tavern rows (stage-switch, tavern-stages, the four delegation rows) sit inside one `cordis:group` with an entry-local realm for `stage`. Other services the group needs (`fs`, `sessionProjections`, `tokenMeter`, `tools`, `systemPrompt`, `skills`, `commands`, `subagents`) stay on the host plane and resolve from inside the realm.
- **The stage sidebar tab is host-plane, not a preset row.** The browser module roster only scans the main Loader tree, and preset rows live in a separate in-memory tree, so a client module declared inside a preset is never loaded. The tab is passive UI (no prompt section, no tool), so the preset package's patch carries it at the host plane, where the roster can see it.
- **Editing the preset in the Web editor replaces its whole `plugins` list.** Declared presets have no patch semantics, so an edited preset is a snapshot that drifts from later plugin and preset-package upgrades; regenerate or re-apply it to pick changes up.
- **Preset id stability.** A session records the preset id it ran under and resolves it again on resume; a missing definition is refused. The tavern preset id therefore stays `tavern-standard`.

### 9. Prompt copy is one JSON source with one derived artifact

All model-facing copy this package owns (stage instructions, `stage:policy` section, ui-complete, forge tool copy, command descriptions) lives in `src/prompts.json` — the single editable source. The three tavern skills' model-visible descriptions come from the preset package's `skills/<name>/SKILL.md` frontmatter instead (the official `dsh-tool-skill` catalog renders exactly that). `src/prompts.ts` reads the JSON at module load, overlaying a script-generated embedded fallback (`src/prompts.defaults.ts`) so a stale install without the JSON keeps working with byte-identical behavior. `scripts/prompts.mjs` (`list|show|set|sync`) edits the JSON and re-runs the regeneration, and `tests/prompts.spec.ts` pins the loaded overlay to the defaults, so a hand edit without re-syncing fails loudly. The sibling `@ai4rpg/dsh-stage-switch` uses the same pattern for its dialog copy; its parsing-sensitive strings (`Current stage:` prefix, `source.summary` shapes, the review id) deliberately stay in code because stage-switch parses them to recover the current stage.
