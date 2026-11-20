# Capability trim — details

[README](../README.md) · [简体中文](../README.zh.md)

## What it is

A Harness profile enables plugins process-wide. Every model step re-sends the
schema of every registered tool and assembles the skill catalog, so a plugin one
project needs is a fixed per-turn cost in every other project.

Capability trim is a per-workspace subtraction over that surface. It never adds a
capability and never enables a plugin: it only removes what a workspace says it
does not want.

## The categories

| Category | Effect when hidden | Mechanism |
|---|---|---|
| Tools | Removed from the Agent's tool list; the schema is not sent | `agent.ctx.tools.restrict({ deny })` |
| Skills | Removed from the session skill catalog and the `skill` tool | A scope-local copy with `modelInvocable: false` |

Both are applied per Agent, so two Sessions in one process can differ — but only
by workspace, because there is no session layer.

### Instruction files were removed

An earlier version also pruned `AGENTS.md` / `CLAUDE.md` sections out of the
injected workspace context by rewriting the `agent/pre-step` frame. That is gone:
the frame no longer carries the stable `Instructions from: <path>` structure the
matcher depended on, so pruning silently did nothing while the UI still offered
switches for it — the worst combination, since the panel claimed a capability the
Host did not have.

The `denyInstructions` field stays in the stored model so an existing state file
loads without losing data, but no code path reads it.

## Layer resolution

```
workspace  >  global
```

For each category the most specific layer that names **any** entry wins, and a
layer replaces the broader list rather than extending it:

```json
{
  "version": 2,
  "global":     { "denyTools": ["office_*"] },
  "workspaces": { "j:\\work\\web": { "denySkills": ["office-docx"] } }
}
```

In that example a Session in `j:\work\web` hides `office-docx` (the workspace
names skills) and `office_*` (the workspace says nothing about tools, so the
global list applies).

Replacement rather than accumulation is the trade that keeps each layer readable
on its own: you can see the whole of what a workspace hides in one place, instead
of having to subtract two lists in your head.

## Reversibility

Every restriction is an effect with two owners:

- the Agent's own scope (`agent.ctx`), unwound when the Agent is disposed;
- this plugin's effect, unwound when the plugin is disabled or removed.

The second owner matters: Loader teardown does not dispose `agent.ctx`
contributions by itself. Without it, disabling the plugin would leave its
restrictions in place until each Agent was disposed.

The profile's `cordis.patch.yml` is never read, filtered, or written, so rows
owned by other plugins — including `!!js` expressions — cannot be damaged.

## Why skill hiding needs a definition copy

`ctx.skills.register()` files into the layer of the context that owns the service
instance, so only `agent.ctx.get('skills').register(...)` lands in the agent layer
where it can shadow a provider-sourced skill.

The registered entry must be a **copy of the whole definition** with
`modelInvocable: false`. A hand-built stub (`{ name, description, content: '' }`)
silently fails to hide anything: the registry returns the runtime entry verbatim,
so the model would receive an empty skill body, and the entry does not displace
the provider-sourced one. Both forms were measured on this host; only the copy
works.

## Removed: instruction pruning

`dsh-agent-instructions` used to render workspace instructions as one
`<system-reminder>` frame whose body held blocks separated by blank lines, each
section starting with `Instructions from: <path>`. Capability trim ran on
`agent/pre-step` after the loader produced that frame and cut matching sections
out.

That seam no longer yields the shape, so the feature was removed rather than left
in a state where the panel advertises switches that do nothing. `pruneInstructionFrame`
and `deniesInstruction` remain in `core.js` as pure, tested functions; nothing in
the Host or the client calls them.

## Verified in this installation

Against DSH `0.2.1-rc.2` / Cordis `4.0.5` (Windows, Desktop profile):

| Claim | How it was checked |
|---|---|
| A globally registered tool leaves the list | `get_screen_metrics` answered `unknown tool` while the control `get_goal` still worked |
| A preset-registered tool cannot be hidden | `get_goal`, `read_image`, `list_agents`, `web_search` stayed callable while denied |
| A skill leaves the catalog | With `grill-me` and `office-docx` denied, the session catalog dropped from 16 to 15 and both names disappeared |
| Clearing a layer restores it | Both the tool and the skill returned after the state file was emptied |
| Disabling the plugin restores live Agents | A live subagent went from `unknown tool` to a successful call |
| The Host route refuses strangers | An unauthenticated request answered `401` |
| Skill discovery needs a scope | `skills.list({})` and `skills.list({ cwd })` both returned 5 (bundled only); `list({ cwd, scope: agent })` returned 16 |

## Limits

- **Only globally registered tools can be restricted.** A tool registered inside
  an Agent preset's own composition is outside `restrict()`'s reach; it remains
  listed in the panel so the surface is visible, but flipping it does nothing.
- **A `ctx.systemPrompt.section()` contribution cannot be removed** from one
  workspace by another plugin; sections are scoped to their registering context.
- **A UI-only plugin has no per-agent seam** to unload.
- **A tool name is not a capability.** Restricting by name hides the schema, not
  the seam.
- **Instruction files are out of scope.** The pruning feature was removed; see
  above.
- **Workspace keys follow the directory.** Moving the folder detaches the scope
  until it is re-selected.

## Data

```
$DSH_HOME/capability-trim.json
```

Version 2. Written atomically (temporary file plus rename). A missing or corrupt
file reads as "nothing configured" rather than failing the Host. A version-1 file
still loads; its `sessions` map is discarded, because version 2 has no session
layer.

## API

`GET /capability-trim/api/state` — state plus the selectable surface (`tools`,
`skills`); accepts `?workspace=<path>` so skill discovery follows one workspace.

`PUT /capability-trim/api/state` — replaces the whole state:
`{ global?, workspaces? }`.

Both run the composition's `connection.requestRejection` fence first, so only
loopback-authenticated callers are served.
