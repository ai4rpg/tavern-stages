// A minimal mock LLM adapter for keyless subagent tests.
//
// Upstream tests import `MockAdapter` from
// `packages/core/agent-loop/tests/mock-adapter.ts`, but that file is not part
// of any package's `exports` and is only reachable via workspace-relative
// paths. This local copy keeps tavern-stages self-contained. It implements
// only the scripted-response subset the subagent tests need; if a future test
// needs `toolCallResponse` or `hang` semantics, copy them from the upstream
// file at that point.
//
// Keep this in sync with `packages/core/agent-loop/tests/mock-adapter.ts`
// in deepseek-harness when the GenerateOptions / StreamChunk shapes change.

import type { GenerateOptions, LlmModelReasoningInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function toolCallResponse(rawCallId: string, name: string, args: object, text?: string): StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  const chunks: StreamChunk[] = []
  let index = 0
  if (text) {
    chunks.push(
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text },
      { type: 'block-end', index, block: { type: 'text', text } },
    )
    index += 1
  }
  chunks.push(
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index, id: callId, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

export class MockAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(
    private script: (StreamChunk[] | ((options: GenerateOptions) => StreamChunk[]))[],
    private readonly reasoning?: LlmModelReasoningInfo,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('MockAdapter: script exhausted')
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/** A reasoning-info that declares support for the given effort ids. */
export function reasoningSupport(...efforts: string[]): LlmModelReasoningInfo {
  return {
    efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
  }
}
