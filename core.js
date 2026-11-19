/**
 * Pure logic for capability trim: scope normalisation, precedence resolution,
 * name matching, and instruction-frame pruning.
 *
 * Everything here is side-effect free and importable by `node --test`; the
 * Host half keeps only orchestration and I/O.
 *
 * @module dsh-capability-trim/core
 */

/** State format version written to disk. */
export const STATE_VERSION = 1

/** Reserved presentation transport; a scope restriction may not name it. */
export const RESERVED_TOOL = 'run_code'

/** Instruction file names this plugin can prune, in the order they are reported. */
export const INSTRUCTION_MARKERS = [
  'Instructions from: ',
  'Additional instructions from: ',
  'Updated instructions from: ',
]

/** An empty scope. */
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
 * pattern a prefix, which is how a whole server or tool family is hidden.
 * Matching is case-insensitive.
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
 * Trim, drop blanks, and remove case-insensitive duplicates while keeping the
 * caller's order.
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
 * Coerce unknown input into a well-formed scope.
 *
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
 * Whether two scopes describe identical restrictions.
 *
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
 * Merge three scope layers so that the most specific one wins per pattern list.
 *
 * The order is `global`, then `workspace`, then `session`: a layer that names
 * any pattern replaces the broader layer's list for that category rather than
 * adding to it. Replacement rather than accumulation is what makes
 * `session > workspace > global` predictable — a session can both hide more and
 * hide less than its workspace without editing it.
 *
 * @param {{ denyTools: string[], denySkills: string[], denyInstructions: string[] } | undefined} globalScope
 * @param {{ denyTools: string[], denySkills: string[], denyInstructions: string[] } | undefined} workspaceScope
 * @param {{ denyTools: string[], denySkills: string[], denyInstructions: string[] } | undefined} sessionScope
 * @returns {{ denyTools: string[], denySkills: string[], denyInstructions: string[] }}
 */
export function resolveEffectiveScope(globalScope, workspaceScope, sessionScope) {
  const layers = [globalScope, workspaceScope, sessionScope]
  const pick = (field) => {
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index]
      if (layer === undefined) continue
      const value = layer[field]
      if (Array.isArray(value) && value.length > 0) return [...value]
    }
    return []
  }
  return {
    denyTools: pick('denyTools'),
    denySkills: pick('denySkills'),
    denyInstructions: pick('denyInstructions'),
  }
}

/**
 * Deserialize persisted state without trusting its shape.
 *
 * Unknown fields are dropped, blank arrays are dropped, and a malformed record
 * is skipped rather than throwing: a corrupt state file must never take the
 * Host down.
 *
 * @param {unknown} parsed
 * @returns {{ version: number, global: object, workspaces: Map<string, object>, sessions: Map<string, object> }}
 */
export function readState(parsed) {
  const source = parsed !== null && typeof parsed === 'object' ? parsed : {}
  const workspaces = new Map()
  const sessions = new Map()
  const globalScope = normalizeScope(source.global)

  const collect = (input, target) => {
    if (input === null || typeof input !== 'object') return
    for (const [key, value] of Object.entries(input)) {
      const scope = normalizeScope(value)
      if (!isEmptyScope(scope)) target.set(key, scope)
    }
  }
  collect(source.workspaces, workspaces)
  collect(source.sessions, sessions)

  return {
    version: STATE_VERSION,
    global: isEmptyScope(globalScope) ? emptyScope() : globalScope,
    workspaces,
    sessions,
  }
}

/**
 * Serialize state for persistence, dropping empty scopes so the file stays
 * readable and a cleared workspace disappears from it entirely.
 *
 * @param {{ global: object, workspaces: Map<string, object>, sessions: Map<string, object> }} state
 * @returns {object}
 */
export function writeState(state) {
  const globalScope = normalizeScope(state.global)
  const collect = (source) => {
    const result = {}
    for (const [key, value] of source) {
      const scope = normalizeScope(value)
      if (!isEmptyScope(scope)) result[key] = scope
    }
    return result
  }
  return {
    version: STATE_VERSION,
    ...isEmptyScope(globalScope) ? {} : { global: globalScope },
    workspaces: collect(state.workspaces ?? new Map()),
    sessions: collect(state.sessions ?? new Map()),
  }
}

/**
 * Split an instruction frame into its opening line, body, and closing line.
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
 * @returns {{ index: number, end: number, displayPath: string } | undefined} the
 * marker's start, the offset just past its newline, and the path it names.
 */
function findMarker(body, from) {
  let best
  for (const marker of INSTRUCTION_MARKERS) {
    let index = body.indexOf(marker, from)
    while (index !== -1) {
      // A marker only counts at a block boundary, so instruction prose that
      // happens to quote the phrase cannot start a phantom section.
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
 * The frame is the one `dsh-agent-instructions` renders: a `<system-reminder>`
 * wrapper whose body is blocks separated by blank lines, each section starting
 * with `Instructions from: <path>` (or an `Additional`/`Updated` variant). Only
 * the matching sections are cut; every other byte — the intro paragraph, the
 * remaining sections, the wrapper — is preserved so the reader sees a normal
 * frame.
 *
 * @param {string} text - the complete model-facing message text.
 * @param {readonly string[]} patterns - path patterns to remove.
 * @returns {{ text: string, removed: string[] }} the pruned frame and the paths
 * it removed. When nothing matched the input is returned unchanged.
 */
export function pruneInstructionFrame(text, patterns) {
  if (typeof text !== 'string' || text === '' || patterns.length === 0) {
    return { text, removed: [] }
  }
  const frame = splitFrame(text)
  if (frame === undefined) return { text, removed: [] }

  const body = frame.body
  /** @type {Array<{ index: number, end: number, displayPath: string }>} */
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
    // The section runs to the next marker; the leading blank separator belongs
    // to the block being removed, so no stray gap survives.
    const start = section.index
    const end = next === undefined ? body.length : next.index
    keeps.push({ start, end })
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
  // Collapse the blank separators left behind where a middle section was cut.
  pruned = pruned.replace(/\n{3,}/g, '\n\n')

  const trimmed = pruned.trim()
  if (trimmed === '') {
    return { text: `${frame.open}${frame.close}`, removed }
  }
  return { text: `${frame.open}${pruned}${frame.close}`, removed }
}

/**
 * Whether a model-facing instruction path matches any deny pattern.
 *
 * A pattern matches either the whole project-relative path or the file's own
 * name, so `CLAUDE.md` hides every `CLAUDE.md` at any depth while
 * `web/CLAUDE.md` hides just that one. Trailing `*` still works as a prefix.
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
