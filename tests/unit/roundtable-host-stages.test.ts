import { describe, expect, it } from 'vitest'
import { RoundtableRuntime } from '../../src/main/roundtable/runtime'
import { defaultRoundtableWorkflow } from '../../src/shared/roundtable/workflow-template'
import { harvestQuestionTexts, harvestAnsweredTexts } from '../../src/shared/roundtable/host-synthesis'
import type { FixtureAgent, RoundtableEventEnvelope } from '../../src/shared/roundtable/events'

function agents(seen: Array<{ agentId: string; stageId: string; hostMode?: string }>): Record<string, FixtureAgent> {
  const make = (id: string): FixtureAgent => ({
    run: async (input) => {
      seen.push({ agentId: id, stageId: input.stageId, hostMode: input.hostMode })
      return `${id} done`
    },
  })
  return { janusx: make('janusx'), 'refiner-1': make('refiner-1'), 'challenger-1': make('challenger-1') }
}

describe('default workflow host stages (§37.1)', () => {
  it('declares intake/refiner/merge/challenger/synthesis order', () => {
    expect(defaultRoundtableWorkflow.stages.map((stage) => stage.id)).toEqual([
      'host-intake', 'refiners', 'host-merge-1', 'challengers', 'host-synthesis',
    ])
  })

  it('runs host → refiner → host → challenger → host with stage-scoped modes', async () => {
    const seen: Array<{ agentId: string; stageId: string; hostMode?: string }> = []
    const runtime = new RoundtableRuntime(agents(seen), defaultRoundtableWorkflow)
    const state = await runtime.start('Design the cache layer')

    expect(seen).toEqual([
      { agentId: 'janusx', stageId: 'host-intake', hostMode: 'intake' },
      { agentId: 'refiner-1', stageId: 'refiners', hostMode: undefined },
      { agentId: 'janusx', stageId: 'host-merge-1', hostMode: 'merge' },
      { agentId: 'challenger-1', stageId: 'challengers', hostMode: undefined },
      { agentId: 'janusx', stageId: 'host-synthesis', hostMode: 'synthesis' },
    ])
    // Intermediate host cards share one id and collapse: the round still ends
    // with exactly three result cards.
    expect(state.cards.map((card) => card.agentId).sort()).toEqual(['challenger-1', 'janusx', 'refiner-1'])
    expect(state.phase).toBe('awaiting-user')
  })

  it('records the user demand as a requirement fact on intake', async () => {
    const runtime = new RoundtableRuntime(agents([]), defaultRoundtableWorkflow)
    const state = await runtime.start('Design the cache layer')
    const req = state.facts.find((fact) => fact.kind === 'requirement')
    expect(req).toMatchObject({ status: 'proposal', title: '用户需求', content: 'Design the cache layer' })
    expect(req?.sourceEventIds.length).toBeGreaterThan(0)
  })

  it('skips intake silently on empty advances; non-empty advances add a new requirement', async () => {
    const runtime = new RoundtableRuntime(agents([]), defaultRoundtableWorkflow)
    const events: RoundtableEventEnvelope[] = []
    runtime.onEvent((event) => events.push(event))
    await runtime.start('Initial topic')
    const reqCount = runtime.getState().facts.filter((fact) => fact.kind === 'requirement').length

    await runtime.advance()
    const round2 = events.filter((event) => 'roundId' in event && event.roundId.endsWith('-round-2'))
    // No intake activity at all in the empty round: pool untouched, no phantom host.
    expect(round2.some((event) => event.type === 'host:pool-update')).toBe(false)
    expect(round2.filter((event) => event.type === 'agent:working' && event.agentId === 'janusx')).toHaveLength(2)
    expect(runtime.getState().facts.filter((fact) => fact.kind === 'requirement')).toHaveLength(reqCount)

    await runtime.advance('Add a latency constraint')
    const reqs = runtime.getState().facts.filter((fact) => fact.kind === 'requirement')
    expect(reqs).toHaveLength(reqCount + 1)
    expect(reqs[reqs.length - 1]?.content).toBe('Add a latency constraint')
  })
})

describe('harvestQuestionTexts (§37.6 deterministic bridge)', () => {
  it('collects Questions-section bullets and question-mark lines', () => {
    const texts = harvestQuestionTexts([{
      summary: 'Plan: layered cache.\nQuestions:\n- 500 or 5000 entries?\n- sync or async refresh\n\nUnrelated prose without marks.',
      sections: [{ id: 's', title: 'S', markdown: '过期会话如何处理？' }],
    }])
    expect(texts).toEqual(['500 or 5000 entries?', 'sync or async refresh', '过期会话如何处理？'])
  })

  it('resets the section on blank lines and dedupes', () => {
    const texts = harvestQuestionTexts([{
      summary: 'Questions:\n- Same thing?\n\nSame thing?\nNot a question',
      sections: [],
    }])
    // The second occurrence sits outside the section and lacks a mark.
    expect(texts).toEqual(['Same thing?'])
  })

  it('caps output at the limit', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `Point number ${i} here?`).join('\n')
    expect(harvestQuestionTexts([{ summary: lines, sections: [] }], 10)).toHaveLength(10)
  })
})

describe('merge/synthesis question harvest (§37.6 end to end)', () => {
  const qAgents: Record<string, FixtureAgent> = {
    janusx: { run: async () => 'host note' },
    'refiner-1': { run: async () => 'Plan: layered cache.\nQuestions:\n- 500 or 5000 entries?' },
    'challenger-1': { run: async () => 'Risk: burst load. How to bound memory?' },
  }

  it('lands refiner and challenger questions in the pool as pending-validation', async () => {
    const runtime = new RoundtableRuntime(qAgents, defaultRoundtableWorkflow)
    const state = await runtime.start('Cache strategy')
    const questions = state.facts.filter((fact) => fact.kind === 'question')
    expect(questions.map((fact) => fact.content).sort()).toEqual(['500 or 5000 entries?', 'Risk: burst load. How to bound memory?'])
    expect(new Set(questions.map((fact) => fact.status))).toEqual(new Set(['pending-validation']))
    // And the host draft surfaces them for §37.8 display.
    expect(state.hostDrafts?.[0]?.questions).toHaveLength(2)
  })

  it('does not duplicate re-asked questions across rounds', async () => {
    const runtime = new RoundtableRuntime(qAgents, defaultRoundtableWorkflow)
    await runtime.start('Cache strategy')
    await runtime.advance('More detail')
    const questions = runtime.getState().facts.filter((fact) => fact.kind === 'question')
    expect(questions).toHaveLength(2)
  })
})

describe('harvestAnsweredTexts (P1a resolution)', () => {
  it('collects Answered-section lines only, never bare question marks', () => {
    const texts = harvestAnsweredTexts([{
      summary: 'Noted.\nAnswered:\n- 500 or 5000 entries?\n- Use async refresh\n\nStray ending line?',
      sections: [],
    }])
    expect(texts).toEqual(['500 or 5000 entries?', 'Use async refresh'])
  })
})

describe('answer resolution end to end (P1a)', () => {
  it('resolves exactly the quoted open question; hallucinations resolve nothing', async () => {
    const resolving: Record<string, FixtureAgent> = {
      janusx: {
        run: async (input) => input.roundNumber === 2
          ? 'Requirement updated.\nAnswered:\n- 500 or 5000 entries?\n- A question nobody asked'
          : 'host note',
      },
      'refiner-1': { run: async () => 'Plan: layered cache.\nQuestions:\n- 500 or 5000 entries?' },
      'challenger-1': { run: async () => 'Steady state review.' },
    }
    const runtime = new RoundtableRuntime(resolving, defaultRoundtableWorkflow)
    await runtime.start('Cache strategy')
    expect(runtime.getState().facts.find((fact) => fact.kind === 'question')?.status).toBe('pending-validation')

    await runtime.advance('Use 5000 entries')
    const questions = runtime.getState().facts.filter((fact) => fact.kind === 'question')
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({ content: '500 or 5000 entries?', status: 'resolved' })
    // And the draft no longer lists it as open.
    const draft = runtime.getState().hostDrafts?.[runtime.getState().hostDrafts.length - 1]
    expect(draft?.questions.filter((item) => item.status === 'open')).toHaveLength(0)
  })
})
