# DSH Message Edit（个人自用 fork）

> 本仓库是由 bychv 为个人自用维护的 fork，并非上游主仓库，也不是 DeepSeek 官方项目。修改主要服务于维护者自己的使用环境，不代表上游的发布、支持或兼容性承诺。

本 fork 维护者的相关开发经验相对有限，时间和精力也不一定足以实时跟进 DeepSeek Harness 最新版本的兼容性变化，因此无法保证及时适配或修复问题。

如果你需要消息编辑、重试与会话分支等类似功能，也推荐了解 [morlay/better-session](https://github.com/morlay/better-session)。它可能在维护和版本跟进方面比本仓库更完善，建议根据自身需求一并评估；实际维护状态、支持版本和安装方式请以该项目的最新说明为准，这里不对其更新速度或兼容性作保证。

两者并非完全等价：根据 better-session 的项目说明，它采用 RDB 持久化，编辑和重试会就地重写同一会话，只有分支操作才创建新会话；本插件则通过创建新会话版本保留原历史。切换前请阅读其数据存储与配置说明，并备份现有会话。

本 fork 以 [GitHub 的 `alpha` 分支](https://github.com/bychv/dsh-message-edit/tree/alpha)作为安装来源。下文版本号与兼容性说明仅针对本 fork；npm 同名包的版本、下载量和发布状态不代表本 fork，也不能据此判断是否包含这里的修复。

`dsh-message-edit` 为 DeepSeek Harness 补充基于事件溯源的「消息编辑与重生成」能力。插件不改写历史事件，也不修改 DSH 引擎内部；每次编辑、重生成或重试都会从目标回合之前创建一个新会话版本，原会话始终保留并可随时切回。

```bash
dsh plugin --profile web add github:bychv/dsh-message-edit#alpha
```

本 fork 当前预发布版本为 `0.2.4-alpha.3`，面向 DeepSeek Harness `0.1.2-alpha.5`。

Host 通过 DSH 注入的服务运行，`SessionLogOffset` 仅作为编译期类型使用，不在运行时从
profile 的 `@deepseek-ai/dsh-session` 导入。这避免了 CLI 已升级、profile 尚保留旧 peer
时出现 `does not provide an export named 'SessionLogOffset'` 并阻止 DSH 启动。
这不表示支持所有旧 DSH API；请以以上版本为运行和测试基准。

## 功能

- **编辑消息**：可编辑已落定的用户文本、`assistant.reasoning` 思考块与 `assistant.response` 回复文本。
- **重生成**：从最后一条已落定助手回复所属回合之前分支，使用原用户输入重新生成。
- **重试任意回合**：在 Timeline 中选择任意历史回合重新执行。
- **级联策略**：
  - `truncate`（默认）：只重新执行目标输入，删除该点之后的旧后续。
  - `preserve`：保留后续用户输入，并在新分支中依次重新执行；助手输出与工具链全部重新生成。
- **版本切换**：会话标题栏的 `←` 撤销当前原子效果，`→` 重施加最新直接子效果；Timeline 展示完整已知分支树、操作时间、编辑前后内容与当前版本。
- **Timeline 标签页**：注册到 `conversation.view`，`order: 15`，位于 Trajectory（10）与 Prompt Studio（20）之间。

## 设计

### 时间可组合性

插件把**完整回合**作为效果原子。目标回合的 `turn/start`、模型请求、工具调用、工具结果与 `turn/end` 不会被局部复制后拼接；新版本从该回合之前的闭合边界分支：

1. 用户消息编辑、Reroll 与 Retry：回退整个目标回合，再把目标用户输入作为新回合交给 Agent。
2. 助手块编辑：回退整个目标回合，以原用户输入和编辑后的助手内容构造一个新的完整闭合回合；原工具链不进入新版本。选择 `preserve` 时，后续用户输入再依次交给 Agent，产生新的完整工具链。
3. 每个版本都追加一个不可拆分的 `message-edit/version` 效果对：`effect` 记录正向效果，`inverse` 记录恢复目标。父版本链自动导出组合逆；恢复不是删除事件，而是沿逆链切换到仍然存在的版本。
4. 消息历史变换彼此不交换，因此撤销遵循 LIFO：一次只撤销当前原子效果并保留更早效果；各后继分支始终保留，可从父版本重新施加。

### 分支与 Agent 接线

旧实现先用短生命周期 Session 暂存分支、落盘、移除 live Session，再用 `agents.resume()` 重建 Agent。这个过程存在两个分离的生命周期边界：暂存日志已经持久化后，Agent 仍可能创建失败。现实现只使用 `AgentRegistry.create()` 已公开的 `seed + meta` 事务缝：

1. 在来源 Agent 的 runMaintenance() 内，从已闭合边界取得不可变 seed；第一回合之前使用空 seed。
2. 用本地等价的纯事件构造器把版本效果对与可选手工助手回合加入 seed，再调用 `ctx.agents.create({ seed, meta })`。Session 在 Agent 构造前一次性验证完整 seed；任何一步失败都会由 AgentFactory 的结构性逆撤销，外部观察者看不到半成品 Session，Agent 的回合计数也直接从完整历史初始化。
3. 发布后调用 `ctx.sessions.flush()`，在 HTTP 操作成功前建立耐久性屏障。
4. Workspace 挂接与 child Agent 生命周期分别返回原子逆；操作失败时按相反顺序组合恢复。随后通过 `child.agent.followup()` 排入需要重新执行的用户输入。

此路径不接触 `ReactLoopAgent`、AgentLoop 私有方法或 apiproxy 的收窄 fork RPC；分支 seed 仍由同一 Session 公共事件契约验证。

### 空间可组合性

- Host 只依赖公开的 `sessions`、`agents`、`sessionPersistence`、`sessionQuery`、`workspaceRegistry` 与 `webServer` 服务。
- Browser 只通过 `slots`、`conversation`、`connection` 与 runtime `sessions` 服务组合。
- Timeline 与标题栏共享一个按 `sessionId` 建立的值级 Snapshot source；控制器反应式订阅当前 Session 的闭合回合值与 Session 列表中的谱系值，Session 身份替换时重新绑定，不缓存旧 Session 对象。
- 新版本导航等待 runtime Session 列表发布对应 ID 后再执行 `ctx.sessions.open()`，依赖可用性变化直接驱动导航。

## 数据模型

每个插件版本在自己的非继承后缀中包含一个 `message-edit/version` 事件：

该插件自定义事件在 seed 信封中带有 `ignorable: true`。这样 DeepSeek Harness 0.1.2-alpha
及其他启用未知事件保护的版本可以安全跳过不认识的 `message-edit/*` 事件，冷启动或重新加载时
不会因插件事件被判定为不支持而拒绝整段会话历史。核心 `turn/*`、`step/*` 等事件不会被标记为
可忽略。

```ts
interface MessageEditVersionEvent {
  schemaVersion: 2
  effect: {
    id: string
    operation: 'edit' | 'reroll' | 'retry'
    cascade: 'truncate' | 'preserve'
    targetTurn: number
    targetEventSeq: number
    targetBlockIndex?: number
    blockKind?: 'user' | 'assistant.reasoning' | 'assistant.response'
    before?: string
    after?: string
  }
  inverse: {
    kind: 'restore-version'
    sessionId: string
  }
}
```

会话头的 `parentSession` 构成版本树，且必须与事件中的 `inverse.sessionId` 一致；继承边界（0.1.2-alpha.4 的 `isSeeded`/`inheritedEventCount`，落盘仍写作 `seedLength`）区分当前版本自己的元数据与从祖先继承的同名事件。Timeline 通过 `ctx.sessionQuery.traceSession()` 和 `readSession()` 生成完整值级投影，并由原子逆链导出 `undoStack` 与直接 `redoSessionIds`。旧版平面事件仍可读取，并在投影时规范化为同一效果对。

## UI

- `conversation.view`
  - `id: message-edit-timeline`
  - `order: 15`
  - `label: Timeline`
- `conversation.session.header.actions`
  - `id: message-edit-controls`
  - 直接父效果撤销、直接子效果重施加、效果链计数、最后回复重生成

组件使用 CSS Modules 与 `--dsw-*` 语义 token，不引入 UI 库。所有产品文案为中文，代码注释为英文。

## 构建

以下命令在本仓库目录中执行，使用 npm 安装构建依赖和运行脚本，不是从 npm 安装本 fork。

```bash
npm install
npm run build
```

构建基于 npm 发布的 `@deepseek-ai/*@0.1.2-alpha.5` 类型与本地工具链（typescript、tsdown、lightningcss），不再依赖 dsh 源码树。构建生成：

- `index.mjs`：Host 插件
- `client.js`：Browser 插件
- `client.js.map`：Browser source map

运行 `npm test` 会先重新构建，再检查旧 profile peer 下的 Host 加载、真实 Session seed
验证、分支继承边界、`ignorable` 标记、历史冷读及 retry 输入保留；测试不调用模型、不写用户历史。

## 安装

安装此个人 fork 请使用完整的 GitHub 来源及 `#alpha` 分支，不要以 npm 同名包替代：

```bash
dsh plugin --profile web add github:bychv/dsh-message-edit#alpha
```

该命令直接安装此 fork 的 `alpha` 分支版本。安装完成后重启 dsh；如曾从 npm 安装同名包，`add` 会将 web profile 中的依赖来源更新为上述 GitHub 分支。包名仍保留为 `dsh-message-edit`，因此它会替换该 profile 中的同名依赖，而不是与原包并存。

或本地开发：

```bash
dsh plugin --profile web add -w link:/path/to/dsh-message-edit
```

`dsh plugin` 是 pnpm 转发器：`add` 后会自动识别 `dsh.bundle` 声明并把插件收编进 profile 的 `dsh.profile.bundles`，重启 dsh 即生效。本地开发建议用 `link:`（符号链接），改动源码重构建后重启即更新。

## HTTP 接口

- `GET /message-edit?sessionId=<id>`：读取可编辑消息、可重试回合与完整版本树。
- `POST /message-edit`：执行 `edit`、`reroll` 或 `retry`，返回已发布的新 Session ID。

## 范围边界

- 不原地改写 Session 事件；历史是 append-only、deep-frozen。
- 不联动恢复或修改工作区文件、命令外部效果与既有产物。
- 不修改 DSH 引擎、apiproxy 或官方 UI 包。
