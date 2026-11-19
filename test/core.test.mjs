import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  INSTRUCTION_MARKERS,
  RESERVED_TOOL,
  STATE_VERSION,
  cleanPatterns,
  deniesInstruction,
  emptyScope,
  isEmptyScope,
  matchesAny,
  matchesPattern,
  normalizeScope,
  pathKey,
  pruneInstructionFrame,
  readState,
  resolveEffectiveScope,
  sameScope,
  writeState,
} from '../core.js'

test('pathKey canonicalises separators, casing and trailing slashes', () => {
  assert.equal(pathKey('J:\\Work\\Proj'), 'j:\\work\\proj')
  assert.equal(pathKey('J:/Work/Proj'), 'j:\\work\\proj')
  assert.equal(pathKey('J:/Work/Proj/'), 'j:\\work\\proj')
  assert.equal(pathKey('J:\\Work\\Proj\\\\'), 'j:\\work\\proj')
  assert.equal(pathKey('  J:\\Work  '), 'j:\\work')
})

test('pathKey is empty for unusable input', () => {
  assert.equal(pathKey(undefined), '')
  assert.equal(pathKey(null), '')
  assert.equal(pathKey(42), '')
  assert.equal(pathKey('   '), '')
  assert.equal(pathKey('\\\\'), '')
})

test('matchesPattern is exact unless the pattern ends in a star', () => {
  assert.equal(matchesPattern('read', 'read'), true)
  assert.equal(matchesPattern('READ', 'read'), true)
  assert.equal(matchesPattern('read', 'read_image'), false)
  assert.equal(matchesPattern('read_*', 'read_image'), true)
  assert.equal(matchesPattern('mcp__github__*', 'mcp__github__list_issues'), true)
  assert.equal(matchesPattern('mcp__github__*', 'mcp__gitlab__list_issues'), false)
})

test('matchesPattern ignores blank patterns', () => {
  assert.equal(matchesPattern('', 'read'), false)
  assert.equal(matchesPattern('   ', 'read'), false)
})

test('matchesAny short-circuits over a list', () => {
  assert.equal(matchesAny(['a', 'b'], 'b'), true)
  assert.equal(matchesAny(['a', 'b'], 'c'), false)
  assert.equal(matchesAny([], 'a'), false)
})

test('cleanPatterns trims, drops blanks and de-duplicates case-insensitively', () => {
  assert.deepEqual(cleanPatterns([' a ', 'A', '', '  ', 'b']), ['a', 'b'])
  assert.deepEqual(cleanPatterns('not an array'), [])
  assert.deepEqual(cleanPatterns([1, null, 'x']), ['x'])
})

test('normalizeScope always yields the three arrays', () => {
  assert.deepEqual(normalizeScope(undefined), { denyTools: [], denySkills: [], denyInstructions: [] })
  assert.deepEqual(normalizeScope(null), { denyTools: [], denySkills: [], denyInstructions: [] })
  assert.deepEqual(
    normalizeScope({ denyTools: [' t '], unknown: ['x'] }),
    { denyTools: ['t'], denySkills: [], denyInstructions: [] },
  )
})

test('emptyScope and isEmptyScope agree', () => {
  assert.equal(isEmptyScope(emptyScope()), true)
  assert.equal(isEmptyScope({ denyTools: ['x'], denySkills: [], denyInstructions: [] }), false)
})

test('sameScope compares every category', () => {
  const a = { denyTools: ['x'], denySkills: [], denyInstructions: [] }
  assert.equal(sameScope(a, { ...a }), true)
  assert.equal(sameScope(a, { ...a, denyInstructions: ['AGENTS.md'] }), false)
  assert.equal(sameScope(undefined, undefined), true)
  assert.equal(sameScope(a, undefined), false)
})

test('resolveEffectiveScope lets the most specific populated layer win', () => {
  const globalScope = { denyTools: ['g'], denySkills: [], denyInstructions: [] }
  const workspaceScope = { denyTools: [], denySkills: ['w'], denyInstructions: [] }
  const sessionScope = { denyTools: ['s'], denySkills: [], denyInstructions: ['CLAUDE.md'] }

  const resolved = resolveEffectiveScope(globalScope, workspaceScope, sessionScope)
  assert.deepEqual(resolved.denyTools, ['s'], 'session overrides the broader tool list')
  assert.deepEqual(resolved.denySkills, ['w'], 'workspace fills the category session left empty')
  assert.deepEqual(resolved.denyInstructions, ['CLAUDE.md'])
})

test('resolveEffectiveScope replaces rather than accumulates', () => {
  const resolved = resolveEffectiveScope(
    { denyTools: ['a'], denySkills: [], denyInstructions: [] },
    { denyTools: ['b'], denySkills: [], denyInstructions: [] },
    undefined,
  )
  assert.deepEqual(resolved.denyTools, ['b'], 'a workspace narrows the global list, not adds to it')
})

test('resolveEffectiveScope tolerates missing layers', () => {
  assert.deepEqual(resolveEffectiveScope(undefined, undefined, undefined), emptyScope())
  assert.deepEqual(
    resolveEffectiveScope(undefined, { denyTools: ['w'], denySkills: [], denyInstructions: [] }, undefined).denyTools,
    ['w'],
  )
})

test('readState rebuilds maps and drops empty scopes', () => {
  const state = readState({
    version: STATE_VERSION,
    global: { denyTools: ['g'] },
    workspaces: {
      'j:\\a': { denyTools: ['x'] },
      'j:\\b': { denyTools: [] },
    },
    sessions: { s1: { denySkills: ['office-docx'] } },
  })
  assert.deepEqual(state.workspaces.get('j:\\a').denyTools, ['x'])
  assert.equal(state.workspaces.has('j:\\b'), false, 'an empty workspace scope is not stored')
  assert.deepEqual(state.sessions.get('s1').denySkills, ['office-docx'])
  assert.deepEqual(state.global.denyTools, ['g'])
})

test('readState survives garbage without throwing', () => {
  for (const input of [undefined, null, 42, 'text', [], { workspaces: 'nope' }, { sessions: null }]) {
    const state = readState(input)
    assert.deepEqual(state.global, emptyScope())
    assert.equal(state.workspaces.size, 0)
    assert.equal(state.sessions.size, 0)
  }
})

test('writeState round-trips through readState', () => {
  const original = {
    global: { denyTools: ['g'], denySkills: [], denyInstructions: [] },
    workspaces: new Map([['j:\\a', { denyTools: ['w'], denySkills: [], denyInstructions: [] }]]),
    sessions: new Map([['s1', { denyTools: [], denySkills: [], denyInstructions: ['AGENTS.md'] }]]),
  }
  const restored = readState(writeState(original))
  assert.deepEqual(restored.global, original.global)
  assert.deepEqual(restored.workspaces.get('j:\\a'), original.workspaces.get('j:\\a'))
  assert.deepEqual(restored.sessions.get('s1'), original.sessions.get('s1'))
})

test('writeState omits an empty global scope', () => {
  const serialized = writeState({ global: emptyScope(), workspaces: new Map(), sessions: new Map() })
  assert.equal('global' in serialized, false)
  assert.deepEqual(serialized.workspaces, {})
})

const frame = (body) => `<system-reminder>\n${body}\n</system-reminder>`

test('pruneInstructionFrame removes one matching section and keeps the rest', () => {
  const body = [
    'The following workspace instructions may be relevant to your work.',
    '',
    'Instructions from: AGENTS.md',
    '',
    'root rules',
    '',
    'Instructions from: web/CLAUDE.md',
    '',
    'legacy rules',
  ].join('\n')
  const result = pruneInstructionFrame(frame(body), ['CLAUDE.md'])
  assert.deepEqual(result.removed, ['web/CLAUDE.md'])
  assert.match(result.text, /root rules/)
  assert.doesNotMatch(result.text, /legacy rules/)
  assert.match(result.text, /^<system-reminder>\n/)
  assert.match(result.text, /<\/system-reminder>$/)
})

test('pruneInstructionFrame leaves an unmatched frame byte-identical', () => {
  const original = frame('Instructions from: AGENTS.md\n\nrules')
  const result = pruneInstructionFrame(original, ['CLAUDE.md'])
  assert.equal(result.text, original)
  assert.deepEqual(result.removed, [])
})

test('pruneInstructionFrame honours prefix patterns', () => {
  const body = ['Instructions from: sub/AGENTS.md', '', 'a', '', 'Instructions from: AGENTS.md', '', 'b'].join('\n')
  const result = pruneInstructionFrame(frame(body), ['sub/*'])
  assert.deepEqual(result.removed, ['sub/AGENTS.md'])
  assert.match(result.text, /Instructions from: AGENTS\.md\n\nb/)
  assert.doesNotMatch(result.text, /sub\/AGENTS\.md/)
})

test('pruneInstructionFrame handles Additional and Updated variants', () => {
  for (const marker of INSTRUCTION_MARKERS) {
    const body = `${marker}CLAUDE.md\n\nrules`
    const result = pruneInstructionFrame(frame(body), ['CLAUDE.md'])
    assert.deepEqual(result.removed, ['CLAUDE.md'], `marker ${marker}`)
    assert.equal(result.text, '<system-reminder>\n</system-reminder>', 'the wrapper survives with an empty body')
  }
})

test('pruneInstructionFrame ignores quoted prose that merely contains a marker', () => {
  const body = ['Instructions from: AGENTS.md', '', 'prose mentioning Additional instructions from: not a header'].join('\n')
  const result = pruneInstructionFrame(frame(body), ['*'])
  assert.deepEqual(result.removed, ['AGENTS.md'], 'only the real section header counts')
})

test('pruneInstructionFrame is a no-op outside a reminder frame', () => {
  const plain = 'Instructions from: AGENTS.md\n\nrules'
  assert.deepEqual(pruneInstructionFrame(plain, ['AGENTS.md']).removed, [])
  assert.equal(pruneInstructionFrame(plain, ['AGENTS.md']).text, plain)
})

test('pruneInstructionFrame tolerates junk input', () => {
  assert.deepEqual(pruneInstructionFrame('', ['x']), { text: '', removed: [] })
  assert.deepEqual(pruneInstructionFrame(undefined, ['x']), { text: undefined, removed: [] })
  assert.deepEqual(pruneInstructionFrame(frame('a'), []), { text: frame('a'), removed: [] })
})

test('deniesInstruction reuses pattern matching on display paths', () => {
  assert.equal(deniesInstruction(['AGENTS.md'], 'AGENTS.md'), true)
  assert.equal(deniesInstruction(['packages/*'], 'packages/api/AGENTS.md'), true)
  assert.equal(deniesInstruction(['AGENTS.md'], 'CLAUDE.md'), false)
})

test('deniesInstruction matches a bare file name at any depth', () => {
  assert.equal(deniesInstruction(['CLAUDE.md'], 'web/CLAUDE.md'), true)
  assert.equal(deniesInstruction(['CLAUDE.md'], 'a/b/c/CLAUDE.md'), true)
  assert.equal(deniesInstruction(['CLAUDE.md'], 'web/CLAUDE.local.md'), false)
  assert.equal(deniesInstruction(['web/CLAUDE.md'], 'api/CLAUDE.md'), false, 'a path pattern stays anchored')
})

test('deniesInstruction normalises backslash separators', () => {
  assert.equal(deniesInstruction(['CLAUDE.md'], 'web\\CLAUDE.md'), true)
  assert.equal(deniesInstruction(['web/CLAUDE.md'], 'web\\CLAUDE.md'), true)
})

test('RESERVED_TOOL stays the transport name the registry reserves', () => {
  assert.equal(RESERVED_TOOL, 'run_code')
})
