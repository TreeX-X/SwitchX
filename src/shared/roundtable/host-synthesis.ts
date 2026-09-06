import type { AgentResultCard, HostSynthesis, HostSynthesisConflict, RoundtableFact, RoundtableQuestion, RoundtableState } from './events'

const NO_CONCLUSION = '主持人尚未形成最终结论。'

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'are', 'was', 'were',
  'will', 'would', 'should', 'could', 'into', 'about', 'their', 'there', 'which', 'when',
  'what', 'how', 'why', 'not', 'but', 'our', 'your', 'they', 'them', 'then', 'than', 'also',
  'such', 'only', 'over', 'under', 'more', 'most', 'some', 'any', 'each', 'other', 'new',
  'use', 'used', 'using', 'via', 'per', 'etc', 'without', 'between', 'through',
])

function extractKeywords(text: string): Set<string> {
  const keys = new Set<string>()
  for (const word of text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)) {
    if (/^[\u4e00-\u9fff]+$/.test(word)) {
      // CJK has no word boundaries: fall back to character bigrams.
      const chars = [...word]
      if (chars.length < 2) continue
      for (let i = 0; i < chars.length - 1; i += 1) {
        const pair = `${chars[i] ?? ''}${chars[i + 1] ?? ''}`
        if (pair.length === 2) keys.add(pair)
      }
    } else {
      if (word.length < 3 || STOPWORDS.has(word)) continue
      keys.add(word)
    }
  }
  return keys
}

function keywordOverlap(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const key of left) if (right.has(key)) count += 1
  return count
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function dedup(items: string[], limit: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const key = normalize(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(item.trim())
    if (result.length >= limit) break
  }
  return result
}

function firstSentence(text: string, limit = 200): string {
  const sentence = text.split(/[。\n.!?！？]/).map((part) => part.trim()).find(Boolean) ?? ''
  return sentence ? sentence.slice(0, limit) : ''
}

function isConcern(fact: RoundtableFact): boolean {
  return fact.status === 'concern' || fact.kind === 'risk' || fact.kind === 'question'
}

function isProposal(fact: RoundtableFact): boolean {
  return fact.status === 'proposal' || fact.status === 'pending-validation' || fact.status === 'confirmed'
}

/**
 * Keywords come from the fact body; titles are card metadata
 * ("refiner result") and would otherwise pair every card with every other.
 * Falls back to the title only when the body carries no keywords.
 */
function factKeywords(fact: RoundtableFact): Set<string> {
  const body = extractKeywords(fact.content)
  return body.size ? body : extractKeywords(fact.title)
}

function mergeConflicts(facts: RoundtableFact[], roundNumber: number, limit = 5): HostSynthesisConflict[] {
  const concerns = facts.filter((fact) => fact.status !== 'rejected' && fact.status !== 'resolved' && isConcern(fact))
  const proposals = facts.filter((fact) => fact.status !== 'rejected' && fact.status !== 'resolved' && !isConcern(fact) && isProposal(fact))
  const candidates: Array<{ overlap: number; conflict: HostSynthesisConflict }> = []
  concerns.forEach((concern, concernIndex) => {
    const concernKeys = factKeywords(concern)
    if (!concernKeys.size) return
    proposals.forEach((proposal) => {
      if (proposal.id === concern.id) return
      const overlap = keywordOverlap(concernKeys, factKeywords(proposal))
      if (overlap < 2) return
      candidates.push({
        overlap,
        conflict: {
          id: `conflict-${roundNumber}-${concernIndex}-${proposal.id}`,
          topic: concern.title || concern.content.slice(0, 40),
          factIds: [concern.id, proposal.id],
          status: 'open',
          sourceEventIds: [...new Set([...concern.sourceEventIds, ...proposal.sourceEventIds])],
        },
      })
    })
  })
  candidates.sort((left, right) => right.overlap - left.overlap)
  return candidates.slice(0, limit).map((item) => item.conflict)
}

/**
 * §37.6 deterministic question harvest (P0-3 bridge): extract member
 * questions from agent prose without a model call. Two shapes, both capped:
 * lines under a trailing `Questions:`/`问题` section, and lines ending with
 * `?`/`？`. Structured agent output (poolRefs/questions fields) replaces this
 * once agents emit it; until then prose questions still reach the pool.
 */
export function harvestQuestionTexts(
  cards: Pick<AgentResultCard, 'summary' | 'sections'>[],
  limit = 10,
): string[] {
  return scanSectionLines(cards, {
    header: /^(questions|待确认|提问|问题)\s*[:：]/i,
    hint: /提问|问题|确认|question/i,
    accept: (line, inSection) => inSection || /[?？]$/.test(line),
    limit,
  })
}

/**
 * P1a answer resolution: extract the intake host's `Answered:` section —
 * quoted question texts the user supplement settled. Callers must match each
 * line against open pool questions (normalized); unmatched lines are ignored
 * so model hallucinations can never resolve real questions.
 */
export function harvestAnsweredTexts(
  cards: Pick<AgentResultCard, 'summary' | 'sections'>[],
  limit = 10,
): string[] {
  return scanSectionLines(cards, {
    header: /^(answered|已回答|已确认|resolved)\s*[:：]/i,
    hint: /回答|确认|answered|resolved/i,
    accept: (line, inSection) => inSection,
    limit,
  })
}

function scanSectionLines(
  cards: Pick<AgentResultCard, 'summary' | 'sections'>[],
  opts: { header: RegExp; hint: RegExp; accept: (line: string, inSection: boolean) => boolean; limit: number },
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  const push = (raw: string): void => {
    // Strip one leading list marker only ("- ", "1. "); a greedy class would
    // eat meaningful leading digits ("500 or 5000?").
    const text = raw.replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim()
    if (text.length < 4 || text.length > 300) return
    const key = normalize(text)
    if (!key || seen.has(key)) return
    seen.add(key)
    result.push(text)
  }
  for (const card of cards) {
    // Scan each text block separately with a fresh section flag: runtime cards
    // duplicate the summary into sections[0].markdown, and a Questions header
    // in the first copy must not capture the second copy's preamble.
    const blocks = [card.summary, ...(card.sections ?? []).map((section) => section.markdown)]
    for (const block of blocks) {
      const lines = block.split('\n').map((line) => line.trim())
      // Reset per card: summary and sections often repeat the same text, and a
      // section header must not leak from one card into the next.
      let inQuestions = false
      for (const line of lines) {
        if (!line) {
          inQuestions = false
          continue
        }
        if (opts.header.test(line)) {
          const rest = line.replace(opts.header, '').trim()
          inQuestions = true
          if (rest) push(rest)
          continue
        }
        if (/^#{1,4}\s/.test(line)) {
          inQuestions = opts.hint.test(line)
          continue
        }
        if (opts.accept(line, inQuestions)) push(line)
        if (result.length >= opts.limit) return result
      }
    }
  }
  return result
}

/**
 * §37.6/§37.8: collect member questions from question-kind facts.
 * Resolved/rejected entries leave the open list; answered ones are still
 * reported so the next round can show what was settled. Attribution is
 * best-effort: facts predate per-agent origin, so unattributed questions
 * render under a generic member label.
 */
function collectQuestions(facts: RoundtableFact[], roundNumber: number, limit = 20): RoundtableQuestion[] {
  const seen = new Set<string>()
  const result: RoundtableQuestion[] = []
  for (const fact of facts) {
    if (fact.kind !== 'question' || fact.status === 'rejected') continue
    const key = normalize(fact.content)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push({
      id: `q-${fact.id}`,
      text: fact.content.trim(),
      fromAgentId: '',
      roundNumber,
      status: fact.status === 'resolved' ? 'answered' : 'open',
      factId: fact.id,
      sourceEventIds: [...fact.sourceEventIds],
    })
    if (result.length >= limit) break
  }
  return result
}

/**
 * Deterministic host synthesis:归纳 shared facts into an independent
 * human-facing draft. Pure function, no model calls, fully testable.
 * Missing sources never block synthesis; facts without sourceEventIds are
 * still included and simply contribute no source links.
 */
export function synthesizeHostDraft(state: RoundtableState, options: { final?: boolean } = {}): HostSynthesis {
  const facts = state.facts.filter((fact) => fact.status !== 'rejected')
  const hostCards = state.cards.filter((card) => card.role === 'host')
  const latestHostSummary = hostCards.length ? (hostCards[hostCards.length - 1]?.summary ?? '') : ''
  const confirmedDecisions = facts.filter((fact) => fact.kind === 'decision' && fact.status === 'confirmed')
  const decisions = dedup(confirmedDecisions.map((fact) => fact.content), 5)
  const conclusion = firstSentence(latestHostSummary) || decisions[0] || NO_CONCLUSION
  const evidence = dedup(facts.filter((fact) => fact.kind === 'evidence').map((fact) => fact.content), 5)
  const pending = dedup(facts.filter((fact) => fact.status === 'proposal' || fact.status === 'pending-validation').map((fact) => fact.content), 5)
  const risks = dedup(facts.filter((fact) => fact.kind === 'risk' || fact.kind === 'question').map((fact) => fact.content), 5)
  const actions = dedup(facts.filter((fact) => fact.kind === 'action').map((fact) => fact.content), 5)
  const conflicts = mergeConflicts(facts, state.roundNumber)
  const questions = collectQuestions(facts, state.roundNumber)
  const sourceEventIds = [...new Set([
    ...facts.flatMap((fact) => fact.sourceEventIds),
    ...state.cards.flatMap((card) => card.sourceEventIds),
  ])]
  return {
    roundNumber: state.roundNumber,
    final: options.final ?? false,
    conclusion, decisions, evidence, pending, conflicts, risks, actions,
    questions,
    sourceEventIds,
    createdAt: new Date().toISOString(),
  }
}
