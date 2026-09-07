import type { OfficecliInfo, OfficePrompt, OfficeSkillId } from '../../shared/office'
import { OFFICE_SKILL_IDS } from '../../shared/office'
import { officecliManager, type OfficecliManager } from './officecli-manager'

export interface BuildOfficePromptInput {
  terminalPreset: 'shell' | 'claude' | 'codex' | 'opencode' | 'janus'
  workspaceId: string
  skillId?: OfficeSkillId
}

const SKILL_GOALS: Record<OfficeSkillId, string> = {
  'officecli-xlsx': 'Create or edit the requested Excel workbook with OfficeCLI.',
  'officecli-docx': 'Create or edit the requested Word document with OfficeCLI.',
  'officecli-pptx': 'Create or edit the requested PowerPoint presentation with OfficeCLI.',
}

function guidancePrompt(info: OfficecliInfo): OfficePrompt {
  const release = info.manualInstall?.release ?? info.manualInstall?.repository
  const releaseGuidance = release ? ` Review the supported release at ${release}.` : ''

  if (!info.installed) {
    return {
      mode: 'guidance',
      text: `OfficeCLI is not installed. Complete the manual installation before generating an Office editing prompt.${releaseGuidance}`,
    }
  }

  if (info.runtimeError) {
    return {
      mode: 'guidance',
      text: `${info.runtimeError} Repair the local runtime, then retry OfficeCLI detection.${releaseGuidance}`,
    }
  }

  const version = info.version ? ` Detected version: ${info.version}.` : ''
  return {
    mode: 'guidance',
    text: `The installed OfficeCLI is incompatible with this JanusX build.${version} Install the supported version, then retry detection.${releaseGuidance}`,
  }
}

function assertKnownSkillId(skillId: unknown): asserts skillId is OfficeSkillId | undefined {
  if (skillId !== undefined && !(OFFICE_SKILL_IDS as readonly unknown[]).includes(skillId)) {
    throw new Error('Invalid Office skillId')
  }
}

export async function buildOfficePromptForAgent(
  input: BuildOfficePromptInput,
  provider: Pick<OfficecliManager, 'detect'> = officecliManager,
): Promise<OfficePrompt> {
  assertKnownSkillId(input.skillId)

  const info = await provider.detect()
  if (!info.installed || !info.compatible || info.runtimeError || !info.path) {
    return guidancePrompt(info)
  }

  const goal = input.skillId ? SKILL_GOALS[input.skillId] : ''
  return {
    mode: input.skillId ? 'specific' : 'generic',
    text: [
      goal,
      'Use OfficeCLI exclusively for Office document writes; do not bypass it with Python libraries, desktop automation, or raw byte edits.',
      `Keep every Office file read or written inside the current JanusX workspace (${input.workspaceId}).`,
      'Only the OfficeCLI editing chain refreshes the preview live. After any bypass write, use "Reload from disk" before trusting the preview.',
      `The provider verified this executable for the current session: ${info.path}`,
      `Start by inspecting its verified create entry point: "${info.path}" create --help`,
      `Apply these instructions in the active ${input.terminalPreset} terminal. Do not submit a command until the requested paths and edits are confirmed.`,
    ].filter(Boolean).join('\n'),
  }
}
