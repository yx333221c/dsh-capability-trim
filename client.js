/**
 * Capability trim — browser half.
 *
 * Two surfaces over one model:
 *
 * - a sidebar panel that edits the global layer;
 * - a control beside the model selector that opens the current workspace's own
 *   layer.
 *
 * Switches read ON when a capability is visible and OFF when it is hidden, so an
 * untouched profile shows everything enabled. There is no save button: flipping a
 * switch writes immediately and the Host applies it to the next session.
 */

window.__ModuleLoader__.load({
  id: '@yx333221c/dsh-capability-trim',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React

    const ROUTE = '/capability-trim/api/state'
    const EMPTY = { denyTools: [], denySkills: [], denyInstructions: [] }
    const ROOT_CLASS = 'capability-trim-root'

    /** Focus treatment a `<button>` cannot express inline. */
    const STYLE_TEXT = `
.${ROOT_CLASS}, .${ROOT_CLASS} * { box-sizing: border-box; }
.${ROOT_CLASS} button:focus { outline: none; }
.${ROOT_CLASS} button:focus-visible {
  outline: 2px solid var(--dsw-alias-accent-fill, #1f6feb);
  outline-offset: 2px;
}
.${ROOT_CLASS} .ct-row:hover { background: var(--dsw-alias-bg-selected); }
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

    /** Toggle one name inside one category, returning a new scope. */
    function toggle(scope, field, name, enabled) {
      const current = scope[field] ?? []
      const rest = current.filter(entry => entry.toLowerCase() !== name.toLowerCase())
      // A switch ON means "visible", so it removes the name from the hidden set.
      return { ...scope, [field]: enabled ? rest : [...rest, name] }
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, width: '100%', color: 'var(--dsw-alias-text-primary)' },
      scroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 },
      lead: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-text-secondary)' },
      card: { border: '1px solid var(--dsw-alias-border-subtle)', borderRadius: 8, background: 'var(--dsw-alias-bg-elevated)', padding: 8 },
      title: { margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: '0.02em', textTransform: 'uppercase', color: 'var(--dsw-alias-text-secondary)' },
      // A dense row: one line, no vertical padding beyond what reads as tappable.
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '1px 4px', borderRadius: 4, fontSize: 12, lineHeight: 1.55 },
      mono: { fontFamily: 'var(--dsw-alias-font-mono, monospace)', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
      muted: { margin: '2px 0 0', fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-text-tertiary)' },
      listBox: { overflowY: 'auto', border: '1px solid var(--dsw-alias-border-subtle)', borderRadius: 6, padding: 2 },
      error: { margin: '2px 0', fontSize: 12, color: 'var(--dsw-alias-text-danger, #d33)' },
      badge: { fontSize: 10.5, padding: '0 6px', borderRadius: 999, background: 'var(--dsw-alias-bg-selected)', color: 'var(--dsw-alias-text-secondary)', whiteSpace: 'nowrap' },
      search: {
        width: 130, flex: '0 0 auto', padding: '2px 8px', borderRadius: 6, fontSize: 12,
        border: '1px solid var(--dsw-alias-border-subtle)', background: 'transparent',
        color: 'var(--dsw-alias-text-primary)',
      },
      smallButton: {
        flex: '0 0 auto', padding: '2px 8px', borderRadius: 6, font: 'inherit', fontSize: 11,
        border: '1px solid var(--dsw-alias-border-subtle)', background: 'transparent',
        color: 'var(--dsw-alias-text-secondary)', cursor: 'pointer',
      },
      headRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 },
      trigger: {
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-subtle)', background: 'transparent',
        color: 'var(--dsw-alias-text-secondary)', font: 'inherit', fontSize: 11, cursor: 'pointer',
      },
    }

    /** Localised strings; the locale snapshot field is `active`. */
    function stringsFor(activeId) {
      const zh = String(activeId ?? '').toLowerCase().startsWith('zh')
      return {
        panel: zh ? '能力裁剪' : 'Capability trim',
        global: zh ? '全局' : 'Global',
        workspace: zh ? '本工作区' : 'This workspace',
        workspaceShort: zh ? '工作区能力' : 'Workspace capabilities',
        globalLead: zh
          ? '这里是所有工作区的默认设置。开关打开 = 模型可见；关闭 = 隐藏。修改立即生效。'
          : 'Defaults for every workspace. A switch ON means visible to the model; OFF hides it. Changes apply immediately.',
        workspaceLead: zh
          ? '本工作区单独设置。未改动的项跟随全局；改过即覆盖全局。'
          : 'This workspace only. Untouched categories follow the global defaults; any change overrides them.',
        loading: zh ? '加载中…' : 'Loading…',
        routeMissing: zh
          ? '宿主半边未加载（路由 404）：请在「设置 → 插件」中启用能力裁剪，然后刷新页面。'
          : 'The Host half is not loaded (route 404): enable Capability trim in Settings → Plugins, then reload.',
        tools: zh ? '工具' : 'Tools',
        skills: zh ? '技能' : 'Skills',
        filterTools: zh ? '筛选工具…' : 'Filter tools…',
        filterSkills: zh ? '筛选技能…' : 'Filter skills…',
        noTool: zh ? '没有可用的工具。' : 'No tool is available.',
        noToolMatch: zh ? '没有工具匹配该筛选。' : 'No tool matches this filter.',
        noSkillMatch: zh ? '没有技能匹配该筛选。' : 'No skill matches this filter.',
        close: zh ? '关闭' : 'Close',
        noSkill: zh ? '没有可被模型调用的技能。' : 'No model-invocable skill is registered.',
        skillError: zh ? '技能发现失败' : 'Skill discovery failed',
        hidden: zh ? '已隐藏' : 'hidden',
        allOn: zh ? '全部开启' : 'all on',
        expand: zh ? '展开' : 'Expand',
        collapse: zh ? '收起' : 'Collapse',
        openWorkspace: zh ? '本工作区的能力' : 'This workspace',
        noWorkspace: zh ? '当前会话没有工作区目录。' : 'This session has no workspace directory.',
        toolLimit: zh
          ? '只有全局注册的工具能被隐藏；由 Agent 预设自带的工具（如 read_image、list_agents）无法隐藏。'
          : 'Only globally registered tools can be hidden; tools that come from the Agent preset itself (such as read_image or list_agents) cannot be hidden.',
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

    /** A switch rendered as a real button with `role="switch"`. */
    function Switch({ checked, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        onClick: () => onChange(!checked),
        style: {
          flex: '0 0 auto', width: 36, height: 20, borderRadius: 999, padding: 2,
          border: '1px solid var(--dsw-alias-border-strong)',
          background: checked ? 'var(--dsw-alias-accent-fill, #1f6feb)' : 'var(--dsw-alias-bg-sunken, var(--dsw-alias-bg-selected))',
          cursor: 'pointer', display: 'flex', alignItems: 'center',
          justifyContent: checked ? 'flex-end' : 'flex-start',
          transition: 'background 120ms ease',
        },
      }, h('span', {
        style: {
          width: 14, height: 14, borderRadius: '50%', display: 'block',
          background: checked ? '#fff' : 'var(--dsw-alias-text-tertiary)',
          boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
        },
      }))
    }

    /**
     * The shared editor. `scope` is the layer being edited; `onToggle` writes one
     * change straight through, so there is no save step.
     */
    function TrimEditor({ scope, onToggle, state, strings, lead, fills }) {
      const [toolFilter, setToolFilter] = useState('')
      const [skillFilter, setSkillFilter] = useState('')
      // One flag per section: a single shared flag made the skills toggle move
      // the tool list, because both read the same state.
      const [expandedTools, setExpandedTools] = useState(false)
      const [expandedSkills, setExpandedSkills] = useState(false)

      const tools = state?.tools ?? []
      const skills = state?.skills ?? []
      // The count is per category: a badge over the tool list must not report a
      // hidden skill, which is what made "1 hidden" appear with every tool on.
      const hiddenTools = tools.filter(name => matchesAny(scope.denyTools, name)).length
      const hiddenSkills = skills.filter(skill => matchesAny(scope.denySkills, skill.name)).length
      const filteredTools = toolFilter === ''
        ? tools
        : tools.filter(name => name.toLowerCase().includes(toolFilter.toLowerCase()))
      const filteredSkills = skillFilter === ''
        ? skills
        : skills.filter(skill => skill.name.toLowerCase().includes(skillFilter.toLowerCase()))

      const list = (items, field, keyOf, hiddenOf, expanded) => h('div', {
        style: { ...S.listBox, maxHeight: expanded ? 460 : 190 },
      },
        items.map(item => {
          const key = keyOf(item)
          return h('div', { key, style: S.row, className: 'ct-row' },
            h('span', { style: S.mono, title: key }, key),
            h(Switch, {
              checked: !hiddenOf(key),
              label: key,
              onChange: value => onToggle(field, key, value),
            }))
        }))

      /**
       * One capability section: title, count, filter, expand toggle, and body.
       *
       * `body` is a single node, not a rest argument: passing both an error line
       * and a list once shifted the positional arguments and dropped the list,
       * which is why the skills section rendered empty.
       */
      const section = (title, badge, filter, setFilter, placeholder, expanded, setExpanded, body) => h('section', { style: S.card },
        h('div', { style: S.headRow },
          h('h3', { style: { ...S.title, flex: '0 0 auto' } }, title),
          h('span', { style: S.badge }, badge),
          h('input', {
            type: 'search', value: filter, placeholder, style: S.search,
            onChange: event => setFilter(event.target.value),
          }),
          h('button', {
            type: 'button', style: S.smallButton,
            onClick: () => setExpanded(value => !value),
            title: expanded ? strings.collapse : strings.expand,
          }, expanded ? strings.collapse : strings.expand)),
        body)

      const badgeFor = count => (count === 0 ? strings.allOn : `${count} ${strings.hidden}`)

      return h('div', { style: S.page, className: ROOT_CLASS },
        h('style', null, STYLE_TEXT),
        h('div', { style: S.scroll },
          lead === undefined ? null : h('p', { style: S.lead }, lead),

          section(strings.tools, badgeFor(hiddenTools), toolFilter, setToolFilter, strings.filterTools,
            expandedTools, setExpandedTools,
            filteredTools.length === 0
              ? h('p', { style: S.muted }, tools.length === 0 ? strings.noTool : strings.noToolMatch)
              : h(React.Fragment, null,
                list(filteredTools, 'denyTools', name => name, name => matchesAny(scope.denyTools, name), expandedTools),
                h('p', { style: S.muted }, strings.toolLimit))),

          section(strings.skills, badgeFor(hiddenSkills), skillFilter, setSkillFilter, strings.filterSkills,
            expandedSkills, setExpandedSkills,
            h(React.Fragment, null,
              state?.skillError === undefined
                ? null
                : h('p', { style: S.error }, `${strings.skillError}: ${state.skillError}`),
              skills.length === 0
                ? h('p', { style: S.muted }, strings.noSkill)
                : filteredSkills.length === 0
                  ? h('p', { style: S.muted }, strings.noSkillMatch)
                  : list(filteredSkills, 'denySkills', skill => skill.name, name => matchesAny(scope.denySkills, name), expandedSkills)))),
      )
    }

    /** Shared loader and writer. */
    function useTrim(cwd) {
      const [state, setState] = useState(null)
      const [globalScope, setGlobalScope] = useState(EMPTY)
      const [workspaces, setWorkspaces] = useState({})
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const reload = useCallback(async (focus) => {
        const target = focus === undefined ? cwd : focus
        try {
          const data = await readStateWithRetry(target)
          setState(data)
          setGlobalScope(asScope(data.global))
          const byPath = {}
          for (const workspace of data.workspaces ?? []) byPath[workspace.path] = asScope(workspace.scope)
          setWorkspaces(byPath)
          setError('')
        } catch (cause) {
          setError(cause?.routeMissing === true ? 'route-missing' : (cause.message ?? String(cause)))
        }
      }, [cwd])

      useEffect(() => { void reload() }, [reload])

      /**
       * Write the whole state. Switches call this on every flip, so the write is
       * debounced by the caller passing already-updated maps.
       */
      const commit = useCallback(async (nextGlobal, nextWorkspaces) => {
        setBusy(true)
        setError('')
        try {
          const pick = source => {
            const result = {}
            for (const [key, scope] of Object.entries(source)) {
              if (!isEmptyScope(scope)) result[key] = scope
            }
            return result
          }
          await writeState({ global: nextGlobal, workspaces: pick(nextWorkspaces) })
        } catch (cause) {
          setError(cause.message ?? String(cause))
        } finally {
          setBusy(false)
        }
      }, [])

      return { state, globalScope, setGlobalScope, workspaces, setWorkspaces, error, busy, commit, reload }
    }

    /** The sidebar panel: the global layer only. */
    function makePanel(locale) {
      return function Panel() {
        const strings = useStrings(locale)
        const trim = useTrim(undefined)

        const onToggle = useCallback((field, name, enabled) => {
          const next = toggle(trim.globalScope, field, name, enabled)
          trim.setGlobalScope(next)
          void trim.commit(next, trim.workspaces)
        }, [trim])

        if (trim.state === null) {
          const message = trim.error === 'route-missing' ? strings.routeMissing : (trim.error !== '' ? trim.error : strings.loading)
          return h('p', { style: { ...S.muted, padding: 16 } }, message)
        }

        return h(TrimEditor, {
          scope: trim.globalScope,
          onToggle,
          state: trim.state,
          strings,
          lead: strings.globalLead,
        })
      }
    }

    /**
     * The composer control, beside the model selector.
     *
     * It reads the current Session's workspace directory from the Host state,
     * opens a modal for that workspace's own layer, and stays hidden when the
     * Session has no workspace.
     */
    function makeWorkspaceTrigger(locale) {
      return function WorkspaceTrigger(props) {
        const strings = useStrings(locale)
        const [open, setOpen] = useState(false)
        const trim = useTrim(undefined)

        const sessionId = props.sessionId === undefined ? undefined : String(props.sessionId)

        const cwd = useMemo(() => {
          if (sessionId === undefined) return undefined
          for (const workspace of trim.state?.workspaces ?? []) {
            if ((workspace.sessionIds ?? []).includes(sessionId)) return workspace.path
          }
          return undefined
        }, [trim.state, sessionId])

        const workspaceScope = cwd === undefined ? EMPTY : asScope(trim.workspaces[cwd])

        const onToggle = useCallback((field, name, enabled) => {
          if (cwd === undefined) return
          const next = toggle(workspaceScope, field, name, enabled)
          const nextWorkspaces = { ...trim.workspaces, [cwd]: next }
          trim.setWorkspaces(nextWorkspaces)
          void trim.commit(trim.globalScope, nextWorkspaces)
        }, [cwd, workspaceScope, trim])

        // The button always renders. An earlier version returned null while the
        // workspace directory was still unknown, which made the control appear,
        // flash, and vanish as state arrived — and returning before later hooks
        // would have crashed the component outright once the tree changed.
        const ready = cwd !== undefined

        /**
         * Fetch the surface for THIS workspace before opening.
         *
         * The first load has no cwd — the workspace directory is only known once
         * the state names it — so the Host answers for its deployment fallback.
         * Re-reading with the resolved path makes the skill catalog match the
         * project the modal is describing.
         */
        const openModal = () => {
          if (cwd !== undefined) void trim.reload(cwd)
          setOpen(true)
        }

        // The control renders for every Session, started or not.
        //
        // A previous version hid it once `blank === false`, reading the Session
        // snapshot through `props.useSession()`. That hook is a selector hook —
        // `(sel, eq?) => S` — so calling it with no selector made the underlying
        // `useSyncExternalStoreWithSelector` throw while reading the snapshot.
        // The throw landed inside a try/catch, but React had already been left
        // with a broken hook, so it unmounted this Slot occupant for the rest of
        // the page's life: the button vanished after opening one conversation and
        // never came back until the app restarted.
        //
        // It also hid the wrong thing. Every toggle here writes a WORKSPACE layer,
        // and that layer is applied when the next Agent is created — so changing
        // it mid-conversation is meaningful, it simply takes effect on the next
        // task. Hiding the entry point took that away without preventing anything.
        //
        // What actually must stay guarded is the no-workspace case, and it is:
        // without a resolved directory the trigger renders dimmed and the modal
        // explains why it cannot edit anything.

        return h(React.Fragment, null,
          h('button', {
            type: 'button',
            className: ROOT_CLASS,
            title: ready ? strings.openWorkspace : strings.noWorkspace,
            onClick: openModal,
            style: { ...S.trigger, opacity: ready ? 1 : 0.5 },
          }, h('span', { 'aria-hidden': true }, '◧'), h('span', null, strings.workspaceShort)),

          open ? h(Modal, {
            title: strings.workspace,
            subtitle: cwd,
            closeLabel: strings.close,
            onClose: () => setOpen(false),
          },
            !ready
              ? h('p', { style: { ...S.muted, padding: 16 } }, strings.noWorkspace)
              : trim.state === null
                ? h('p', { style: { ...S.muted, padding: 16 } }, trim.error !== '' ? trim.error : strings.loading)
                : h(TrimEditor, {
                  scope: workspaceScope,
                  onToggle,
                  state: trim.state,
                  strings,
                  lead: strings.workspaceLead,
                }))
          : null)
      }
    }

    /**
     * A centred modal dialog, matching the shape of the app's own Settings
     * window: dim backdrop, titled header with a close button, and a body that
     * scrolls on its own.
     *
     * The backdrop is a full-viewport layer that swallows pointer, wheel and key
     * events. Without that, wheel scrolling fell through to the conversation
     * behind the dialog, which is what produced the stray scrolling and the
     * overlapping text.
     */
    function Modal({ title, subtitle, closeLabel, onClose, children }) {
      useEffect(() => {
        const onKey = event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }
        // Capture phase: the app's own key handling must not see Escape first.
        document.addEventListener('keydown', onKey, true)
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          document.removeEventListener('keydown', onKey, true)
          document.body.style.overflow = previous
        }
      }, [onClose])

      const stop = event => { event.stopPropagation() }

      return h('div', {
        role: 'dialog',
        'aria-modal': true,
        'aria-label': title,
        onClick: event => { if (event.target === event.currentTarget) onClose() },
        onWheel: stop,
        onTouchMove: stop,
        className: ROOT_CLASS,
        style: {
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.55)', padding: '5vh 24px',
          overscrollBehavior: 'contain',
        },
      }, h('div', {
        style: {
          width: 'min(880px, 100%)', maxHeight: '88vh',
          display: 'flex', flexDirection: 'column', minHeight: 0,
          borderRadius: 14,
          border: '1px solid var(--dsw-alias-border-strong)',
          background: 'var(--dsw-alias-bg-elevated)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
          overflow: 'hidden',
        },
      },
        h('div', {
          style: {
            flex: '0 0 auto',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, padding: '12px 16px',
            borderBottom: '1px solid var(--dsw-alias-border-subtle)',
          },
        },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: 15, fontWeight: 600 } }, title),
            subtitle === undefined
              ? null
              : h('div', {
                title: subtitle,
                style: {
                  fontSize: 11, marginTop: 2,
                  color: 'var(--dsw-alias-text-tertiary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                },
              }, subtitle)),
          h('button', {
            type: 'button',
            'aria-label': closeLabel,
            title: closeLabel,
            onClick: onClose,
            style: {
              flex: '0 0 auto', padding: '3px 10px', borderRadius: 8, font: 'inherit',
              fontSize: 13, cursor: 'pointer', lineHeight: 1.4,
              border: '1px solid var(--dsw-alias-border-strong)',
              background: 'transparent', color: 'var(--dsw-alias-text-secondary)',
            },
          }, '✕')),
        h('div', {
          style: { flex: '1 1 auto', minHeight: 0, display: 'flex', overflow: 'hidden' },
        }, children)))
    }

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
        const Trigger = makeWorkspaceTrigger(ctx.locale)
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

        // Workspace control beside the model selector in the composer tool row.
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'capability-trim-workspace',
          order: 5,
          label,
        }, Trigger))
      },
    }
  },
})

