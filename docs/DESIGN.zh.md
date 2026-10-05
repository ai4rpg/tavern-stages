# 设计：@ai4rpg/dsh-tavern-stages

## 问题

tavern-cards 仓库提供了三套用于编写 SillyTavern 卡片的 coding-agent skill。我们希望把这些工作流作为 DSH 插件运行在 DeepSeek Harness 内，并以 `@ai4rpg/dsh-stage-switch` 作为阶段协作骨架。

本包是其中的插件半边。组合它的按会话 agent 预设，连同 CC BY-NC-SA 的技能正文与 persona 散文，由配套包 `@ai4rpg/dsh-tavern-preset` 分发：它是只发 GitHub 的 tavern 内容仓里的一个目录，不上 npm（决策 8）。

## 决策

### 1. 阶段匹配用户工作流，而不是每个工具步骤

tavern 阶段配置使用五个阶段：

- `route` —— 不持有任何产物；对用户请求分类后转发给持有它的阶段（入口路由；隐式初始阶段）
- `design` —— tavern-design 产出 `design-spec.md`；方向变更即使 spec 已存在也留在这里
- `planning` —— tavern-cards 对齐需求并写出 `创作规划.yaml`
- `content` —— 合并条目 + MVU/EJS/configure + 开场白；对已规划条目的细节调整落在这里，不在 `design`
- `ui` —— 文本状态栏或 tavern-ui 前端工作

`route` 存在的原因：AI 以前默认停在 `design`，把每个请求（哪怕是对已规划产物的细节调整）都当成设计工作。把请求提前路由出去，让 `design` 专注方向/spec 工作，把具体修改送到持有该产物的阶段。把 `route` 加为第一个阶段使它成为隐式初始阶段（StageController 默认取 `stages[0].name`）；route 不持有交付物，所以它永远不会被判完成、也永远不会注入 `stage:policy` section，始终只是一个纯入口路由。

打包不是阶段：它是反复出现的预览/验证动作，通过 `/tavern-forge` 与 `/tavern-pack` 暴露。

### 2. 一个复合判定器

`dsh-stage-switch` 在**任一**已注册判定器返回 true 时显示切换引导。为每个阶段各注册一个判定器，会让任何一个阶段的完成都使引导在所有阶段出现。因此插件只注册一个判定器：

```ts
(agent) => status.isComplete(agent, ctx.stage.current(agent.session))
```

### 3. 同步判定器 + 异步文件刷新

`registerEligibility` 是同步的，文件系统读取是异步的。插件在请求装配之前于 `agent/pre-step` 刷新一份按 cwd 的缓存，判定器只读这份缓存。

### 4. 完成判定 = 焦点项目内容检查 + pack gate

完成判定针对**焦点项目**，不是 workspace。焦点追踪器（`BehaviorFocus`，`src/focus.ts`）从近期发生在项目自有路径（即带 `cards/<project>/` 段的路径）上的 `fs/observed` 写/编辑事件推断当前项目；写入权重 5、参考读取权重 2，所以一次写入压过对其它项目的读取。这取代了早先的 workspace 级 OR：后者只要**另一个**项目看起来已完成就催促切换阶段。

每个阶段插件都对焦点项目跑一次内容检查，`content`/`ui` 另加一道 **pack gate**（打包门禁）：只凭内容永远不足以完成该阶段，直到 `pack` 成功（`PackLedger`，`src/pack-ledger.ts`）：

- `design` —— `design-spec.md` 存在**且有实质内容**：是真正的设计叙述，不是复制的章节骨架或占位空壳（`src/design.ts`）
- `planning` —— `创作规划.yaml` 存在且不含 `# 待细化`
- `content` —— 规划条目已注册（老项目按 state 推断）、MVU 核心文件 + `state.zod` + MVU manifest 条目（`mvu: true` 时）、EJS 条目带 `@@if` / EJS 语法（规划声明时）、所有 manifest 条目都有 `strategy` 与 `position`（configure 已执行）、开场白已注册——**且 pack gate 已满足**
- `ui` —— 无 UI 工作的项目（worldbook / 非 MVU / 无 UI 文件的 `ui_mode: none`）算完成；否则 UI 用到的每个 `正则/` 替换文件都必须读作已部署内容（无本地预览引用、真正的 CDN/自托管 payload——`src/ui.ts`）**且 pack gate 已满足**

产物路径从焦点项目**已注册的 `state_file` 父目录**解析，而不是猜 `cards/{Project}`：多项目 workspace 可能把项目目录放得更深一层，靠猜会让每个文件检查都读到 `undefined`（没有任何阶段能注册为已完成）。未注册 `state_file` 的项目仍回退到 `cards/{Project}/` 约定。

老的手工项目失去自动跳过：从未写过的 spec 或缺失的规划文档会让阶段保持打开，模型改用 `goto_stage` 回访。

### 5. 技能随预设包分发，forge 是外部模型工具

三个技能正文是由内容仓预设包（`@ai4rpg/dsh-tavern-preset`，不上 npm）分发的 CC BY-NC-SA 内容，放在它自己的 `skills/` 目录；它的 `skill-filesystem` 行通过 `customSkillDirs` 指向那里，因此官方 `dsh-tool-skill` 的 catalog/加载器会暴露它们。技能注册交给那个包：本插件 tarball（MIT）只含代码；无预设的部署自己挂载一行 `skill-filesystem`，指向它自备的技能副本。

`tavern-cards-forge` 是外部 npm 依赖（`^0.1.0`，由 pnpm/npm 解析），以**一个 `tavern_forge` 工具**（`src/forge.ts`，`command` + `args: string[]`）到达模型；打包即 `command: 'pack'`，`tavern_pack` 模型工具被刻意排除。成功打包会 emit `tavern-cards/packed` 事件，满足 content/ui 的 pack gate（决策 4）。人类 slash 命令 `/tavern-forge` 与 `/tavern-pack` 保留为快捷入口。技能正文自己的命令示例使用同一工具调用形式（`tavern_forge({ command, args })`），由预设包的同步脚本改写。

### 6. 作为预设包的依赖安装，不带 bundle patch

本插件**不**携带 `dsh.bundle.patch`：没有可供安装或翻转启用的宿主平面行。正常安装路径是预设包：从 tavern 内容仓的克隆按绝对路径安装（`dsh plugin --profile <name> add file:<克隆路径>/tavern-preset`；预设包的 `file:` 人格依赖使它不能上 npm）。它把本插件（其依赖）连同 `@ai4rpg/dsh-stage-switch` 与 `tavern-cards-forge` 一并装入；按会话的组合来自声明式 agent 预设（决策 8）。编程式嵌入方直接从导出组合本插件。把模型可见工具绑定到 `tavern:<name>` provider 的那些行住在预设的 tavern 组里，因此没有预设的部署完全没有 tavern 表面。曾经为无预设部署携带这些行的 disabled 宿主平面兜底已被刻意退役：预设是唯一受支持的部署路径。

### 7. 具名子代理默认开启、由宿主提供、正文前置而非 persona

`@ai4rpg/tavern-agents` 内容包的四个 persona（check / conversion / schema / first-message）**默认**成为模型可见的委派工具：tavern 预设为每个 agent 组合一行 `tool-subagent`，由 `loadTavernAgents()` 生成，因此这些行与 provider 不可能漂移。插件配置**没有 effort/路由旋钮**：子代理路由与推理力度是原生 `AgentOptions`，按 `tool-subagent` 行经 `agentOptions` 调整；随包行保持不设，所以子代理像普通 spawn 子代理一样跟随部署/连接默认解析（不同模型接受的 effort 值不同，强制 `max` 可能让部分模型报错）。接线在宿主组合了带 spawn 能力的 `subagents` service 时激活；`dsh-base` 已在每个标准 profile 上组合 `@deepseek-ai/dsh-subagent-spawn-in-process`（`providerName: spawn`），所以这些工具在 tavern 预设会话里开箱即用；在没有 `subagents` 的宿主上，工具行保持 pending，阶段/forge 功能仍可用。子代理没有 UI 开关，所以预设以启用状态分发；要关闭，在 `tavern-stages` 行上设 `subagents.enabled: false`。

接线在插件与预设之间拆分：插件为每个 agent 在 `tavern:<name>` 下注册一个 in-process provider；模型可见工具是声明式的 `@deepseek-ai/dsh-tool-subagent` 行，住在预设的 tavern 组里，绑定到这些 provider 名，因此 `agentOptions`（provider/model/reasoningEffort/maxTokens）、`toolFilter` 与 `maxDepth` 都能按预设调整，无需插件代码。注册是**幂等**的：插件对每个预设 id 运行一次（tavern-standard），预设文件编辑触发重新挂载时再运行一次，而 `subagents.registerProvider` 注册在进程生命周期的注册表上、重名抛 `DUPLICATE_PROVIDER`，所以后一次挂载共享先一次挂载的 provider（共享 provider 不带 per-mount 配置：路由/力度/maxTokens 每次调用都从各行的 `agentOptions` 解析）。provider 的实现只遵循一条规则（接线说明见 `src/subagents.ts`）：

- **agent 正文进 prompt，不进 persona。** 正文前置到子代理的首条 user message，绝不注册成 persona section。persona section 会覆盖宿主 persona 并丢掉它的 `complete` 标记，让运行时上下文泄漏进子代理首请求。
- **自定义 provider 只为正文前置存在。** provider 唯一的职责是把 agent 正文前置到子代理首条 prompt（外加解析正文引用的技能目录）；`persona` 必须保持不设。力度是原生能力：行的 `agentOptions` 经 `request.agentOptions` → `resolveChildAgentOptions` → `agents.create`，agent-loop 在请求组装时读 `options.reasoningEffort`，没有 `agent/created` + `installModelSelection` 注入。
- **技能目录解析是 best-effort 的。** 被引用的 tavern 技能名从正文散文里读出（`/\b(tavern-[a-z0-9][a-z0-9-]*)\b/g`），在父代理的 scope 上经 `skills` 注册表解析，并作为绝对路径追加；没有 `skills` 服务或没有命中时，正文逐字传递，spawn 照常继续。
- **推荐基座：官方 `standard` 预设。** 会话的预设提供 `spawn` provider、宿主全局 fs 上的标准 `read`/`write`/`edit`/`glob`/`grep` 工具加 `bash`，以及 tavern 工作流工具。项目文件写入应走**被追踪的编辑工具**（`tool-fs` 的 `write`/`edit`；基座挂了 `str_replace_editor` 时也含它）：它们发出 `fs/observed`，喂给 `stage:policy` 背后的项目焦点追踪。`bash` 重定向用于跑命令——经它产生的文件写入不被计为项目活动。
- **接受的缺口：standard persona 不是 `complete`。** 上面这套继承在宿主 persona 是 `complete: true` 且 `includeRuntimeContext: false` 时最干净。官方 `standard` persona 两者都不是，所以 tavern 子代理继承的是**完整宿主提示**（persona、agent instructions、运行时上下文）而非极简版。两件事使它仍然可用：子代理自己的任务以正文形式前置到它的首条 user 消息，且 stage-switch 对子代理会话跳过阶段提示注入，所以子代理不会被告知去调 `goto_stage`。在 `tool-subagent` 行上设 `persona` 来「修」这一点会覆盖宿主 persona、重新引入正文前置要避开的问题；该禁令记录在 AGENTS.md。`tests/helpers/preset-fixtures.ts` 在单元层继续钉住 `complete: true` 条件：它演练的是继承机制，不是随包预设。
- **仅 one-shot。** continuable 子代理（驻留的「世界书创作专员」）是后续阶段；provider 大声拒绝 `prepareContinuable`，而不是静默丢掉 persona 正文。卡点在 seam：`prepareContinuable` 只返回 fork `seed`，continuation manager 从工具 config 组合 persona/toolFilter，因此 provider 没有可前置正文的钩子；continuable tavern 代理将不得不放弃正文前置改用 persona section，而那会覆盖宿主 persona 并把运行时上下文泄漏进子代理首请求。

### 8. 按会话部署：声明式预设，由内容仓分发

tavern 上下文是按会话作用域的，不是按进程。没有这一点，宿主级挂载会把 route 阶段指令注入每个首步、让 `goto_stage`/`tavern_forge` 留在每个工具目录、在每个会话里列出 tavern 技能与委派工具，插件因此污染 profile 上每一个非卡片任务（这正是催生本设计的投诉）。

预设现在是**声明**的，不是被发现的：它就是 profile patch 里一行 `@deepseek-ai/dsh-agent-preset`，其 `config.plugins` 是子组合，而 `@deepseek-ai/dsh-agent-preset-registry` 是 roster 服务（`ctx.agentPresets`、`mount(agentCtx, id?)`）。tavern 预设由 `@ai4rpg/dsh-tavern-preset` 分发，即内容仓里的预设目录，按路径安装、不上 npm；Web UI 已自带预设选择，所以两个包都不构建 UI。推论：

- **预设是派生的，不是重打的。** 预设包的生成器取官方 `standard` 组合，并从本包的导出组合出 tavern 组：stage-switch 行的 config 是 `tavernCardsStageConfig`，四个 `tool-subagent` 行来自 `loadTavernAgents()`。组是追加的，所以升级本插件会带着预设一起走；组保持 `isolate: { stage: true }`（见下）。
- **组携带 `isolate: { stage: true }`。** `StageController` 发布 `stage` service；预设行向根 realm 发布会在挂载时被拒，而 tavern-stages 消费 `ctx.stage`，所以 tavern 各行（stage-switch、tavern-stages、四个 tool-subagent 行）坐在一个 `cordis:group` 内，`stage` 用 entry-local realm。组需要的其它 service（`fs`、`sessionProjections`、`tokenMeter`、`tools`、`systemPrompt`、`skills`、`commands`、`subagents`）留在宿主平面，从 realm 内解析。
- **阶段侧边栏 tab 在宿主平面，不是预设行。** 浏览器 module roster 只扫主 Loader 树，而预设行住在独立的内存树里，所以声明在预设里的客户端 module 永远不会被加载。这个 tab 是被动 UI（无提示词 section、无工具），所以由预设包自己的 patch 把它带在宿主平面上，roster 看得见的位置。
- **在 Web 编辑器里编辑预设会整体替换它的 `plugins` 列表。** 声明式预设没有 patch 语义，所以编辑过的预设是一份快照，会与之后的插件与预设包升级漂移；要接住变更，重新生成或重新应用它。
- **预设 id 稳定性。** 会话记录自己运行时所用的预设 id，并在 resume 时重新解析它；定义缺失会被拒绝。因此 tavern 预设 id 保持 `tavern-standard`。

### 9. 提示词单一事实源：一个 JSON，一个派生产物

本包拥有的全部模型可见文案（stage 指令、`stage:policy` section、ui-complete、子代理技能目录路径清单、forge 工具文案、命令描述）住在 `src/prompts.json`，即唯一可编辑事实源。三个 tavern 技能的模型可见描述改由预设包的 `skills/<name>/SKILL.md` frontmatter 提供（官方 `dsh-tool-skill` catalog 渲染的正是它）。`src/prompts.ts` 在模块加载时读取该 JSON，并叠加脚本生成的嵌入兜底（`src/prompts.defaults.ts`），所以没有该 JSON 的陈旧安装仍以逐字一致的行为工作。`scripts/prompts.mjs`（`list|show|set|sync`）编辑该 JSON 并重跑再生成，`tests/prompts.spec.ts` 把加载后的叠加钉在兜底上，所以手改而不同步会响亮失败。兄弟包 `@ai4rpg/dsh-stage-switch` 对其对话框文案使用同一模式；它的解析敏感字符串（`Current stage:` 前缀、`source.summary` 形状、review id）刻意留在代码里，因为 stage-switch 要靠它们恢复当前阶段。
