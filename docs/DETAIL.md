# Capability trim — details

## What it is

A Harness profile enables plugins process-wide. Every model step re-sends the
schema of every registered tool and assembles the skill catalog, so a plugin
that one project needs is a fixed per-turn cost in every other project.

Capability trim is a per-Session subtraction over that surface. It never adds a
capability and never enables a plugin: it only removes what a layer says it does
not want.

## The three categories

| Category | Effect when hidden | Mechanism |
|---|---|---|
| Tools | Removed from the Agent's tool list; the schema is not sent | `agent.ctx.tools.restrict({ deny })` |
| Skills | Removed from the session skill catalog and the `skill` tool | A same-name scope-local registration marked non-invocable |
| Instruction files | The section is cut out of the injected workspace context | `agent/pre-step` rewrites the rendered frame |

All three are applied per Agent, so two Sessions in one process see different
surfaces.

## Layer resolution

```
session  >  workspace  >  global
```

For each category the most specific layer that names **any** pattern wins. A
layer replaces the broader category list rather than extending it:

```json
{
  "version": 1,
  "global":    { "denyTools": ["office_*"] },
  "workspaces": { "j:\\work\\web": { "denySkills": ["office-docx"] } },
  "sessions":   { "<sessionId>": { "denyTools": ["read_image"] } }
}
```

In that example a Session in `j:\work\web` hides `read_image` (session category
wins for tools) and `office-docx` (workspace category, since the session says
nothing about skills). Instruction files fall back to global, which is empty.
`office_*` is **not** applied to that session, because the session's tool
category replaced the global one. That is the trade that makes each layer
predictable: you can always see the whole of what a session hides in one place.

## Reversibility

Every restriction is an effect with two owners:

- the Agent's own scope (`agent.ctx`), which unwinds it when the Agent is
  disposed;
- this plugin's effect, which unwinds it when the plugin is disabled or removed.

The second owner matters: Loader teardown does not dispose `agent.ctx`
contributions by itself. Without it, disabling the plugin would leave its
restrictions in place until each Agent was disposed.

The profile's `cordis.patch.yml` is never read, filtered, or written, so rows
owned by other plugins — including `!!js` expressions — cannot be damaged.

## Instruction pruning

`dsh-agent-instructions` renders workspace instructions as a single
`<system-reminder>` frame whose body is blocks separated by blank lines, each
section starting with `Instructions from: <path>` (plus the
`Additional instructions from:` and `Updated instructions from:` variants for
deltas).

Capability trim runs on `agent/pre-step` after the loader has produced that
frame, and only for messages whose source kind is `agent-instructions`. A
section is removed when its printed path matches a pattern; everything else —
the intro paragraph, the surviving sections, the wrapper — is preserved byte for
byte. A pattern also matches the bare file name at any depth, so `CLAUDE.md`
hides every `CLAUDE.md`, while `web/CLAUDE.md` hides exactly one.

The section list is parsed from the rendered text, not from the source files, so
this works for the baseline and for later reconciliation deltas alike, and it
never touches the instruction files themselves.

## Verified in this installation

Against DSH `0.2.1-rc.2` / Cordis `4.0.5` (Windows, Desktop profile):

| Claim | How it was checked |
|---|---|
| A hidden tool leaves the Agent's tool list | A subagent could not call the hidden tool while a control tool still worked |
| Clearing the layer restores it | The same Agent could call it again after the state file was emptied |
| Disabling the plugin restores live Agents | A live subagent went from `unknown tool` to a successful call after the plugin was disabled |
| The Host route refuses unauthenticated callers | An unauthenticated request answered `401` |
| Scope is per Agent, not per process | A fresh Agent saw the untrimmed surface while another Agent stayed trimmed |
| **Only globally registered tools are restrictable** | Denying six tools at once hid `get_screen_metrics` and `desktop_step` (global) while `read_image`, `list_agents`, `get_goal` and `web_search` (registered inside the preset's own scope) stayed callable |

The last row is the important one: `tools.restrict()` accepts only names the
global view knows. It does not throw for a scoped name — it simply cannot reach
it. A deployment that registers its tools inside an agent preset therefore has a
smaller trimmable surface than its tool list suggests.

Pruning of instruction frames is covered by unit tests, not by an end-to-end
observation in the running GUI.

## Limits

- **Only globally registered tools can be restricted.** `tools.restrict()` masks
  tools the deployment registers globally; a tool registered inside an Agent
  preset's own composition is outside its reach. Hiding its tools is therefore
  not the same as emptying the tool list — see the measured row above.
- **A `ctx.systemPrompt.section()` contribution cannot be removed** from one
  workspace by another plugin; sections are scoped to their registering context.
- **A UI-only plugin has no per-agent seam** to unload: hiding its tools removes
  what the model calls, not the sidebar button.
- **A tool name is not a capability.** Restricting by name hides the schema, not
  the seam; anything the model reaches another way is unaffected.
- **Instruction pruning is textual.** A file whose rendered path is inside a
  truncated or omitted section cannot be pruned, because it never appeared.
- **Workspace keys follow the directory.** Moving the folder detaches the scope
  until it is re-selected.

## Data

```
$DSH_HOME/capability-trim.json
```

Written atomically (temporary file plus rename). A missing or corrupt file reads
as "nothing configured" rather than failing the Host.

## API

`GET /capability-trim/api/state` — current state plus the selectable surface
(`tools`, `skills`, `instructions`); accepts `?workspace=<path>` so skill and
instruction discovery follow one workspace.

`PUT /capability-trim/api/state` — replaces the whole state:
`{ global?, workspaces?, sessions? }`.

Both run the composition's `connection.requestRejection` fence first, so only
loopback-authenticated callers are served.
