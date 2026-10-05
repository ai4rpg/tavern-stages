/**
 * Behavior focus: infer the session's focus project from recent `fs/observed`
 * events on `cards/{Project}/…` paths.
 *
 * Replaces the old workspace-level OR: completion eligibility is evaluated for
 * the *focused* project only, so working on A never renders completion pressure
 * caused by B's files.
 *
 * @module @ai4rpg/dsh-tavern-stages/focus
 */

/** One recorded observation of a project-owned path. */
export interface FocusEvent {
  /** Project name segment of the observed `cards/{project}/…` path. */
  readonly project: string
  /** Observed path as given (used only for diagnostics). */
  readonly path: string
  /** Write observations outweigh reads (2:5): reference reads of another
   * project must not steal focus from the project being written. */
  readonly weight: number
  /** Epoch ms of the observation. */
  readonly at: number
}

/** Weight of a read-kind observation (read/view/read_image, unknown tools). */
export const FOCUS_READ_WEIGHT = 2

/** Weight of a write-kind observation (write/edit/str_replace_editor edits). */
export const FOCUS_WRITE_WEIGHT = 5

/**
 * Split a path on either `/` or `\` (any run of them collapses), so a Windows
 * `C:\\Users\\…\\cards\\项目\\…` path segments the same as a POSIX
 * `/Users/…/cards/项目/…` path or a mixed `C:/Users/…/cards/项目/…` path.
 * `displayPath` is backend-decided and carries the backend's native separator,
 * which on a Windows `fs-local` deployment is `\` — `node:path`'s
 * platform-bound `sep` cannot be trusted to match it, so this splits on both.
 */
function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter(segment => segment !== '')
}

/**
 * Extract the project name from a `cards/{Project}/…` display path
 * (absolute, workspace-relative, `/`-joined, or `\`-joined). Returns
 * undefined for paths outside any project directory.
 */
export function projectFromPath(path: string): string | undefined {
  const segments = splitPath(path)
  const i = segments.indexOf('cards')
  return i < 0 || i + 1 >= segments.length ? undefined : segments[i + 1]
}

/**
 * Duck-typed write/read classification of the observing tool. `fs/observed`
 * does not carry the distinction, but the actor is the tool execution, whose
 * `name` (and the editor's `arguments.command`) does: write/edit and
 * non-view editor commands are writes; everything else counts as a read.
 * Unknown actors default to the read weight so they never outvote writes.
 */
export function focusWeightFromActor(actor: object | undefined): number {
  if (actor === undefined) return FOCUS_READ_WEIGHT
  const name = (actor as { name?: unknown }).name
  const args = (actor as { arguments?: { command?: unknown } }).arguments
  if (name === 'write' || name === 'edit') return FOCUS_WRITE_WEIGHT
  if (name === 'str_replace_editor' && args?.command !== 'view') return FOCUS_WRITE_WEIGHT
  return FOCUS_READ_WEIGHT
}

/**
 * Last-N ring buffer of project-owned path observations, keyed by session cwd.
 * The focus project is the highest total weight in the buffer; weight ties
 * resolve to the most recent entry.
 */
export class BehaviorFocus {
  private readonly n: number
  private readonly byCwd = new Map<string, FocusEvent[]>()

  constructor(n = 5) {
    this.n = n
  }

  /** Record an observation for a session cwd (synchronous; no I/O). */
  record(cwd: string, project: string, path: string, weight = FOCUS_READ_WEIGHT, at = Date.now()): void {
    const buffer = this.byCwd.get(cwd) ?? []
    buffer.push({ project, path, weight, at })
    while (buffer.length > this.n) buffer.shift()
    this.byCwd.set(cwd, buffer)
  }

  /**
   * Focus project for a cwd, restricted to `allowed` registered project names
   * when given (unregistered observations do not pollute the focus).
   * Undefined when no qualifying observation exists.
   */
  focusProject(cwd: string, allowed?: readonly string[]): string | undefined {
    const buffer = this.byCwd.get(cwd)
    if (buffer === undefined || buffer.length === 0) return undefined
    const totals = new Map<string, { weight: number; lastIndex: number }>()
    buffer.forEach((event, index) => {
      if (allowed !== undefined && !allowed.includes(event.project)) return
      const entry = totals.get(event.project)
      if (entry === undefined) totals.set(event.project, { weight: event.weight, lastIndex: index })
      else {
        entry.weight += event.weight
        entry.lastIndex = index
      }
    })
    let best: { project: string; weight: number; lastIndex: number } | undefined
    for (const [project, entry] of totals) {
      if (best === undefined
        || entry.weight > best.weight
        || (entry.weight === best.weight && entry.lastIndex > best.lastIndex)) {
        best = { project, ...entry }
      }
    }
    return best?.project
  }

  /** Forget recorded observations for one session cwd. */
  clear(cwd: string): void {
    this.byCwd.delete(cwd)
  }

  /** Dispose all state. */
  dispose(): void {
    this.byCwd.clear()
  }
}

/**
 * Duck-typed cwd extraction from the opaque `fs/observed` actor: tool
 * executions carry `agent.session.header.cwd` when dispatched from the agent
 * loop. Returns undefined when the actor has no attributable session.
 */
export function cwdFromActor(actor: object | undefined): string | undefined {
  const agent = (actor as { agent?: { session?: { header?: { cwd?: string } } } } | undefined)?.agent
  return agent?.session?.header?.cwd
}
