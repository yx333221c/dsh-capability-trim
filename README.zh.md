# 能力裁剪（Capability trim）

[English](README.md) · 简体中文

装了很多插件的 profile，每个工作区都要为全部插件付出代价。工具 schema 与技能目录在每次模型步骤前装配，
所以一个和图像生成毫无关系的项目，工具列表里仍然躺着图像工具——而候选给多了，模型反而选得更差。

能力裁剪让每个工作区关掉自己用不上的东西。

## 它做什么

对被覆盖的层，每个 Agent 会话会：

- **拿掉被隐藏的工具**，它们的 schema 不再发送；
- **拿掉被隐藏的技能**，从会话技能目录和 `skill` 工具里消失；
- **拿掉被隐藏的指令文件**——`AGENTS.md` / `CLAUDE.md` 的段落会在步骤执行前，从注入的工作区上下文中裁掉；
- **保留其余一切**，与 profile 原有配置完全一致。

## 分层

只有两层：

```
工作区  >  全局
```

侧边栏面板改的是**全局**默认；模型选择器旁的按钮改的是**当前工作区**。三类能力——工具、技能、指令文件——
各自独立解析：哪一层为某一类写了条目，就以哪一层为准；层与层之间是**替换**而不是累加。

没有会话层。会话跟随它所在的工作区，所以这里的设置永远不会和「在同一个文件夹里新建会话」拿到的结果不一致。

## 为什么能还原

限制注册在每个 Agent 自己的 Cordis scope 上，而不是写进 profile。三点后果：

1. **把开关拨回来即刻复原**，没有配置文件要修，也不用重启。
2. **卸载插件即全部还原**。注册被两处同时持有——Agent scope 与本插件的 effect——所以禁用插件会把它加在
   存活 Agent 上的限制全部撤销。
3. **从不改写 profile 的 `cordis.patch.yml`**，因此破坏不了不属于它的行。

状态只有一个文件，位于 DeepSeek Harness 主目录下：

```
$DSH_HOME/capability-trim.json
```

删掉它等于把所有开关拨回打开。

## 怎么用

**开关打开 = 模型可见**，关闭即隐藏。没有保存按钮：改动立刻写入，对该层的下一个会话生效。

- **侧边栏 → 能力裁剪**——全局默认。
- **输入框 → ◧ 工作区能力**（模型选择器旁）——只改本工作区。

### 模式

开关本身不需要它，但存储的列表支持：以 `*` 结尾表示前缀匹配，例如 `mcp__github__*` 可隐藏某个 MCP
服务器的全部工具。指令模式还会按文件名匹配任意深度，所以 `CLAUDE.md` 隐藏所有 `CLAUDE.md`，而
`web/CLAUDE.md` 只隐藏那一个。

## 已知边界

这些是当前 Harness 扩展点的边界，不是配置问题。每一条都在本机实测过，不是推断：

- **只有全局注册的工具能被隐藏。** `tools.restrict()` 只能遮蔽部署层全局注册的工具。由 Agent 预设自身
  组合提供的工具（标准预设下的 `read_image`、`list_agents`、`get_goal`、`web_search`）无法被另一个插件
  触达，仍会显示。面板里仍会列出它们以便你看到完整能力面，但拨动不生效。
- **技能可以完全隐藏。** 被隐藏的技能会离开模型目录，但保留正文，所以手动 `/name` 调用依然可用。
- **别的插件用 `ctx.systemPrompt.section()` 注入的提示词段落无法被第三方插件单独移除**；段落绑定在
  注册它的 context 上。
- **纯界面插件仍然可见**。只有页面或面板的插件没有 per-agent 的卸载接缝。
- **指令裁剪是文本级的**，按帧上打印的路径匹配，而不是去读文件。
- **工作区按目录路径识别**，忽略大小写与结尾分隔符；移动文件夹会让它的作用域脱钩。

## 安装

需要 DSH `0.2.1-rc.2` 或更新版本（即 `engines.dsh` 的下界）。

### 从 npm 安装

```powershell
dsh plugin --profile <profile> add @yx333221c/dsh-capability-trim
```

### 从 GitHub 安装

本包是纯 ESM、无构建步骤，git 安装可直接用：

```powershell
dsh plugin --profile <profile> add github:yx333221c/dsh-capability-trim
```

### 没有 `dsh` 命令时（桌面版）

桌面版 `PATH` 上没有 `dsh`。用 **设置 → 插件 → 添加插件** 指向本地目录，或把依赖
`"@yx333221c/dsh-capability-trim": "link:<本地目录>"` 加到
`%USERPROFILE%\.dsh\profiles\<profile>\package.json`，把包名追加进 `dsh.profile.bundles`，
执行 `pnpm install --dir <profile>`，然后重启 DSH。

### 确认已加载

侧边栏出现 **能力裁剪** 图标，或会话输入框旁出现 **◧ 工作区能力**，即加载成功。

### 卸载

```powershell
dsh plugin --profile <profile> remove @yx333221c/dsh-capability-trim
```

## 开发

```powershell
node --check index.js
node --check client.js
node --test
```

`core.js` 放全部纯函数（模式匹配、路径键、分层解析、指令帧裁剪），由 `test/core.test.mjs` 覆盖。
