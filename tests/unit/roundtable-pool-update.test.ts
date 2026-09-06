import { describe, expect, it } from 'vitest'
import { EMPTY_ROUNDTABLE_STATE, migrateRoundtableState, reduceRoundtableEvent } from '../../src/shared/roundtable/state'
import { synthesizeHostDraft } from '../../src/shared/roundtable/host-synthesis'
import type { RoundtableEventEnvelope, RoundtableFact, RoundtablePoolUpdateOp } from '../../src/shared/roundtable/events'

function fact(partial: Partial<RoundtableFact> & { id: string }): RoundtableFact {
  return {
    kind: 'evidence', status: 'proposal', title: partial.id, content: partial.id,
    sourceEventIds: [], updatedAt: '2026-01-01T00:00:00.000Z', ...partial,
  }
}

function poolUpdate(eventId: string, ops: RoundtablePoolUpdateOp[]): RoundtableEventEnvelope {
  return { type: 'host:pool-update', sessionId: 's', roundId: 'r', ops, eventId, occurredAt: '2026-01-01T00:00:00.000Z' }
}

describe('host:pool-update reducer (§37.3 host-only write)', () => {
  it('adds new facts and ignores duplicate adds by id', () => {
    const op = { opId: 'op-1', action: 'add' as const, fact: fact({ id: 'f1', kind: 'requirement', content: 'Need login' }) }
    const once = reduceRoundtableEvent(EMPTY_ROUNDTABLE_STATE, poolUpdate('e1', [op]))
    expect(once.facts).toHaveLength(1)
    const twice = reduceRoundtableEvent(once, poolUpdate('e2', [op]))
    expect(twice.facts).toHaveLength(1)
  })

  it('updates content by id and ignores updates for unknown ids', () => {
    const base = reduceRoundtableEvent(EMPTY_ROUNDTABLE_STATE, poolUpdate('e1', [
      { opId: 'op-1', action: 'add', fact: fact({ id: 'f1', kind: 'solution', content: 'v1' }) },
    ]))
    const updated = reduceRoundtableEvent(base, poolUpdate('e2', [
      { opId: 'op-2', action: 'update', fact: fact({ id: 'f1', kind: 'solution', content: 'v2' }) },
      { opId: 'op-3', action: 'update', fact: fact({ id: 'ghost', content: 'fabricated' }) },
    ]))
    expect(updated.facts).toHaveLength(1)
    expect(updated.facts[0]?.content).toBe('v2')
  })

  it('set-status transitions status and merges source event ids', () => {
    const base = reduceRoundtableEvent(EMPTY_ROUNDTABLE_STATE, poolUpdate('e1', [
      { opId: 'op-1', action: 'add', fact: fact({ id: 'q1', kind: 'question', status: 'pending-validation', content: 'Which limit?', sourceEventIds: ['ea'] }) },
    ]))
    const next = reduceRoundtableEvent(base, poolUpdate('e2', [
      { opId: 'op-2', action: 'set-status', fact: fact({ id: 'q1', status: 'resolved', content: 'ignored body', sourceEventIds: ['eb'] }) },
    ]))
    // Body stays intact on set-status; only status/sources change.
    expect(next.facts[0]).toMatchObject({ status: 'resolved', content: 'Which limit?' })
    expect(next.facts[0]?.sourceEventIds.sort()).toEqual(['ea', 'eb'])
  })

  it('re-delivery of the same envelope is a no-op (idempotent retry)', () => {
    const envelope = poolUpdate('e1', [{ opId: 'op-1', action: 'add', fact: fact({ id: 'f1' }) }])
    const once = reduceRoundtableEvent(EMPTY_ROUNDTABLE_STATE, envelope)
    const twice = reduceRoundtableEvent(once, envelope)
    expect(twice.facts).toHaveLength(1)
    expect(twice.version).toBe(once.version)
  })
})

describe('questions derivation (§37.6/§37.8)', () => {
  it('collects open questions, maps resolved to answered, skips rejected', () => {
    const state = {
      ...EMPTY_ROUNDTABLE_STATE,
      roundNumber: 1,
      facts: [
        fact({ id: 'q1', kind: 'question', status: 'pending-validation', content: '500 or 5000?', sourceEventIds: ['e1'] }),
        fact({ id: 'q2', kind: 'question', status: 'resolved', content: 'Settled topic' }),
        fact({ id: 'q3', kind: 'question', status: 'rejected', content: 'Dropped' }),
        fact({ id: 'p1', kind: 'evidence', status: 'proposal', content: 'Not a question' }),
      ],
    }
    const draft = synthesizeHostDraft(state)
    expect(draft.questions).toHaveLength(2)
    expect(draft.questions[0]).toMatchObject({ status: 'open', factId: 'q1', roundNumber: 1 })
    expect(draft.questions[1]).toMatchObject({ status: 'answered', factId: 'q2' })
  })

  it('dedupes identical question bodies', () => {
    const state = {
      ...EMPTY_ROUNDTABLE_STATE,
      roundNumber: 1,
      facts: [
        fact({ id: 'q1', kind: 'question', status: 'pending-validation', content: 'Same question?' }),
        fact({ id: 'q2', kind: 'question', status: 'pending-validation', content: 'Same question?' }),
      ],
    }
    expect(synthesizeHostDraft(state).questions).toHaveLength(1)
  })

  it('migrates old drafts without questions to an empty list', () => {
    const migrated = migrateRoundtableState({ hostDrafts: [{ roundNumber: 1, final: false }] })
    expect(migrated.hostDrafts?.[0]?.questions).toEqual([])
  })
})
