import React, { useEffect, useState, useRef } from 'react'
import { MODEL_MENU_ROW_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, host, Button, Input, useValue, queryClient } from '@hermes/plugin-sdk'
const h = React.createElement

const REFRESH_MS = 60 * 1000
const PROVIDERS = new Set(['workbuddy', 'workbuddy-ai', 'trae', 'trae-ai', 'qoder-cn', 'qoder'])

export default {
  id: 'dsh-model-rates',
  name: 'Hermes 渠道中心',
  defaultEnabled: true,
  register(ctx) {
    let rates = {}
    let loaded = false
    let active = true
    let removeDecoration = null
    let loading = false
    let retryTimer = null
    let refreshAttempts = 0

    const registerDecoration = () => {
      removeDecoration?.()
      removeDecoration = ctx.register({
        id: 'multipliers',
        area: MODEL_MENU_ROW_AREA,
        data: {
          decorate: ({ provider, model }) => {
            if (!PROVIDERS.has(provider)) return null
            const badge = rates[provider]?.[model]
            return { badge: typeof badge === 'string' && badge.length > 0
              ? badge : loaded ? '倍率未知' : '倍率加载中' }
          },
        },
      })
    }

    const refresh = async () => {
      if (!active || loading) return
      loading = true
      const scope = host.state.profile.get()
      try {
        const payload = await ctx.rest('/multipliers')
        if (!active || scope !== host.state.profile.get() || !payload || !payload.rates || typeof payload.rates !== 'object') return
        rates = payload.rates
        loaded = !payload.refreshing
        registerDecoration()
        if (payload.refreshing && refreshAttempts < 12) {
          refreshAttempts += 1
          retryTimer ??= setTimeout(() => {
            retryTimer = null
            void refresh()
          }, 5000)
        } else {
          refreshAttempts = 0
        }
      } catch {
        if (!active || scope !== host.state.profile.get()) return
        loaded = true
        rates = {}
        registerDecoration()
      } finally {
        loading = false
        if (active && scope !== host.state.profile.get()) void refresh()
      }
    }

    let removeNav = null
    const onSettingsChanged = settings => {
      removeNav?.(); removeNav = null
      if (settings.sidebar !== false) removeNav = ctx.register({ id: 'channel-center-nav', area: SIDEBAR_NAV_AREA,
        order: 60, data: { label: '渠道中心', codicon: 'server', path: '/local-channels' } })
    }
    const Page = () => {
      const scope = useValue(host.state.profile)
      return h(ChannelCenter, { key: scope, scope, ctx, onModelsChanged: () => void refresh(), onSettingsChanged })
    }
    ctx.register({ id: 'channel-center-page', area: ROUTES_AREA, data: { path: '/local-channels' }, render: () => h(Page) })
    ctx.registerSettingsPage?.({ id: 'channel-center', title: '渠道中心', icon: 'server', render: () => h(Page) })
    onSettingsChanged({ sidebar: true })
    const stopProfile = host.state.profile.subscribe(scope => {
      rates = {}; loaded = false; registerDecoration(); void refresh()
      void ctx.rest('/channels/settings').then(settings => {
        if (active && scope === host.state.profile.get()) onSettingsChanged(settings)
      }).catch(() => {})
    })
    ctx.onDispose(stopProfile)
    ctx.onDispose(() => { removeNav?.() })
    registerDecoration()
    void refresh()
    ctx.setInterval(() => { void refresh() }, REFRESH_MS)
    ctx.onDispose(() => {
      active = false
      if (retryTimer !== null) clearTimeout(retryTimer)
      removeDecoration?.()
    })
  },
}

function ChannelCenter({ ctx, onModelsChanged, onSettingsChanged, scope }) {
  const [rows, setRows] = useState([])
  const [settings, setSettings] = useState({ auto_checkin: false, sidebar: true })
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState({})
  const [message, setMessage] = useState('')
  const [editing, setEditing] = useState(null)
  const [selection, setSelection] = useState(new Set())
  const [allFuture, setAllFuture] = useState(false)
  const [search, setSearch] = useState('')
  const generation = useRef(0)
  const autoEnabled = useRef(false)
  const active = useRef(true)
  const sameScope = () => active.current && host.state.profile.get() === scope
  const call = (path, method = 'GET', body) => ctx.rest(path, { method, body, timeoutMs: 120000 })
  const load = async (allowAuto = true, force = false) => {
    const turn = ++generation.current
    setLoading(true)
    try {
      const result = await call('/channels')
      if (!sameScope() || turn !== generation.current) return
      setSettings(result.settings)
      autoEnabled.current = result.settings.auto_checkin
      onSettingsChanged(result.settings)
      setRows(result.channels.map(row => ({ ...row, pending: row.logged_in })))
      const details = await Promise.all(result.channels.map(async row => {
        if (!row.logged_in) return row
        try {
          const detail = await call(`/channels/${row.id}?refresh=${force}`)
          if (sameScope() && turn === generation.current) setRows(old => old.map(item => item.id === row.id ? detail : item))
          return detail
        } catch {
          const detail = { ...row, pending: false, error: '渠道信息读取失败，请刷新重试' }
          if (sameScope() && turn === generation.current) setRows(old => old.map(item => item.id === row.id ? detail : item))
          return detail
        }
      }))
      if (allowAuto && result.settings.auto_checkin && sameScope() && turn === generation.current) {
        for (const row of details) {
          if (!autoEnabled.current || !sameScope()) break
          if (row.logged_in && row.checkin?.can_claim) await claim(row.id)
        }
      }
    } catch { if (sameScope()) setMessage('渠道中心加载失败；首次升级请完全退出并重新打开 Hermes，并确认 Agent 和 Desktop 两个插件开关均已开启。') }
    finally { if (sameScope() && turn === generation.current) setLoading(false) }
  }
  useEffect(() => {
    active.current = true
    void load()
    return () => { active.current = false; generation.current += 1 }
  }, [])
  async function claim(id) {
    if (!sameScope()) return
    setBusy(old => ({ ...old, [id]: true }))
    try {
      const result = await call(`/channels/${id}/checkin`, 'POST', { confirm: true })
      if (!sameScope()) return
      setMessage(result.claimed ? result.replayed ? '今日已签到，未重复领取。' : '签到成功。' : result.error || '上游未发放奖励，可能暂无可签到活动。')
      const detail = await call(`/channels/${id}`)
      if (sameScope()) setRows(old => old.map(row => row.id === id ? detail : row))
    } catch { if (sameScope()) setMessage('签到结果未确认，请刷新状态后再重试。') }
    finally { if (sameScope()) setBusy(old => ({ ...old, [id]: false })) }
  }
  async function login(id) {
    setBusy(old => ({ ...old, [id]: true }))
    try { const result = await call(`/channels/${id}/login`, 'POST'); if (sameScope()) setMessage(result.message) }
    catch { if (sameScope()) setMessage('无法打开应用，请手动登录对应桌面应用后刷新。') }
    finally { if (sameScope()) setBusy(old => ({ ...old, [id]: false })) }
  }
  async function saveSettings(next) {
    try {
      const saved = await call('/channels/settings', 'PUT', next)
      if (!sameScope()) return
      autoEnabled.current = saved.auto_checkin
      setSettings(saved); onSettingsChanged(saved)
      if (saved.auto_checkin && !settings.auto_checkin) setMessage('已开启：下次打开渠道中心时，为可签到的渠道领取奖励。')
    } catch { if (sameScope()) setMessage('设置保存失败，原设置保持不变。') }
  }
  function edit(row) {
    setEditing(row.id); setSearch(''); setAllFuture(row.all_selected === true)
    setSelection(new Set((row.models || []).filter(model => model.selected).map(model => model.id)))
  }
  async function saveModels(row) {
    setBusy(old => ({ ...old, models: true }))
    try {
      await call(`/channels/${row.id}/models`, 'PUT', { selected: allFuture ? null : [...selection] })
      if (!sameScope()) return
      setRows(old => old.map(item => item.id === row.id ? { ...item, all_selected: allFuture, models: item.models.map(model => ({ ...model, selected: allFuture || selection.has(model.id) })) } : item))
      setEditing(null); setMessage('模型显示已保存；当前会话使用的模型不会被强制切换。')
      onModelsChanged()
      void host.request('model.options', { refresh: true }).then(() => queryClient.invalidateQueries({ queryKey: ['model-options'] })).catch(() => setMessage('选择已保存；请在模型选择器中点击“刷新模型”。'))
    } catch { if (sameScope()) setMessage('模型选择保存失败。至少保留一个模型，或选择全部模型。') }
    finally { if (sameScope()) setBusy(old => ({ ...old, models: false })) }
  }
  const text = { checked: '已签到', available: '可签到', not_applicable: '暂无签到活动', unknown: '签到状态待确认' }
  const fmt = value => Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '未知'
  const button = (label, onClick, disabled = false) => h(Button, { variant: 'outline', onClick, disabled, type: 'button' }, label)
  return h('section', { style: { height: '100%', overflow: 'auto', padding: 24 } },
    h('div', { style: { maxWidth: 960, margin: '0 auto' } },
      h('header', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } },
        h('h1', { className: 'text-xl font-semibold' }, '渠道中心'), button(loading ? '刷新中…' : '刷新', () => load(true, true), loading)),
      h('p', { className: 'text-muted-foreground', style: { marginTop: 12 } }, `已登录 ${rows.filter(row => row.logged_in).length}/${rows.length} · 已签到 ${rows.filter(row => row.checkin?.state === 'checked').length} · 可签到 ${rows.filter(row => row.checkin?.can_claim).length}`),
      message && h('p', { role: 'status', style: { margin: '16px 0' } }, message),
      ...rows.map(row => h('article', { key: row.id, style: { padding: '20px 0', borderBottom: '1px solid var(--border)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h('strong', null, `${row.logged_in ? '●' : '○'} ${row.label}`),
          h('span', { className: 'text-muted-foreground' }, row.account || (row.unavailable ? '渠道不可用' : row.logged_in ? '已登录' : '未登录')),
          h('span', { style: { marginLeft: 'auto' } }, row.pending ? '正在读取…' : text[row.checkin?.state] || '签到状态未知'),
          button('认证', () => login(row.id), busy[row.id]),
          row.checkin?.can_claim && button('签到', () => claim(row.id), busy[row.id])),
        row.quota ? h('div', { style: { marginTop: 12 } },
          h('p', null, `剩余 ${row.quota.unlimited ? '不限量' : fmt(row.quota.remaining)} / ${row.quota.unlimited ? '不限量' : fmt(row.quota.total)} ${row.quota.unit || '积分'}${row.quota.packages ? ` · ${row.quota.packages} 个包` : ''}`),
          !row.quota.unlimited && row.quota.total > 0 && h('progress', { value: Math.max(0, Math.min(row.quota.remaining, row.quota.total)), max: row.quota.total, 'aria-label': `${row.label}剩余额度`, style: { width: '100%', marginTop: 8 } }))
          : row.logged_in && h('p', { className: 'text-muted-foreground', style: { marginTop: 12 } }, row.pending ? '积分读取中…' : row.usage_error || '上游暂未提供可用积分数据'),
        row.checkin?.reason && h('p', { className: 'text-xs text-muted-foreground', style: { marginTop: 8 } }, row.checkin.reason),
        (row.error || row.models_error) && h('p', { role: 'alert' }, row.error || row.models_error),
        row.logged_in && h('div', { style: { marginTop: 12 } }, button(`已选 ${(row.models || []).filter(model => model.selected).length} / ${(row.models || []).length} 个模型`, () => edit(row), !row.models?.length)),
        editing === row.id && h('div', { style: { padding: '16px 0' } },
          h(Input, { placeholder: '搜索模型', value: search, onChange: event => setSearch(event.target.value), 'aria-label': '搜索模型' }),
          h('div', { style: { display: 'flex', gap: 8, margin: '12px 0' } },
            button('全选（含今后新增模型）', () => { setAllFuture(true); setSelection(new Set(row.models.map(model => model.id))) }),
            button('清空选择', () => { setAllFuture(false); setSelection(new Set()) })),
          h('div', { style: { maxHeight: 320, overflow: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8 } },
            ...row.models.filter(model => `${model.id} ${model.label}`.toLowerCase().includes(search.toLowerCase())).map(model => h('label', { key: model.id, style: { display: 'flex', alignItems: 'center', gap: 8, padding: 6 } },
              h('input', { type: 'checkbox', checked: selection.has(model.id), onChange: event => { setAllFuture(false); setSelection(old => { const next = new Set(old); event.target.checked ? next.add(model.id) : next.delete(model.id); return next }) } }),
              h('span', null, model.label), h('span', { className: 'text-xs text-muted-foreground' }, model.multiplier_label)))),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } }, button('保存选择', () => saveModels(row), busy.models || selection.size === 0), button('取消', () => setEditing(null))))
      )),
      h('div', { style: { display: 'grid', gap: 16, marginTop: 24 } },
        h('label', null, h('input', { type: 'checkbox', checked: settings.auto_checkin, onChange: event => saveSettings({ ...settings, auto_checkin: event.target.checked }) }), ' 打开渠道中心时自动签到（默认关闭）'),
        h('label', null, h('input', { type: 'checkbox', checked: settings.sidebar, onChange: event => saveSettings({ ...settings, sidebar: event.target.checked }) }), ' 在侧栏显示渠道中心入口'),
        button('签到所有可签渠道', async () => { for (const row of rows) if (row.logged_in && row.checkin?.can_claim) await claim(row.id) }, loading || Object.values(busy).some(Boolean) || !rows.some(row => row.checkin?.can_claim)),
        h('p', { className: 'text-xs text-muted-foreground' }, '积分来自对应渠道实时接口；不同套餐的积分不可跨渠道相加。认证会打开对应桌面应用，不需要把令牌粘贴到 Hermes。'))))
}
