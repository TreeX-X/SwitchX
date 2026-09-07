import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PolicyAuditQuery, PolicyDecisionRecord } from '../../../shared/ipc/agent-runtime'
import { knowledgeRootPath } from '../../knowledge/constants'

export interface PolicyAuditStore {
  record(record: PolicyDecisionRecord): Promise<void>
  query(query?: PolicyAuditQuery): Promise<PolicyDecisionRecord[]>
}

function matches(record: PolicyDecisionRecord, query: PolicyAuditQuery): boolean {
  return (!query.workspaceId || record.workspaceId === query.workspaceId)
    && (!query.sessionId || record.sessionId === query.sessionId)
    && (!query.correlationId || record.correlationId === query.correlationId)
}

export class MemoryPolicyAuditStore implements PolicyAuditStore {
  private readonly records: PolicyDecisionRecord[] = []
  async record(record: PolicyDecisionRecord): Promise<void> { this.records.push(structuredClone(record)) }
  async query(query: PolicyAuditQuery = {}): Promise<PolicyDecisionRecord[]> {
    return this.records.filter((record) => matches(record, query)).map((record) => structuredClone(record))
  }
}

let writeQueue = Promise.resolve()

export class FilePolicyAuditStore implements PolicyAuditStore {
  private readonly path = join(knowledgeRootPath(), 'audit', 'workspace-policy.jsonl')
  async record(record: PolicyDecisionRecord): Promise<void> {
    const operation = writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8')
    })
    writeQueue = operation.catch(() => undefined)
    return operation
  }
  async query(query: PolicyAuditQuery = {}): Promise<PolicyDecisionRecord[]> {
    let content = ''
    try { content = await readFile(this.path, 'utf8') } catch { return [] }
    return content.split('\n').flatMap((line) => {
      if (!line.trim()) return []
      try {
        const record = JSON.parse(line) as PolicyDecisionRecord
        return matches(record, query) ? [record] : []
      } catch { return [] }
    })
  }
}
