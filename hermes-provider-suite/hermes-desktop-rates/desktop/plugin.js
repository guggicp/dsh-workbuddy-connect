import { MODEL_MENU_ROW_AREA } from '@hermes/plugin-sdk'

const REFRESH_MS = 60 * 1000
const PROVIDERS = new Set(['workbuddy', 'workbuddy-ai', 'trae', 'trae-ai', 'qoder-cn', 'qoder'])

export default {
  id: 'dsh-model-rates',
  name: 'DSH Model Multipliers',
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
      try {
        const payload = await ctx.rest('/multipliers')
        if (!active || !payload || !payload.rates || typeof payload.rates !== 'object') return
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
        if (!active) return
        loaded = true
        rates = {}
        registerDecoration()
      } finally {
        loading = false
      }
    }

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
