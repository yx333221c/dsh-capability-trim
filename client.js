/**
 * Capability trim — browser half.
 *
 * Two surfaces over one model:
 *
 * - a sidebar panel that edits the global layer and each workspace;
 * - a Conversation View tab that edits the current Session and its workspace.
 *
 * Effective scope layers as `session > workspace > global`. The page is a single
 * full-width column with a sticky footer: a two-column grid left a large empty
 * region on the right and pushed the save button out of view, so it is gone.
 */

window.__ModuleLoader__.load({
  id: '@yx333221c/dsh-capability-trim',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const ROUTE = '/capability-trim/api/state'
    const EMPTY = { denyTools: [], denySkills: [], denyInstructions: [] }
    const ROOT_CLASS = 'capability-trim-root'

    /**
     * Styles that inline objects cannot express: focus treatment and hover.
     *
     * A `<button>` keeps the platform focus ring after a click, which is why a
     * deselected layer still showed a white outline. Only keyboard focus draws a
     * ring now, and it is the theme accent rather than the platform default.
     */
    const STYLE_TEXT = `
.${ROOT_CLASS}, .${ROOT_CLASS} * { box-sizing: border-box; }
.${ROOT_CLASS} button:focus { outline: none; }
.${ROOT_CLASS} button:focus-visible {
  outline: 2px solid var(--dsw-alias-accent-fill, #1f6feb);
  outline-offset: 2px;
}
.${ROOT_CLASS} .ct-chip {
  border-color: var(--dsw-alias-border-strong);
  background: var(--dsw-alias-bg-elevated);
}
.${ROOT_CLASS} .ct-chip:hover { border-color: var(--dsw-alias-accent-fill, #1f6feb); }
.${ROOT_CLASS} .ct-chip[data-active="true"] {
  background: var(--dsw-alias-bg-selected);
  border-color: var(--dsw-alias-accent-fill, #1f6feb);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-accent-fill, #1f6feb);
}
.${ROOT_CLASS} .ct-chip .ct-tick { visibility: hidden; }
.${ROOT_CLASS} .ct-chip[data-active="true"] .ct-tick { visibility: visible; }
.${ROOT_CLASS} .ct-check:hover { background: var(--dsw-alias-bg-selected); }
`

    /** Read the Host state, optionally focused on one workspace directory. */
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
          if (cause?.routeMissing !== true) throw cause
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
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, width: '100%', color: 'var(--dsw-alias-text-primary)' },
      scroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '14px 16px 4px', display: 'flex', flexDirection: 'column', gap: 10 },
      footer: {
        flex: '0 0 auto', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 16px', borderTop: '1px solid var(--dsw-alias-border-subtle)',
        background: 'var(--dsw-alias-bg-elevated)',
      },
      lead: { margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-text-secondary)' },
      chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
        padding: '5px 11px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-strong)',
        background: 'var(--dsw-alias-bg-elevated)', color: 'var(--dsw-alias-text-primary)',
        font: 'inherit', fontSize: 13, cursor: 'pointer',
      },
      chipActive: {
        background: 'var(--dsw-alias-bg-selected)',
        borderColor: 'var(--dsw-alias-accent-fill, #1f6feb)',
        boxShadow: 'inset 0 0 0 1px var(--dsw-alias-accent-fill, #1f6feb)',
        fontWeight: 600,
      },
      chipLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 },
      badge: { fontSize: 11, padding: '0 6px', borderRadius: 999, background: 'var(--dsw-alias-bg-selected)', color: 'var(--dsw-alias-text-secondary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-subtle)', borderRadius: 10,
        background: 'var(--dsw-alias-bg-elevated)', padding: 12, minWidth: 0, width: '100%',
      },
      title: { margin: '0 0 8px', fontSize: 12, fontWeight: 600, letterSpacing: '0.02em', textTransform: 'uppercase', color: 'var(--dsw-alias-text-secondary)' },
      subtitleRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 },
      showing: { margin: '0 0 2px', fontSize: 12, color: 'var(--dsw-alias-text-secondary)' },
      headActions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      toggleRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 },
      check: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 6px', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
      mono: { fontFamily: 'var(--dsw-alias-font-mono, monospace)', fontSize: 12, wordBreak: 'break-all' },
      muted: { margin: '2px 0', fontSize: 12, color: 'var(--dsw-alias-text-tertiary)' },
      listBox: { maxHeight: 190, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-subtle)', borderRadius: 8, padding: 4, width: '100%' },
      path: { fontSize: 11, color: 'var(--dsw-alias-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      button: {
        padding: '6px 14px', borderRadius: 8, font: 'inherit', fontSize: 13, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-strong)', background: 'var(--dsw-alias-bg-elevated)',
        color: 'var(--dsw-alias-text-primary)',
      },
      primary: { background: 'var(--dsw-alias-accent-fill, #1f6feb)', borderColor: 'transparent', color: '#fff', fontWeight: 600 },
      search: {
        width: 160, flex: '0 0 auto', padding: '4px 10px', borderRadius: 8, fontSize: 13,
        border: '1px solid var(--dsw-alias-border-strong)', background: 'transparent',
        color: 'var(--dsw-alias-text-primary)',
      },
      error: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-text-danger, #d33)' },
      ok: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-text-success, #1a7f37)' },
      note: { padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-text-secondary)', background: 'var(--dsw-alias-bg-selected)' },
    }

    /** Localised strings; the locale snapshot field is `active`. */
    function stringsFor(activeId) {
      const zh = String(activeId ?? '').toLowerCase().startsWith('zh')
      return {
        panel: zh ? '能力裁剪' : 'Capability trim',
        global: zh ? '全局' : 'Global',
        session: zh ? '本会话' : 'This session',
        workspace: zh ? '本工作区' : 'This workspace',
        globalHint: zh ? '所有工作区的默认' : 'default for every workspace',
        saved: zh ? '已保存并应用。' : 'Saved and applied.',
        loading: zh ? '加载中…' : 'Loading…',
        routeMissing: zh
          ? '宿主半边未加载（路由 404）：请在「设置 → 插件」中启用能力裁剪，然后刷新页面。'
          : 'The Host half is not loaded (route 404): enable Capability trim in Settings → Plugins, then reload.',
        hiddenIn: zh ? '本层隐藏的能力' : 'Hidden in this layer',
        showing: zh ? '当前正在配置' : 'Editing',
        nothingHidden: zh ? '本层未隐藏任何能力' : 'nothing hidden in this layer',
        appliesTo: zh ? '同时写入' : 'also writes',
        workspaces: zh ? '个工作区' : 'workspaces',
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
        skillError: zh ? '技能发现失败' : 'Skill discovery failed',
        noInstruction: zh ? '这个工作区里没有找到指令文件。' : 'No instruction file was found in this workspace.',
        nothing: zh ? '暂无可配置对象。' : 'Nothing to configure yet.',
        lead: zh
          ? '把属于其他项目的能力收起来。分层生效：会话 > 工作区 > 全局，配置不写入 profile，清空某层即刻复原。'
          : 'Hide capabilities that belong to other projects. Layered session > workspace > global; nothing is written to the profile, so clearing a layer restores it immediately.',
        note: zh
          ? '隐藏工具会把它从新步骤的工具列表移除；隐藏技能会去掉目录条目；隐藏指令文件会把该段从注入的上下文裁掉。只有全局注册的工具能被真正隐藏。'
          : 'Hiding a tool removes it from the tool list for new steps; hiding a skill removes its catalog entry; hiding an instruction file cuts that section out of the injected context. Only globally registered tools can actually be hidden.',
      }
    }

    /** Subscribe to the locale snapshot so a language switch is reflected live. */
    function useStrings(locale) {
      const subscribe = useCallback(listener => {
        if (locale === undefined || typeof locale.subscribe !== 'function') return () => {}
        return locale.subscribe(listener)
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
      return h('label', { style: S.check, className: 'ct-check' },
        h('input', { type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }),
        h('span', { style: mono ? S.mono : undefined }, label))
    }

    /**
     * The shared editor: a wrapped chip row for layers, one full-width card, and
     * a footer that never scrolls away.
     *
     * `multiSelect` makes the layer row additive: clicking a chip adds or removes
     * it, so a global edit can be applied to several workspaces at once.
     */
    function TrimEditor({ layer, setLayer, layers, state, scope, onScope, onSave, busy, error, notice, strings, multiSelect, selected, onToggleLayer }) {
      const [filter, setFilter] = useState('')

      const tools = state?.tools ?? []
      const skills = state?.skills ?? []
      const instructions = state?.instructions ?? []
      const filteredTools = filter === ''
        ? tools
        : tools.filter(name => name.toLowerCase().includes(filter.toLowerCase()))
      const hidden = countOf(scope)
      const current = layers.find(entry => entry.id === layer)
      const isOn = entry => multiSelect === true
        ? (selected !== undefined && selected.has(entry.id))
        : entry.id === layer

      return h('div', { style: S.page, className: ROOT_CLASS },
        h('style', null, STYLE_TEXT),
        h('div', { style: S.scroll },
          h('p', { style: S.lead }, strings.lead),

          layers.length === 0
            ? h('p', { style: S.muted }, strings.nothing)
            : h('div', { style: S.chipRow }, layers.map(entry => h('button', {
              key: entry.id,
              type: 'button',
              className: 'ct-chip',
              'data-active': isOn(entry) ? 'true' : 'false',
              'aria-pressed': isOn(entry),
              title: entry.hint,
              // Selection is expressed inline, not only through the class rule:
              // the inline style object wins over the stylesheet, so a
              // class-only active state would never paint.
              style: isOn(entry) ? { ...S.chip, ...S.chipActive } : S.chip,
              onClick: () => (multiSelect === true ? onToggleLayer(entry.id) : setLayer(entry.id)),
            },
              h('span', { 'aria-hidden': true, style: { fontSize: 12, lineHeight: 1, opacity: isOn(entry) ? 1 : 0 } }, '✓'),
              h('span', { style: S.chipLabel }, entry.label),
              entry.count > 0 ? h('span', { style: S.badge }, String(entry.count)) : null))),

          // Which layer the checklist below is editing. Stated for every surface,
          // including the global one, so the page is never ambiguous.
          h('p', { style: S.showing },
            h('strong', { style: { fontWeight: 600 } }, strings.showing),
            ': ',
            current === undefined ? '—' : current.label,
            hidden === 0 ? ` · ${strings.nothingHidden}` : ` · ${hidden} ${strings.hidden}`,
            multiSelect === true && selected !== undefined && selected.size > 1
              ? ` · ${strings.appliesTo} ${selected.size - 1} ${selected.size - 1 === 1 ? strings.workspace.toLowerCase() : strings.workspaces.toLowerCase()}`
              : ''),

          current !== undefined && current.hint !== undefined
            ? h('p', { style: S.path, title: current.hint }, current.hint)
            : null,

          h('section', { style: S.card },
            // Title, search and Clear sit together at the left. Previously the
            // header used space-between, which pushed the controls to the far
            // edge and opened a wide empty band between them.
            h('div', { style: S.subtitleRow },
              h('h3', { style: { ...S.title, margin: 0, flex: '0 0 auto' } }, strings.hiddenIn),
              h('div', { style: S.headActions },
                h('input', {
                  type: 'search', value: filter, placeholder: strings.filterTools, style: S.search,
                  onChange: event => setFilter(event.target.value),
                }),
                h('button', {
                  type: 'button', style: S.button, disabled: hidden === 0,
                  onClick: () => onScope({ ...EMPTY }),
                }, strings.clearLayer))),

            h('h4', { style: S.title }, `${strings.tools} (${filteredTools.length})`),
            filteredTools.length === 0
              ? h('p', { style: S.muted }, tools.length === 0 ? strings.noTool : strings.noToolMatch)
              : h('div', { style: S.listBox }, filteredTools.map(name => h(Check, {
                key: name, label: name, mono: true,
                checked: matchesAny(scope.denyTools, name),
                onChange: on => onScope(toggle(scope, 'denyTools', name, on)),
              }))),

            h('h4', { style: { ...S.title, marginTop: 12 } }, `${strings.skills} (${skills.length})`),
            // An empty catalog and a failed discovery look identical otherwise,
            // which is how a missing user-skills root went unnoticed once.
            state?.skillError === undefined
              ? null
              : h('p', { style: S.error }, `${strings.skillError}: ${state.skillError}`),
            skills.length === 0
              ? h('p', { style: S.muted }, strings.noSkill)
              : h('div', { style: S.listBox }, skills.map(skill => h(Check, {
                key: skill.name, label: skill.name, mono: true,
                checked: matchesAny(scope.denySkills, skill.name),
                onChange: on => onScope(toggle(scope, 'denySkills', skill.name, on)),
              }))),

            h('h4', { style: { ...S.title, marginTop: 12 } }, `${strings.instructions} (${instructions.length})`),
            instructions.length === 0
              ? h('p', { style: S.muted }, strings.noInstruction)
              : h('div', { style: S.listBox }, instructions.map(file => h(Check, {
                key: file.path, label: file.path, mono: true,
                checked: deniesInstruction(scope.denyInstructions, file.path),
                onChange: on => onScope(toggle(scope, 'denyInstructions', file.path, on)),
              })))),

          error !== '' ? h('p', { style: S.error }, error) : null,
          notice !== '' ? h('p', { style: S.ok }, notice) : null,
          h('div', { style: S.note }, strings.note)),

        h('div', { style: S.footer },
          h('button', {
            type: 'button', style: { ...S.button, ...S.primary, opacity: busy ? 0.6 : 1 },
            onClick: onSave, disabled: busy,
          }, busy ? strings.saving : strings.save),
          h('span', { style: S.muted }, strings.saveHint)))
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
        /**
         * Workspaces the current edit is applied to alongside the global layer.
         *
         * A click toggles, so clicking a selected workspace deselects it — the
         * additive behaviour users expect from a multi-select. Editing the global
         * layer with workspaces selected writes the same checklist to each of
         * them, which is how one policy reaches several projects at once.
         * The global layer starts selected; deselecting it makes the edit apply
         * to the chosen workspaces only.
         */
        const [selected, setSelected] = useState(['global'])

        const allLayers = useMemo(() => [
          { id: 'global', label: strings.global, hint: strings.globalHint, count: countOf(trim.globalScope) },
          ...(trim.state?.workspaces ?? []).map(workspace => ({
            id: workspace.path,
            label: workspace.title || workspace.path,
            hint: workspace.path,
            count: countOf(trim.workspaces[workspace.path]),
          })),
        ], [strings.global, strings.globalHint, trim.state, trim.globalScope, trim.workspaces])

        // Keep only selections that still exist, so a deleted workspace cannot
        // linger as an invisible target.
        const liveSelected = useMemo(() => {
          const ids = new Set(allLayers.map(entry => entry.id))
          return selected.filter(id => ids.has(id))
        }, [allLayers, selected])

        const toggleLayer = useCallback(id => {
          setSelected(current => current.includes(id)
            ? current.filter(entry => entry !== id)
            : [...current, id])
        }, [])

        const scope = trim.globalScope

        /**
         * Write one checklist to the global layer and every selected workspace.
         *
         * The global layer is written when it is part of the selection, so
         * deselecting 全局 makes the edit apply to the chosen workspaces only.
         */
        const onScope = next => {
          // With nothing selected there is no target; treat the global layer as
          // the implicit target rather than discarding the edit silently.
          const targets = liveSelected.length === 0 ? ['global'] : liveSelected
          if (targets.includes('global')) trim.setGlobalScope(next)
          const others = targets.filter(id => id !== 'global')
          if (others.length === 0) return
          trim.setWorkspaces(current => {
            const updated = { ...current }
            for (const path of others) updated[path] = { ...next }
            return updated
          })
        }

        if (trim.state === null) {
          const message = trim.error === 'route-missing' ? strings.routeMissing : (trim.error !== '' ? trim.error : strings.loading)
          return h('p', { style: { ...S.muted, padding: 16 } }, message)
        }

        return h(TrimEditor, {
          layer: liveSelected.includes('global') ? 'global' : (liveSelected[0] ?? 'global'),
          setLayer: id => setSelected([id]),
          layers: allLayers, state: trim.state,
          // The checklist edits the global layer when 全局 is selected; otherwise
          // it edits the first selected workspace, which is what the readout
          // names. Multi-target writes still hit every selection.
          scope: liveSelected.includes('global') ? scope : asScope(trim.workspaces[liveSelected[0]]),
          onScope,
          onSave: trim.save, busy: trim.busy,
          error: trim.error === 'route-missing' ? strings.routeMissing : trim.error,
          notice: trim.saved ? strings.saved : '',
          strings,
          multiSelect: true,
          selected: new Set(liveSelected),
          onToggleLayer: toggleLayer,
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
        const seeded = useRef(undefined)

        /**
         * Resolve this Session's workspace directory from the Host state.
         *
         * The View slot's props carry no workspace directory, so the
         * Session-to-workspace association travels with the state instead of
         * being guessed.
         */
        const cwd = useMemo(() => {
          if (sessionId === undefined) return undefined
          for (const workspace of trim.state?.workspaces ?? []) {
            if ((workspace.sessionIds ?? []).includes(sessionId)) return workspace.path
          }
          return undefined
        }, [trim.state, sessionId])

        // Skill and instruction discovery follow the resolved workspace.
        useEffect(() => {
          if (cwd !== undefined) void trim.reload(cwd)
        }, [cwd, trim.reload])

        /**
         * Seed this session from its workspace, automatically and once.
         *
         * A session layer starts empty would mean re-ticking everything the
         * workspace already hides, which is how a narrower layer silently
         * inherits nothing. Seeding merges, so anything already there survives,
         * and it stays in memory until the user saves — no extra control to
         * click, and a deliberate clear is not undone for the rest of the mount.
         */
        useEffect(() => {
          if (trim.state === null || sessionId === undefined || cwd === undefined) return
          const key = `${sessionId}\u0000${cwd}`
          if (seeded.current === key) return
          seeded.current = key
          const workspaceScope = asScope(trim.workspaces[cwd])
          if (isEmptyScope(workspaceScope)) return
          trim.setSessions(current => {
            const existing = asScope(current[sessionId])
            const merged = mergeScopes(workspaceScope, existing)
            if (countOf(merged) === countOf(existing)) return current
            return { ...current, [sessionId]: merged }
          })
        }, [trim.state, trim.workspaces, sessionId, cwd, trim.setSessions])

        const layers = useMemo(() => [
          { id: 'session', label: strings.session, hint: sessionId, count: countOf(trim.sessions[sessionId]) },
          { id: 'workspace', label: strings.workspace, hint: cwd, count: countOf(trim.workspaces[cwd]) },
          { id: 'global', label: strings.global, hint: strings.globalHint, count: countOf(trim.globalScope) },
        ], [strings.session, strings.workspace, strings.global, strings.globalHint, sessionId, cwd, trim.sessions, trim.workspaces, trim.globalScope])

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

    /** Read the active locale id defensively. */
    function safeActive(locale) {
      try {
        return String(locale?.getLocale?.()?.active ?? '')
      } catch {
        return ''
      }
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
  },
})
