import type { AgentEvent, StreamParser } from '../types'

const TOOL_NAME_MAP: Record<string, string> = {
  read: 'Read',
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  glob: 'Glob',
  list: 'List',
}

export class OpenCodeParser implements StreamParser {
  private lastText = ''
  private startedTools = new Set<string>()

  parseLine(json: Record<string, unknown>): AgentEvent[] {
    const events: AgentEvent[] = []
    const type = json.type as string

    switch (type) {
      case 'text': {
        const text = json.text as string | undefined
        if (text) {
          const delta = text.slice(this.lastText.length)
          if (delta) events.push({ type: 'text-delta', delta, fullText: text })
          this.lastText = text
        }
        break
      }
      case 'tool_use': {
        const toolId = (json.tool_id ?? json.id) as string
        const state = json.state as string | undefined
        const part = json as Record<string, unknown>
        const rawName = (part.tool ?? part.name) as string
        const name = TOOL_NAME_MAP[rawName] ?? rawName

        if (state === 'running' || state === 'started') {
          if (!this.startedTools.has(toolId)) {
            this.startedTools.add(toolId)
            const input = (part.state as Record<string, unknown>)?.input as
              | Record<string, unknown>
              | undefined
            events.push({
              type: 'tool-start',
              id: toolId,
              name,
              arg: String(input?.filePath ?? input?.command ?? ''),
              filePath: input?.filePath as string | undefined,
            })
          }
        } else if (state === 'completed') {
          if (this.startedTools.has(toolId)) {
            events.push({ type: 'tool-end', id: toolId })
          }
        }
        break
      }
      case 'error': {
        events.push({ type: 'error', message: String(json.message ?? '') })
        break
      }
      case 'done': {
        events.push({ type: 'done', exitCode: 0 })
        break
      }
    }
    return events
  }

  reset(): void {
    this.lastText = ''
    this.startedTools.clear()
  }
}
