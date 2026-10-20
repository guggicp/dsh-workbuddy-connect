import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { APP_NAMES, type TraeEdition } from './paths.ts'

const run = promisify(execFile)

/** Which editions' Electron apps are currently running, best effort. */
export type RunningProbe = () => Promise<ReadonlySet<TraeEdition>>

/**
 * Why this exists at all: Trae keeps `storage.json` in memory and flushes it over
 * the file. Rewriting that file while the app runs is silently undone on its next
 * write — the account reappears and the user is told the deletion failed twice
 * for two different reasons. So the delete refuses while the matching app is up
 * and says which app to quit.
 *
 * This is a helper, never a gate on correctness: if the probe itself fails
 * (`ps` missing, sandbox denial) the answer is "nothing is running", and the
 * write proceeds. A false negative costs a retry; a false positive would block a
 * deletion that would have worked.
 */
export const probeRunningTraeApps: RunningProbe = async () => {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run('ps', ['-Ao', 'command'], { maxBuffer: 16 * 1024 * 1024 })
      return traeEditionsInCommands(stdout, 'Application Support')
    }
    if (process.platform === 'linux') {
      const { stdout } = await run('ps', ['-Ao', 'args'], { maxBuffer: 16 * 1024 * 1024 })
      return traeEditionsInCommands(stdout, '.config')
    }
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH'], { maxBuffer: 16 * 1024 * 1024 })
      // Windows reports a single `Trae.exe` family whose per-edition names are
      // unverified, so any Trae process blocks every edition rather than risking
      // a rewrite that the still-running app would revert.
      return /trae/i.test(stdout) ? new Set<TraeEdition>(['cn', 'sg', 'solo', 'solo-sg']) : new Set<TraeEdition>()
    }
  } catch {
    // A probe that cannot run must not block a deletion it cannot reason about.
  }
  return new Set<TraeEdition>()
}

/**
 * Editions whose app-support directory appears in a process listing.
 *
 * The names are prefixes of each other (`Trae` vs `Trae CN`), so the match is
 * made longest-first at each occurrence and consumes the name it claimed. A
 * plain `includes('Trae')` would report the international app running whenever
 * only `Trae CN` was, and the delete would then refuse for the wrong edition.
 */
export function traeEditionsInCommands(commands: string, supportDir: string): Set<TraeEdition> {
  const running = new Set<TraeEdition>()
  const editions = (['cn', 'sg', 'solo', 'solo-sg'] as const)
    .map(edition => ({ edition, name: APP_NAMES[edition] }))
    .sort((a, b) => b.name.length - a.name.length)
  const marker = `${supportDir}/`
  let cursor = commands.indexOf(marker)
  while (cursor !== -1) {
    let consumed = 0
    for (const { edition, name } of editions) {
      if (!commands.startsWith(name, cursor + marker.length)) continue
      running.add(edition)
      consumed = name.length
      break
    }
    cursor = commands.indexOf(marker, cursor + marker.length + consumed)
  }
  return running
}
