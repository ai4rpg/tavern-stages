# @ai4rpg/dsh-tavern-stages

将 [tavern-cards](https://github.com/ai4rpg/tavern-cards) 的三套 skill 工作流接入独立 `@ai4rpg/dsh-stage-switch` 插件的 DSH 插件。设计决策记录见 [docs/DESIGN.zh.md](docs/DESIGN.zh.md)。

[English](README.md) | 中文

> 注意：本插件与 stage-switch 基础包都发布在 `@ai4rpg/*` 命名空间。tavern 内容（agent 预设、三个 tavern 技能、persona 散文与四个子代理人格）在单独的 GitHub 内容仓 [tavern-content](https://github.com/ai4rpg/tavern-content) 里分发，不上 npm。仓库中出现的 `@deepseek-ai/*` 包是上游 DSH 依赖（`dsh-agent`、`dsh-fs`、`dsh-session` 等），属于另一命名空间。

覆盖三套 tavern-cards 工作流：

- `tavern-design`：叙事设计 / design-spec 阶段
- `tavern-cards`：规划、条目创作、MVU/EJS/configure、开场白
- `tavern-ui`：状态栏 / 前端 UI

## 本仓交付什么、什么单独交付

本包是**插件**：`dsh-stage-switch` 的阶段配置、项目工作区工具（`tavern_forge`、焦点追踪、完成判定），以及具名子代理 provider。

**agent 预设**（`tavern-standard`）、三个 tavern 技能体、persona 散文与四个子代理人格由配套的 **tavern 内容仓**（[github.com/ai4rpg/tavern-content](https://github.com/ai4rpg/tavern-content)；它不上 npm，请克隆）交付。里面并排放着预设包 `@ai4rpg/dsh-tavern-preset` 与人格包 `@ai4rpg/tavern-agents`。预设声明 `tavern-standard` 并把本包的导出组合进去；**安装那个包才是正常安装路径**，它把本插件作为依赖拉进来。部署细节见内容仓自己的 README 与安装指南。

## 本包提供什么

- 提供 `tavernCardsStageConfig` / `createTavernCardsStageConfig()` 给 `dsh-stage-switch`。
- 注册一个复合判定器，报告**当前**阶段是否完成。
- 完成判定针对**焦点项目**（焦点追踪器跟踪最近的 `fs/observed` 写入），逐阶段做内容检查；`content`/`ui` 额外要求 `pack` 成功（pack gate）。
- 读取 `.cardrc.json`、`design-spec.md`、`创作规划.yaml`、`tavern-cards-state.json`。
- forge CLI 以一个 `tavern_forge` 工具暴露给模型（打包即 `command: 'pack'`），对人类暴露 `/tavern-forge` + `/tavern-pack`；`@ai4rpg/tavern-cards-forge` 保持外部 npm 依赖。
- 导出 `loadTavernAgents()`（及 `TavernAgentDescriptor`），预设包的生成器据此为 `@ai4rpg/tavern-agents` 内容包里的每个 persona 声明一行 `tool-subagent`，与 provider 注册同源。
- 技能注册交给预设包：CC BY-NC-SA 的技能体随预设包分发，经官方 `skill-filesystem` 行暴露。

## 用法

```ts
import { apply, tavernCardsStageConfig } from '@ai4rpg/dsh-tavern-stages'
import StageController from '@ai4rpg/dsh-stage-switch'

await ctx.plugin(StageController, tavernCardsStageConfig)
await ctx.plugin(apply)
```

## 安装

tavern 上下文是**按会话**的：只在 tavern agent 预设上创建的会话里加载，其它预设上的会话保持无 tavern 状态（没有 route 阶段指令、`goto_stage`/`tavern_forge` 工具与 tavern 技能）。预设选择由 DSH 的 Web UI 提供。

```sh
dsh plugin --profile <name> add file:<tavern-content 克隆里 tavern-preset 的绝对路径>
```

本插件发 npm；预设包从克隆的内容仓按绝对路径安装（`dsh plugin` 只接受绝对 spec）。profile 把本插件从 npm 作为预设包的依赖拉进来，预设包自己的 `file:` 依赖再把人格内容包带上。

预设的选用、默认值、校验与「编辑过的预设是快照」的语义都是内容仓的部署事务，见其 [`tavern-preset/docs/install-guide.zh.md`](https://github.com/ai4rpg/tavern-content/blob/main/tavern-preset/docs/install-guide.zh.md)。

## 配置

编程式嵌入见「用法」。预设部署里，参数（stage-switch 的 `language`、按工具的 `agentOptions`、`subagents.enabled`）设在预设自己的行上；见预设包 README（[`tavern-preset/README.zh.md`](https://github.com/ai4rpg/tavern-content/blob/main/tavern-preset/README.zh.md)）。

## Forge CLI 访问

forge CLI 作为外部 `@ai4rpg/tavern-cards-forge` 依赖到达（已发布到 npm，bin 跟随 `dist/index.mjs`），由 pnpm/npm 从 `node_modules` 解析。

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

四个 agent persona（`check-agent`、`conversion-agent`、`schema-agent`、`first-message-agent`）住在 `@ai4rpg/tavern-agents` 内容包里（CC BY-NC-SA，与本 MIT 包分属两套许可）。插件为每个 persona 注册一个 provider，名为 `tavern:<name>`。模型可见的工具是声明式的：预设的 tavern 组为每个 agent 带一行 `@deepseek-ai/dsh-tool-subagent`，绑定到这些 provider。每个工具让模型把聚焦工作交给全新上下文的子代理（如「用 check-agent 检查这些条目」），而非自审自校。

`loadTavernAgents()` 读取每个 persona（name、frontmatter 描述、正文），预设生成器据此声明那些行，与 provider 注册同源，两者不会漂移。

provider 在设了 `subagents.enabled` **且**宿主组合了带 spawn 能力的 `subagents` service 时注册。`dsh-base` 已在每个标准 profile 上组合 `@deepseek-ai/dsh-subagent-spawn-in-process`（`providerName: spawn`），所以在 tavern 预设会话上开箱即用；随包预设设了 `subagents.enabled: true`。

### 子代理提示词继承

子代理继承宿主系统提示词。agent 正文前置到子代理首条 user 消息，`persona` section 留给宿主，宿主 persona 因此保持原位。随包 `tavern-standard` 基座携带完整官方 persona，而非 `complete: true` 的极简版；这可以接受：子代理的任务就是那段前置正文，且 stage-switch 对子代会话跳过阶段提示注入。tavern 会话里项目文件请用被追踪的编辑工具（`write`/`edit`，基座挂了 `str_replace_editor` 时也含它）写：它们发出 `fs/observed`，喂给 `stage:policy` 背后的项目焦点追踪；经 `bash` 的文件写入绕过该追踪。provider 还会把正文引用的 tavern 技能解析成绝对目录追加，子代理可以直接读 `references/` 文档，省一次 `skill` 查询。

完整设计理由（继承、力度解析、仅 one-shot 的立场）见 [docs/DESIGN.zh.md](docs/DESIGN.zh.md) 决策 7。

### 按工具的模型与推理力度

工具子代理继承会话的模型路由与（默认）连接级推理力度；随包行保持 `agentOptions` 未设，因为不同模型接受的力度值不同。路由、力度与 `maxTokens` 是每个 `tool-subagent-*` 行的原生 `AgentOptions`；按工具固定的做法见内容仓的 [`tavern-preset/README.zh.md`](https://github.com/ai4rpg/tavern-content/blob/main/tavern-preset/README.zh.md)。

### 代码

```ts
await ctx.plugin(apply, {
  subagents: {
    enabled: true,
  },
})
```

## 依赖

- `@ai4rpg/dsh-stage-switch`：`^0.2.0`，本插件扩展的阶段机。0.2.0 通过强制 seam `session-projection`（由 `dsh-base` 组合）读取会话阶段记录，并带 `language` 行配置（默认 `en`，中文评审对话框用 `zh`）。
- `@ai4rpg/tavern-cards-forge`：`^0.1.0`，外部 forge CLI，其 bin 跟随 `dist/index.mjs`。
- `@ai4rpg/tavern-agents`：承载四个具名子代理 persona 的内容包（CC BY-NC-SA）。它留在本包清单之外，因为已发布清单只携带版本化规格；personas 经内容仓里预设包的 `file:../tavern-agents` 依赖到达 profile，插件的 `resolveAgentsDir()` 在那里用 `createRequire` 命中它们。

stage-switch 与 forge 是普通版本化 npm 依赖；profile 的 pnpm 安装使它们能被预设行解析。

## 许可

MIT。具名子代理 persona 由 `@ai4rpg/tavern-agents` 交付，三个 tavern 技能体由 `@ai4rpg/dsh-tavern-preset` 交付（两者均为内容仓包，不上 npm），均为 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.en)（署名-非商业-相同方式共享），同步自 [ai4rpg/tavern-cards](https://github.com/ai4rpg/tavern-cards)。本包为纯 MIT。
