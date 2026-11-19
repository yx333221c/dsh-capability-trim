# 能力裁剪（Capability trim）

[English](README.md) · 简体中文

装了很多插件的 profile，每个会话都要为全部插件付出代价。工具 schema 与技能目录在每次模型步骤前装配，
所以一个和图像生成毫无关系的项目，工具列表里仍然躺着图像工具——而候选给多了，模型反而选得更差。

能力裁剪让每个会话、每个工作区声明自己不需要哪些能力。

## 它做什么

对被覆盖的层，每个 Agent 会话会：

- **拿掉被隐藏的工具**，它们的 schema 不再发送，模型也不再把它们当候选；
- **拿掉被隐藏的技能**，从会话技能目录和 `skill` 工具里消失；
- **拿掉被隐藏的指令文件**——`AGENTS.md` / `CLAUDE.md` 的段落会在步骤执行前，从注入的工作区上下文中裁掉；
- **保留其余一切**，与 profile 原有配置完全一致。

## 分层

选择是分层的，越具体越优先：

```
会话  >  工作区  >  全局
```

工具、技能、指令文件三类各自独立解析：哪一层为某一类写了模式，就以哪一层为准。层与层之间是
**替换**而不是累加，所以一个会话可以比它的工作区藏得更多、也可以更少，而不必去改工作区。

## 为什么能还原

限制注册在每个 Agent 自己的 Cordis scope 上，而不是写进 profile。三点后果：

1. **清空某一层即刻复原**，没有配置文件要修，也不用重启。
2. **卸载插件即全部还原**。注册被两处同时持有——Agent scope 与本插件的 effect——所以禁用插件会把
   它加在存活 Agent 上的限制全部撤销。
3. **从不改写 profile 的 `cordis.patch.yml`**。本插件不读、不筛、不保存用户配置，因此破坏不了
   不属于它的行。

状态只有一个文件，位于 DeepSeek Harness 主目录下：

```
$DSH_HOME/capability-trim.json
```

删掉它就是清空所有层。

## 怎么用

- **侧边栏面板**——全局层与每个已注册的工作区。
- **会话视图标签**——本会话、它的工作区、以及全局。

在左侧选一个层，取消勾选不属于这个项目的项，然后点 **保存并应用**（固定在页脚，始终可见）。
运行中的会话会就地更新，其他工作区不受影响。

`全局` 是所有工作区的默认层：在那里隐藏的能力，除非工作区或会话按类别覆盖，否则处处生效。

想让某个会话从它的工作区选择出发，用 **预填本工作区设置**，会把工作区的隐藏项复制进来。
预填是**合并**，会话已有的隐藏项会被保留，不会被覆盖。

### 模式

以 `*` 结尾表示前缀匹配，例如 `mcp__github__*` 可隐藏某个 MCP 服务器的全部工具。指令模式还会按
文件名匹配任意深度，所以 `CLAUDE.md` 会隐藏所有 `CLAUDE.md`，而 `web/CLAUDE.md` 只隐藏那一个。

## 已知边界

这些是当前 Harness 扩展点的边界，不是配置问题：

- **只有全局注册的工具才能被隐藏。** `tools.restrict()` 只遮蔽部署层全局注册的工具；在 agent preset 自身
  组合里注册的工具（例如该 preset 的 `read_image`、`list_agents`、`get_goal`）无法被另一个插件限制，仍然可见。
  这是实测结论，不是推断。
- **别的插件用 `ctx.systemPrompt.section()` 注入的提示词段落，无法被第三方插件单独移除**；段落绑定在
  注册它的 context 上。只贡献提示词文本的插件，其文本仍在。
- **纯界面插件仍然可见**。只有页面或面板的插件，没有 per-agent 的卸载接缝。
- **指令裁剪是文本级的**。它重写渲染后的帧，因此按帧上打印的路径匹配，而不是去读文件。
- **隐藏技能只隐藏目录条目**，不删磁盘上的文件。
- **工作区按目录路径识别**，忽略大小写与结尾分隔符；移动文件夹会让它的作用域脱钩。

## 安装

需要 DSH `0.2.1-rc.2` 或更新版本（即 `engines.dsh` 的下界）。下面三条路径殊途同归，按你运行 DSH 的方式挑一条。

### 从 npm 安装（发布之后）

```powershell
dsh plugin --profile <profile> add @yx333221c/dsh-capability-trim
```

### 从 GitHub 安装

本包是纯 ESM，没有构建步骤，所以 git 安装可以直接用：

```powershell
dsh plugin --profile <profile> add github:yx333221c/dsh-capability-trim
```

### 从本地目录安装

```powershell
dsh plugin --profile <profile> add <本地目录路径>
```

### 没有 `dsh` 命令时（桌面版）

桌面版的 `PATH` 上没有 `dsh`。改用应用本身：

1. **设置 → 插件 → 添加插件**，指向本地目录（发布后也可以直接填包名）。
2. 启用该行；若提示 `restart-required`，重启宿主。

或者直接改 profile——`<profile>` 是 `%USERPROFILE%\.dsh\profiles\` 下的目录，通常是 `desktop`：

1. 在 `<profile>\package.json` 里加上依赖
   `"@yx333221c/dsh-capability-trim": "link:<本地目录路径>"`，并把
   `@yx333221c/dsh-capability-trim` 追加到 `dsh.profile.bundles`。
2. 执行 `pnpm install --dir <profile>`。
3. 重启 DSH。

### 确认已加载

打开侧边栏，找 **能力裁剪** 的面板图标；或打开一个会话，找 **能力裁剪** 的视图标签。任一处能列出工具，就说明宿主路由已经应答。

### 卸载

```powershell
dsh plugin --profile <profile> remove @yx333221c/dsh-capability-trim
```

卸载会还原它裁剪过的全部能力面：限制由插件与各个 Agent 共同持有，从不写进你的 profile。

## 开发

```powershell
node --check index.js
node --check client.js
node --test
```

`core.js` 放全部纯函数（模式匹配、路径键、分层解析、指令帧裁剪），由 `test/core.test.mjs` 覆盖。
