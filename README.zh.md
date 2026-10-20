# @ai4rpg/dsh-tavern-stages

将 [tavern-cards](https://github.com/ai4rpg/tavern-cards) 的三套 skill 工作流接入独立 `@ai4rpg/dsh-stage-switch` 插件的 DSH 插件。设计决策记录见 [docs/DESIGN.zh.md](docs/DESIGN.zh.md)。

[English](README.md) | 中文

> 注意：本插件与 stage-switch 基础包都发布在 `@ai4rpg/*` 命名空间。tavern 内容（agent 预设、技能与人格）在单独的 GitHub 内容仓 [tavern-content](https://github.com/ai4rpg/tavern-content) 里分发，不上 npm。仓库中出现的 `@deepseek-ai/*` 包是上游 DSH 依赖（`dsh-agent`、`dsh-fs`、`dsh-session` 等），属于另一命名空间。

覆盖三套 tavern-cards 工作流：

- `tavern-design`：叙事设计 / design-spec 阶段
- `tavern-cards`：规划、条目创作、MVU/EJS/configure、开场白
- `tavern-ui`：状态栏 / 前端 UI

## 本仓交付什么、什么单独交付

本包是**插件**：`dsh-stage-switch` 的阶段配置、项目工作区工具（`tavern_forge`、焦点追踪、完成判定），以及供预设生成器构建委派行与子预设的人格加载器。

**agent 预设**（`tavern-standard`）、三个 tavern 技能体、主预设的 persona 文本与四个 agent persona 由配套的 **tavern 内容仓**（[github.com/ai4rpg/tavern-content](https://github.com/ai4rpg/tavern-content)；请克隆安装）交付。仓里并排放着预设包 `@ai4rpg/dsh-tavern-preset` 与人格包 `@ai4rpg/tavern-agents`。预设声明 `tavern-standard` 并把本包的导出组合进去。部署细节见内容仓自己的 README 与安装指南。

## 本包提供什么

- 提供 `tavernCardsStageConfig` / `createTavernCardsStageConfig()` 给 `dsh-stage-switch`。
- 注册一个复合判定器，报告**当前**阶段是否完成。
- 完成判定针对**焦点项目**（焦点追踪器跟踪最近的 `fs/observed` 写入），逐阶段做内容检查；`content`/`ui` 额外要求 `pack` 成功（pack gate）。
- 读取 `.cardrc.json`、`design-spec.md`、`创作规划.yaml`、`tavern-cards-state.json`。
- forge CLI 以一个 `tavern_forge` 工具暴露给模型（打包即 `command: 'pack'`），对人类暴露 `/tavern-forge` + `/tavern-pack`；`@ai4rpg/tavern-cards-forge` 保持外部 npm 依赖。
- 导出 `loadTavernAgents()`（及 `TavernAgentDescriptor`），预设包的生成器据此为 `@ai4rpg/tavern-agents` 内容包里的每个 agent 声明一条委派行（`provider: spawn`、`agentPreset: tavern-child-<name>`）与一个子预设，单一事实源——行、预设与 persona 内容不会漂移。
- 技能注册交给预设包：CC BY-NC-SA 的技能体随预设包分发，经官方 `skill-filesystem` 行暴露。

## 用法

```ts
import { apply, tavernCardsStageConfig } from '@ai4rpg/dsh-tavern-stages'
import StageController from '@ai4rpg/dsh-stage-switch'

await ctx.plugin(StageController, tavernCardsStageConfig)
await ctx.plugin(apply)
```

## 安装

tavern 上下文是**按会话**的：只在 tavern agent 预设上创建的会话里加载；其它预设上的会话没有 `route` 阶段指令、`goto_stage`/`tavern_forge` 工具与 tavern 技能。预设选择由 DSH 的 Web UI 提供。

```sh
dsh plugin --profile <name> add file:<tavern-content 克隆里 tavern-preset 的绝对路径>
```

本插件发布在 npm；预设包从克隆的内容仓按绝对路径安装（`dsh plugin` 只接受绝对 spec）。profile 以预设包依赖的形式从 npm 拉入本插件。

要求 dsh 0.2 线不低于 `0.2.1-rc.2`：本包声明 `engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`，dsh 的插件管理器在加载前检查它。

> **预设兼容性：** 在预设部署中，本版本需要 0.2.0 预设包。0.1.0 预设仍声明已退役的 `tavern:*` provider 与 `subagents.enabled`，与本插件不兼容。切换前请更新或重新生成预设。

预设的选用、默认值、校验与「编辑过的预设是快照」的语义都是内容仓的部署事务，见其 [`tavern-preset/docs/install-guide.zh.md`](https://github.com/ai4rpg/tavern-content/blob/main/tavern-preset/docs/install-guide.zh.md)。

## 配置

编程式嵌入见「用法」。预设部署里，参数（stage-switch 的 `language`、每个工具的 `agentOptions`）设在预设自己的行上；见预设包 README（[`tavern-preset/README.zh.md`](https://github.com/ai4rpg/tavern-content/blob/main/tavern-preset/README.zh.md)）。

## Forge CLI 访问

forge CLI 作为外部 `@ai4rpg/tavern-cards-forge` 依赖到达（已发布到 npm，其 bin 由 `dist/index.mjs` 提供），由 pnpm/npm 从 `node_modules` 解析。

组合 `@deepseek-ai/dsh-commands` 时，插件注册：

- `/tavern-forge <command> [args]`：运行任意 forge 命令（`init`、`configure`、`query`、`patch`、`pack`、…）
- `/tavern-pack <project>`：`tavern-cards-forge pack` 的便捷包装

示例：

```text
/tavern-forge init Demo --mvu
/tavern-forge configure Demo
/tavern-forge pack Demo
/tavern-pack Demo
```

这让打包在每个阶段都可用。

## 具名子代理

四个 agent persona（`check-agent`、`conversion-agent`、`schema-agent`、`first-message-agent`）住在 `@ai4rpg/tavern-agents` 内容仓包里（CC BY-NC-SA，与本 MIT 包分属两套许可）。本插件不注册委派 provider、也不挂载委派工具。`loadTavernAgents()` 读取每个 persona（name、frontmatter 描述、正文），预设包的生成器把这份清单变成：

- 每个 agent 一行 `@deepseek-ai/dsh-tool-subagent`，绑定 dsh 官方的 `spawn` provider（`provider: spawn`），并带 `agentPreset: tavern-child-<name>`；
- 每个 agent 一个子预设（`tavern-child-<name>`），其 `persona` 前缀就是 persona 正文，工具集按该 agent 的任务声明（check 预设只读；只有 conversion 预设带 `bash`）。

每个工具让模型把聚焦工作交给全新上下文的子代理（如「用 check-agent 检查这些条目」），而非自审自校。委派是异步的：工具立即返回一个 activation id，子代理的最终答案以父级的完成通知送达。依赖结果的后续步骤要等通知到达再继续；工具返回值里没有答案。子会话是真实、可恢复的会话：宿主可以向它发送后续消息，恢复时也会重新解析它记录的预设 id。因此 `tavern-child-<name>` 是稳定性契约——改名或删除会让已记录该 id 的会话无法恢复。

子代理是独立组合，不是父上下文的副本：persona 与工具集来自它自己的预设，`agent-instructions` 与 tavern 技能（`skill-filesystem` 带同一 `customSkillDirs`，外加 `tool-skill`）也在那里重新声明。正文若以相对某个 tavern skill 目录的路径引用文档，子代理会为该技能调一次 `skill` 工具；返回结果带该技能的 resource base 路径，子代理从那里读文档。

### 按工具的模型与推理力度

工具子代理继承父会话的模型路由，并在路由不变时继承其连接级推理力度；随包行保持 `agentOptions` 未设，因为不同模型接受的力度值不同。路由、力度与 `maxTokens` 是每个 `tool-subagent-*` 行的 `agentOptions` 中的字段；按工具固定的做法见内容仓的 [`tavern-preset/README.zh.md`](https://github.com/ai4rpg/tavern-content/blob/main/tavern-preset/README.zh.md)。

### 关闭委派工具

插件没有委派开关；四个 `tool-subagent-*` 行与其子预设就是全部接线。在预设里禁用或删除这些行即可隐藏工具。

## 依赖

- `@ai4rpg/dsh-stage-switch`：`^0.2.1`，本插件扩展的阶段机。0.2.1 的 peer 范围同时接受 dsh 0.2.0 与 0.2.1 线；0.2.x 线通过强制 seam `session-projection`（由 `dsh-base` 组合）读取会话阶段记录，并带 `language` 行配置（默认 `en`，中文评审对话框用 `zh`）。
- `@ai4rpg/tavern-cards-forge`：`^0.1.0`，外部 forge CLI，其 bin 由 `dist/index.mjs` 提供。
- `@ai4rpg/tavern-agents`：承载四个 agent persona 的内容仓包（CC BY-NC-SA）。它留在本包清单之外，因为发布到 npm 的包不能依赖 `file:` 规格；personas 经内容仓里预设包的 `file:../tavern-agents` 依赖到达 profile，插件的 `resolveAgentsDir()` 在那里用 `createRequire` 命中它们。

stage-switch 与 forge 是普通版本化 npm 依赖；profile 的 pnpm 安装使它们能被预设行解析。DSH 的 profile 关闭了 `autoInstallPeers`，只作为 peer 出现的包不会被安装。

## 许可

MIT。agent persona 由 `@ai4rpg/tavern-agents` 交付，三个 tavern 技能体由 `@ai4rpg/dsh-tavern-preset` 交付（两者均为内容仓包，不上 npm），均为 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.en)（署名-非商业-相同方式共享），同步自 [ai4rpg/tavern-cards](https://github.com/ai4rpg/tavern-cards)。本包为纯 MIT。
