import { z } from 'zod'
import type { Blueprint } from '../../../shared/janus/types'
import type { BlueprintOperation } from '../../../shared/janus/maintenance-types'
import type { JanusAgentTool } from '@janus-agent/agent-core'
import { normalizeProposedOperations } from './changeset'

const operationBase = {
  operationId: z.string().min(1),
  reason: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  risk: z.enum(['low', 'medium', 'high']).default('low'),
}

const relationType = z.enum(['depends-on', 'blocks', 'related-to', 'implements'])
const proposedFeature = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().default(''),
  progress: z.number().min(0).max(100).default(0),
  status: z.enum(['planned', 'in-progress', 'done', 'blocked']).default('planned'),
  requirementNotes: z.array(z.string()).default([]),
})

export const blueprintProposalSchema = z.object({
  summary: z.string().min(1),
  operations: z.array(z.discriminatedUnion('type', [
    z.object({ ...operationBase, type: z.literal('create-node'), tempNodeId: z.string().min(1), parentId: z.string().min(1), after: z.object({
      title: z.string().min(1), type: z.enum(['epic', 'feature', 'task', 'issue']), description: z.string().default(''),
      positioning: z.string().default(''), techSolution: z.string().default(''), notes: z.string().default(''), tags: z.array(z.string()).default([]),
    }) }),
    z.object({ ...operationBase, type: z.literal('update-node'), nodeId: z.string().min(1), after: z.object({
      title: z.string().min(1).optional(), type: z.enum(['epic', 'feature', 'task', 'issue']).optional(),
      status: z.enum(['not-started', 'in-progress', 'testing', 'done', 'blocked']).optional(), progress: z.number().min(0).max(100).optional(),
      positioning: z.string().optional(), description: z.string().optional(), techSolution: z.string().optional(), notes: z.string().optional(), tags: z.array(z.string()).optional(),
      features: z.array(proposedFeature).max(40).optional(),
    }) }),
    z.object({ ...operationBase, type: z.literal('move-node'), nodeId: z.string().min(1), afterParentId: z.string().min(1) }),
    z.object({ ...operationBase, type: z.literal('add-relation'), tempRelationId: z.string().min(1), after: z.object({
      sourceNodeId: z.string().min(1), targetNodeId: z.string().min(1), relationType, description: z.string().optional(),
    }) }),
    z.object({ ...operationBase, type: z.literal('update-relation'), relationId: z.string().min(1), after: z.object({
      relationType: relationType.optional(), description: z.string().optional(),
    }) }),
    z.object({ ...operationBase, type: z.literal('remove-relation'), relationId: z.string().min(1) }),
    z.object({ ...operationBase, type: z.literal('update-workspace-binding'), nodeId: z.string().min(1), after: z.object({
      primaryWorkspaceId: z.string().min(1).nullable(), linkedWorkspaceIds: z.array(z.string().min(1)).default([]),
    }) }),
    z.object({ ...operationBase, type: z.literal('archive-node'), nodeId: z.string().min(1) }),
    z.object({ ...operationBase, type: z.literal('delete-node'), nodeId: z.string().min(1) }),
  ])).max(60),
})

export function blueprintNodeContext(blueprint: Blueprint, allowed: Set<string>): string {
  const nodes = [...allowed].map((id) => {
    const node = blueprint.nodes[id]
    return node && {
      id: node.id, title: node.title, type: node.type, status: node.status, progress: node.progress,
      positioning: node.positioning, description: node.description, techSolution: node.techSolution,
      notes: node.notes, tags: node.tags, parentId: node.parentId, children: node.children,
      primaryWorkspaceId: node.primaryWorkspaceId, linkedWorkspaceIds: node.linkedWorkspaceIds,
    }
  }).filter(Boolean)
  // Relations touching the scope are readable context even when the far endpoint is out of scope.
  const relations = (blueprint.relations ?? [])
    .filter((relation) => allowed.has(relation.sourceNodeId) || allowed.has(relation.targetNodeId))
    .map((relation) => ({
      id: relation.id, type: relation.type, description: relation.description,
      sourceNodeId: relation.sourceNodeId, targetNodeId: relation.targetNodeId,
      sourceTitle: blueprint.nodes[relation.sourceNodeId]?.title,
      targetTitle: blueprint.nodes[relation.targetNodeId]?.title,
      sourceInScope: allowed.has(relation.sourceNodeId),
      targetInScope: allowed.has(relation.targetNodeId),
    }))
  return JSON.stringify({ nodes, relations }, null, 2)
}

export function createJanusBlueprintTools(options: {
  readOnlyTools?: JanusAgentTool[]
  blueprint: Blueprint
  allowedNodeIds: Set<string>
}): JanusAgentTool[] {
  const read: JanusAgentTool = {
    name: 'janus.blueprint.read',
    executionMode: 'parallel',
    execute: async () => ({
      content: blueprintNodeContext(options.blueprint, options.allowedNodeIds),
      details: { blueprintId: options.blueprint.id, contentRevision: options.blueprint.contentRevision },
    }),
  }
  const propose: JanusAgentTool = {
    name: 'janus.blueprint.propose',
    executionMode: 'sequential',
    execute: async (call) => {
      const input = blueprintProposalSchema.parse(call.arguments)
      const operations = normalizeProposedOperations(
        options.blueprint,
        new Set(options.allowedNodeIds),
        input.operations as BlueprintOperation[],
      )
      return {
        content: JSON.stringify({ summary: input.summary, operations }),
        details: { summary: input.summary, operations },
      }
    },
  }
  return [...(options.readOnlyTools ?? []), read, propose]
}

export const blueprintReadModelTool = {
  description: 'Read the authorized Blueprint node scope, including exact node IDs and parent-child structure.',
  parameters: z.object({}),
}
