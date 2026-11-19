/**
 * Capability trim — Host half.
 *
 * Removes part of the capability surface from a Session: tools leave the model
 * tool list, skills leave the session catalog, and instruction files are cut out
 * of the injected workspace context. Selection is layered
 * `session > workspace > global`, and every restriction is an effect owned by
 * either the Agent scope or this plugin, so nothing touches the profile
 * configuration and clearing a layer restores the surface immediately.
 *
 * @module dsh-capability-trim
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  RESERVED_TOOL,
  emptyScope,
  isEmptyScope,
  matchesAny,
  normalizeScope,
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

  /** The scope one Agent is governed by, after layering. */
  const scopeFor = agent => {
    const cwd = directoryOf(agent)
    const sessionId = String(agent.id)
    return resolveEffectiveScope(
      isEmptyScope(state.global) ? undefined : state.global,
      cwd === undefined ? undefined : state.workspaces.get(pathKey(cwd)),
      state.sessions.get(sessionId),
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
        const catalog = await skills.list(cwd === undefined ? {} : { cwd })
        for (const summary of catalog) {
          if (!matchesAny(scope.denySkills, summary.name)) continue
          // A scoped registration with the same name wins outright in this
          // Agent's layer; a non-model-invocable entry leaves the catalog.
          disposers.push(agent.ctx.skills.register({
            name: summary.name,
            description: summary.description,
            content: '',
            invocation: { modelInvocable: false, userInvocable: false },
            provider: name,
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
   * Re-apply every live Agent whose effective scope changed, so a save is felt
   * by running sessions without a restart.
   *
   * @param {{ global: object, workspaces: Map<string, object>, sessions: Map<string, object> }} previous
   */
  const applyChanged = async previous => {
    const agents = ctx.get('agents')
    if (agents === undefined) return
    for (const agent of agents.list()) {
      const cwd = directoryOf(agent)
      const before = resolveEffectiveScope(
        isEmptyScope(previous.global) ? undefined : previous.global,
        cwd === undefined ? undefined : previous.workspaces.get(pathKey(cwd)),
        previous.sessions.get(String(agent.id)),
      )
      if (sameScope(before, scopeFor(agent))) continue
      await applyTo(agent)
    }
  }

  ctx.on('agent/created', async ({ agent }) => {
    if (ready) await applyTo(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    uninstall(String(agent.id))
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

  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (webServer === undefined || connection === undefined) return

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
   * Instruction files present in a workspace, so the panel offers real paths
   * rather than a guess. Discovery is best-effort: a missing `fs` seam or a
   * vanished workspace simply yields fewer rows.
   *
   * @param {string | undefined} cwd
   */
  const instructionFiles = async cwd => {
    const candidates = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
    if (cwd === undefined) return candidates.map(path => ({ path }))
    const fs = ctx.get('fs')
    if (fs === undefined) return candidates.map(path => ({ path }))
    const found = []
    for (const candidate of candidates) {
      try {
        // `lstat` accepts a plain path plus a base directory, which is the one
        // shape that does not require constructing a provider-specific target.
        const info = await fs.lstat(candidate, { cwd })
        if (info !== undefined && info !== null) found.push({ path: candidate })
      } catch {
        // A missing candidate is simply not offered.
      }
    }
    return found
  }

  /** Everything the panel needs to render a checklist for one workspace. */
  const surface = async cwd => {
    const skills = ctx.get('skills')
    let skillSummaries = []
    if (skills !== undefined) {
      try {
        const catalog = await skills.list(cwd === undefined ? {} : { cwd })
        skillSummaries = catalog
          .filter(summary => summary.invocation.modelInvocable)
          .map(summary => ({ name: summary.name, description: summary.description }))
      } catch {
        skillSummaries = []
      }
    }
    return {
      tools: knownToolNames().sort(),
      skills: skillSummaries,
      instructions: await instructionFiles(cwd),
    }
  }

  /** Registry workspaces plus each one's own scope. */
  const workspaceView = () => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return []
    return registry.list().map(workspace => ({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
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
        sendJson(res, 200, {
          version: state.version,
          global: state.global,
          workspaces: workspaceView(),
          sessions: Object.fromEntries(state.sessions),
          ...await surface(typeof requested === 'string' && requested !== '' ? requested : undefined),
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
          global: normalizeScope(body?.global),
          workspaces: body?.workspaces,
          sessions: body?.sessions,
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
        sendJson(res, 200, {
          ok: true,
          workspaces: next.workspaces.size,
          sessions: next.sessions.size,
        })
        return
      }

      res.statusCode = 405
      res.setHeader('allow', 'GET, PUT')
      res.end()
    },
  }), `capability-trim: ${ROUTE_BASE}/state`)
}
