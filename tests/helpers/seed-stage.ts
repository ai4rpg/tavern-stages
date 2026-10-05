import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

/** Seed the stage-switch fold the same way production writes it: a stage-switch
 * notice. The source kind is the one stage-switch 0.2.0 declares through its
 * `MessageSourceMap` augmentation (`stage-switch` / legacy `plugin:stage-switch`)
 * — the pre-0.2.0 `{ kind: 'plugin', plugin: 'stage-switch' }` shape is neither
 * a valid type nor accepted by the persistence path. */
export function seedStage(session: Session, stage: string): void {
  const summary = `Current stage: ${stage}`
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: summary }],
    source: { kind: 'stage-switch', form: 'notice', summary },
  }), { surfaceOp: 'append' })
}
