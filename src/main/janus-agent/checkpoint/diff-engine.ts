const CONFLICT_START = '<<<<<<< ours'
const CONFLICT_SEP = '======='
const CONFLICT_END = '>>>>>>> theirs'

export function generateUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')

  const changes: string[] = []

  let oldIdx = 0
  let newIdx = 0

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (oldIdx >= oldLines.length) {
      changes.push(`+${newLines[newIdx]}`)
      newIdx++
    } else if (newIdx >= newLines.length) {
      changes.push(`-${oldLines[oldIdx]}`)
      oldIdx++
    } else if (oldLines[oldIdx] === newLines[newIdx]) {
      changes.push(` ${oldLines[oldIdx]}`)
      oldIdx++
      newIdx++
    } else {
      // Find next matching line
      let foundOld = -1
      let foundNew = -1
      for (let look = 1; look < 5 && (oldIdx + look < oldLines.length || newIdx + look < newLines.length); look++) {
        if (newIdx + look < newLines.length && oldLines[oldIdx] === newLines[newIdx + look]) {
          foundNew = look
          break
        }
        if (oldIdx + look < oldLines.length && oldLines[oldIdx + look] === newLines[newIdx]) {
          foundOld = look
          break
        }
      }

      if (foundNew > 0) {
        for (let i = 0; i < foundNew; i++) {
          changes.push(`+${newLines[newIdx]}`)
          newIdx++
        }
      } else if (foundOld > 0) {
        for (let i = 0; i < foundOld; i++) {
          changes.push(`-${oldLines[oldIdx]}`)
          oldIdx++
        }
      } else {
        changes.push(`-${oldLines[oldIdx]}`)
        changes.push(`+${newLines[newIdx]}`)
        oldIdx++
        newIdx++
      }
    }
  }

  if (changes.every(c => c.startsWith(' '))) return ''

  const diffLines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...changes,
  ]

  return diffLines.join('\n')
}

export interface MergeResult {
  merged: string
  conflicts: boolean
  conflictRegions: Array<{ start: number; end: number }>
}

export function threeWayMerge(base: string, ours: string, theirs: string): MergeResult {
  // If ours and theirs are the same, no conflict
  if (ours === theirs) return { merged: ours, conflicts: false, conflictRegions: [] }

  // If one matches base, take the other
  if (ours === base) return { merged: theirs, conflicts: false, conflictRegions: [] }
  if (theirs === base) return { merged: ours, conflicts: false, conflictRegions: [] }

  // Both changed differently - produce conflict markers
  const merged = [
    CONFLICT_START,
    ours,
    CONFLICT_SEP,
    theirs,
    CONFLICT_END,
  ].join('\n')

  return {
    merged,
    conflicts: true,
    conflictRegions: [{ start: 0, end: merged.length }],
  }
}

export function parseConflictMarkers(content: string): {
  hasConflicts: boolean
  regions: Array<{ ours: string; theirs: string }>
} {
  const regions: Array<{ ours: string; theirs: string }> = []
  const lines = content.split('\n')

  let inConflict = false
  let oursLines: string[] = []
  let theirsLines: string[] = []
  let isOurs = true

  for (const line of lines) {
    if (line === CONFLICT_START) {
      inConflict = true
      isOurs = true
      oursLines = []
      theirsLines = []
    } else if (line === CONFLICT_SEP && inConflict) {
      isOurs = false
    } else if (line === CONFLICT_END && inConflict) {
      inConflict = false
      regions.push({
        ours: oursLines.join('\n'),
        theirs: theirsLines.join('\n'),
      })
    } else if (inConflict) {
      if (isOurs) oursLines.push(line)
      else theirsLines.push(line)
    }
  }

  return { hasConflicts: regions.length > 0, regions }
}
