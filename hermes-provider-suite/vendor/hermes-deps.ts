import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

type AtomicOptions = { mode?: number; dirMode?: number }

/** Hermes-owned state root used by the vendored DSH protocol modules. */
export function resolveDshHome(): string {
  const explicit = process.env['HERMES_DSH_STATE_DIR']?.trim()
  if (explicit) return explicit
  const home = process.env['HERMES_HOME']?.trim()
  if (home) return `${home.replace(/\/$/u, '')}/data/dsh-model-providers`
  throw new Error('HERMES_HOME is not set')
}

/** Replace a file atomically in its own directory, with owner-only defaults. */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  options: AtomicOptions = {},
): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: options.dirMode ?? 0o700 })
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const handle = await open(temporary, 'wx', options.mode ?? 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await handle.close()
  await rename(temporary, target)
}

/** Serialize read-modify-write operations across bridge processes. */
export async function withFileLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  let lock
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      lock = await open(lockPath, 'wx', 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs > 120_000) {
          await rm(lockPath, { force: true })
          continue
        }
      } catch {
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  if (!lock) throw new Error(`timed out waiting for state lock: ${target}`)
  try {
    return await operation()
  } finally {
    await lock.close().catch(() => undefined)
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}
