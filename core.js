/**
 * Pure logic for capability trim: scope normalisation, two-layer resolution,
 * name matching, and instruction-frame pruning.
 *
 * Everything here is side-effect free and importable by `node --test`; the Host
 * half keeps only orchestration and I/O.
 *
 * @module dsh-capability-trim/core
 */

/** State format version written to disk. */
export const STATE_VERSION = 2

/** Reserved presentation transport; a scope restriction may not name it. */
export const RESERVED_TOOL = 'run_code'

/**
 * The capability categories this plugin can act on.
 *
 * `instructions` is NOT one of them. Instruction-file pruning was removed: it
 * rewrote the injected workspace context on `agent/pre-step`, and that seam no
 * longer produces the shape it matched. The `denyInstructions` field survives in
 * the stored model so an existing state file still loads without loss, but
 * nothing reads it.
 */
export const CATEGORIES = ['tools', 'skills']

/**
 * Instruction section markers, retained for the data model only.
 *
 * @deprecated Instruction pruning was removed; kept so old state files parse.
 */
export const INSTRUCTION_MARKERS = [
  'Instructions from: ',
  'Additional instructions from: ',
  'Updated instructions from: ',
]

/**
 * The stored model.
 *
 * A category holds ENTRances to hide, but the UI shows switches that default to
 * ON, so the wire form keeps the hidden list: absent means "nothing hidden",
 * which is the same as every switch on. Storing the hidden set rather than the
 * enabled set keeps an untouched profile at `{}`.
 */
export function emptyScope() {
  return { denyTools: [], denySkills: [], denyInstructions: [] }
}

/**
 * Whether a scope hides nothing.
 *
 * @param {{ denyTools: string[], denySkills: string[], denyInstructions: string[] }} scope
 * @returns {boolean}
 */
export function isEmptyScope(scope) {
  return scope.denyTools.length === 0
    && scope.denySkills.length === 0
    && scope.denyInstructions.length === 0
}

/**
 * Canonical comparison key for a workspace directory, so state survives casing
 * and separator drift between the registry and a Session header.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function pathKey(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replaceAll('/', '\\').replace(/\\+$/, '')
  return trimmed === '' ? '' : trimmed.toLowerCase()
}

/**
 * Whether one pattern selects a candidate name. A trailing `*` makes the
 * pattern a prefix, which is how a whole tool family is hidden.
 *
 * @param {string} pattern
 * @param {string} candidate
 * @returns {boolean}
 */
export function matchesPattern(pattern, candidate) {
  const needle = String(pattern).trim().toLowerCase()
  if (needle === '') return false
  const name = String(candidate).toLowerCase()
  return needle.endsWith('*') ? name.startsWith(needle.slice(0, -1)) : name === needle
}

/**
 * Whether any pattern selects the candidate.
 *
 * @param {readonly string[]} patterns
 * @param {string} candidate
 * @returns {boolean}
 */
export function matchesAny(patterns, candidate) {
  for (const pattern of patterns) {
    if (matchesPattern(pattern, candidate)) return true
  }
  return false
}

/**
 * Trim, drop blanks, and remove case-insensitive duplicates.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function cleanPatterns(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const result = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

/**
 * @param {unknown} value
 * @returns {{ denyTools: string[], denySkills: string[], denyInstructions: string[] }}
 */
export function normalizeScope(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  return {
    denyTools: cleanPatterns(source.denyTools),
    denySkills: cleanPatterns(source.denySkills),
    denyInstructions: cleanPatterns(source.denyInstructions),
  }
}

/**
 * @param {{ denyTools: string[], denySkills: string[], denyInstructions: string[] } | undefined} left
 * @param {{ denyTools: string[], denySkills: string[], denyInstructions: string[] } | undefined} right
 * @returns {boolean}
 */
export function sameScope(left, right) {
  if (left === undefined || right === undefined) return left === right
  return left.denyTools.join('\u0000') === right.denyTools.join('\u0000')
    && left.denySkills.join('\u0000') === right.denySkills.join('\u0000')
    && left.denyInstructions.join('\u0000') === right.denyInstructions.join('\u0000')
}

/**
 * Merge the two layers so the workspace wins per category.
 *
 * There is no session layer: a Session follows the workspace it runs in. Each
 * category resolves independently — a workspace that says nothing about skills
 * inherits the global skill list, while a workspace that names tools replaces
 * the global tool list rather than adding to it. Replacement keeps each layer
 * readable on its own: you can see the whole of what a workspace hides in one
 * place.
 *
 * @param {object | undefined} globalScope
 * @param {object | undefined} workspaceScope
 * @returns {{ denyTools: string[], denySkills: string[], denyInstructions: string[] }}
 */
export function resolveEffectiveScope(globalScope, workspaceScope) {
  const pick = field => {
    const workspaceValue = workspaceScope?.[field]
    if (Array.isArray(workspaceValue) && workspaceValue.length > 0) return [...workspaceValue]
    const globalValue = globalScope?.[field]
    if (Array.isArray(globalValue) && globalValue.length > 0) return [...globalValue]
    return []
  }
  return {
    denyTools: pick('denyTools'),
    denySkills: pick('denySkills'),
    denyInstructions: pick('denyInstructions'),
  }
}

/**
 * Read persisted state without trusting its shape.
 *
 * Version 1 carried a `sessions` map; version 2 drops it. A v1 file is accepted
 * and its session entries discarded, so an upgrade does not fail the Host.
 *
 * @param {unknown} parsed
 * @returns {{ version: number, global: object, workspaces: Map<string, object> }}
 */
export function readState(parsed) {
  const source = parsed !== null && typeof parsed === 'object' ? parsed : {}
  const workspaces = new Map()
  const globalScope = normalizeScope(source.global)

  if (source.workspaces !== null && typeof source.workspaces === 'object') {
    for (const [key, value] of Object.entries(source.workspaces)) {
      const scope = normalizeScope(value)
      if (!isEmptyScope(scope)) workspaces.set(pathKey(key), scope)
    }
  }

  return {
    version: STATE_VERSION,
    global: isEmptyScope(globalScope) ? emptyScope() : globalScope,
    workspaces,
  }
}

/**
 * Serialize state for persistence, dropping empty scopes so a cleared layer
 * disappears from the file entirely.
 *
 * @param {{ global: object, workspaces: Map<string, object> }} state
 * @returns {object}
 */
export function writeState(state) {
  const globalScope = normalizeScope(state.global)
  const workspaces = {}
  for (const [key, value] of state.workspaces ?? new Map()) {
    const scope = normalizeScope(value)
    if (!isEmptyScope(scope)) workspaces[key] = scope
  }
  return {
    version: STATE_VERSION,
    ...isEmptyScope(globalScope) ? {} : { global: globalScope },
    workspaces,
  }
}

/**
 * Split an instruction frame into its wrapper and body.
 *
 * @param {string} text
 * @returns {{ open: string, body: string, close: string } | undefined}
 */
function splitFrame(text) {
  const match = /^(<system-reminder>\n)([\s\S]*?)(<\/system-reminder>)$/.exec(text)
  if (match === null) return undefined
  return { open: match[1], body: match[2], close: match[3] }
}

/**
 * Locate the marker line that starts one instruction section.
 *
 * @param {string} body
 * @param {number} from
 * @returns {{ index: number, end: number, displayPath: string, marker: string } | undefined}
 */
function findMarker(body, from) {
  let best
  for (const marker of INSTRUCTION_MARKERS) {
    let index = body.indexOf(marker, from)
    while (index !== -1) {
      // A marker only counts at a block boundary, so instruction prose that
      // quotes the phrase cannot start a phantom section.
      const atBoundary = index === 0 || body.startsWith('\n\n', index - 2)
      if (atBoundary) {
        const newline = body.indexOf('\n', index)
        const lineEnd = newline === -1 ? body.length : newline
        const displayPath = body.slice(index + marker.length, lineEnd).trim()
        if (displayPath !== '' && (best === undefined || index < best.index)) {
          best = { index, marker, end: newline === -1 ? body.length : newline + 1, displayPath }
        }
        break
      }
      index = body.indexOf(marker, index + marker.length)
    }
  }
  return best
}

/**
 * Remove the instruction sections whose path matches a deny pattern.
 *
 * @param {string} text - the complete model-facing message text.
 * @param {readonly string[]} patterns - path patterns to remove.
 * @returns {{ text: string, removed: string[] }}
 */
export function pruneInstructionFrame(text, patterns) {
  if (typeof text !== 'string' || text === '' || patterns.length === 0) {
    return { text, removed: [] }
  }
  const frame = splitFrame(text)
  if (frame === undefined) return { text, removed: [] }

  const body = frame.body
  const sections = []
  let cursor = 0
  while (true) {
    const marker = findMarker(body, cursor)
    if (marker === undefined) break
    sections.push({ index: marker.index, end: marker.end, displayPath: marker.displayPath })
    cursor = marker.end
  }
  if (sections.length === 0) return { text, removed: [] }

  const keeps = []
  const removed = []
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]
    const next = sections[index + 1]
    if (!deniesInstruction(patterns, section.displayPath)) continue
    keeps.push({ start: section.index, end: next === undefined ? body.length : next.index })
    removed.push(section.displayPath)
  }
  if (keeps.length === 0) return { text, removed: [] }

  let pruned = ''
  let position = 0
  for (const span of keeps) {
    pruned += body.slice(position, span.start)
    position = span.end
  }
  pruned += body.slice(position)
  pruned = pruned.replace(/\n{3,}/g, '\n\n')

  if (pruned.trim() === '') return { text: `${frame.open}${frame.close}`, removed }
  return { text: `${frame.open}${pruned}${frame.close}`, removed }
}

/**
 * Whether a model-facing instruction path matches a deny pattern.
 *
 * A pattern matches either the whole project-relative path or the file's own
 * name, so `CLAUDE.md` hides every `CLAUDE.md` at any depth.
 *
 * @param {readonly string[]} patterns
 * @param {string} displayPath
 * @returns {boolean}
 */
export function deniesInstruction(patterns, displayPath) {
  const path = String(displayPath).replaceAll('\\', '/')
  const base = path.slice(path.lastIndexOf('/') + 1)
  for (const pattern of patterns) {
    if (matchesPattern(pattern, path)) return true
    if (base !== path && matchesPattern(pattern, base)) return true
  }
  return false
}
