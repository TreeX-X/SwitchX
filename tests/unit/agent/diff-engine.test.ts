import { describe, it, expect } from 'vitest'
import { generateUnifiedDiff, threeWayMerge, parseConflictMarkers } from '../../../src/main/janus-agent/checkpoint/diff-engine'

describe('generateUnifiedDiff', () => {
  it('returns empty string for identical content', () => {
    const content = 'line1\nline2\nline3'
    const result = generateUnifiedDiff('test.ts', content, content)
    expect(result).toBe('')
  })

  it.each([
    ['shows + lines for added lines', 'line1', 'line1\nline2', ['+line2'], []],
    ['shows - lines for removed lines', 'line1\nline2', 'line1', ['-line2'], []],
    ['shows both - and + for changed lines', 'old line', 'new line', ['-old line', '+new line'], []],
  ] as const)('%s', (_label, oldContent, newContent, expectedContains, expectedAbsent) => {
    const result = generateUnifiedDiff('test.ts', oldContent, newContent)
    for (const expected of expectedContains) {
      expect(result).toContain(expected)
    }
    const removalLines = result.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'))
    for (const absent of expectedAbsent) {
      expect(removalLines).not.toContain(absent)
    }
  })

  it('includes file path in header', () => {
    const result = generateUnifiedDiff('src/foo.ts', 'a', 'b')
    expect(result).toContain('--- a/src/foo.ts')
    expect(result).toContain('+++ b/src/foo.ts')
  })

  it('includes hunk header', () => {
    const result = generateUnifiedDiff('test.ts', 'a', 'b')
    expect(result).toMatch(/^--- a\/test\.ts\n\+\+\+ b\/test\.ts\n@@ .+ @@/)
  })
})

describe('threeWayMerge', () => {
  it.each([
    ['returns ours when all three are the same', 'same content', 'same content', 'same content', 'same content'],
    ['returns ours when theirs matches base (ours changed)', 'original', 'modified by us', 'original', 'modified by us'],
    ['returns theirs when ours matches base (theirs changed)', 'original', 'original', 'modified by them', 'modified by them'],
    ['returns ours when both changed the same way', 'original', 'both changed to this', 'both changed to this', 'both changed to this'],
  ] as const)('%s', (_label, base, ours, theirs, expected) => {
    const result = threeWayMerge(base, ours, theirs)
    expect(result.merged).toBe(expected)
    expect(result.conflicts).toBe(false)
    expect(result.conflictRegions).toEqual([])
  })

  it('produces conflict markers when both changed differently', () => {
    const base = 'original'
    const ours = 'our version'
    const theirs = 'their version'
    const result = threeWayMerge(base, ours, theirs)
    expect(result.conflicts).toBe(true)
    expect(result.merged).toContain('<<<<<<< ours')
    expect(result.merged).toContain('=======')
    expect(result.merged).toContain('>>>>>>> theirs')
    expect(result.merged).toContain(ours)
    expect(result.merged).toContain(theirs)
    expect(result.conflictRegions.length).toBeGreaterThan(0)
  })
})

describe('parseConflictMarkers', () => {
  it('returns no conflicts for content without markers', () => {
    const result = parseConflictMarkers('just plain text\nno conflicts here')
    expect(result.hasConflicts).toBe(false)
    expect(result.regions).toEqual([])
  })

  it('extracts a single conflict region', () => {
    const content = [
      'before',
      '<<<<<<< ours',
      'our version',
      '=======',
      'their version',
      '>>>>>>> theirs',
      'after',
    ].join('\n')
    const result = parseConflictMarkers(content)
    expect(result.hasConflicts).toBe(true)
    expect(result.regions).toHaveLength(1)
    expect(result.regions[0].ours).toBe('our version')
    expect(result.regions[0].theirs).toBe('their version')
  })

  it('extracts multiple conflict regions', () => {
    const content = [
      '<<<<<<< ours',
      'first ours',
      '=======',
      'first theirs',
      '>>>>>>> theirs',
      'middle',
      '<<<<<<< ours',
      'second ours',
      '=======',
      'second theirs',
      '>>>>>>> theirs',
    ].join('\n')
    const result = parseConflictMarkers(content)
    expect(result.hasConflicts).toBe(true)
    expect(result.regions).toHaveLength(2)
    expect(result.regions[0].ours).toBe('first ours')
    expect(result.regions[0].theirs).toBe('first theirs')
    expect(result.regions[1].ours).toBe('second ours')
    expect(result.regions[1].theirs).toBe('second theirs')
  })

  it('handles multi-line conflict content', () => {
    const content = [
      '<<<<<<< ours',
      'our line 1',
      'our line 2',
      '=======',
      'their line 1',
      'their line 2',
      'their line 3',
      '>>>>>>> theirs',
    ].join('\n')
    const result = parseConflictMarkers(content)
    expect(result.hasConflicts).toBe(true)
    expect(result.regions[0].ours).toBe('our line 1\nour line 2')
    expect(result.regions[0].theirs).toBe('their line 1\ntheir line 2\ntheir line 3')
  })

  it('returns empty regions for partial/malformed markers', () => {
    const content = '<<<<<<< ours\norphan conflict'
    const result = parseConflictMarkers(content)
    expect(result.hasConflicts).toBe(false)
    expect(result.regions).toEqual([])
  })
})