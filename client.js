/**
 * Capability trim — browser half.
 *
 * Two surfaces over one model:
 *
 * - a sidebar panel that edits the global layer and each workspace;
 * - a Conversation View tab that edits the current Session and its workspace.
 *
 * Effective scope layers as `session > workspace > global`. The save bar sits
 * outside the scrolling area so it is reachable without scrolling.
 */

window.__ModuleLoader__.load({
  id: '@yx333221c/dsh-capability-trim',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const ROUTE = '/capability-trim/api/state'
    const EMPTY = { denyTools: [], denySkills: [], denyInstructions: [] }

    /**
     * Read the Host state, optionally focused on one workspace directory.
     *
     * A `404` here means the Host half has not registered its route yet — the
     * page loaded before the plugin row activated, or the row was just disabled.
     * Reporting that as a plain status number is what made the earlier failure
     * unreadable, so the message names the cause instead.
     */
    async function readState(cwd) {
      const query = typeof cwd === 'string' && cwd !== '' ? `?workspace=${encodeURIComponent(cwd)}` : ''
      const response = await fetch(`${ROUTE}${query}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (response.status === 404) {
        throw new Error('the Host half of Capability trim is not loaded (route 404): enable the plugin in Settings → Plugins, then reload the page')
      }
      if (!response.ok) throw new Error(`the Host answered ${response.status}`)
      return response.json()
    }

    /**
     * Read the state, retrying briefly while the route is still missing.
     *
     * The page can render before the Host row finishes activating, and the row
     * can be re-enabled while this component stays mounted; a single attempt
     * turns both cases into a permanent error.
     */
    async function readStateWithRetry(cwd, attempts = 4) {
      let last
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          return await readState(cwd)
        } catch (cause) {
          last = cause
          const retryable = String(cause?.message ?? '').includes('404')
          if (!retryable) throw cause
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
        }
      }
      throw last
    }

    /** Persist the complete layered state. */
    async function writeState(body) {
      const response = await fetch(ROUTE, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.detail ?? payload.error ?? `the Host answered ${response.status}`)
      return payload
    }

    /** Normalise arbitrary input into a scope with three arrays. */
    function asScope(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const list = field => (Array.isArray(field) ? field.filter(entry => typeof entry === 'string') : [])
      return {
        denyTools: list(source.denyTools),
        denySkills: list(source.denySkills),
        denyInstructions: list(source.denyInstructions),
      }
    }

    /** Whether one scope hides nothing. */
    function isEmptyScope(scope) {
      return scope.denyTools.length === 0 && scope.denySkills.length === 0 && scope.denyInstructions.length === 0
    }

    /** Count the hidden entries of one scope. */
    function countOf(scope) {
      if (scope === undefined || scope === null) return 0
      return (scope.denyTools?.length ?? 0) + (scope.denySkills?.length ?? 0) + (scope.denyInstructions?.length ?? 0)
    }

    /** Glob matching shared with the Host: a trailing `*` is a prefix. */
    function matchesAny(patterns, candidate) {
      const name = String(candidate).toLowerCase()
      for (const pattern of patterns) {
        const needle = String(pattern).trim().toLowerCase()
        if (needle === '') continue
        if (needle.endsWith('*') ? name.startsWith(needle.slice(0, -1)) : name === needle) return true
      }
      return false
    }

    /** Instruction patterns also match a bare file name at any depth. */
    function deniesInstruction(patterns, candidate) {
      const path = String(candidate).replaceAll('\\', '/')
      const base = path.slice(path.lastIndexOf('/') + 1)
      return matchesAny(patterns, path) || (base !== path && matchesAny(patterns, base))
    }

    /** Toggle one name inside one category of a scope. */
    function toggle(scope, field, name, on) {
      const current = scope[field] ?? []
      const rest = current.filter(entry => entry.toLowerCase() !== name.toLowerCase())
      return { ...scope, [field]: on ? [...rest, name] : rest }
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'var(--dsw-alias-text-primary)' },
      body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '16px 18px 8px', display: 'flex', flexDirection: 'column', gap: 14 },
      footer: {
        flex: '0 0 auto', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 18px', borderTop: '1px solid var(--dsw-alias-border-subtle)',
        background: 'var(--dsw-alias-bg-elevated)',
      },
      lead: { margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-text-secondary)' },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(160px, 210px) minmax(0, 1fr)', gap: 14, alignItems: 'start' },
      card: {
        border: '1px solid var(--dsw-alias-border-subtle)', borderRadius: 10,
        background: 'var(--dsw-alias-bg-elevated)', padding: 12, minWidth: 0,
      },
      title: { margin: '0 0 8px', fontSize: 12, fontWeight: 600, letterSpacing: '0.02em', textTransform: 'uppercase', color: 'var(--dsw-alias-text-secondary)' },
      list: { display: 'flex', flexDirection: 'column', gap: 2, margin: 0, padding: 0, listStyle: 'none' },
      navRow: {
        display: 'flex', flexDirection: 'column', gap: 2, width: '100%', textAlign: 'left',
        padding: '8px 10px', borderRadius: 8, border: '1px solid transparent',
        background: 'transparent', color: 'var(--dsw-alias-text-primary)', cursor: 'pointer',
        font: 'inherit', fontSize: 13,
      },
      navActive: { background: 'var(--dsw-alias-bg-selected)', borderColor: 'var(--dsw-alias-border-strong)' },
      path: { fontSize: 11, color: 'var(--dsw-alias-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      check: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 6px', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
      mono: { fontFamily: 'var(--dsw-alias-font-mono, monospace)', fontSize: 12, wordBreak: 'break-all' },
      muted: { margin: '2px 0', fontSize: 12, color: 'var(--dsw-alias-text-tertiary)' },
      pill: { display: 'inline-flex', alignItems: 'center', padding: '1px 8px', borderRadius: 999, fontSize: 11, background: 'var(--dsw-alias-bg-selected)', color: 'var(--dsw-alias-text-secondary)' },
      button: {
        padding: '6px 14px', borderRadius: 8, font: 'inherit', fontSize: 13, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-strong)', background: 'var(--dsw-alias-bg-elevated)',
        color: 'var(--dsw-alias-text-primary)',
      },
      primary: { background: 'var(--dsw-alias-accent-fill, #1f6feb)', borderColor: 'transparent', color: '#fff', fontWeight: 600 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      error: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-text-danger, #d33)' },
      ok: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-text-success, #1a7f37)' },
      note: { padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-text-secondary)', background: 'var(--dsw-alias-bg-selected)' },
      search: {
        flex: '1 1 140px', minWidth: 110, padding: '5px 10px', borderRadius: 8, fontSize: 13,
        border: '1px solid var(--dsw-alias-border-strong)', background: 'transparent',
        color: 'var(--dsw-alias-text-primary)',
      },
      scroll: { maxHeight: 220, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-subtle)', borderRadius: 8, padding: 4 },
      toolbar: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 2 },
    }

    /** Localised labels, re-read on every render so a language switch is live. */
    function labelsOf(locale) {
      let id = ''
      try {
        id = String(locale?.getLocale?.()?.id ?? '')
      } catch {
        id = ''
      }
      const zh = id.toLowerCase().startsWith('zh')
      return {
        panel: zh ? '能力裁剪' : 'Capability trim',
        global: zh ? '全局' : 'Global',
        session: zh ? '本会话' : 'This session',
        workspace: zh ? '本工作区' : 'This workspace',
        saved: zh ? '已保存并应用。' : 'Saved and applied.',
        loading: zh ? '加载中…' : 'Loading…',
      }
    }

    /** One checkbox row. */
    function Check({ label, checked, onChange, mono }) {
      return h('label', { style: S.check },
        h('input', { type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }),
        h('span', { style: mono ? S.mono : undefined }, label))
    }

    /**
     * The shared editor: a layer column plus three checklists, with the save bar
     * pinned outside the scrolling area.
     */
    function TrimEditor({ layer, setLayer, layers, state, scope, onScope, onSave, busy, error, notice, labels }) {
      const [filter, setFilter] = useState('')

      const tools = state?.tools ?? []
      const skills = state?.skills ?? []
      const instructions = state?.instructions ?? []
      const filteredTools = filter === ''
        ? tools
        : tools.filter(name => name.toLowerCase().includes(filter.toLowerCase()))
      const hidden = countOf(scope)

      return h('div', { style: S.page },
        h('div', { style: S.body },
          h('p', { style: S.lead },
            'Hide capabilities that belong to other projects. Hiding happens per layer: a session overrides its ',
            'workspace, which overrides the global default. Nothing is written to the profile configuration, so ',
            'clearing a layer here restores the surface immediately.'),

          h('div', { style: S.grid },
            h('section', { style: S.card },
              h('h3', { style: S.title }, 'Configured in'),
              layers.length === 0
                ? h('p', { style: S.muted }, 'Nothing to configure yet.')
                : h('ul', { style: S.list }, layers.map(entry => h('li', { key: entry.id },
                  h('button', {
                    type: 'button',
                    style: { ...S.navRow, ...(entry.id === layer ? S.navActive : {}) },
                    onClick: () => setLayer(entry.id),
                  },
                    h('span', { style: { display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 } },
                      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.label),
                      entry.count > 0 ? h('span', { style: S.pill }, `${entry.count}`) : null),
                    entry.hint === undefined ? null : h('span', { style: S.path, title: entry.hint }, entry.hint)))))),

            h('section', { style: S.card },
              h('div', { style: { ...S.row, justifyContent: 'space-between', marginBottom: 8 } },
                h('h3', { style: { ...S.title, margin: 0 } }, 'Hidden in this layer'),
                h('span', { style: S.pill }, `${hidden} hidden`)),

              h('div', { style: { ...S.row, marginBottom: 10 } },
                h('input', {
                  type: 'search', value: filter, placeholder: 'Filter tools…', style: S.search,
                  onChange: event => setFilter(event.target.value),
                }),
                h('button', {
                  type: 'button', style: S.button, disabled: hidden === 0,
                  onClick: () => onScope({ ...EMPTY }),
                }, 'Clear this layer')),

              h('h4', { style: S.title }, `Tools (${filteredTools.length})`),
              filteredTools.length === 0
                ? h('p', { style: S.muted }, tools.length === 0 ? 'No tool is registered.' : 'No tool matches this filter.')
                : h('div', { style: S.scroll }, filteredTools.map(name => h(Check, {
                  key: name, label: name, mono: true,
                  checked: matchesAny(scope.denyTools, name),
                  onChange: on => onScope(toggle(scope, 'denyTools', name, on)),
                }))),

              h('h4', { style: { ...S.title, marginTop: 14 } }, `Skills (${skills.length})`),
              skills.length === 0
                ? h('p', { style: S.muted }, 'No model-invocable skill is registered.')
                : h('div', { style: S.scroll }, skills.map(skill => h(Check, {
                  key: skill.name, label: skill.name, mono: true,
                  checked: matchesAny(scope.denySkills, skill.name),
                  onChange: on => onScope(toggle(scope, 'denySkills', skill.name, on)),
                }))),

              h('h4', { style: { ...S.title, marginTop: 14 } }, `Instruction files (${instructions.length})`),
              instructions.length === 0
                ? h('p', { style: S.muted }, 'No instruction file was found in this workspace.')
                : h('div', { style: S.scroll }, instructions.map(file => h(Check, {
                  key: file.path, label: file.path, mono: true,
                  checked: deniesInstruction(scope.denyInstructions, file.path),
                  onChange: on => onScope(toggle(scope, 'denyInstructions', file.path, on)),
                }))))),

          error !== '' ? h('p', { style: S.error }, error) : null,
          notice !== '' ? h('p', { style: S.ok }, notice) : null,

          h('div', { style: S.note },
            'Hiding a tool removes it from the model’s tool list for new steps; hiding a skill removes its catalog ',
            'entry; hiding an instruction file cuts that section out of the injected workspace context.')),

        h('div', { style: S.footer },
          h('button', {
            type: 'button', style: { ...S.button, ...S.primary, opacity: busy ? 0.6 : 1 },
            onClick: onSave, disabled: busy,
          }, busy ? 'Saving…' : 'Save and apply'),
          h('span', { style: S.muted }, 'Applies to running sessions too.')))
    }

    /** Shared loader and saver for both surfaces. */
    function useTrim(cwd) {
      const [state, setState] = useState(null)
      const [globalScope, setGlobalScope] = useState(EMPTY)
      const [workspaces, setWorkspaces] = useState({})
      const [sessions, setSessions] = useState({})
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)

      const reload = useCallback(async () => {
        try {
          const data = await readStateWithRetry(cwd)
          setState(data)
          setGlobalScope(asScope(data.global))
          const byPath = {}
          for (const workspace of data.workspaces ?? []) byPath[workspace.path] = asScope(workspace.scope)
          setWorkspaces(byPath)
          const bySession = {}
          for (const [id, scope] of Object.entries(data.sessions ?? {})) bySession[id] = asScope(scope)
          setSessions(bySession)
          setError('')
        } catch (cause) {
          setError(cause.message ?? String(cause))
        }
      }, [cwd])

      useEffect(() => { void reload() }, [reload])

      const save = useCallback(async () => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const pick = source => {
            const result = {}
            for (const [key, scope] of Object.entries(source)) {
              if (!isEmptyScope(scope)) result[key] = scope
            }
            return result
          }
          await writeState({
            global: globalScope,
            workspaces: pick(workspaces),
            sessions: pick(sessions),
          })
          setNotice('saved')
          await reload()
        } catch (cause) {
          setError(cause.message ?? String(cause))
        } finally {
          setBusy(false)
        }
      }, [workspaces, sessions, globalScope, reload])

      return { state, globalScope, setGlobalScope, workspaces, setWorkspaces, sessions, setSessions, error, notice, busy, save }
    }

    /** The sidebar panel: global layer plus every registered workspace. */
    function makePanel(locale) {
      return function Panel() {
        const labels = labelsOf(locale)
        const trim = useTrim(undefined)
        const [layer, setLayer] = useState('global')

        const layers = useMemo(() => [
          { id: 'global', label: labels.global, count: countOf(trim.globalScope) },
          ...(trim.state?.workspaces ?? []).map(workspace => ({
            id: workspace.path,
            label: workspace.title || workspace.path,
            hint: workspace.path,
            count: countOf(trim.workspaces[workspace.path]),
          })),
        ], [labels.global, trim.state, trim.globalScope, trim.workspaces])

        const scope = layer === 'global' ? trim.globalScope : asScope(trim.workspaces[layer])
        const onScope = next => {
          if (layer === 'global') trim.setGlobalScope(next)
          else trim.setWorkspaces(current => ({ ...current, [layer]: next }))
        }

        if (trim.state === null) {
          return h('p', { style: { ...S.muted, padding: 16 } }, trim.error !== '' ? trim.error : labels.loading)
        }
        return h(TrimEditor, {
          layer, setLayer, layers, state: trim.state, scope, onScope,
          onSave: trim.save, busy: trim.busy,
          error: trim.error, notice: trim.notice === 'saved' ? labels.saved : '', labels,
        })
      }
    }

    /** The Conversation View tab: this session, its workspace, and global. */
    function makeSessionView(locale) {
      return function SessionView(props) {
        const labels = labelsOf(locale)
        const sessionId = props.sessionId === undefined ? undefined : String(props.sessionId)
        const [cwd, setCwd] = useState(undefined)
        const trim = useTrim(cwd)
        const [layer, setLayer] = useState('session')

        useEffect(() => {
          let live = true
          const workspaces = props.useWorkspaces
          if (workspaces === undefined) return () => { live = false }
          let snapshot
          try {
            snapshot = workspaces()
          } catch {
            return () => { live = false }
          }
          const list = snapshot?.workspaces ?? []
          const match = list.find(workspace => (workspace.sessionIds ?? []).some(id => String(id) === sessionId))
          if (live && match !== undefined) setCwd(match.path)
          return () => { live = false }
        }, [props.useWorkspaces, sessionId])

        const layers = useMemo(() => [
          { id: 'session', label: labels.session, hint: sessionId, count: countOf(trim.sessions[sessionId]) },
          { id: 'workspace', label: labels.workspace, hint: cwd, count: countOf(trim.workspaces[cwd]) },
          { id: 'global', label: labels.global, count: countOf(trim.globalScope) },
        ], [labels.session, labels.workspace, labels.global, sessionId, cwd, trim.sessions, trim.workspaces, trim.globalScope])

        const scope = layer === 'session'
          ? asScope(trim.sessions[sessionId])
          : layer === 'workspace'
            ? asScope(trim.workspaces[cwd])
            : trim.globalScope

        const onScope = next => {
          if (layer === 'session') trim.setSessions(current => ({ ...current, [sessionId]: next }))
          else if (layer === 'workspace') trim.setWorkspaces(current => ({ ...current, [cwd]: next }))
          else trim.setGlobalScope(next)
        }

        if (trim.state === null) {
          return h('p', { style: { ...S.muted, padding: 16 } }, trim.error !== '' ? trim.error : labels.loading)
        }
        return h(TrimEditor, {
          layer, setLayer, layers, state: trim.state, scope, onScope,
          onSave: trim.save, busy: trim.busy,
          error: trim.error, notice: trim.notice === 'saved' ? labels.saved : '', labels,
        })
      }
    }

    /** The sidebar panel icon. */
    function PanelIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('rect', { x: 3, y: 4, width: 7, height: 7, rx: 1.5 }),
        h('rect', { x: 14, y: 4, width: 7, height: 7, rx: 1.5, opacity: 0.45 }),
        h('rect', { x: 3, y: 14, width: 7, height: 6, rx: 1.5, opacity: 0.45 }),
        h('rect', { x: 14, y: 14, width: 7, height: 6, rx: 1.5 }),
        h('path', { d: 'M14 7.5h7' }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const label = () => labelsOf(ctx.locale).panel
        const Panel = makePanel(ctx.locale)
        const SessionView = makeSessionView(ctx.locale)

        // Main (global) surface: a sidebar panel icon plus its page.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'capability-trim',
          order: 40,
          label,
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'capability-trim',
        }, Panel))

        // Session view tab: this session, its workspace, and global.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'capability-trim',
          order: 40,
          label,
        }, SessionView))
      },
    }
  },
})
