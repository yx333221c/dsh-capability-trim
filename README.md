# Capability trim

A tool-heavy profile pays for every plugin in every session. Tool schemas and
the skill catalog are assembled before each model step, so a project that has
nothing to do with image generation still carries the image tools in its tool
list — and a model given more candidates than it needs picks worse.

Capability trim lets a session or a workspace declare which capabilities it does
not want.

## What it does

For a covered layer, each Agent session:

- **loses the hidden tools** from its tool list, so their schemas stop being sent
  and the model stops seeing them as candidates;
- **loses the hidden skills** from the session skill catalog and the `skill`
  tool;
- **loses the hidden instruction files** — the `AGENTS.md` / `CLAUDE.md`
  sections are cut out of the injected workspace context before the step runs;
- **keeps everything else** exactly as the profile configured it.

## Layers

Selection is layered, most specific first:

```
session  >  workspace  >  global
```

Each category — tools, skills, instruction files — resolves independently: the
most specific layer that names any pattern wins for that category. Layers
**replace**, they do not accumulate, so a session can hide more or less than its
workspace without editing it.

## Why it is reversible

Restrictions are registered on each Agent's own Cordis scope rather than written
into the profile. That has three consequences:

1. **Clearing a layer restores it immediately.** No configuration file to
   repair, no restart.
2. **Uninstalling the plugin restores everything.** The registrations are owned
   twice — by the Agent scope and by this plugin's effect — so disabling the
   plugin lifts every restriction it installed on live Agents.
3. **The profile's `cordis.patch.yml` is never rewritten.** This plugin does not
   read, filter or save the user's configuration, so it cannot corrupt rows it
   does not own.

State lives in one file under the DeepSeek Harness home:

```
$DSH_HOME/capability-trim.json
```

Deleting that file is the same as clearing every layer.

## Using it

- **Sidebar panel** — the global layer and each registered workspace.
- **Conversation View tab** — this session, its workspace, and global.

Untick what does not belong, then **Save and apply**. Running sessions are
updated in place; other workspaces are untouched.

### Patterns

An entry ending in `*` is a prefix match, so `mcp__github__*` hides every tool
from one MCP server. Instruction patterns also match a bare file name at any
depth, so `CLAUDE.md` hides every `CLAUDE.md` while `web/CLAUDE.md` hides one.

## Limits

These are boundaries of the current Harness extension points, not configuration:

- **Prompt sections contributed by another plugin cannot be removed** from one
  workspace by a different plugin; sections are scoped to the context that
  registered them. A plugin that contributes only prompt text keeps that text.
- **Interface-only plugins stay visible.** A plugin whose only contribution is a
  page or panel has no per-agent seam to unload it.
- **Instruction pruning is textual.** It rewrites the rendered frame, so a
  section is matched by the path the frame prints, not by reading the file.
- **Hiding a skill hides its catalog entry**, not the file on disk.
- **A workspace is keyed by directory path**, matched case-insensitively and
  ignoring trailing separators. Moving the folder detaches its scope.

## Install

Install the bundle directory with the plugin manager (**Plugins → Add plugin**),
then enable **Capability trim** in the sidebar panel list.

## Development

```powershell
node --check index.js
node --check client.js
node --test
```

`core.js` holds every pure function — pattern matching, path keys, scope
resolution, instruction-frame pruning — and is covered by `test/core.test.mjs`.
