/**
 * In-memory record of the last successful pack per workspace project
 * Fed by `tavern-cards/packed`
 * events (model tool or human slash); not persisted across sessions — a fresh
 * session re-opens the pack gate until the next pack or an existing artifact.
 *
 * @module @ai4rpg/dsh-tavern-stages/pack-ledger
 */

/**
 * `cwd\0project` → epoch ms of the last successful pack. Completing the
 * content/ui stages requires a pack at least as recent as the content.
 */
export class PackLedger {
  private readonly last = new Map<string, number>()

  /** Record a successful pack for a project in a session cwd. */
  mark(cwd: string, project: string, at = Date.now()): void {
    this.last.set(PackLedger.key(cwd, project), at)
  }

  /** Epoch ms of the last successful pack, if any. */
  lastPack(cwd: string, project: string): number | undefined {
    return this.last.get(PackLedger.key(cwd, project))
  }

  /** Forget pack records for one session cwd. */
  clear(cwd: string): void {
    const prefix = `${cwd}\0`
    for (const key of this.last.keys()) {
      if (key.startsWith(prefix)) this.last.delete(key)
    }
  }

  /** Dispose all records. */
  dispose(): void {
    this.last.clear()
  }

  private static key(cwd: string, project: string): string {
    return `${cwd}\0${project}`
  }
}
