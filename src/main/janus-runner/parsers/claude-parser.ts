import type { AgentEvent, StreamParser } from '../types'

function extractToolArg(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read': return String(input.file_path ?? '')
    case 'Bash': return String(input.command ?? '')
    case 'Edit': return String(input.file_path ?? '')
    case 'Write': return String(input.file_path ?? '')
    case 'Grep': return String(input.pattern ?? '')
    case 'Glob': return String(input.pattern ?? '')
    default: return JSON.stringify(input).slice(0, 120)
  }
}

export class ClaudeParser implements StreamParser {
  private lastId = ''
  private lastText = ''
  private startedTools = new Set<string>()

  parseLine(json: Record<string, unknown>): AgentEvent[] {
    const events: AgentEvent[] = []
    const type = json.type as string

    switch (type) {
      case 'assistant': {
        const msg = json.message as Record<string, unknown> | undefined
        const msgId = msg?.id as string
        const content = (msg?.content ?? []) as Array<Record<string, unknown>>

        const fullText = content
          .filter((b) => b.type === 'text')
          .map((b) => b.text as string)
          .join('')

        if (msgId === this.lastId) {
          const delta = fullText.slice(this.lastText.length)
          if (delta) events.push({ type: 'text-delta', delta, fullText })
        } else {
          if (fullText) events.push({ type: 'text-chunk', text: fullText })
        }
        this.lastId = msgId
        this.lastText = fullText

        for (const item of content) {
          if (item.type === 'tool_use' && !this.startedTools.has(item.id as string)) {
            this.startedTools.add(item.id as string)
            events.push({
              type: 'tool-start',
              id: item.id as string,
              name: item.name as string,
              arg: extractToolArg(item.name as string, (item.input ?? {}) as Record<string, unknown>),
            })
          }
        }
        break
      }

      case 'user': {
        const msg = json.message as Record<string, unknown> | undefined
        const content = (msg?.content ?? []) as Array<Record<string, unknown>>
        for (const item of content) {
          if (item.type === 'tool_result' && this.startedTools.has(item.tool_use_id as string)) {
            events.push({ type: 'tool-end', id: item.tool_use_id as string })
          }
        }
        break
      }

      case 'result':
        events.push(json.is_error
          ? { type: 'error', message: String(json.result ?? '') }
          : { type: 'done', exitCode: 0 })
        break
    }
    return events
  }

  reset(): void {
    this.lastId = ''
    this.lastText = ''
    this.startedTools.clear()
  }
}
