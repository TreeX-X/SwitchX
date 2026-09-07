/**
 * @file Deterministic knowledge sedimentation (Phase 1-2, §4 of the plan).
 * @description LLM-free pipeline stage, always runs: normalize → exact +
 *              near-duplicate collapsing → derived index side-files → a small
 *              number of high-precision CandidateFacts → candidate-stage
 *              conflict marking. Consumed by the processing queue as its
 *              deterministic-stage handler (Phase 1-1 `configureDeterministicHandler`).
 *
 *              Deliberately free of LLM dependencies: producers that need the
 *              new Candidate fields write them here with derivation
 *              'deterministic'. Exact-dedupe keys (§3.1/§4.2) are shared with
 *              capture-time dedupe via `observation-service`; the §4.6
 *              auto-accept policy applies at the end of the stage when enabled.
 */

import { randomUUID } from 'crypto'
import { mkdir, readFile, appendFile } from 'fs/promises'
import { dirname, join } from 'path'
import type {
  CandidateFact,
  CandidateGraphEdge,
  FactKind,
  GraphEdge,
  KnowledgeProvenance,
  KnowledgeSource,
  MemoryFact,
  Observation,
} from '../../shared/knowledge'
import type { ReviewCandidateInput } from '../../shared/ipc/knowledge'
import type { DeterministicBatch } from './processing-queue'
import { CONTENT_PREVIEW_CHARS, knowledgeRootPath } from './constants'
import { writeFileAtomic } from '../lib/atomic-file'
import { knowledgeObservationService, observationDedupeKey } from './observation-service'
export { observationDedupeKey } from './observation-service'
import { knowledgeAuditService } from './audit-service'
import { knowledgeTruthService } from './truth-service'
import { knowledgeReviewService } from './review-service'
import { configService } from '../config/service'
import { redactHighConfidenceSecrets } from '../janus-agent/runtime/policy-gate'

const FACT_CANDIDATES_FILE = join('facts', 'candidates.jsonl')
const GRAPH_CANDIDATES_FILE = join('graph', 'candidates.jsonl')
const DERIVED_DIR = join('processing', 'derived')

const NORMALIZE_MAX_CHARS = 4000
const NEAR_DUPE_JACCARD = 0.85
const PROCEDURE_MIN_REPEATS = 3
const MAX_LIST_ITEMS = 20

const ANSI_CSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g
const FILE_TOKEN_RE = /(?:^|[\s"'`([{])([a-zA-Z]:[\\/][\w.~\-/\\]+|[\w.~\-/\\]*\/[\w.~\-/\\]+|[\w][\w.-]*\.[a-zA-Z0-9]{1,8})(?=[\s"'`)\]}:;,]|$)/g
const TIME_TAG_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b/g

const DECISION_RE = /决定|采用|弃用|决议|we decided|decided to|use [\w.~-]+ instead of/i
const PREFERENCE_RE = /我习惯|不要用|别用|always|never|prefer/i
const COMMAND_OR_ERROR_RE = /(^|\n)\s*[$#>]\s*\S|error|fail|exception|\bE[A-Z0-9-]{2,}\b|exit code \d+/i

export interface NormalizedText {
  text: string
  truncated: boolean
  redacted: boolean
}

export interface DerivedObservation {
  version: 1
  observationId: string
  workspaceId: string
  summary: string
  entities: string[]
  fileRefs: string[]
  timeTags: string[]
  truncated: boolean
  redacted: boolean
  derivedAt: string
  derivation: 'deterministic'
}

export interface DeterministicStageResult {
  derived: number
  proposals: number
  autoAccepted: number
}

export interface DeterministicStageDeps {
  resolveContent: (observation: Observation) => Promise<string>
  listTruthFacts: () => Promise<MemoryFact[]>
  /** Accepted graph edges, used to skip already-linked truth pairs. */
  listTruthEdges: () => Promise<GraphEdge[]>
  nowIso: () => string
  /** Phase 1 convergence (§4.6): reads the auto-accept switch; test-injectable. */
  getAutoAccept: () => Promise<boolean>
  /** Phase 1 convergence (§4.6): applies a matching candidate; test-injectable. */
  applyCandidate: (input: ReviewCandidateInput) => Promise<unknown>
}

function defaultDeps(): DeterministicStageDeps {
  return {
    resolveContent: (observation) => knowledgeObservationService.resolveContent(observation),
    listTruthFacts: async () => (await knowledgeTruthService.list()).facts,
    listTruthEdges: async () => (await knowledgeTruthService.list()).graphEdges,
    nowIso: () => new Date().toISOString(),
    getAutoAccept: async () => (await configService.getKnowledgeSettings()).autoAcceptDeterministicFacts,
    applyCandidate: (input) => knowledgeReviewService.applyCandidate(input),
  }
}

/** §4.1 normalize: blob already resolved by caller; strip ANSI/control chars, reuse secret redaction, truncate. */
export function normalizeObservationText(content: string): NormalizedText {
  const stripped = content
    .replace(ANSI_CSI_RE, '')
    .replace(CONTROL_CHARS_RE, '')
  const { text: redactedText, redacted } = redactHighConfidenceSecrets(stripped)
  const text = redactedText.trim()
  if (text.length <= NORMALIZE_MAX_CHARS) return { text, truncated: false, redacted }
  return { text: text.slice(0, NORMALIZE_MAX_CHARS), truncated: true, redacted }
}

export function tokenizeForSimilarity(text: string): string[] {
  const lower = text.toLowerCase()
  const ascii = lower.split(/[^a-z0-9_]+/).filter((token) => token.length >= 2)
  const cjk = lower.match(/[一-鿿]/g) ?? []
  const bigrams = cjk.slice(0, -1).map((char, index) => char + cjk[index + 1])
  return [...ascii, ...bigrams]
}

/** §4.2 token Jaccard similarity; two empty texts count as identical. */
export function tokenJaccard(left: string, right: string): number {
  const setLeft = new Set(tokenizeForSimilarity(left))
  const setRight = new Set(tokenizeForSimilarity(right))
  if (setLeft.size === 0 && setRight.size === 0) return 1
  let intersection = 0
  for (const token of setLeft) {
    if (setRight.has(token)) intersection += 1
  }
  return intersection / (setLeft.size + setRight.size - intersection)
}

export interface NearDupeGroup<T> {
  members: T[]
  primary: T
}

/**
 * §4.2 near-dupe collapsing within one workspace (oldest → newest greedy):
 * joins the group whose latest member scores Jaccard ≥ 0.85, primary is newest.
 */
export function clusterNearDuplicates<T>(items: T[], textOf: (item: T) => string): Array<NearDupeGroup<T>> {
  const groups: Array<{ members: T[]; latestText: string }> = []
  for (const item of items) {
    const text = textOf(item)
    const target = groups.find((group) => tokenJaccard(text, group.latestText) >= NEAR_DUPE_JACCARD)
    if (target) {
      target.members.push(item)
      target.latestText = text
    } else {
      groups.push({ members: [item], latestText: text })
    }
  }
  return groups.map((group) => ({
    members: group.members,
    primary: group.members[group.members.length - 1]!,
  }))
}

export function firstLine(text: string): string {
  const line = text.split('\n').map((entry) => entry.trim()).find((entry) => entry.length > 0)
  return (line ?? '').slice(0, CONTENT_PREVIEW_CHARS)
}

function matchedLine(text: string, pattern: RegExp): string {
  const flags = pattern.flags.includes('i') ? 'i' : ''
  const lineRe = new RegExp(pattern.source, flags)
  const hit = text.split('\n').map((entry) => entry.trim()).find((entry) => lineRe.test(entry))
  return (hit ?? firstLine(text)).slice(0, CONTENT_PREVIEW_CHARS)
}

export function extractFileRefs(text: string): string[] {
  const seen = new Set<string>()
  const results: string[] = []
  FILE_TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FILE_TOKEN_RE.exec(text)) !== null && results.length < MAX_LIST_ITEMS) {
    const token = (match[1] ?? '').replace(/[/\\]+$/, '')
    if (!token || token.length > 200 || seen.has(token)) continue
    seen.add(token)
    results.push(token)
  }
  return results
}

export function extractTimeTags(text: string): string[] {
  return Array.from(new Set(text.match(TIME_TAG_RE) ?? [])).slice(0, 10)
}

/**
 * Deterministic concepts: file stems (`src/db.ts` → `db`). Predictable and
 * high-signal — shared stems become graph entity nodes and feed the §4.5
 * conflict overlap that empty concept lists could never trigger.
 */
export const MAX_DETERMINISTIC_CONCEPTS = 8

export function extractFileConcepts(files: string[]): string[] {
  const seen = new Set<string>()
  const results: string[] = []
  for (const file of files) {
    const base = file.split(/[/\\]/).pop() ?? ''
    const stem = base.replace(/\.[a-zA-Z0-9]{1,8}$/, '').toLowerCase()
    if (stem.length < 2 || /^\d+$/.test(stem) || seen.has(stem)) continue
    seen.add(stem)
    results.push(stem)
    if (results.length >= MAX_DETERMINISTIC_CONCEPTS) break
  }
  return results
}

function unionLists(...lists: string[][]): string[] {
  const seen = new Set<string>()
  const results: string[] = []
  for (const list of lists) {
    for (const item of list) {
      const trimmed = item.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      results.push(trimmed)
      if (results.length >= MAX_LIST_ITEMS) return results
    }
  }
  return results
}

export interface PatternMatch {
  kind: FactKind
  confidence: number
}

/**
 * §4.4 high-precision proposal patterns (operates on the group primary).
 * Priority: git/checkpoint → decision → preference → repeated command/error.
 * Anything else yields no proposal (derived index artifact only).
 */
export function classifyDeterministic(
  observationType: string,
  normalizedText: string,
  signalRepeats: number,
): PatternMatch | null {
  if (observationType === 'git-event' || observationType === 'checkpoint-event') {
    return { kind: 'fact', confidence: 0.9 }
  }
  if (DECISION_RE.test(normalizedText)) return { kind: 'decision', confidence: 0.7 }
  if (PREFERENCE_RE.test(normalizedText)) return { kind: 'preference', confidence: 0.7 }
  const signal = firstLine(normalizedText)
  if (signalRepeats >= PROCEDURE_MIN_REPEATS && COMMAND_OR_ERROR_RE.test(signal)) {
    return { kind: 'procedure', confidence: Math.min(0.6 + 0.1 * (signalRepeats - PROCEDURE_MIN_REPEATS), 0.9) }
  }
  return null
}

export interface ConflictTarget {
  id: string
  content: string
  concepts: string[]
  files: string[]
  workspaceId: string
  kind: FactKind
}

/**
 * §4.5 candidate-stage conflict check: same workspace + same kind +
 * non-empty concepts/files overlap + different content → conflicting truth ids.
 */
export function findConflicts(
  candidate: { workspaceId: string; kind: FactKind; concepts: string[]; files: string[]; content: string },
  truthFacts: ConflictTarget[],
): string[] {
  const candidateConcepts = new Set(candidate.concepts.map((concept) => concept.toLowerCase()))
  const candidateFiles = new Set(candidate.files)
  return truthFacts
    .filter((truth) => truth.workspaceId === candidate.workspaceId)
    .filter((truth) => truth.kind === candidate.kind)
    .filter((truth) => truth.content !== candidate.content)
    .filter((truth) =>
      truth.concepts.some((concept) => candidateConcepts.has(concept.toLowerCase()))
      || truth.files.some((file) => candidateFiles.has(file)),
    )
    .map((truth) => truth.id)
}

/**
 * Phase 2: adapts truth facts (which may predate the required `kind` field)
 * into conflict-check targets; kindless records can never match and are dropped.
 */
export function toConflictTargets(facts: MemoryFact[]): ConflictTarget[] {
  return facts
    .filter((fact) => typeof (fact as { kind?: unknown }).kind === 'string')
    .map((fact) => ({
      id: fact.id,
      content: fact.content,
      concepts: fact.concepts,
      files: fact.files,
      workspaceId: fact.provenance.workspaceId,
      kind: (fact as MemoryFact).kind,
    }))
}

export function derivedFilePath(observationId: string): string {
  return join(knowledgeRootPath(), DERIVED_DIR, `${observationId}.json`)
}

/** Phase 1-2: BM25/Detail reads derived artifacts best-effort; missing → null. */
export async function readDerivedObservation(observationId: string): Promise<DerivedObservation | null> {
  try {
    const parsed = JSON.parse(await readFile(derivedFilePath(observationId), 'utf8')) as DerivedObservation
    if (!parsed || parsed.observationId !== observationId) return null
    return parsed
  } catch {
    return null
  }
}

async function writeDerived(derived: DerivedObservation): Promise<void> {
  const file = derivedFilePath(derived.observationId)
  await mkdir(dirname(file), { recursive: true })
  await writeFileAtomic(file, `${JSON.stringify(derived)}\n`)
}

async function appendCandidateFacts(candidates: CandidateFact[]): Promise<void> {
  if (candidates.length === 0) return
  const file = join(knowledgeRootPath(), FACT_CANDIDATES_FILE)
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, candidates.map((candidate) => JSON.stringify(candidate)).join('\n') + '\n', 'utf8')
}

async function appendCandidateGraphEdges(candidates: CandidateGraphEdge[]): Promise<void> {
  if (candidates.length === 0) return
  const file = join(knowledgeRootPath(), GRAPH_CANDIDATES_FILE)
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, candidates.map((candidate) => JSON.stringify(candidate)).join('\n') + '\n', 'utf8')
}

/**
 * Truth–truth `mentions` proposals: settled facts in one workspace sharing a
 * file ref with no stored edge between them (either direction, any type).
 * Human-gated through the normal candidate flow; keeps the stored graph from
 * depending solely on the LLM ever emitting edges.
 */
export const MAX_DETERMINISTIC_MENTIONS = 20

export function synthesizeMentionEdges(
  truthFacts: MemoryFact[],
  existingEdges: Pick<GraphEdge, 'from' | 'to'>[],
  workspaceId: string,
  nowIso: string,
): CandidateGraphEdge[] {
  const linked = new Set<string>()
  const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)
  for (const edge of existingEdges) {
    linked.add(pairKey(edge.from, edge.to))
  }
  const scoped = truthFacts.filter((fact) => fact.provenance.workspaceId === workspaceId)
  const results: CandidateGraphEdge[] = []
  for (let i = 0; i < scoped.length && results.length < MAX_DETERMINISTIC_MENTIONS; i++) {
    const left = scoped[i]!
    const leftFiles = new Set(left.files)
    if (leftFiles.size === 0) continue
    for (let j = i + 1; j < scoped.length && results.length < MAX_DETERMINISTIC_MENTIONS; j++) {
      const right = scoped[j]!
      if (right.provenance.workspaceId !== workspaceId) continue
      const shared = right.files.some((file) => leftFiles.has(file))
      if (!shared) continue
      const key = pairKey(left.id, right.id)
      if (linked.has(key)) continue
      linked.add(key)
      const [from, to] = left.id < right.id ? [left.id, right.id] : [right.id, left.id]
      results.push({
        id: randomUUID(),
        type: 'graph-edge',
        status: 'proposed',
        edge: {
          id: randomUUID(),
          from,
          to,
          type: 'mentions',
          confidence: 0.6,
          sourceFactIds: [from, to],
          workspaceId,
          createdAt: nowIso,
        },
        derivation: 'deterministic',
        evidence: { observationIds: [] },
      })
    }
  }
  return results
}

interface PreparedObservation {
  observation: Observation
  text: string
  truncated: boolean
  redacted: boolean
  duplicateOf: string | null
}

function mostFrequentSource(observations: Observation[]): KnowledgeSource {
  const counts = new Map<KnowledgeSource, number>()
  for (const observation of observations) {
    counts.set(observation.source, (counts.get(observation.source) ?? 0) + 1)
  }
  let best: KnowledgeSource = observations[0]!.source
  let bestCount = -1
  for (const [source, count] of counts) {
    if (count > bestCount) {
      best = source
      bestCount = count
    }
  }
  return best
}

/**
 * Runs the deterministic stage over one workspace batch from the queue.
 * Writes derived artifacts for every unique observation, appends at most one
 * high-precision proposal per near-dupe group, and audits the batch.
 */
export async function runDeterministicStage(
  batch: DeterministicBatch,
  overrides: Partial<DeterministicStageDeps> = {},
): Promise<DeterministicStageResult> {
  const deps: DeterministicStageDeps = { ...defaultDeps(), ...overrides }
  const prepared: PreparedObservation[] = []
  for (const observation of batch.observations) {
    let raw: string
    if (observation.blobRef) {
      try {
        raw = await deps.resolveContent(observation)
      } catch {
        raw = observation.contentPreview ?? observation.content
      }
    } else {
      raw = observation.content
    }
    const normalized = normalizeObservationText(raw)
    prepared.push({ observation, ...normalized, duplicateOf: null })
  }

  // §4.2 exact dedupe: later observations with an identical key ride along as
  // evidence ids instead of being processed twice.
  const byKey = new Map<string, PreparedObservation>()
  const unique: PreparedObservation[] = []
  for (const item of prepared) {
    const key = observationDedupeKey({
      workspaceId: item.observation.workspaceId,
      type: item.observation.type,
      contentHash: item.observation.contentHash,
      content: item.observation.content,
    })
    const first = byKey.get(key)
    if (first) {
      item.duplicateOf = first.observation.id
    } else {
      byKey.set(key, item)
      unique.push(item)
    }
  }

  // Repeat counts (§4.4 procedure) observe every occurrence, duplicates included.
  const signalCounts = new Map<string, number>()
  for (const item of prepared) {
    const signal = firstLine(item.text)
    if (signal) signalCounts.set(signal, (signalCounts.get(signal) ?? 0) + 1)
  }
  const signalMembers = new Map<string, string[]>()
  for (const item of prepared) {
    const signal = firstLine(item.text)
    if (!signal) continue
    const list = signalMembers.get(signal) ?? []
    list.push(item.observation.id)
    signalMembers.set(signal, list)
  }

  const nowIso = deps.nowIso()
  for (const item of unique) {
    const extractedFiles = extractFileRefs(item.text)
    const derived: DerivedObservation = {
      version: 1,
      observationId: item.observation.id,
      workspaceId: item.observation.workspaceId,
      summary: firstLine(item.text),
      entities: extractedFiles,
      fileRefs: unionLists(item.observation.fileRefs, extractedFiles),
      timeTags: extractTimeTags(item.text),
      truncated: item.truncated || item.observation.truncated === true,
      redacted: item.redacted,
      derivedAt: nowIso,
      derivation: 'deterministic',
    }
    await writeDerived(derived)
  }

  const groups = clusterNearDuplicates(
    [...unique].sort((a, b) =>
      a.observation.createdAt.localeCompare(b.observation.createdAt)
      || a.observation.id.localeCompare(b.observation.id),
    ),
    (item) => item.text,
  )
  const truthFacts = await deps.listTruthFacts()

  const candidates: CandidateFact[] = []
  for (const group of groups) {
    const primary = group.primary
    const signal = firstLine(primary.text)
    const match = classifyDeterministic(
      primary.observation.type,
      primary.text,
      signal ? (signalCounts.get(signal) ?? 0) : 0,
    )
    if (!match) continue

    // Evidence: near-dupe group members (+ exact dupes); procedure additionally
    // cites every observation repeating the same command/error signal.
    const evidenceIds = new Set<string>()
    for (const member of group.members) {
      evidenceIds.add(member.observation.id)
      for (const item of prepared) {
        if (item.duplicateOf === member.observation.id) evidenceIds.add(item.observation.id)
      }
    }
    if (match.kind === 'procedure' && signal) {
      for (const id of signalMembers.get(signal) ?? []) evidenceIds.add(id)
    }
    const evidenceObservations = prepared.filter((item) => evidenceIds.has(item.observation.id))

    const files = unionLists(
      ...evidenceObservations.map((item) => item.observation.fileRefs),
      ...evidenceObservations.map((item) => extractFileRefs(item.text)),
    )
    const provenance: KnowledgeProvenance = {
      workspaceId: batch.workspaceId,
      workspaceName: primary.observation.workspaceName,
      workspacePath: primary.observation.workspacePath,
      source: mostFrequentSource(evidenceObservations.map((item) => item.observation)),
      sourceObservationIds: [...evidenceIds],
      fileRefs: files,
      actor: 'knowledge-deterministic',
      createdAt: nowIso,
    }
    const content = match.kind === 'fact'
      ? firstLine(primary.text) + (files.length > 0 ? ` [${files.join(', ')}]` : '')
      : match.kind === 'procedure'
        ? signal
        : matchedLine(primary.text, match.kind === 'decision' ? DECISION_RE : PREFERENCE_RE)
    const fact: MemoryFact = {
      id: randomUUID(),
      content,
      concepts: extractFileConcepts(files),
      files,
      tags: unionLists(primary.observation.tags, extractTimeTags(primary.text)),
      confidence: match.confidence,
      version: 1,
      status: 'proposed',
      kind: match.kind,
      provenance,
    }
    const conflicts = findConflicts(
      { workspaceId: batch.workspaceId, kind: match.kind, concepts: fact.concepts, files: fact.files, content: fact.content },
      toConflictTargets(truthFacts),
    )
    candidates.push({
      id: randomUUID(),
      type: 'fact',
      status: 'proposed',
      fact,
      derivation: 'deterministic',
      evidence: {
        observationIds: [...evidenceIds],
        snippets: [firstLine(primary.text)],
      },
      ...(conflicts.length > 0 ? { conflicts } : {}),
    })
  }

  await appendCandidateFacts(candidates)
  // Truth–truth mentions discovered from shared file refs. Human-gated
  // through the normal graph-candidate flow; an empty truth set yields none.
  const mentionEdges = synthesizeMentionEdges(
    truthFacts,
    await deps.listTruthEdges().catch(() => []),
    batch.workspaceId,
    nowIso,
  )
  await appendCandidateGraphEdges(mentionEdges)
  if (candidates.length > 0 || mentionEdges.length > 0) {
    await knowledgeAuditService.record({
      action: 'candidate_proposed',
      targetType: 'fact',
      targetId: batch.workspaceId,
      before: null,
      after: {
        factCandidateIds: candidates.map((candidate) => candidate.id),
        graphCandidateIds: mentionEdges.map((candidate) => candidate.id),
        sourceObservationIds: prepared.map((item) => item.observation.id),
        derivation: 'deterministic',
      },
      provenance: {
        workspaceId: batch.workspaceId,
        workspaceName: batch.observations[0]?.workspaceName ?? batch.workspaceId,
        workspacePath: batch.observations[0]?.workspacePath ?? '',
        source: mostFrequentSource(batch.observations),
        sourceObservationIds: prepared.map((item) => item.observation.id),
        fileRefs: [],
        actor: 'knowledge-deterministic',
        createdAt: nowIso,
      },
    })
  }

  return { derived: unique.length, proposals: candidates.length + mentionEdges.length, autoAccepted: await autoAcceptEligible(candidates, deps) }
}

/**
 * §4.6 auto-accept (opt-in via settings, default off): deterministic
 * high-confidence facts from tool-driven sources (git / checkpoint captures)
 * skip the Inbox and apply immediately with audit actor 'auto-policy'.
 * Note: checkpoint captures carry source 'checkpoint', so both sources count
 * as the "git/checkpoint class" the plan refers to. Failures never fail the
 * stage; the candidate simply stays proposed for manual review.
 */
const AUTO_ACCEPT_SOURCES: ReadonlySet<KnowledgeSource> = new Set(['tool', 'checkpoint'])
const AUTO_ACCEPT_MIN_CONFIDENCE = 0.9

async function autoAcceptEligible(
  candidates: CandidateFact[],
  deps: DeterministicStageDeps,
): Promise<number> {
  let enabled = false
  try {
    enabled = await deps.getAutoAccept()
  } catch (error) {
    console.error(`[knowledge] auto-accept settings read failed: ${error instanceof Error ? error.message : String(error)}`)
    return 0
  }
  if (!enabled) return 0
  let accepted = 0
  for (const candidate of candidates) {
    if (
      candidate.derivation !== 'deterministic'
      || candidate.fact.kind !== 'fact'
      || candidate.fact.confidence < AUTO_ACCEPT_MIN_CONFIDENCE
      || !AUTO_ACCEPT_SOURCES.has(candidate.fact.provenance.source)
    ) continue
    try {
      await deps.applyCandidate({ type: 'fact', id: candidate.id, actor: 'auto-policy' })
      accepted += 1
    } catch (error) {
      console.error(`[knowledge] auto-accept failed for ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return accepted
}
