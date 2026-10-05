/**
 * tavern-cards-forge CLI bridge: shared runner, model-facing `tavern_forge`
 * tool, and `tavern-cards/packed` emission after a successful pack.
 *
 * One model tool (no `tavern_pack` tool);
 * human slash `/tavern-forge` / `/tavern-pack` stay in `src/index.ts` and call
 * the same helpers.
 *
 * @module @ai4rpg/dsh-tavern-stages/forge
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tavernPrompts } from './prompts.ts'

/** Model-facing forge tool name. Pack is `command: 'pack'`, not a second tool. */
export const TAVERN_FORGE = 'tavern_forge'

/** Emitted after a successful pack (tool or slash); the pack ledger listens. */
export const TAVERN_CARDS_PACKED = 'tavern-cards/packed'

/** Payload for {@link TAVERN_CARDS_PACKED}. */
export interface TavernCardsPackedPayload {
  /** Project name passed to `pack`. */
  readonly project: string
  /** Session cwd when pack ran, if known. */
  readonly cwd: string | undefined
  /** Epoch ms when pack succeeded. */
  readonly at: number
  /** Whether pack came from the model tool or a human slash command. */
  readonly via: 'tool' | 'command'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'tavern-cards/packed'(payload: TavernCardsPackedPayload): void
  }
}

function resolveForgeCli(): string {
  // Explicit override wins (tests inject a fake CLI; local checkouts may
  // point at an unbuilt workspace forge).
  const configured = process.env.TAVERN_CARDS_FORGE_CLI
  if (configured !== undefined && configured !== '') return configured

  try {
    const require = createRequire(import.meta.url)
    const packagePath = require.resolve('@ai4rpg/tavern-cards-forge/package.json')
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      bin?: string | Record<string, string>
    }
    const bin = typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.['tavern-cards-forge']
    if (bin !== undefined) return join(dirname(packagePath), bin)
    throw new Error('tavern-cards-forge package has no tavern-cards-forge bin entry')
  } catch {
    throw new Error(
      '@ai4rpg/tavern-cards-forge is not installed; install it as a dependency '
      + 'or set TAVERN_CARDS_FORGE_CLI to the forge CLI entry file',
    )
  }
}

/** Cap on accumulated child stdout/stderr, so a runaway forge process cannot
 * consume unbounded memory before the abort signal lands. */
const MAX_FORGE_OUTPUT = 1024 * 1024

/** Run `tavern-cards-forge` with the given argv (subcommand first). */
export function runForge(
  args: readonly string[],
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolveForgeCli(), ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    // Accumulate up to MAX_FORGE_OUTPUT bytes; further chunks are dropped and
    // a marker notes the truncation.
    const sink = (state: { text: string; truncated: boolean }) => (chunk: Buffer): void => {
      if (state.text.length >= MAX_FORGE_OUTPUT) {
        state.truncated = true
        return
      }
      const text = chunk.toString()
      const remaining = MAX_FORGE_OUTPUT - state.text.length
      if (text.length > remaining) {
        state.text += text.slice(0, remaining)
        state.truncated = true
      } else {
        state.text += text
      }
    }
    const stdoutState = { text: '', truncated: false }
    const stderrState = { text: '', truncated: false }
    child.stdout.on('data', sink(stdoutState))
    child.stderr.on('data', sink(stderrState))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdoutState.truncated
          ? `${stdoutState.text}\n[output truncated at ${MAX_FORGE_OUTPUT} bytes]`
          : stdoutState.text)
      } else {
        const message = stderrState.truncated
          ? `${stderrState.text}\n[stderr truncated at ${MAX_FORGE_OUTPUT} bytes]`
          : stderrState.text
        reject(new Error(message.trim() || `tavern-cards-forge exited with code ${code ?? 'unknown'}`))
      }
    })
  })
}

/**
 * First non-flag token after `pack` (or the sole project arg for `/tavern-pack`).
 * Flags like `--output` are skipped so `pack Demo --output x` still yields `Demo`.
 */
export function packProjectFromArgs(args: readonly string[]): string | undefined {
  // `pack <project> [flags…]` is the common shape; also accept
  // `pack --flag value <project>` by skipping valued flags.
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--') {
      return args[i + 1]
    }
    if (arg.startsWith('-')) {
      // Short/long flags with an inline value (`--out=x`, `-o=x`) take no extra token.
      if (arg.includes('=')) continue
      // Bare flag: skip the following token when it is a value (not another flag).
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) i += 1
      continue
    }
    return arg
  }
  return undefined
}

/** Emit {@link TAVERN_CARDS_PACKED} when a pack argv succeeded. */
export function emitPacked(
  ctx: Context,
  forgeArgs: readonly string[],
  cwd: string | undefined,
  via: TavernCardsPackedPayload['via'],
): void {
  const [command, ...rest] = forgeArgs
  if (command !== 'pack') return
  const project = packProjectFromArgs(rest)
  if (project === undefined || project === '') return
  ctx.emit(TAVERN_CARDS_PACKED, { project, cwd, at: Date.now(), via })
}

function sessionCwd(agent: Agent | undefined): string | undefined {
  return agent?.session.header.cwd
}

/** Register the model-facing `tavern_forge` tool when `tools` is composed. */
export function applyForgeTool(ctx: Context): void {
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(defineTool({
      name: TAVERN_FORGE,
      description: tavernPrompts.forgeTool.description,
      parameters: {
        command: {
          type: 'string',
          required: true,
          description: tavernPrompts.forgeTool.command,
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: tavernPrompts.forgeTool.args,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stdout: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.stdout }],
      },
      execute: async (args, exec) => {
        const command = args.command.trim()
        if (command === '') {
          throw new Error(`${TAVERN_FORGE} requires a non-empty command`)
        }
        const forgeArgs = [command, ...(args.args ?? [])]
        const cwd = sessionCwd(exec.agent)
        const stdout = await runForge(forgeArgs, cwd, exec.signal)
        emitPacked(toolCtx, forgeArgs, cwd, 'tool')
        return { stdout: stdout.trim() || 'tavern-cards-forge completed.' }
      },
    }))
  })
}
