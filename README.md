# Capability trim

English · [简体中文](README.zh.md)

A tool-heavy profile pays for every plugin in every workspace. Tool schemas and
the skill catalog are assembled before each model step, so a project that has
nothing to do with image generation still carries the image tools in its tool
list — and a model given more candidates than it needs picks worse.

Capability trim lets a workspace turn off what it does not use.

## What it does

For a covered layer, each Agent session:

- **loses the hidden tools** from its tool list, so their schemas stop being sent;
- **loses the hidden skills** from the session skill catalog and the `skill` tool;
- **loses the hidden instruction files** — the `AGENTS.md` / `CLAUDE.md` sections
  are cut out of the injected workspace context before the step runs;
- **keeps everything else** exactly as the profile configured it.

## Layers

Two, and only two:

```
workspace  >  global
```

The sidebar panel edits the **global** default. The control beside the model
selector edits the **current workspace**. Each category — tools, skills,
instruction files — resolves on its own: the most specific layer that names any
entry wins for that category, and a layer replaces the broader list rather than
adding to it.

There is no per-session layer. A session follows the workspace it runs in, so the
state never diverges from what a fresh session in that folder will get.

## Why it is reversible

Restrictions are registered on each Agent's own Cordis scope rather than written
into the profile. That has three consequences:

1. **Turning a switch back on restores it immediately.** No file to repair, no
   restart.
2. **Uninstalling the plugin restores everything.** The registrations are owned
   twice — by the Agent scope and by this plugin's effect — so disabling the
   plugin lifts every restriction it installed on live Agents.
3. **The profile's `cordis.patch.yml` is never rewritten.** This plugin does not
   read, filter or save your configuration, so it cannot corrupt rows it does not
   own.

State lives in one file under the DeepSeek Harness home:

```
$DSH_HOME/capability-trim.json
```

Deleting that file is the same as turning every switch back on.

## Using it

Every switch reads **ON** when the capability is visible. Turning one off hides
it. There is no save button: the change is written at once and applies to the next
session in that layer.

- **Sidebar panel → Capability trim** — the global default.
- **Composer → ◧ 工作区能力** (beside the model selector) — this workspace only.

### Patterns

Not required for the switches, but the stored lists accept them: an entry ending
in `*` is a prefix, so `mcp__github__*` hides every tool from one MCP server. An
instruction pattern also matches a bare file name at any depth, so `CLAUDE.md`
hides every `CLAUDE.md` while `web/CLAUDE.md` hides exactly one.

## Limits

These are boundaries of the current Harness extension points, not configuration.
Each was measured on this host, not assumed:

- **Only globally registered tools can be hidden.** `tools.restrict()` masks tools
  the deployment registers globally. A tool that comes from the Agent preset's own
  composition — `read_image`, `list_agents`, `get_goal`, `web_search` on the
  standard preset — is not reachable from another plugin and stays visible. It
  remains listed in the panel so you can see the whole surface, but flipping it
  has no effect.
- **Skills are fully hideable.** A hidden skill leaves the model catalog while
  keeping its body, so a manual `/name` invocation still works.
- **Prompt sections contributed by another plugin cannot be removed** from one
  workspace by a different plugin; sections are scoped to the context that
  registered them.
- **Interface-only plugins stay visible.** A plugin whose only contribution is a
  page or panel has no per-agent seam to unload it.
- **Instruction pruning is textual.** A section is matched by the path the frame
  prints, not by reading the file.
- **A workspace is keyed by directory path**, matched case-insensitively and
  ignoring trailing separators. Moving the folder detaches its scope.

## Install

Requires DSH `0.2.1-rc.2` or newer (the `engines.dsh` lower bound).

### From npm

```powershell
dsh plugin --profile <profile> add @yx333221c/dsh-capability-trim
```

### From GitHub

This package is plain ESM with no build step, so a git install works as-is:

```powershell
dsh plugin --profile <profile> add github:yx333221c/dsh-capability-trim
```

### Without a `dsh` CLI (desktop app)

The desktop app has no `dsh` on `PATH`. Use **Settings → Plugins → Add plugin**
and point it at the checkout directory, or add the dependency
`"@yx333221c/dsh-capability-trim": "link:<path>"` to
`%USERPROFILE%\.dsh\profiles\<profile>\package.json`, append the package name to
`dsh.profile.bundles`, run `pnpm install --dir <profile>`, then restart DSH.

### Verify it loaded

Open the sidebar and look for the **Capability trim** panel icon, or a
conversation and look for the **◧ 工作区能力** control beside the model selector.

### Uninstall

```powershell
dsh plugin --profile <profile> remove @yx333221c/dsh-capability-trim
```

## Development

```powershell
node --check index.js
node --check client.js
node --test
```

`core.js` holds every pure function — matching, path keys, layer resolution,
instruction-frame pruning — covered by `test/core.test.mjs`.
