export { ClaudeParser } from './claude-parser'
export { CodexParser } from './codex-parser'
export { OpenCodeParser } from './opencode-parser'

import type { AgentEngine, StreamParser } from '../types'
import { ClaudeParser } from './claude-parser'
import { CodexParser } from './codex-parser'
import { OpenCodeParser } from './opencode-parser'

export function createParser(engine: AgentEngine): StreamParser {
  switch (engine) {
    case 'claude':
      return new ClaudeParser()
    case 'codex':
      return new CodexParser()
    case 'opencode':
      return new OpenCodeParser()
  }
}
