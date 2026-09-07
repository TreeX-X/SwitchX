/**
 * src/main/ipc/project-handlers.ts
 *
 * 项目管理 IPC 处理器
 * 职责：
 * 1. 暴露项目检测、配置、启动等接口给前端
 * 2. 处理 IPC 请求和响应
 * 3. 管理全局的 ProjectRunner 实例
 */

import { ipcMain } from 'electron'
import ProjectDetector from '../project/detector/detector'
import { getProjectRunner, stopAllProjects } from '../project/runner/service'
import { resolveProjectTestScript, runProjectTest } from '../project/runner/task-runner'
import ProjectConfig from '../project/config/project-config'
import { getProjectTypes } from '../project/config/project-schemas'
import {
  PROJECT_CHANNELS,
  type LaunchConfig,
  type ProjectType,
} from '../../shared/ipc/project'
import { authorizeRendererAction, type RendererActionAuthorizer } from '../janus-agent/runtime/renderer-authorization'

/**
 * 注册项目管理相关的 IPC 处理器
 *
 * 暴露的接口：
 * - project:detect - 检测项目类型
 * - project:detect-with-details - 详细检测
 * - project:config:read - 读取配置
 * - project:config:write - 写入配置
 * - project:config:create-default - 创建默认配置
 * - project:config:validate - 验证配置
 * - project:run - 启动项目
 * - project:stop - 停止项目
 * - project:list - 列表运行中的项目
 */
export function registerProjectHandlers(authorize: RendererActionAuthorizer = authorizeRendererAction) {
  // ═══════════════════════════════════════════════════════════
  // 项目检测
  // ═══════════════════════════════════════════════════════════

  /**
   * 检测项目类型
   * @param projectPath 项目根目录
   * @returns 项目类型
   */
  ipcMain.handle(PROJECT_CHANNELS.detect, async (_, projectPath: string) => {
    try {
      const type = await ProjectDetector.detect(projectPath)
      return {
        success: true,
        data: { type },
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  /**
   * 详细检测项目
   * @param projectPath 项目根目录
   * @returns 检测结果（包括置信度、特征文件、推荐配置）
   */
  ipcMain.handle(PROJECT_CHANNELS.detectWithDetails, async (_, projectPath: string) => {
    try {
      const result = await ProjectDetector.detectWithDetails(projectPath)
      return {
        success: true,
        data: result,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  // ═══════════════════════════════════════════════════════════
  // 配置管理
  // ═══════════════════════════════════════════════════════════

  /**
   * 读取项目配置
   * @param projectPath 项目根目录
   * @returns .janusX/janusX.launch.json 配置，若不存在返回 null
   */
  ipcMain.handle(PROJECT_CHANNELS.readConfig, async (_, projectPath: string) => {
    try {
      const config = await ProjectConfig.read(projectPath)
      return {
        success: true,
        data: config,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  /**
   * 写入项目配置
   * @param projectPath 项目根目录
   * @param config 配置对象
   */
  ipcMain.handle(PROJECT_CHANNELS.writeConfig, async (event, projectPath: string, config: LaunchConfig) => {
    try {
      if (!await authorize(event, { workspaceRoot: projectPath, toolName: 'legacy.project.write-config', actionRisk: 'config-apply', source: 'renderer-user', preview: { summary: 'Apply project launch configuration', paths: [projectPath], detail: `${JSON.stringify(config).length} characters`, truncated: false } })) return { success: false, error: 'Configuration update denied by workspace policy' }
      await ProjectConfig.write(projectPath, config)
      return {
        success: true,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  /**
   * 创建默认配置
   * @param projectPath 项目根目录
   * @param projectType 项目类型
   * @param projectName 项目名称
   * @returns 创建的配置
   */
  ipcMain.handle(
    PROJECT_CHANNELS.createDefaultConfig,
    async (_, ...args: [projectPath: string, projectType: ProjectType, projectName: string]) => {
      try {
        const [projectPath, projectType, projectName] = args
        const config = ProjectConfig.createDefault(
          projectPath,
          projectType,
          projectName
        )
        return {
          success: true,
          data: config,
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      }
    }
  )

  /**
   * 验证配置
   * @param config 配置对象
   * @returns 验证结果
   */
  ipcMain.handle(PROJECT_CHANNELS.validateConfig, async (_, config: LaunchConfig) => {
    try {
      const result = ProjectConfig.validate(config)
      return {
        success: true,
        data: result,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  // ═══════════════════════════════════════════════════════════
  // 项目执行
  // ═══════════════════════════════════════════════════════════

  ipcMain.handle(PROJECT_CHANNELS.test, async (event, projectPath: string, script?: string) => {
    try {
      const selected = await resolveProjectTestScript(projectPath, script)
      if (!await authorize(event, {
        workspaceRoot: projectPath,
        toolName: 'project.test',
        actionRisk: 'run',
        source: 'renderer-user',
        preview: {
          summary: 'Run project tests',
          paths: [projectPath],
          detail: `Package script: ${selected.name}\n${selected.command}`,
          truncated: false,
        },
      })) return { success: false, error: 'Project test denied by workspace policy' }
      return { success: true, data: await runProjectTest(projectPath, selected.name) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  /**
   * 启动项目
   * @param projectPath 项目根目录
   * @param configName 配置名称（默认 'dev'）
   * @returns 进程信息
   */
  ipcMain.handle(
    PROJECT_CHANNELS.run,
    async (event, projectPath: string, configName: string = 'dev') => {
      try {
        if (!await authorize(event, { workspaceRoot: projectPath, toolName: 'legacy.project.run', actionRisk: 'run', source: 'renderer-user', preview: { summary: 'Start project', paths: [projectPath], detail: `Configuration: ${configName}`, truncated: false } })) return { success: false, error: 'Project run denied by workspace policy' }
        const runner = getProjectRunner()
        const processHandle = await runner.run(projectPath, configName)

        return {
          success: true,
          data: {
            pid: processHandle.pid,
            config: processHandle.config,
            startTime: processHandle.startTime.toISOString(),
          },
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      }
    }
  )

  /**
   * 停止项目
   * @param projectId 项目 ID（通常是项目路径）
   */
  ipcMain.handle(PROJECT_CHANNELS.stop, async (event, projectId: string) => {
    try {
      if (!await authorize(event, { workspaceRoot: projectId, toolName: 'legacy.project.stop', actionRisk: 'run', source: 'renderer-user', preview: { summary: 'Stop project', paths: [projectId], truncated: false } })) return { success: false, error: 'Project stop denied by workspace policy' }
      const runner = getProjectRunner()
      await runner.stop(projectId)

      return {
        success: true,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  /**
   * 获取运行中的项目列表
   * @returns 所有运行中的项目
   */
  ipcMain.handle(PROJECT_CHANNELS.list, async () => {
    try {
      const runner = getProjectRunner()
      const running = runner.getAllRunning()

      const projects = Array.from(running.entries()).map(([id, handle]) => ({
        id,
        pid: handle.pid,
        type: handle.config.type,
        name: handle.config.name,
        port: handle.port,
        startTime: handle.startTime.toISOString(),
        uptime: Date.now() - handle.startTime.getTime(),
      }))

      return {
        success: true,
        data: projects,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  /**
   * 获取单个运行中的项目信息
   * @param projectId 项目 ID
   */
  ipcMain.handle(PROJECT_CHANNELS.get, async (_, projectId: string) => {
    try {
      const runner = getProjectRunner()
      const handle = runner.getRunning(projectId)

      if (!handle) {
        return {
          success: false,
          error: `Project ${projectId} is not running`,
        }
      }

      return {
        success: true,
        data: {
          pid: handle.pid,
          config: handle.config,
          startTime: handle.startTime.toISOString(),
          port: handle.port,
          output: handle.output,
        },
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  // ═══════════════════════════════════════════════════════════
  // Schema 查询
  // ═══════════════════════════════════════════════════════════

  /**
   * 获取所有项目类型 Schema
   * @returns 所有支持的项目类型 Schema 列表
   */
  ipcMain.handle(PROJECT_CHANNELS.schemas, async () => {
    try {
      return {
        success: true,
        data: getProjectTypes(),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

}

export { getProjectRunner, stopAllProjects }
