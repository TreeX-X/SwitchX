import type { AgentEvent, StreamParser } from '../types'

export class CodexParser implements StreamParser {
  private startedItems = new Set<string>()

  parseLine(json: Record<string, unknown>): AgentEvent[] {
    const events: AgentEvent[] = []
    const type = json.type as string

    switch (type) {
      case 'agent_message': {
        const text = json.text as string | undefined
        if (text) events.push({ type: 'text-chunk', text })
        break
      }
      case 'item.started': {
        const item = json.item as Record<string, unknown> | undefined
        if (item) {
          const id = (item.id as string) ?? String(Date.now())
          const name = (item.type as string) ?? 'unknown'
          this.startedItems.add(id)
          events.push({
            type: 'tool-start',
            id,
            name,
            arg: String(item.command ?? item.path ?? item.query ?? ''),
          })
        }
        break
      }
      case 'item.completed': {
        const item = json.item as Record<string, unknown> | undefined
        if (item) {
          events.push({ type: 'tool-end', id: (item.id as string) ?? '' })
        }
        break
      }
      case 'error': {
        events.push({ type: 'error', message: String(json.message ?? json.error ?? '') })
        break
      }
      case 'thread.completed': {
        events.push({ type: 'done', exitCode: 0 })
        break
      }
    }
    return events
  }

  reset(): void {
    this.startedItems.clear()
  }
}
