/**
 * Capability trim — Host half.
 *
 * Removes part of the model-facing capability surface from a workspace: hidden
 * tools leave the tool list, hidden skills leave the session catalog, and hidden
 * instruction files are cut out of the injected workspace context.
 *
 * Selection has two layers — `workspace > global` — and no session layer: a
 * Session follows the workspace it runs in. Every restriction is an effect owned
 * by either the Agent scope or this plugin, so nothing touches the profile
 * configuration and clearing a layer restores the surface immediately.
 *
 * @module dsh-capability-trim
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  RESERVED_TOOL,
  emptyScope,
  isEmptyScope,
  matchesAny,
  pathKey,
  pruneInstructionFrame,
  readState,
  resolveEffectiveScope,
  sameScope,
  writeState,
} from './core.js'

/** Cordis plugin name. */
export const name = 'capability-trim'

/** The tool registry is required; every other seam is optional through `ctx.get`. */
export const inject = ['tools']

const STATE_FILE = 'capability-trim.json'
const ROUTE_BASE = '/capability-trim/api'
const MAX_BODY_BYTES = 256 * 1024

/** Absolute path of the persisted state file. */
function statePath() {
  const home = process.env.DSH_HOME
  const root = typeof home === 'string' && home.trim() !== '' ? home : join(homedir(), '.dsh')
  return join(root, STATE_FILE)
}

/**
 * Replace the state file atomically, so an interrupted write cannot leave a
 * half-written scope behind.
 *
 * @param {object} state
 */
async function persist(state) {
  const target = statePath()
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(writeState(state), null, 2)}\n`, 'utf8')
  await rename(temporary, target)
}

/** Read persisted state, treating absence or corruption as "nothing configured". */
async function load() {
  try {
    return readState(JSON.parse(await readFile(statePath(), 'utf8')))
  } catch {
    return readState(undefined)
  }
}

/**
 * Register the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  let state = readState(undefined)
  let ready = false
  /** @type {Map<string, () => void>} */
  const installed = new Map()
  /** @type {Set<() => void>} */
  const retired = new Set()
  const logger = ctx.logger?.(name)

  /** Release every scope this plugin installed on live Agents. */
  const retireAll = () => {
    for (const dispose of [...retired]) {
      try {
        dispose()
      } catch {}
    }
    retired.clear()
  }

  // The plugin owns the registrations it made on each `agent.ctx`; disabling or
  // uninstalling restores the global surface immediately instead of waiting for
  // those Agents to be disposed.
  ctx.effect(() => () => retireAll())

  /** Effective directory of one live Agent, or undefined when it has none. */
  const directoryOf = agent => {
    const directories = ctx.get('workingDirectory')
    if (directories === undefined) return undefined
    try {
      return directories.get(agent.session)
    } catch {
      return undefined
    }
  }

  /** The restrictions one Agent is governed by, after layering. */
  const scopeFor = agent => {
    const cwd = directoryOf(agent)
    return resolveEffectiveScope(
      isEmptyScope(state.global) ? undefined : state.global,
      cwd === undefined ? undefined : state.workspaces.get(pathKey(cwd)),
    )
  }

  /** Names the tool registry offers globally and that a restriction may name. */
  const knownToolNames = () => ctx.tools.definitions()
    .map(definition => definition.name)
    .filter(toolName => toolName !== RESERVED_TOOL)

  /** Remove every registration that made up one Agent's scope. */
  const uninstall = agentId => {
    const dispose = installed.get(agentId)
    if (dispose === undefined) return
    installed.delete(agentId)
    try {
      dispose()
    } catch {}
  }

  /**
   * Install one Agent's restrictions on its own scope.
   *
   * @param {any} agent
   * @returns {Promise<(() => void) | undefined>}
   */
  const install = async agent => {
    const scope = scopeFor(agent)
    if (isEmptyScope(scope)) return undefined

    /** @type {Array<() => void>} */
    const disposers = []
    try {
      const denied = knownToolNames().filter(toolName => matchesAny(scope.denyTools, toolName))
      if (denied.length > 0) disposers.push(agent.ctx.tools.restrict({ deny: denied }))

      const skills = ctx.get('skills')
      if (skills !== undefined && scope.denySkills.length > 0) {
        const cwd = directoryOf(agent)
        // A scope is required: without it the registry merges only its global
        // layer, so user and project skills from the preset-registered provider
        // are invisible and a deny rule silently matches nothing.
        const lookup = { ...cwd === undefined ? {} : { cwd }, scope: agent }
        const catalog = await skills.list(lookup)
        for (const summary of catalog) {
          if (!matchesAny(scope.denySkills, summary.name)) continue
          // Copy the whole definition before hiding it. A hand-built stub
          // (`content: ''`) does not work: the registry returns the runtime entry
          // verbatim, so the model would receive an empty body, and the entry
          // does not displace the provider-sourced one. Measured both ways.
          const definition = await skills.get(summary.name, lookup)
          if (definition === undefined) continue
          const invocation = definition.invocation ?? { modelInvocable: true, userInvocable: true }
          // Register through THIS Agent's own service instance: `register()`
          // files into the layer of the context that owns the service, so
          // `agent.ctx` is the only instance that lands in the layer where it
          // can shadow a preset-registered skill.
          const scopedSkills = agent.ctx.get('skills')
          if (scopedSkills === undefined) continue
          disposers.push(scopedSkills.register({
            ...definition,
            invocation: {
              ...invocation,
              modelInvocable: false,
              userInvocable: invocation.userInvocable !== false,
            },
          }))
        }
      }
    } catch (error) {
      for (const release of disposers.reverse()) {
        try {
          release()
        } catch {}
      }
      logger?.warn('could not apply the capability trim: %o', error)
      return undefined
    }

    if (disposers.length === 0) return undefined
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      for (const release of disposers.reverse()) {
        try {
          release()
        } catch {}
      }
      retired.delete(dispose)
    }
    retired.add(dispose)
    return dispose
  }

  /**
   * Apply the current state to one Agent, replacing any earlier scope.
   *
   * @param {any} agent
   */
  const applyTo = async agent => {
    uninstall(agent.id)
    const dispose = await install(agent)
    if (dispose !== undefined) installed.set(agent.id, dispose)
  }

  /**
   * Re-apply every live Agent whose effective scope changed.
   *
   * @param {{ global: object, workspaces: Map<string, object> }} previous
   */
  const applyChanged = async previous => {
    const agents = ctx.get('agents')
    if (agents === undefined) return
    for (const agent of agents.list()) {
      const cwd = directoryOf(agent)
      const before = resolveEffectiveScope(
        isEmptyScope(previous.global) ? undefined : previous.global,
        cwd === undefined ? undefined : previous.workspaces.get(pathKey(cwd)),
      )
      if (sameScope(before, scopeFor(agent))) continue
      await applyTo(agent)
    }
  }

  ctx.on('agent/created', async ({ agent }) => {
    if (ready) await applyTo(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    uninstall(agent.id)
  })

  // Instructions are injected as ordinary user messages. This listener runs
  // after the instruction loader has produced its frame and rewrites only the
  // frames whose source is that producer, so nothing else in the step moves.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!ready) return decision

    const trim = scopeFor(payload.agent)
    if (trim.denyInstructions.length === 0) return decision

    let anyChanged = false
    const messages = decision.messages.map(message => {
      if (message.source?.kind !== 'agent-instructions') return message
      const blocks = []
      let changed = false
      for (const block of message.content) {
        if (block.type !== 'text') {
          blocks.push(block)
          continue
        }
        const pruned = pruneInstructionFrame(block.text, trim.denyInstructions)
        if (pruned.removed.length === 0) {
          blocks.push(block)
          continue
        }
        changed = true
        blocks.push({ ...block, text: pruned.text })
      }
      if (!changed) return message
      anyChanged = true
      return { ...message, content: blocks }
    })
    if (!anyChanged) return decision
    return { ...decision, messages }
  })

  void (async () => {
    state = await load()
    ready = true
    const agents = ctx.get('agents')
    if (agents === undefined) return
    for (const agent of agents.list()) await applyTo(agent)
  })()

  // The route is its own lifecycle: `webServer` and `connection` may be provided
  // after this plugin applies, so waiting on them keeps the panel working
  // regardless of boot order.
  ctx.inject(['webServer', 'connection'], browser => {
    const webServer = browser.webServer
    const connection = browser.connection

    /** Answer an unauthenticated or foreign request; true when it was rejected. */
    const rejected = (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection === undefined) return false
      res.statusCode = rejection
      res.end()
      return true
    }

    const sendJson = (res, status, body) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    }

    const readJsonBody = async req => {
      const chunks = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > MAX_BODY_BYTES) throw new Error('request body is too large')
        chunks.push(chunk)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }

    /**
     * A live Agent to read the catalog through.
     *
     * The skill registry merges a global layer with the viewing scope's chain,
     * and the filesystem provider — the source of every user and project skill —
     * is registered inside an agent-preset layer. A read without a scope sees
     * only the deployment-wide bundled skills, so every catalog read borrows an
     * Agent.
     *
     * @param {string | undefined} preferredCwd prefer an Agent working here
     */
    const anyAgent = preferredCwd => {
      const agents = ctx.get('agents')
      if (agents === undefined) return undefined
      const live = agents.list()
      if (live.length === 0) return undefined
      if (preferredCwd === undefined) return live[0]
      const key = pathKey(preferredCwd)
      for (const agent of live) {
        if (pathKey(directoryOf(agent) ?? '') === key) return agent
      }
      return live[0]
    }

    /**
     * Instruction files present in a workspace.
     *
     * Uses Node's own `fs` rather than `ctx.fs`: this is a read of four known
     * names directly under a directory the Host already trusts, and routing it
     * through the composed filesystem made a present `AGENTS.md` report absent.
     * The listener that does the pruning never reads files either — it rewrites
     * the frame the instruction loader already produced — so the panel must not
     * claim a different set than that loader sees.
     */
    const instructionFiles = async cwd => {
      const candidates = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
      if (cwd === undefined) return candidates.map(path => ({ path }))
      const found = []
      for (const candidate of candidates) {
        try {
          const info = await stat(join(cwd, candidate))
          if (info.isFile()) found.push({ path: candidate, bytes: info.size })
        } catch {
          // A missing candidate is simply not offered.
        }
      }
      // Every name the loader would consider, so the panel can say what exists
      // even when a higher-precedence file already won.
      return found
    }

    /** The selectable surface for one workspace. */
    const surface = async cwd => {
      const skills = ctx.get('skills')
      const agent = anyAgent(cwd)
      let skillSummaries = []
      let skillError
      if (skills !== undefined) {
        try {
          const options = {
            ...cwd === undefined ? {} : { cwd },
            ...agent === undefined ? {} : { scope: agent },
          }
          const catalog = await skills.list(options)
          skillSummaries = catalog
            .filter(summary => summary.invocation.modelInvocable)
            .map(summary => ({ name: summary.name, description: summary.description }))
        } catch (error) {
          // An empty list and a failed discovery look identical in the panel, so
          // the failure travels to it rather than being swallowed.
          skillError = error instanceof Error ? error.message : String(error)
          logger?.warn('skill discovery failed: %s', skillError)
        }
      }
      return {
        tools: knownToolNames().sort(),
        skills: skillSummaries,
        ...skillError === undefined ? {} : { skillError },
        instructions: await instructionFiles(cwd),
      }
    }

    /** Registry workspaces, with the directory the panel keys scopes by. */
    const workspaceView = () => {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined) return []
      return registry.list().map(workspace => ({
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
        // The composer control must map a Session to its workspace directory, and
        // the slot props carry none, so the association travels with the state.
        sessionIds: [...workspace.sessionIds].map(String),
        scope: state.workspaces.get(pathKey(workspace.path)) ?? emptyScope(),
      }))
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/state`,
      handler: async (req, res) => {
        if (rejected(req, res)) return

        if (req.method === 'GET') {
          const requested = new URL(String(req.url), 'http://localhost').searchParams.get('workspace')
          const directories = ctx.get('workingDirectory')
          const fallback = directories === undefined ? undefined : directories.defaultDirectory
          const focus = typeof requested === 'string' && requested !== '' ? requested : fallback
          sendJson(res, 200, {
            version: state.version,
            global: state.global,
            workspaces: workspaceView(),
            ...await surface(focus),
          })
          return
        }

        if (req.method === 'PUT') {
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            sendJson(res, 400, { error: 'invalid body', detail: String(error) })
            return
          }
          const next = readState({
            global: body?.global,
            workspaces: body?.workspaces,
          })
          const previous = state
          state = next
          try {
            await persist(next)
          } catch (error) {
            state = previous
            sendJson(res, 500, { error: 'could not save the capability trim', detail: String(error) })
            return
          }
          await applyChanged(previous)
          sendJson(res, 200, { ok: true, workspaces: next.workspaces.size })
          return
        }

        res.statusCode = 405
        res.setHeader('allow', 'GET, PUT')
        res.end()
      },
    }), `capability-trim: ${ROUTE_BASE}/state`)
  })
}
