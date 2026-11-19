/**
 * Capability trim — browser half.
 *
 * Two surfaces over one model:
 *
 * - a sidebar panel that edits the global layer and each workspace;
 * - a Conversation View tab that edits the current Session and its workspace.
 *
 * Effective scope layers as `session > workspace > global`. The save bar sits
 * outside the scrolling area so it is always reachable.
 */

window.__ModuleLoader__.load({
  id: '@yx333221c/dsh-capability-trim',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React

    const ROUTE = '/capability-trim/api/state'
    const EMPTY = { denyTools: [], denySkills: [], denyInstructions: [] }

    /**
     * Read the Host state, optionally focused on one workspace directory.
     *
     * A `404` means the Host half has not registered its route yet — the page
     * loaded before the row activated, or the row was just disabled. Reporting
     * the bare status is what made that failure unreadable once already.
     */
    async function readState(cwd) {
      const query = typeof cwd === 'string' && cwd !== '' ? `?workspace=${encodeURIComponent(cwd)}` : ''
      const response = await fetch(`${ROUTE}${query}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (response.status === 404) {
        const failure = new Error('host-route-missing')
        failure.routeMissing = true
        throw failure
      }
      if (!response.ok) throw new Error(`the Host answered ${response.status}`)
      return response.json()
    }

    /** Retry briefly while the Host route is still absent. */
    async function readStateWithRetry(cwd, attempts = 4) {
      let last
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          return await readState(cwd)
        } catch (cause) {
          last = cause
          if (cause?.routeMissing !== true && !String(cause?.message ?? '').includes('404')) throw cause
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

    /** Union of two scopes, used to seed a narrower layer from a broader one. */
    function mergeScopes(base, overlay) {
      const union = (field) => {
        const seen = new Set()
        const result = []
        for (const entry of [...(base?.[field] ?? []), ...(overlay?.[field] ?? [])]) {
          const key = entry.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          result.push(entry)
        }
        return result
      }
      return {
        denyTools: union('denyTools'),
        denySkills: union('denySkills'),
        denyInstructions: union('denyInstructions'),
      }
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'var(--dsw-alias-text-primary)' },
      body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '16px 18px 8px', display: 'flex', flexDirection: 'column', gap: 12 },
      footer: {
        flex: '0 0 auto', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 18px', borderTop: '1px solid var(--dsw-alias-border-subtle)',
        background: 'var(--dsw-alias-bg-elevated)',
      },
      lead: { margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-text-secondary)' },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(150px, 200px) minmax(0, 1fr)', gap: 12, alignItems: 'start' },
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
      scroll: { maxHeight: 210, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-subtle)', borderRadius: 8, padding: 4 },
      toolbar: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      tag: { fontSize: 11, padding: '1px 7px', borderRadius: 999, background: 'var(--dsw-alias-bg-selected)', color: 'var(--dsw-alias-text-secondary)' },
    }

    /**
     * Localised strings.
     *
     * `LocaleSnapshot` exposes `active`, not `id`; reading the wrong field is why
     * an earlier build never left English. The snapshot is also read through
     * `subscribe`, so a language switch re-renders instead of waiting for a
     * remount.
     */
    function stringsFor(activeId) {
      const zh = String(activeId ?? '').toLowerCase().startsWith('zh')
      return {
        panel: zh ? '能力裁剪' : 'Capability trim',
        global: zh ? '全局（所有工作区的默认）' : 'Global (default for every workspace)',
        session: zh ? '本会话' : 'This session',
        workspace: zh ? '本工作区' : 'This workspace',
        saved: zh ? '已保存并应用。' : 'Saved and applied.',
        loading: zh ? '加载中…' : 'Loading…',
        routeMissing: zh ? '宿主半边未加载（路由 404）：请在「设置 → 插件」中启用能力裁剪，然后刷新页面。' : 'The Host half is not loaded (route 404): enable Capability trim in Settings → Plugins, then reload.',
        configuredIn: zh ? '配置对象' : 'Configured in',
        hiddenIn: zh ? '本层隐藏的能力' : 'Hidden in this layer',
        hidden: zh ? '已隐藏' : 'hidden',
        clearLayer: zh ? '清空本层' : 'Clear this layer',
        save: zh ? '保存并应用' : 'Save and apply',
        saving: zh ? '保存中…' : 'Saving…',
        saveHint: zh ? '运行中的会话也会立即生效。' : 'Applies to running sessions too.',
        tools: zh ? '工具' : 'Tools',
        skills: zh ? '技能' : 'Skills',
        instructions: zh ? '指令文件' : 'Instruction files',
        filterTools: zh ? '筛选工具…' : 'Filter tools…',
        noTool: zh ? '该层尚未注册任何工具。' : 'No tool is registered.',
        noToolMatch: zh ? '没有工具匹配该筛选。' : 'No tool matches this filter.',
        noSkill: zh ? '没有可被模型调用的技能。' : 'No model-invocable skill is registered.',
        noInstruction: zh ? '这个工作区里没有找到指令文件。' : 'No instruction file was found in this workspace.',
        nothing: zh ? '暂无可配置对象。' : 'Nothing to configure yet.',
        untick: zh ? '取消勾选 = 在本层隐藏。' : 'Unticked means hidden in this layer.',
        seed: zh ? '预填本工作区设置' : 'Seed from workspace',
        seeded: zh ? '已用本工作区的设置预填本会话。' : 'Seeded this session from its workspace.',
        selectWorkspace: zh ? '先在左侧选择一个工作区。' : 'Select a workspace on the left first.',
        lead: zh
          ? '把属于其他项目的能力收起来。隐藏按层生效：会话覆盖工作区，工作区覆盖全局默认。配置不写入 profile，因此清空某层即刻复原。'
          : 'Hide capabilities that belong to other projects. Hiding is layered: a session overrides its workspace, which overrides the global default. Nothing is written to the profile, so clearing a layer restores it immediately.',
        note: zh
          ? '隐藏工具会把它从新步骤的模型工具列表中移除；隐藏技能会去掉它的目录条目；隐藏指令文件会把该段从注入的工作区上下文中裁掉。只有全局注册的工具才能真正隐藏——preset 自带作用域里的工具仍可见。'
          : 'Hiding a tool removes it from the model tool list for new steps; hiding a skill removes its catalog entry; hiding an instruction file cuts that section out of the injected context. Only globally registered tools can actually be hidden — tools registered inside the preset’s own scope stay visible.',
      }
    }

    /** Subscribe to the locale snapshot so a language switch is reflected live. */
    function useStrings(locale) {
      const subscribe = useCallback(listener => {
        if (locale === undefined) return () => {}
        if (typeof locale.subscribe === 'function') return locale.subscribe(listener)
        return () => {}
      }, [locale])

      const getSnapshot = useCallback(() => {
        try {
          return String(locale?.getLocale?.()?.active ?? '')
        } catch {
          return ''
        }
      }, [locale])

      const active = useSyncExternalStore(subscribe, getSnapshot, () => '')
      return useMemo(() => stringsFor(active), [active])
    }

    /** One checkbox row. */
    function Check({ label, checked, onChange, mono }) {
      return h('label', { style: S.check },
        h('input', { type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }),
        h('span', { style: mono ? S.mono : undefined }, label))
    }

    /**
     * The shared editor. `layers` is the full ordered list; `layer` is the
     * currently selected id, and selection is always one of them, so switching
     * is reversible by clicking another row rather than getting stuck.
     */
    function TrimEditor({ layer, setLayer, layers, state, scope, onScope, onSave, busy, error, notice, strings, extras }) {
      const [filter, setFilter] = useState('')

      const tools = state?.tools ?? []
      const skills = state?.skills ?? []
      const instructions = state?.instructions ?? []
      const filteredTools = filter === ''
        ? tools
        : tools.filter(name => name.toLowerCase().includes(filter.toLowerCase()))
      const hidden = countOf(scope)
      const current = layers.find(entry => entry.id === layer)

      return h('div', { style: S.page },
        h('div', { style: S.body },
          h('p', { style: S.lead }, strings.lead),

          h('div', { style: S.grid },
            h('section', { style: S.card },
              h('h3', { style: S.title }, strings.configuredIn),
              layers.length === 0
                ? h('p', { style: S.muted }, strings.nothing)
                : h('ul', { style: S.list }, layers.map(entry => h('li', { key: entry.id },
                  h('button', {
                    type: 'button',
                    'aria-pressed': entry.id === layer,
                    style: { ...S.navRow, ...(entry.id === layer ? S.navActive : {}) },
                    onClick: () => setLayer(entry.id),
                  },
                    h('span', { style: { display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 } },
                      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.label),
                      entry.count > 0 ? h('span', { style: S.pill }, String(entry.count)) : null),
                    entry.hint === undefined ? null : h('span', { style: S.path, title: entry.hint }, entry.hint))))),

            h('section', { style: S.card },
              h('div', { style: { ...S.row, justifyContent: 'space-between', marginBottom: 8 } },
                h('h3', { style: { ...S.title, margin: 0 } }, strings.hiddenIn),
                h('span', { style: S.pill }, `${hidden} ${strings.hidden}`)),

              current !== undefined && current.hint !== undefined
                ? h('p', { style: S.path, title: current.hint }, current.hint)
                : null,

              extras === undefined ? null : h('div', { style: { ...S.toolbar, marginBottom: 8 } }, extras),

              h('div', { style: { ...S.row, marginBottom: 10 } },
                h('input', {
                  type: 'search', value: filter, placeholder: strings.filterTools, style: S.search,
                  onChange: event => setFilter(event.target.value),
                }),
                h('button', {
                  type: 'button', style: S.button, disabled: hidden === 0,
                  onClick: () => onScope({ ...EMPTY }),
                }, strings.clearLayer)),

              h('h4', { style: S.title }, `${strings.tools} (${filteredTools.length})`),
              filteredTools.length === 0
                ? h('p', { style: S.muted }, tools.length === 0 ? strings.noTool : strings.noToolMatch)
                : h('div', { style: S.scroll }, filteredTools.map(name => h(Check, {
                  key: name, label: name, mono: true,
                  checked: matchesAny(scope.denyTools, name),
                  onChange: on => onScope(toggle(scope, 'denyTools', name, on)),
                }))),

              h('h4', { style: { ...S.title, marginTop: 12 } }, `${strings.skills} (${skills.length})`),
              skills.length === 0
                ? h('p', { style: S.muted }, strings.noSkill)
                : h('div', { style: S.scroll }, skills.map(skill => h(Check, {
                  key: skill.name, label: skill.name, mono: true,
                  checked: matchesAny(scope.denySkills, skill.name),
                  onChange: on => onScope(toggle(scope, 'denySkills', skill.name, on)),
                }))),

              h('h4', { style: { ...S.title, marginTop: 12 } }, `${strings.instructions} (${instructions.length})`),
              instructions.length === 0
                ? h('p', { style: S.muted }, strings.noInstruction)
                : h('div', { style: S.scroll }, instructions.map(file => h(Check, {
                  key: file.path, label: file.path, mono: true,
                  checked: deniesInstruction(scope.denyInstructions, file.path),
                  onChange: on => onScope(toggle(scope, 'denyInstructions', file.path, on)),
                }))))),

          error !== '' ? h('p', { style: S.error }, error) : null,
          notice !== '' ? h('p', { style: S.ok }, notice) : null,

          h('div', { style: S.note }, strings.note)),

        h('div', { style: S.footer },
          h('button', {
            type: 'button', style: { ...S.button, ...S.primary, opacity: busy ? 0.6 : 1 },
            onClick: onSave, disabled: busy,
          }, busy ? strings.saving : strings.save),
          h('span', { style: S.muted }, strings.saveHint))))
    }

    /** Shared loader and saver for both surfaces. */
    function useTrim(cwd) {
      const [state, setState] = useState(null)
      const [globalScope, setGlobalScope] = useState(EMPTY)
      const [workspaces, setWorkspaces] = useState({})
      const [sessions, setSessions] = useState({})
      const [error, setError] = useState('')
      const [saved, setSaved] = useState(false)
      const [busy, setBusy] = useState(false)

      const reload = useCallback(async (target) => {
        const focus = target === undefined ? cwd : target
        try {
          const data = await readStateWithRetry(focus)
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
          setError(cause?.routeMissing === true ? 'route-missing' : (cause.message ?? String(cause)))
        }
      }, [cwd])

      useEffect(() => { void reload() }, [reload])

      const save = useCallback(async () => {
        setBusy(true)
        setError('')
        setSaved(false)
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
          setSaved(true)
          await reload()
        } catch (cause) {
          setError(cause.message ?? String(cause))
        } finally {
          setBusy(false)
        }
      }, [workspaces, sessions, globalScope, reload])

      return { state, globalScope, setGlobalScope, workspaces, setWorkspaces, sessions, setSessions, error, saved, busy, save, reload }
    }

    /** The sidebar panel: the global layer plus every registered workspace. */
    function makePanel(locale) {
      return function Panel() {
        const strings = useStrings(locale)
        const trim = useTrim(undefined)
        const [layer, setLayer] = useState('global')

        const layers = useMemo(() => [
          { id: 'global', label: strings.global, count: countOf(trim.globalScope) },
          ...(trim.state?.workspaces ?? []).map(workspace => ({
            id: workspace.path,
            label: workspace.title || workspace.path,
            hint: workspace.path,
            count: countOf(trim.workspaces[workspace.path]),
          })),
        ], [strings.global, trim.state, trim.globalScope, trim.workspaces])

        // A workspace can disappear between renders; fall back to global rather
        // than rendering an editor bound to no layer.
        const active = layers.some(entry => entry.id === layer) ? layer : 'global'
        const scope = active === 'global' ? trim.globalScope : asScope(trim.workspaces[active])
        const onScope = next => {
          if (active === 'global') trim.setGlobalScope(next)
          else trim.setWorkspaces(current => ({ ...current, [active]: next }))
        }

        if (trim.state === null) {
          const message = trim.error === 'route-missing' ? strings.routeMissing : (trim.error !== '' ? trim.error : strings.loading)
          return h('p', { style: { ...S.muted, padding: 16 } }, message)
        }

        return h(TrimEditor, {
          layer: active, setLayer, layers, state: trim.state, scope, onScope,
          onSave: trim.save, busy: trim.busy,
          error: trim.error === 'route-missing' ? strings.routeMissing : trim.error,
          notice: trim.saved ? strings.saved : '',
          strings,
        })
      }
    }

    /** The Conversation View tab: this session, its workspace, and the global layer. */
    function makeSessionView(locale) {
      return function SessionView(props) {
        const strings = useStrings(locale)
        const sessionId = props.sessionId === undefined ? undefined : String(props.sessionId)

        const trim = useTrim()
        const [layer, setLayer] = useState('session')

        /**
         * Resolve this Session's workspace directory from the state itself.
         *
         * The View slot's standard props carry no workspace directory, and
         * `useWorkspaces` is not guaranteed to expose one per Session here, so
         * the association travels with the Host state (`sessionIds`) instead of
         * being guessed.
         */
        const cwd = useMemo(() => {
          if (sessionId === undefined) return undefined
          for (const workspace of trim.state?.workspaces ?? []) {
            if ((workspace.sessionIds ?? []).includes(sessionId)) return workspace.path
          }
          return undefined
        }, [trim.state, sessionId])

        // Skill and instruction discovery follow the resolved workspace, so the
        // lists the user ticks are the ones this Session actually sees.
        useEffect(() => {
          if (cwd !== undefined) void trim.reload(cwd)
        }, [cwd, trim.reload])

        const layers = useMemo(() => [
          { id: 'session', label: strings.session, hint: sessionId, count: countOf(trim.sessions[sessionId]) },
          { id: 'workspace', label: strings.workspace, hint: cwd, count: countOf(trim.workspaces[cwd]) },
          { id: 'global', label: strings.global, count: countOf(trim.globalScope) },
        ], [strings.session, strings.workspace, strings.global, sessionId, cwd, trim.sessions, trim.workspaces, trim.globalScope])

        const active = layers.some(entry => entry.id === layer) ? layer : 'session'
        const scope = active === 'session'
          ? asScope(trim.sessions[sessionId])
          : active === 'workspace'
            ? asScope(trim.workspaces[cwd])
            : trim.globalScope

        const onScope = next => {
          if (active === 'session') trim.setSessions(current => ({ ...current, [sessionId]: next }))
          else if (active === 'workspace') trim.setWorkspaces(current => ({ ...current, [cwd]: next }))
          else trim.setGlobalScope(next)
        }

        /**
         * Seed this session from its workspace: copy whatever the workspace
         * layer hides, so a narrower layer starts complete instead of needing
         * every entry re-ticked by hand.
         */
        const seed = useCallback(() => {
          const workspaceScope = asScope(trim.workspaces[cwd])
          const merged = mergeScopes(workspaceScope, asScope(trim.sessions[sessionId]))
          trim.setSessions(current => ({ ...current, [sessionId]: merged }))
        }, [cwd, sessionId, trim])

        const seedButton = cwd === undefined
          ? null
          : h('button', {
            type: 'button', style: S.button, onClick: seed,
            disabled: countOf(trim.workspaces[cwd]) === 0,
            title: strings.seeded,
          }, strings.seed)

        if (trim.state === null) {
          const message = trim.error === 'route-missing' ? strings.routeMissing : (trim.error !== '' ? trim.error : strings.loading)
          return h('p', { style: { ...S.muted, padding: 16 } }, message)
        }

        return h(TrimEditor, {
          layer: active, setLayer, layers, state: trim.state, scope, onScope,
          onSave: trim.save, busy: trim.busy,
          error: trim.error === 'route-missing' ? strings.routeMissing : trim.error,
          notice: trim.saved ? strings.saved : '',
          strings,
          extras: active === 'session' ? [seedButton] : undefined,
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
        const Panel = makePanel(ctx.locale)
        const SessionView = makeSessionView(ctx.locale)
        const label = () => stringsFor(safeActive(ctx.locale)).panel

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

    /** Read the active locale id defensively; the snapshot field is `active`. */
    function safeActive(locale) {
      try {
        return String(locale?.getLocale?.()?.active ?? '')
      } catch {
        return ''
      }
    }
  },
})
