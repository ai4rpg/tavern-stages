# Design: @ai4rpg/dsh-tavern-stages

## Problem

The tavern-cards repository provides three coding-agent skills for writing SillyTavern cards. We want those workflows to run inside DeepSeek Harness as a DSH plugin, using `@ai4rpg/dsh-stage-switch` as the stage-collaboration backbone.

This package is the plugin half. The per-session agent preset that composes it, plus the CC BY-NC-SA skill bodies and the persona prose, ships as the companion package `@ai4rpg/dsh-tavern-preset`: a folder in the GitHub-only tavern content repo, outside npm (decision 8).

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

`tavern-cards-forge` is an external npm dependency (`^0.1.0`, resolved by pnpm/npm) and reaches the model as **one `tavern_forge` tool** (`src/forge.ts`) with `command` + `args: string[]`; packing is `command: 'pack'`, with a separate `tavern_pack` model tool deliberately left out. A successful pack emits the `tavern-cards/packed` event that satisfies the content/ui pack gate (decision 4). Human slash commands `/tavern-forge` and `/tavern-pack` stay as shortcuts. The skill bodies' own command examples use the same tool-call form (`tavern_forge({ command, args })`), rewritten by the preset package's sync script.

### 6. Installed as a dependency of the preset, no bundle patch

The plugin ships no `dsh.bundle.patch`: there is no host-plane row set to install or flip on. The normal install path is the preset package, installed by absolute path from a clone of the tavern content repo (`dsh plugin --profile <name> add file:<clone>/tavern-preset`; the preset package stays off npm because its `file:` persona dependency cannot ship in a published manifest). It pulls this plugin (its dependency) in together with `@ai4rpg/dsh-stage-switch` and `tavern-cards-forge`, and per-session composition comes from the declared agent preset (decision 8). Programmatic embedders compose the plugin directly from the exports. The rows that bind model-facing tools to the `tavern:<name>` providers live in the preset's tavern group, so a deployment without the preset has no tavern surface at all. The disabled host-plane fallback that used to carry these rows for preset-less deployments was retired deliberately: the preset is the only supported deployment path.

### 7. Named subagents default-on, host-supplied, body-prepend instead of persona

The four personas of the `@ai4rpg/tavern-agents` content package (check / conversion / schema / first-message) become model-visible delegation tools **by default**: the tavern preset composes one `tool-subagent` row per agent, generated from `loadTavernAgents()`, so the rows and the providers cannot drift. The plugin config has **no effort/route knob**: child route and reasoning effort are native `AgentOptions`, tuned per `tool-subagent` row via `agentOptions`; the shipped rows keep it unset, so children follow the deployment/connection default resolution like a plain spawn child (models differ in which effort values they accept, and forcing `max` can error on some). The wiring activates once the host composes a `subagents` service with a spawn-capable provider; `dsh-base` already composes `@deepseek-ai/dsh-subagent-spawn-in-process` (`providerName: spawn`) on every standard profile, so the tools are active out of the box in a tavern preset session; on a host without `subagents`, the tool rows stay pending and the stage/forge features still work. There is no UI toggle for subagents, so the preset ships them enabled; to disable, set `subagents.enabled: false` on the `tavern-stages` row.

The wiring is split between the plugin and the preset: the plugin registers one in-process provider per agent under `tavern:<name>`; the model-facing tools are declarative `@deepseek-ai/dsh-tool-subagent` rows in the preset's tavern group, bound to those provider names, so `agentOptions` (provider/model/reasoningEffort/maxTokens), `toolFilter`, and `maxDepth` are per-preset tunable without plugin code. Registration is **idempotent** — the plugin runs once per preset id (tavern-standard) and again whenever a preset-file edit re-mounts the preset, and `subagents.registerProvider` registers on a process-lifetime registry and throws `DUPLICATE_PROVIDER` for a reused name, so a later mount shares the first mount's provider (the shared provider carries no per-mount configuration: route/effort/maxTokens resolve per call from each row's `agentOptions`). One rule governs the provider implementation (wiring notes in `src/subagents.ts`):

- **Agent body goes to the prompt, not the persona.** The body is prepended to the child's first user message; a persona section is never registered, since it would override the host's persona, drop its `complete` flag, and let runtime contexts leak into the child's first request.
- **The custom provider exists only to prepend the body.** Its only job is prepending the agent body to the child's first prompt (plus resolving the skill directories that body references); `persona` stays unset. Effort is native: a row's `agentOptions` flows through `request.agentOptions` → `resolveChildAgentOptions` → `agents.create`, and the agent loop reads `options.reasoningEffort` at request composition, with no `agent/created` + `installModelSelection` injection.
- **Skill directory resolution is best-effort.** The referenced tavern skill names are read out of the body prose (`/\b(tavern-[a-z0-9][a-z0-9-]*)\b/g`), resolved through the `skills` registry at the parent's scope, and appended as absolute paths; when the `skills` service is absent or a name misses, the body is passed through verbatim and the spawn proceeds.
- **Recommended base: the official `standard` preset.** The session's preset supplies the `spawn` provider, the standard `read`/`write`/`edit`/`glob`/`grep` tools on the host's global fs plus `bash`, and the tavern workflow tools. Project-file writes belong to the tracked editor tools (`write`/`edit` from `tool-fs`, plus `str_replace_editor` where the base mounts it): they emit `fs/observed`, which feeds the project-focus tracker behind `stage:policy`. `bash` redirection is for commands — its file writes are not tracked as project activity.
- **Accepted gap: the standard persona is not `complete`.** The inheritance above is cleanest when the host persona is `complete: true` with `includeRuntimeContext: false`. The official `standard` persona is neither, so tavern children inherit the full host prompt (persona, agent instructions, runtime contexts) instead of a minimal one. Two things keep that usable: the child's own task arrives as the body prepended to its first user message, and stage-switch skips the stage-prompt injection for subagent sessions, so a child is never told to call `goto_stage`. Fixing this by setting `persona` on a tool-subagent row would override the host persona and reintroduce exactly what body-prepending avoids; the rule lives in AGENTS.md. `tests/helpers/preset-fixtures.ts` keeps the `complete: true` condition pinned at the unit tier: it exercises the inheritance mechanism, not the shipped preset.
- **One-shot only.** Continuable children (the resident "worldbuilding commissioner") are a later phase; the provider refuses `prepareContinuable` loudly rather than silently dropping the persona body. The seam is the blocker: `prepareContinuable` returns only a fork `seed` and the continuation manager composes persona/toolFilter from the tool config, leaving no provider hook to prepend the body; continuable tavern agents would have to abandon body-prepending for a persona section, which overrides the host's persona and leaks runtime contexts into the child's first request.

### 8. Per-session deployment: a declared preset, shipped by the content repo

Tavern context is scoped per session, not per process. Without this, a host-wide mount injects the route stage instruction into every first step, keeps `goto_stage`/`tavern_forge` in every tool catalog, and lists the tavern skills and delegation tools in every session — the plugin then pollutes every non-card task on the profile (the complaint that motivated this design).

A preset is now **declared**, not discovered: it is one `@deepseek-ai/dsh-agent-preset` row inside a profile patch whose `config.plugins` is the child composition, and `@deepseek-ai/dsh-agent-preset-registry` is the roster service (`ctx.agentPresets`, `mount(agentCtx, id?)`). The tavern preset is shipped by `@ai4rpg/dsh-tavern-preset`, the preset folder of the content repo, installed by path and outside npm; the web UI already ships preset selection, so neither package builds UI. Consequences:

- **The preset is derived, not retyped.** The preset package's generator takes the official `standard` composition and composes the tavern group from this package's exports — the stage-switch row's config is `tavernCardsStageConfig`, and the four `tool-subagent` rows come from `loadTavernAgents()`. The group is appended, so upgrading this plugin moves the preset with it; the group keeps `isolate: { stage: true }` (below).
- **The group carries `isolate: { stage: true }`.** `StageController` publishes the `stage` service; a preset row publishing into the root realm is rejected at mount, and tavern-stages consumes `ctx.stage`, so the tavern rows (stage-switch, tavern-stages, the four tool-subagent rows) sit inside one `cordis:group` with an entry-local realm for `stage`. Other services the group needs (`fs`, `sessionProjections`, `tokenMeter`, `tools`, `systemPrompt`, `skills`, `commands`, `subagents`) stay on the host plane and resolve from inside the realm.
- **The stage sidebar tab is host-plane, not a preset row.** The browser module roster only scans the main Loader tree, and preset rows live in a separate in-memory tree, so a client module declared inside a preset is never loaded. The tab is passive UI (no prompt section, no tool), so the preset package's patch carries it at the host plane, where the roster can see it.
- **Editing the preset in the Web editor replaces its whole `plugins` list.** Declared presets have no patch semantics, so an edited preset is a snapshot that drifts from later plugin and preset-package upgrades; regenerate or re-apply it to pick changes up.
- **Preset id stability.** A session records the preset id it ran under and resolves it again on resume; a missing definition is refused. The tavern preset id therefore stays `tavern-standard`.

### 9. Prompt copy is one JSON source with one derived artifact

All model-facing copy this package owns (stage instructions, `stage:policy` section, ui-complete, the subagent skill-directory path block, forge tool copy, command descriptions) lives in `src/prompts.json` — the single editable source. The three tavern skills' model-visible descriptions come from the preset package's `skills/<name>/SKILL.md` frontmatter instead (the official `dsh-tool-skill` catalog renders exactly that). `src/prompts.ts` reads the JSON at module load, overlaying a script-generated embedded fallback (`src/prompts.defaults.ts`) so a stale install without the JSON keeps working with byte-identical behavior. `scripts/prompts.mjs` (`list|show|set|sync`) edits the JSON and re-runs the regeneration, and `tests/prompts.spec.ts` pins the loaded overlay to the defaults, so a hand edit without re-syncing fails loudly. The sibling `@ai4rpg/dsh-stage-switch` uses the same pattern for its dialog copy; its parsing-sensitive strings (`Current stage:` prefix, `source.summary` shapes, the review id) deliberately stay in code because stage-switch parses them to recover the current stage.
