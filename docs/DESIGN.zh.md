# 设计：@ai4rpg/dsh-tavern-stages

## 问题

tavern-cards 仓库提供了三套用于编写 SillyTavern 卡片的 coding-agent skill。我们希望把这些工作流作为 DSH 插件运行在 DeepSeek Harness 内，并以 `@ai4rpg/dsh-stage-switch` 作为阶段协作骨架。

本包是其中的插件半边。配套的只在 GitHub 分发、不上 npm 的 tavern 内容仓提供按会话 agent 预设 `@ai4rpg/dsh-tavern-preset`（含 CC BY-NC-SA 技能正文与主 persona 文本），以及承载四个 agent persona 的 `@ai4rpg/tavern-agents`（决策 8）。

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

`@ai4rpg/tavern-cards-forge` 是外部 npm 依赖（`^0.1.0`，由 pnpm/npm 解析），以**一个 `tavern_forge` 工具**（`src/forge.ts`，`command` + `args: string[]`）到达模型；打包即 `command: 'pack'`，`tavern_pack` 模型工具被刻意排除。成功打包会 emit `tavern-cards/packed` 事件，满足 content/ui 的 pack gate（决策 4）。人类 slash 命令 `/tavern-forge` 与 `/tavern-pack` 保留为快捷入口。技能正文自己的命令示例使用同一工具调用形式（`tavern_forge({ command, args })`），由预设包的同步脚本改写。

### 6. 作为预设包的依赖安装，不带 bundle patch

本插件**不**携带 `dsh.bundle.patch`：没有可供安装或翻转启用的宿主平面行。正常安装路径是预设包：从 tavern 内容仓的克隆按绝对路径安装（`dsh plugin --profile <name> add file:<克隆路径>/tavern-preset`；预设包不上 npm，因为发布到 npm 的清单不能包含它的 `file:` 人格依赖）。它把本插件（其依赖）连同 `@ai4rpg/dsh-stage-switch` 与 `@ai4rpg/tavern-cards-forge` 一并装入；按会话的组合来自声明式 agent 预设（决策 8）。编程式嵌入方直接从导出组合本插件。把模型可见委派工具绑定到 dsh `spawn` provider 的行、以及给每个子代理提供 persona 的子预设都在预设包里，因此没有预设的部署完全没有 tavern 表面。曾经为无预设部署携带这些行的 disabled 宿主平面兜底已被刻意退役：预设是唯一受支持的部署路径。

### 7. 具名子代理：声明为 `spawn` + `agentPreset`，每个 agent 一个子预设

`@ai4rpg/tavern-agents` 内容包的四个 agent（check / conversion / schema / first-message）**默认**成为模型可见的委派工具：tavern 预设为每个 agent 组合一行 `@deepseek-ai/dsh-tool-subagent`（`provider: spawn`、`agentPreset: tavern-child-<name>`）与一个子预设，全部由 `loadTavernAgents()` 生成，因此行、预设与 persona 内容不可能漂移。本插件不注册委派 provider、不携带委派配置：它只提供人格加载器与阶段/forge 表面。

**为什么是这形态。** dsh 0.2.1 的委派由它自己的 provider 执行，本地 provider 只贡献创建输入：子代理由 subagent 服务创建并组合。外部 provider 也不能包裹本地子代理——服务会拒绝 id 已被本地 agent/session 占用的 run，所以「外部 provider + 本地 agent」不是可表示形态。旧 provider 的唯一职责（正文前置）因此没有 seam。**改由组合承载：** 子预设的 `persona` 前缀就是 agent 正文，其 `plugins` 列表就是该 agent 的工具集。

把 agent 身份移进预设组合后的推论：

- **子代理是独立组合。** 它不再继承父级 persona 或对话上下文；由它自己的预设重新声明 `agent-instructions`、`tool-fs`/`tool-fs-search`、技能行与 compaction。子预设不含阶段行，所以子代理不会收到 `goto_stage` 指引，也不带 tavern 阶段策略。
- **权限收窄是声明式的。** check 预设关掉 `tool-fs` 的写入（`write: false`、`edit: false`），因为该 agent 只报告；conversion 是唯一带 `bash`/`pwsh` 的预设（其正文要跑校验脚本）。其余只给读/搜索/技能工具。
- **委派是异步的。** 每次调用返回 activation id，子代理的最终答案以父级完成通知送达。负责串行编排的技能必须等待通知，而不是从工具返回值里取结果。
- **子预设 id 属冷恢复契约。** `tavern-child-<name>` 会被子会话记录；改名或删除会让这些会话无法恢复。内容包的 persona 规则（只增、不删、不改名）延伸到这些 id。
- **技能发现从 provider 移到 `skill` 工具。** 子预设仍挂载 `skill-filesystem`（同一 `customSkillDirs`）与 `tool-skill`，被引用的文档仍可通过返回的 resource base 路径读取。旧 provider 追加的绝对路径块及 `subagentSkillDirs` 提示词键已删除；接受的代价是每个被引用技能一次查询（用户侧行为见 README「具名子代理」）。
- **`{{` 是硬约束。** 正文成为 persona 前缀，而 dsh 严格插值它，正文里出现 `{{…}}` 宏会打挂子代理的 system prompt。内容包的校验脚本保证这一点；该守卫从「保险」变成功能性约束。
- **力度与路由保持原生。** 子代理的路由与推理力度通过每条委派行的 `agentOptions` 设置（合并到父级路由之上）；随包行保持 `agentOptions` 未设，子代理因此跟随父会话的路由，并在路由不变时继承其推理力度。不同模型接受的力度值不同，强制 `max` 可能让部分模型报错。没有插件代码参与。
- **父会话的推荐基座：官方 `standard` 预设。** 它提供 `spawn` provider、宿主全局 fs 上的标准文件/搜索/shell 工具，以及 tavern 工作流工具。子预设由它派生，但只保留该 agent 需要的行。父会话的项目文件写入应走**被追踪的编辑工具**（`tool-fs` 的 `write`/`edit`；基座挂了 `str_replace_editor` 时也含它）：它们发出 `fs/observed`，喂给 `stage:policy` 背后的项目焦点追踪。`bash` 重定向用于跑命令——经它产生的文件写入不被计为项目活动。
- **roster 里会出现四个内部预设。** dsh 0.2.1 没有 hidden 字段，所以它们的名称与描述都标明为「内部子预设」，order 排在主预设之后；不供用户会话选用。

委派没有 UI 开关：预设自带四个委派行与对应子预设。要关闭委派，删除或停用这些行。

### 8. 按会话部署：声明式预设，由内容仓分发

tavern 上下文是按会话作用域的，不是按进程。没有这一点，宿主级挂载会把 route 阶段指令注入每个首步、让 `goto_stage`/`tavern_forge` 留在每个工具目录、在每个会话里列出 tavern 技能与委派工具，插件因此污染 profile 上每一个非卡片任务（这正是催生本设计的投诉）。

预设现在是**声明**的，不是被发现的：它就是 profile patch 里一行 `@deepseek-ai/dsh-agent-preset`，其 `config.plugins` 是子组合，而 `@deepseek-ai/dsh-agent-preset-registry` 是 roster 服务（`ctx.agentPresets`、`mount(agentCtx, id?)`）。tavern 预设由 `@ai4rpg/dsh-tavern-preset` 分发，即内容仓里的预设目录，按路径安装、不上 npm；Web UI 已自带预设选择，所以两个包都不构建 UI。推论：

- **预设是派生的，不是重打的。** 预设包的生成器取官方 `standard` 组合，并从本包的导出组合出 tavern 组：stage-switch 行的 config 是 `tavernCardsStageConfig`，四个委派行与它们的子预设来自 `loadTavernAgents()`。组是追加的，所以升级本插件会带着预设一起走；组保持 `isolate: { stage: true }`（见下）。子预设是独立的 `@deepseek-ai/dsh-agent-preset` 声明，不是本组的行。
- **组携带 `isolate: { stage: true }`。** `StageController` 发布 `stage` service；预设行向根 realm 发布会在挂载时被拒，而 tavern-stages 消费 `ctx.stage`，所以 tavern 各行（stage-switch、tavern-stages、四个委派行）坐在一个 `cordis:group` 内，`stage` 用 entry-local realm。组需要的其它 service（`fs`、`sessionProjections`、`tokenMeter`、`tools`、`systemPrompt`、`skills`、`commands`、`subagents`）留在宿主平面，从 realm 内解析。
- **阶段侧边栏 tab 在宿主平面，不是预设行。** 浏览器 module roster 只扫主 Loader 树，而预设行住在独立的内存树里，所以声明在预设里的客户端 module 永远不会被加载。这个 tab 是被动 UI（无提示词 section、无工具），所以由预设包自己的 patch 把它带在宿主平面上，roster 看得见的位置。
- **在 Web 编辑器里编辑预设会整体替换它的 `plugins` 列表。** 声明式预设没有 patch 语义，所以编辑过的预设是一份快照，会与之后的插件与预设包升级漂移；要接住变更，重新生成或重新应用它。
- **预设 id 稳定性。** 会话记录自己运行时所用的预设 id，并在 resume 时重新解析它；定义缺失会被拒绝。因此 tavern 预设 id 保持 `tavern-standard`。

### 9. 提示词单一事实源：一个 JSON，一个派生产物

本包拥有的全部模型可见文案（stage 指令、`stage:policy` section、ui-complete、forge 工具文案、命令描述）住在 `src/prompts.json`，即唯一可编辑事实源。三个 tavern 技能的模型可见描述改由预设包的 `skills/<name>/SKILL.md` frontmatter 提供（官方 `dsh-tool-skill` catalog 渲染的正是它）。`src/prompts.ts` 在模块加载时读取该 JSON，并叠加脚本生成的嵌入兜底（`src/prompts.defaults.ts`），所以没有该 JSON 的陈旧安装仍以逐字一致的行为工作。`scripts/prompts.mjs`（`list|show|set|sync`）编辑该 JSON 并重跑再生成，`tests/prompts.spec.ts` 把加载后的叠加钉在兜底上，所以手改而不同步会响亮失败。兄弟包 `@ai4rpg/dsh-stage-switch` 对其对话框文案使用同一模式；它的解析敏感字符串（`Current stage:` 前缀、`source.summary` 形状、review id）刻意留在代码里，因为 stage-switch 要靠它们恢复当前阶段。
