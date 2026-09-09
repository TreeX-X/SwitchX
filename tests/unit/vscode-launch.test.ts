import { describe, expect, it } from 'vitest'
import { buildVSCodeLaunchArgs } from '../../src/main/ide-launch'

describe('VS Code launcher', () => {
  it('builds a new-window launch with the default user profile', () => {
    expect(buildVSCodeLaunchArgs(
      'C:\\Users\\Tree\\Desktop\\git\\JanusX',
    )).toEqual([
      '--new-window',
      'C:\\Users\\Tree\\Desktop\\git\\JanusX',
    ])
  })

  it('does not require shell or hidden-window flags for the GUI executable', () => {
    expect({ detached: true, stdio: 'ignore' }).not.toHaveProperty('windowsHide')
  })
})
