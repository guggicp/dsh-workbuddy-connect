/**
 * The card's account-transfer section: batch export and import of a region's
 * stored credentials, in the file format shared with sibling credential
 * managers for the same upstream (the `dsh-connect-workbuddy` family).
 *
 * Modelled on that plugin's `AccountTransfer`, deliberately: the two plugins
 * share one external-presentation language, and a user who has imported
 * accounts in one should recognise the flow in the other. The shape is a single
 * section owning all of its state (busy / result line / error), with the export
 * dialog (pick accounts → download JSON) and the import dialog (pick file →
 * desensitised preview → tick → import) split the same way.
 *
 * Two properties are load-bearing and must not be relaxed:
 *  - The preview carries display fields and a `hasToken` boolean only. Tokens
 *    never enter the browser at all until the user explicitly exports a chosen
 *    account, and the Host re-parses the file on import rather than trusting
 *    anything this component says about it.
 *  - Import is offered even when the region has NO account: a machine that has
 *    never signed in is exactly where importing someone else's export matters
 *    most. Only EXPORT needs an existing account to select.
 *
 * The download uses `<a download>` on a Blob because the card runs inside the
 * settings iframe and has no host save dialog; a same-origin anchor download is
 * the reliable path there.
 *
 * @module dsh-connect-trae/client/AccountTransfer
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { TRAE_TRANSFER_PATH, withTraeTransferAction } from '../status-paths.ts'
import type { TraeRegion } from '../region.ts'
import type { TraeTransferPreview } from '../status-paths.ts'
import type { TraeSettingsKey } from './locales.ts'
import { BusyOverlay } from './BusyOverlay.tsx'

/** How long the veil may wait for the card's re-read before it comes down. */
const REFRESH_SETTLE_TIMEOUT_MS = 5_000

type Phase =
  | { kind: 'idle' }
  | { kind: 'exporting' }
  | { kind: 'importing' }
  /** The write landed; the account list re-read is still in flight. */
  | { kind: 'refreshing', message: string }
  | { kind: 'done', message: string }
  | { kind: 'error', message: string }

export interface AccountTransferProps {
  t: (key: TraeSettingsKey, params?: Record<string, unknown>) => string
  region: TraeRegion
  /** The region's accounts (id + name), token-free, from the usage snapshot. */
  accounts: readonly { id: string, accountName: string }[]
  /**
   * Called after an import actually added something, so the card re-reads its
   * snapshot. Without it the freshly written credential only appears on the next
   * poll — and when the region had NO account before the import, that poll is
   * not even running, so the new account would appear only after the settings
   * page was closed and reopened.
   */
  onChanged?: () => void | Promise<unknown>
  /**
   * Drop the section's own heading. The pool's tool row already prints a
   * label for this control, and two headings over one pair of buttons read as
   * duplicated information.
   */
  hideLabel?: boolean
}

/** Build the default export file name: trae-accounts-YYYY-MM-DD.json. */
function exportFileName(): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const now = new Date()
  return `trae-accounts-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`
}

/** Download a JSON value as a local file (no host save dialog inside the iframe). */
function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** Resolve once `value` settles, or after `timeoutMs` — whichever comes first. */
async function settlesWithin(value: void | Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([
    Promise.resolve(value).catch(() => undefined),
    new Promise<void>(resolve => { setTimeout(resolve, timeoutMs) }),
  ])
}

export function AccountTransfer({ t, region, accounts, onChanged, hideLabel = false }: AccountTransferProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [dialog, setDialog] = useState<'export' | 'import' | undefined>(undefined)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [preview, setPreview] = useState<TraeTransferPreview | undefined>(undefined)
  const [importSelected, setImportSelected] = useState<ReadonlySet<number>>(new Set())
  const fileInput = useRef<HTMLInputElement | null>(null)
  /**
   * The text of the file the user just picked, held here rather than re-read
   * from the input at import time: the picker is a bare system dialog that
   * closes immediately, so between preview and confirm no dialog holds the
   * File. Re-reading `fileInput.current.files` would also break the moment
   * anything clears the input — and it must be cleared after every pick, or
   * choosing the SAME file twice fires no change event.
   */
  const importText = useRef('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const closeDialog = (): void => {
    setDialog(undefined)
    setSelected(new Set())
    setPreview(undefined)
    setImportSelected(new Set())
  }

  const runExport = async (): Promise<void> => {
    if (selected.size === 0) return
    setPhase({ kind: 'exporting' })
    try {
      const response = await fetch(withTraeTransferAction(TRAE_TRANSFER_PATH, region, 'export'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ accountIds: [...selected] }),
      })
      const body = await response.json() as { accounts?: unknown, error?: string }
      if (!mounted.current) return
      if (!response.ok || !Array.isArray(body.accounts)) {
        setPhase({ kind: 'error', message: body.error ?? `HTTP ${response.status}` })
        return
      }
      const fileName = exportFileName()
      downloadJson(fileName, body.accounts)
      closeDialog()
      setPhase({ kind: 'done', message: t('row.transferExported', { count: body.accounts.length, fileName }) })
    } catch (error: unknown) {
      if (mounted.current) setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const readImportFile = async (file: File): Promise<void> => {
    setPhase({ kind: 'importing' })
    try {
      const text = await file.text()
      importText.current = text
      const response = await fetch(withTraeTransferAction(TRAE_TRANSFER_PATH, region, 'preview'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text }),
      })
      const body = await response.json() as TraeTransferPreview & { error?: string }
      if (!mounted.current) return
      if (!response.ok || !Array.isArray(body.accounts)) {
        setPhase({ kind: 'error', message: body.error ?? `HTTP ${response.status}` })
        return
      }
      setPreview(body)
      // Pre-select only records that can actually be imported, so a
      // credential-less row is visibly skipped instead of silently succeeding.
      setImportSelected(new Set(body.accounts.filter(entry => entry.hasToken).map(entry => entry.index)))
      setPhase({ kind: 'idle' })
    } catch (error: unknown) {
      if (mounted.current) setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const runImport = async (): Promise<void> => {
    if (preview === undefined || importSelected.size === 0 || importText.current === '') return
    setPhase({ kind: 'importing' })
    try {
      const response = await fetch(withTraeTransferAction(TRAE_TRANSFER_PATH, region, 'import'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text: importText.current, indexes: [...importSelected] }),
      })
      const body = await response.json() as { imported?: number, skipped?: number, error?: string }
      if (!mounted.current) return
      if (!response.ok || typeof body.imported !== 'number') {
        setPhase({ kind: 'error', message: body.error ?? `HTTP ${response.status}` })
        return
      }
      closeDialog()
      const message = t('row.transferImported', { imported: body.imported, skipped: body.skipped ?? 0 })
      // Hold the veil across the re-read, not just across the write: the write
      // is the fast half, and the account list is what the user is watching.
      setPhase({ kind: 'refreshing', message })
      await settlesWithin(onChanged?.(), REFRESH_SETTLE_TIMEOUT_MS)
      if (!mounted.current) return
      setPhase({ kind: 'done', message })
    } catch (error: unknown) {
      if (mounted.current) setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const busy = phase.kind === 'exporting' || phase.kind === 'importing' || phase.kind === 'refreshing'
  const veilMessage = phase.kind === 'exporting'
    ? t('row.transferExporting')
    : phase.kind === 'importing' || phase.kind === 'refreshing'
      ? t('row.transferImporting')
      : ''

  return (
    <section
      className={hideLabel ? 'dsm-trae-transfer dsm-trae-transfer-flat' : 'dsm-trae-transfer'}
      aria-label={t('row.transferTitle')}
    >
      <BusyOverlay visible={busy} message={veilMessage} {...busy ? { hint: t('row.transferVeilHint') } : {}} />
      {hideLabel ? null : <p className="dsm-trae-transfer-label">{t('row.transferTitle')}</p>}
      {phase.kind === 'done'
        ? <p className="dsm-trae-transfer-status dsm-trae-transfer-ok">{phase.message}</p>
        : phase.kind === 'error'
          ? <p className="dsm-trae-transfer-status dsm-trae-transfer-error">{t('row.transferError', { message: phase.message })}</p>
          : null}
      <div className="dsm-trae-transfer-actions">
        <button
          type="button"
          className="dsm-btn dsm-btn-outline"
          disabled={busy || accounts.length === 0}
          onClick={() => { setSelected(new Set()); setDialog('export') }}
        >
          {t('row.transferExport')}
        </button>
        {/*
          The import button opens the SYSTEM file picker directly. A one-line
          dialog in front of it would be a click of ceremony before a dialog the
          OS is about to show anyway; the preview is the step that actually needs
          the user's attention, and it still appears.
        */}
        <button
          type="button"
          className="dsm-btn dsm-btn-outline"
          disabled={busy}
          onClick={() => { fileInput.current?.click() }}
        >
          {t('row.transferImport')}
        </button>
      </div>
      {/* The picker's input is mounted with the section, not inside the preview
          dialog: the button must be able to open it before any dialog exists,
          and `value=""` after every pick lets the same file be chosen twice. */}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="dsm-trae-transfer-file"
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) {
            setPreview(undefined)
            setImportSelected(new Set())
            setDialog('import')
            void readImportFile(file)
          }
        }}
      />
      {dialog === 'export'
        ? <div className="dsm-trae-transfer-dialog" role="dialog" aria-label={t('row.transferExport')}>
            <p>{t('row.transferExportPick', { total: accounts.length })}</p>
            {/* The privacy note lives here rather than on the resting bar: it
                matters at the moment credentials leave the machine, and on the
                bar it would cost a line to repeat forever. */}
            <p className="dsm-trae-hint">{t('row.transferHint')}</p>
            <ul className="dsm-trae-transfer-list">
              {accounts.map(account => (
                <li key={account.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(account.id)}
                      onChange={event => {
                        const next = new Set(selected)
                        if (event.target.checked) next.add(account.id)
                        else next.delete(account.id)
                        setSelected(next)
                      }}
                    />
                    <span>{account.accountName}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="dsm-trae-transfer-dialog-actions">
              <button type="button" className="dsm-btn" disabled={selected.size === 0} onClick={() => { void runExport() }}>
                {t('row.transferExportConfirm', { count: selected.size })}
              </button>
              <button type="button" className="dsm-btn dsm-btn-outline" onClick={closeDialog}>{t('row.transferCancel')}</button>
            </div>
            <button type="button" className="dsm-trae-transfer-link" onClick={() => setSelected(new Set(accounts.map(account => account.id)))}>
              {t('row.transferSelectAll')}
            </button>
          </div>
        : null}
      {dialog === 'import'
        ? <div className="dsm-trae-transfer-dialog" role="dialog" aria-label={t('row.transferImport')}>
            {preview === undefined
              ? <p>{t('row.transferReading')}</p>
              : <>
                  <p>{t('row.transferImportPick', { total: preview.total })}</p>
                  {/* The preview is deliberately desensitised: identifier-ish
                      display fields and whether a token is present. It is what
                      lets the user confirm they picked the right file without
                      the card ever holding a credential. */}
                  <ul className="dsm-trae-transfer-list">
                    {preview.accounts.map(entry => (
                      <li key={entry.index}>
                        <label>
                          <input
                            type="checkbox"
                            checked={importSelected.has(entry.index)}
                            disabled={!entry.hasToken}
                            onChange={event => {
                              const next = new Set(importSelected)
                              if (event.target.checked) next.add(entry.index)
                              else next.delete(entry.index)
                              setImportSelected(next)
                            }}
                          />
                          <span>
                            {entry.nickname || entry.uid || t('row.transferUnnamed')}
                            {entry.email === '' ? null : <span className="dsm-trae-hint"> · {entry.email}</span>}
                            {entry.hasToken ? null : <span className="dsm-trae-hint"> · {t('row.transferNoToken')}</span>}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <div className="dsm-trae-transfer-dialog-actions">
                    <button type="button" className="dsm-btn" disabled={importSelected.size === 0} onClick={() => { void runImport() }}>
                      {t('row.transferImportConfirm', { count: importSelected.size })}
                    </button>
                    <button type="button" className="dsm-btn dsm-btn-outline" onClick={closeDialog}>{t('row.transferCancel')}</button>
                  </div>
                </>}
          </div>
        : null}
    </section>
  )
}
