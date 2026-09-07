import type { ToolResult } from '../../../shared/ipc/agent-runtime'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * P4 preview-only: command.run sync stdout/stderr are already 8KB tail
 * previews with the full log at logPath. Refs are ordered BEFORE the preview
 * blobs because compactToolMessage cuts tool messages at 4k chars: a cut must
 * keep logPath/totalBytes/guidance, never silently drop them.
 */
function commandRunModelValue(output: Record<string, unknown>): unknown {
  // 引用键按固定顺序前置（compactToolMessage 按 4k 裁剪时引用存活），blob 放最后。
  const refs: Record<string, unknown> = {}
  for (
    const key of [
      'workspaceId',
      'program',
      'args',
      'cwd',
      'ok',
      'exitCode',
      'timedOut',
      'outputTruncated',
      'executionMode',
      'totalBytes',
      'wallTimeMs',
      'logTruncated',
      'background',
      'projectId',
      'pid',
      'name',
      'timeoutMs',
      // R4：非空 env 回显（审批/回看可知覆盖了哪些变量；审计侧天然只存长度）。
      'env',
      'logPath',
    ]
  ) {
    if (output[key] !== undefined) refs[key] = output[key]
  }
  const totalBytes = typeof output.totalBytes === 'number' ? output.totalBytes : '?'
  const logPath = typeof output.logPath === 'string' ? output.logPath : undefined
  refs.guidance = logPath
    ? `stdout/stderr below are 8KB tail previews (${totalBytes} bytes total). Read the full log at ${logPath} with workspace_read (offset/maxBytes) to find earlier errors such as TSxxxx.`
    : output.background === true
      ? 'Background job started. Poll project_process_output with the projectId above; increase offsetLines to read earlier lines.'
      : 'stdout/stderr below are 8KB tail previews.'
  if (output.stdout !== undefined) refs.stdout = output.stdout
  if (output.stderr !== undefined) refs.stderr = output.stderr
  return refs
}

/**
 * P4 preview-only: project.process-output pages are already bounded, but the
 * 128KB page blob must not bury totalLines/offsetLines/truncated. Refs first,
 * blob last, plus a paging hint when truncated.
 */
function processOutputModelValue(output: Record<string, unknown>): unknown {
  const value: Record<string, unknown> = {
    workspaceId: output.workspaceId,
    projectId: output.projectId,
    totalLines: output.totalLines,
    offsetLines: output.offsetLines,
    truncated: output.truncated,
    // P4尾巴：已退出任务的退出信息与磁盘日志引用同样前置。
    ...(output.exited !== undefined ? { exited: output.exited } : {}),
    ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
    ...(output.signal !== undefined ? { signal: output.signal } : {}),
    // R3：超时 kill 的后台任务带 timedOut:true，排在 blob 前避免被裁掉。
    ...(output.timedOut !== undefined ? { timedOut: output.timedOut } : {}),
    ...(typeof output.logPath === 'string' ? { logPath: output.logPath } : {}),
    output: output.output,
  }
  if (output.truncated === true) {
    value.guidance = `Output is paged (${String(output.totalLines)} lines total). Increase offsetLines to read earlier lines.`
  } else if (typeof output.logPath === 'string') {
    value.guidance = `Full log also at ${output.logPath}; read it with workspace_read for lines outside this page.`
  }
  return value
}

export function toolResultToModelValue(result: ToolResult): unknown {
  if (result.status === 'completed') {
    const output = asRecord(result.output)
    if (output && result.toolName === 'command.run') return commandRunModelValue(output)
    if (output && result.toolName === 'project.process-output') return processOutputModelValue(output)
    return result.output
  }
  if (result.reasonCode === 'APPROVAL_DENIED') {
    return {
      ok: false,
      status: result.status,
      reasonCode: result.reasonCode,
      userDenied: true,
      guidance: 'The user declined this action in the approval dialog. Do not retry it; acknowledge the decision and continue helping.',
    }
  }
  if (result.reasonCode === 'TARGET_CHANGED') {
    return {
      ok: false,
      status: result.status,
      reasonCode: result.reasonCode,
      retryable: true,
      error: result.error || `${result.toolName} ${result.status}`,
      guidance: 'The file changed during this read attempt. The workspace is not locked. Call workspace_read once more to obtain the current content and SHA-256 before editing.',
    }
  }
  return {
    ok: false,
    status: result.status,
    reasonCode: result.reasonCode,
    error: result.error || `${result.toolName} ${result.status}`,
  }
}
