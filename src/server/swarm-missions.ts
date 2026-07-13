import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SWARM_CANONICAL_REPO } from './swarm-environment'
import type { ParsedSwarmCheckpoint } from './swarm-checkpoints'
import { getSwarmProfilePath } from './swarm-foundation'
import { readWorkerTokenUsage, type SwarmTokenUsageSnapshot } from './swarm-token-usage'

export type SwarmMissionAssignmentState = 'queued' | 'dispatched' | 'checkpointed' | 'blocked' | 'needs_input' | 'reviewing' | 'done' | 'cancelled'
export type SwarmMissionState = 'planning' | 'dispatching' | 'executing' | 'reviewing' | 'blocked' | 'complete' | 'cancelled'

export type SwarmMissionAssignment = {
  id: string
  workerId: string
  task: string
  rationale: string | null
  dependsOn: Array<string>
  reviewRequired: boolean
  state: SwarmMissionAssignmentState
  dispatchedAt: number | null
  completedAt: number | null
  reviewedAt: number | null
  reviewedBy: string | null
  checkpoint: ParsedSwarmCheckpoint | null
  tokenBaseline?: SwarmTokenUsageSnapshot | null
  tokenUsage?: SwarmMissionTokenUsage | null
}

export type SwarmMissionAuthority = {
  system: 'desktop' | 'github' | 'paperclip' | 'project'
  id: string
  url: string
}

export type SwarmMissionRepository = {
  localPath: string | null
  githubUrl: string | null
}

export type SwarmMissionBudget = {
  mode?: 'advisory'
  tokenLimit: number | null
  stopCondition: string | null
}

export type SwarmMissionTokenUsage = {
  available: boolean
  source: 'state.db:sessions'
  measuredAt: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  overBudget: boolean | null
}

export type SwarmMissionEvent = {
  id: string
  type: 'created' | 'assignment_dispatched' | 'checkpoint' | 'continuation' | 'review' | 'blocked' | 'assignment_cancelled' | 'mission_cancelled'
  at: number
  workerId?: string
  assignmentId?: string
  message: string
  data?: Record<string, unknown>
}

export type SwarmCheckpointReport = {
  missionId: string
  assignmentId: string
  workerId: string
  recordedAt: number
  stateLabel: ParsedSwarmCheckpoint['stateLabel']
  checkpointStatus: ParsedSwarmCheckpoint['checkpointStatus']
  runtimeState: ParsedSwarmCheckpoint['runtimeState']
  filesChanged: string | null
  commandsRun: string | null
  result: string | null
  blocker: string | null
  nextAction: string | null
  source: string
  tokenUsage?: SwarmMissionTokenUsage | null
}

export type SwarmMission = {
  id: string
  title: string
  authority?: SwarmMissionAuthority | null
  repository?: SwarmMissionRepository | null
  initiatedBy?: string | null
  returnSessionKey?: string | null
  budget?: SwarmMissionBudget | null
  workMode?: 'direct' | 'governed' | 'autonomous'
  tokenUsage?: SwarmMissionTokenUsage | null
  state: SwarmMissionState
  createdAt: number
  updatedAt: number
  assignments: Array<SwarmMissionAssignment>
  events: Array<SwarmMissionEvent>
}

type SwarmMissionStore = {
  version: 1
  missions: Array<SwarmMission>
}

export const SWARM_MISSIONS_PATH = join(SWARM_CANONICAL_REPO, '.runtime', 'swarm-missions.json')

function now(): number {
  return Date.now()
}

function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function readStore(): SwarmMissionStore {
  if (!existsSync(SWARM_MISSIONS_PATH)) return { version: 1, missions: [] }
  try {
    const parsed = JSON.parse(readFileSync(SWARM_MISSIONS_PATH, 'utf8')) as SwarmMissionStore
    const missions = Array.isArray(parsed.missions) ? parsed.missions : []
    for (const mission of missions) {
      mission.workMode ??= 'direct'
      if (mission.budget) mission.budget.mode ??= 'advisory'
    }
    return { version: 1, missions }
  } catch {
    return { version: 1, missions: [] }
  }
}

function writeStore(store: SwarmMissionStore): void {
  mkdirSync(dirname(SWARM_MISSIONS_PATH), { recursive: true })
  const tmp = `${SWARM_MISSIONS_PATH}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n')
  renameSync(tmp, SWARM_MISSIONS_PATH)
}

function event(type: SwarmMissionEvent['type'], message: string, extra?: Partial<SwarmMissionEvent>): SwarmMissionEvent {
  return { id: shortId('evt'), type, at: now(), message, ...extra }
}

function reportFromCheckpoint(input: {
  missionId: string
  assignmentId: string
  workerId: string
  checkpoint: ParsedSwarmCheckpoint
  source?: string | null
  tokenUsage?: SwarmMissionTokenUsage | null
}): SwarmCheckpointReport {
  return {
    missionId: input.missionId,
    assignmentId: input.assignmentId,
    workerId: input.workerId,
    recordedAt: now(),
    stateLabel: input.checkpoint.stateLabel,
    checkpointStatus: input.checkpoint.checkpointStatus,
    runtimeState: input.checkpoint.runtimeState,
    filesChanged: input.checkpoint.filesChanged,
    commandsRun: input.checkpoint.commandsRun,
    result: input.checkpoint.result,
    blocker: input.checkpoint.blocker,
    nextAction: input.checkpoint.nextAction,
    source: input.source?.trim() || 'unknown',
    tokenUsage: input.tokenUsage ?? null,
  }
}

function deriveMissionState(assignments: Array<SwarmMissionAssignment>): SwarmMissionState {
  if (assignments.length > 0 && assignments.every((item) => item.state === 'cancelled')) return 'cancelled'
  if (assignments.some((item) => item.state === 'blocked' || item.state === 'needs_input')) return 'blocked'
  if (assignments.length > 0 && assignments.every((item) => item.state === 'done' || item.state === 'cancelled' || (item.state === 'checkpointed' && !item.reviewRequired))) return 'complete'
  if (assignments.some((item) => item.state === 'reviewing' || (item.state === 'checkpointed' && item.reviewRequired))) return 'reviewing'
  if (assignments.some((item) => item.state === 'dispatched' || item.state === 'checkpointed')) return 'executing'
  return 'planning'
}

function inferReviewRequired(task: string, rationale?: string | null): boolean {
  // Match intent-bearing task terms only. The previous loose alternation matched
  // substrings such as "patch" inside "dispatch" and left simple smoke runs in
  // review forever.
  return /\b(code|patch(?:es|ed|ing)?|implement(?:ation|ed|ing)?|pr|benchmarks?)\b/i.test(`${task} ${rationale ?? ''}`)
}

const TERMINAL_ASSIGNMENT_STATES = new Set<SwarmMissionAssignmentState>(['done', 'cancelled'])

function isTerminalAssignment(assignment: SwarmMissionAssignment): boolean {
  return TERMINAL_ASSIGNMENT_STATES.has(assignment.state)
}

function unavailableTokenUsage(measuredAt = now()): SwarmMissionTokenUsage {
  return { available: false, source: 'state.db:sessions', measuredAt, inputTokens: null, outputTokens: null, totalTokens: null, overBudget: null }
}

function measureAssignmentTokenUsage(assignment: SwarmMissionAssignment, tokenLimit: number | null): void {
  const current = readWorkerTokenUsage(getSwarmProfilePath(assignment.workerId))
  const baseline = assignment.tokenBaseline
  if (!baseline?.available || !current.available) {
    assignment.tokenUsage = unavailableTokenUsage(current.measuredAt)
    return
  }
  const inputTokens = Math.max(0, (current.inputTokens ?? 0) - (baseline.inputTokens ?? 0))
  const outputTokens = Math.max(0, (current.outputTokens ?? 0) - (baseline.outputTokens ?? 0))
  const totalTokens = inputTokens + outputTokens
  assignment.tokenUsage = { available: true, source: current.source, measuredAt: current.measuredAt, inputTokens, outputTokens, totalTokens, overBudget: tokenLimit === null ? false : totalTokens > tokenLimit }
}

function aggregateMissionTokenUsage(mission: SwarmMission): void {
  const measured = mission.assignments.map((assignment) => assignment.tokenUsage).filter((usage): usage is SwarmMissionTokenUsage => Boolean(usage?.available))
  if (measured.length === 0) {
    mission.tokenUsage = unavailableTokenUsage()
    return
  }
  const inputTokens = measured.reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0)
  const outputTokens = measured.reduce((sum, usage) => sum + (usage.outputTokens ?? 0), 0)
  const totalTokens = inputTokens + outputTokens
  const tokenLimit = mission.budget?.tokenLimit ?? null
  mission.tokenUsage = { available: true, source: 'state.db:sessions', measuredAt: Math.max(...measured.map((usage) => usage.measuredAt)), inputTokens, outputTokens, totalTokens, overBudget: tokenLimit === null ? false : totalTokens > tokenLimit }
}

export function listSwarmMissions(limit = 20): Array<SwarmMission> {
  return readStore().missions
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, Math.min(100, limit)))
}

export function getSwarmMission(missionId: string): SwarmMission | null {
  return readStore().missions.find((mission) => mission.id === missionId) ?? null
}

export function archiveStaleMissions(staleMs: number = 6 * 60 * 60 * 1000): { archivedIds: Array<string>; count: number } {
  const store = readStore()
  const now = Date.now()
  const archivedIds: Array<string> = []
  for (const mission of store.missions) {
    if (mission.state !== 'executing' && mission.state !== 'planning') continue
    if ((now - mission.updatedAt) < staleMs) continue
    if (!mission.assignments.every(a => ['done', 'checkpointed', 'blocked', 'needs_input'].includes(a.state))) continue
    mission.state = 'complete'
    mission.events.push(event('continuation', `Archived as stale (>${Math.round(staleMs / 3600000)}h, all assignments terminal)`))
    archivedIds.push(mission.id)
  }
  if (archivedIds.length) {
    writeStore(store)
  }
  return { archivedIds, count: archivedIds.length }
}

export type CreateOrUpdateMissionResult = SwarmMission & { _created?: boolean }

export function createOrUpdateMission(input: {
  missionId?: string | null
  title: string
  authority?: SwarmMissionAuthority | null
  repository?: SwarmMissionRepository | null
  initiatedBy?: string | null
  returnSessionKey?: string | null
  budget?: SwarmMissionBudget | null
  workMode?: 'direct' | 'governed' | 'autonomous'
  assignments: Array<{ workerId: string; task: string; rationale?: string | null; dependsOn?: Array<string>; reviewRequired?: boolean }>
}): CreateOrUpdateMissionResult {
  const store = readStore()
  const createdAt = now()
  const missionId = input.missionId?.trim() || shortId('mission')
  let mission = store.missions.find((item) => item.id === missionId)
  let createdMission = false
  if (!mission) {
    mission = {
      id: missionId,
      title: input.title || 'Untitled swarm mission',
      authority: input.authority ?? null,
      repository: input.repository ?? null,
      initiatedBy: input.initiatedBy ?? null,
      returnSessionKey: input.returnSessionKey ?? null,
      budget: input.budget ?? null,
      workMode: input.workMode ?? 'direct',
      tokenUsage: unavailableTokenUsage(createdAt),
      state: 'planning',
      createdAt,
      updatedAt: createdAt,
      assignments: [],
      events: [event('created', `Mission created: ${input.title || missionId}`, {
        data: input.authority ? {
          authoritySystem: input.authority.system,
          authorityId: input.authority.id,
          authorityUrl: input.authority.url,
        } : undefined,
      })],
    }
    store.missions.push(mission)
    createdMission = true
  }

  if (!mission) throw new Error(`Failed to create mission ${missionId}`)

  mission.title = input.title || mission.title
  if (input.authority !== undefined) mission.authority = input.authority
  if (input.repository !== undefined) mission.repository = input.repository
  if (input.initiatedBy !== undefined) mission.initiatedBy = input.initiatedBy
  if (input.returnSessionKey !== undefined) mission.returnSessionKey = input.returnSessionKey
  if (input.budget !== undefined) mission.budget = input.budget
  if (mission.budget) mission.budget.mode = 'advisory'
  if (input.workMode !== undefined) mission.workMode = input.workMode
  mission.workMode ??= 'direct'
  for (const assignment of input.assignments) {
    const existing = mission.assignments.find((item) => item.workerId === assignment.workerId && item.task === assignment.task)
    if (existing) continue
    const id = shortId('assign')
    mission.assignments.push({
      id,
      workerId: assignment.workerId,
      task: assignment.task,
      rationale: assignment.rationale ?? null,
      dependsOn: assignment.dependsOn ?? [],
      reviewRequired: assignment.reviewRequired ?? inferReviewRequired(assignment.task, assignment.rationale),
      state: 'queued',
      dispatchedAt: null,
      completedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      checkpoint: null,
      tokenBaseline: null,
      tokenUsage: null,
    })
  }
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return Object.assign(mission, { _created: createdMission })
}

export function markMissionAssignmentDispatched(input: {
  missionId: string
  workerId: string
  task: string
  source?: string | null
  author?: string | null
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled' || mission.state === 'complete') return mission
  const assignment = mission.assignments.find((item) => item.workerId === input.workerId && item.task === input.task)
  if (!assignment) return null
  if (isTerminalAssignment(assignment)) return mission
  assignment.state = 'dispatched'
  assignment.dispatchedAt = now()
  assignment.tokenBaseline = readWorkerTokenUsage(getSwarmProfilePath(input.workerId))
  mission.events.push(event('assignment_dispatched', `Dispatched ${assignment.id} to ${input.workerId}`, {
    workerId: input.workerId,
    assignmentId: assignment.id,
    data: {
      task: assignment.task,
      source: input.source?.trim() || 'swarm-dispatch',
      author: input.author?.trim() || 'aurora',
    },
  }))
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

export type RecordCheckpointResult = (SwarmMission & { _completed?: boolean; _ignoredReason?: string }) | null

export function recordMissionCheckpoint(input: {
  missionId?: string | null
  assignmentId?: string | null
  workerId: string
  checkpoint: ParsedSwarmCheckpoint
  source?: string | null
}): RecordCheckpointResult {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled') return Object.assign(mission, { _ignoredReason: 'mission cancelled' })
  const assignment = (input.assignmentId
    ? mission.assignments.find((item) => item.id === input.assignmentId)
    : null)
    ?? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId && item.state !== 'done')
    ?? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId)
  if (!assignment) return null
  if (assignment.state === 'cancelled') return Object.assign(mission, { _ignoredReason: 'assignment cancelled' })
  if (assignment.state === 'done') return Object.assign(mission, { _ignoredReason: 'assignment done' })
  if (assignment.checkpoint?.raw === input.checkpoint.raw) {
    return Object.assign(mission, { _completed: mission.state === 'complete' })
  }
  assignment.checkpoint = input.checkpoint
  assignment.completedAt = now()
  assignment.state = input.checkpoint.stateLabel === 'BLOCKED'
    ? 'blocked'
    : input.checkpoint.stateLabel === 'NEEDS_INPUT'
      ? 'needs_input'
      : input.checkpoint.stateLabel === 'IN_PROGRESS'
        ? 'dispatched'
        : 'checkpointed'
  measureAssignmentTokenUsage(assignment, mission.budget?.tokenLimit ?? null)
  aggregateMissionTokenUsage(mission)
  const report = reportFromCheckpoint({
    missionId: mission.id,
    assignmentId: assignment.id,
    workerId: input.workerId,
    checkpoint: input.checkpoint,
    source: input.source,
    tokenUsage: assignment.tokenUsage,
  })
  mission.events.push(event('checkpoint', `${input.workerId} checkpointed: ${input.checkpoint.stateLabel}`, {
    workerId: input.workerId,
    assignmentId: assignment.id,
    data: report,
  }))
  mission.updatedAt = now()
  const previousState = mission.state
  mission.state = deriveMissionState(mission.assignments)
  const completed = mission.state === 'complete' && previousState !== 'complete'
  writeStore(store)
  return Object.assign(mission, { _completed: completed })
}

export function recordMissionAssignmentBlocked(input: {
  missionId?: string | null
  assignmentId?: string | null
  workerId: string
  reason?: string | null
  source?: string | null
}): { mission: SwarmMission; assignment: SwarmMissionAssignment; changed: boolean } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled' || mission.state === 'complete') return null
  const assignment = (input.assignmentId
    ? mission.assignments.find((item) => item.id === input.assignmentId)
    : null)
    ?? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId && !isTerminalAssignment(item))
    ?? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId)
  if (!assignment) return null
  if (assignment.state === 'cancelled' || assignment.state === 'done') return { mission, assignment, changed: false }

  const reason = input.reason?.trim() || 'Dispatch failed before a worker checkpoint was recorded.'
  const blockedAt = now()
  const checkpoint: ParsedSwarmCheckpoint = {
    stateLabel: 'BLOCKED',
    runtimeState: 'blocked',
    checkpointStatus: 'blocked',
    filesChanged: 'none',
    commandsRun: 'none',
    result: null,
    blocker: reason,
    nextAction: 'Fix blocker and retry dispatch.',
    raw: `STATE: BLOCKED\nFILES_CHANGED: none\nCOMMANDS_RUN: none\nRESULT: none\nBLOCKER: ${reason}\nNEXT_ACTION: Fix blocker and retry dispatch.`,
  }
  const changed = assignment.state !== 'blocked' || assignment.checkpoint?.raw !== checkpoint.raw
  assignment.state = 'blocked'
  assignment.completedAt = blockedAt
  assignment.checkpoint = checkpoint
  measureAssignmentTokenUsage(assignment, mission.budget?.tokenLimit ?? null)
  aggregateMissionTokenUsage(mission)
  const report = reportFromCheckpoint({
    missionId: mission.id,
    assignmentId: assignment.id,
    workerId: input.workerId,
    checkpoint,
    source: input.source,
    tokenUsage: assignment.tokenUsage,
  })
  if (changed) {
    mission.events.push(event('blocked', `${input.workerId} blocked: ${reason}`, {
      workerId: input.workerId,
      assignmentId: assignment.id,
      data: report,
    }))
  }
  mission.updatedAt = blockedAt
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return { mission, assignment, changed }
}

export function appendMissionContinuation(input: {
  missionId?: string | null
  workerId: string
  task: string
  rationale: string
}): SwarmMission | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled') return null
  const id = shortId('assign')
  mission.assignments.push({
    id,
    workerId: input.workerId,
    task: input.task,
    rationale: input.rationale,
    dependsOn: [],
    reviewRequired: false,
    state: 'queued',
    dispatchedAt: null,
    completedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    checkpoint: null,
  })
  mission.events.push(event('continuation', `Queued continuation ${id} for ${input.workerId}`, { workerId: input.workerId, assignmentId: id }))
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

export function readyQueuedAssignments(missionId: string): Array<SwarmMissionAssignment> {
  const mission = getSwarmMission(missionId)
  if (!mission) return []
  const doneIds = new Set(mission.assignments.filter((item) => ['checkpointed', 'done'].includes(item.state)).map((item) => item.id))
  return mission.assignments.filter((item) => item.state === 'queued' && item.dependsOn.every((id) => doneIds.has(id)))
}

export function cancelSwarmAssignment(input: {
  missionId?: string | null
  assignmentId?: string | null
  workerId?: string | null
  actor?: string | null
  reason?: string | null
}): { mission: SwarmMission; assignment: SwarmMissionAssignment; changed: boolean } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const assignment = (input.assignmentId
    ? mission.assignments.find((item) => item.id === input.assignmentId)
    : null)
    ?? (input.workerId ? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId && !isTerminalAssignment(item)) : null)
    ?? null
  if (!assignment) return null
  if (assignment.state === 'cancelled') return { mission, assignment, changed: false }
  const cancelledAt = now()
  measureAssignmentTokenUsage(assignment, mission.budget?.tokenLimit ?? null)
  assignment.state = 'cancelled'
  assignment.completedAt = cancelledAt
  assignment.reviewedAt = cancelledAt
  assignment.reviewedBy = input.actor?.trim() || 'system-cancel'
  mission.events.push(event('assignment_cancelled', `Cancelled ${assignment.id}${input.reason ? `: ${input.reason}` : ''}`, {
    workerId: assignment.workerId,
    assignmentId: assignment.id,
    data: {
      actor: input.actor?.trim() || 'system-cancel',
      reason: input.reason?.trim() || null,
    },
  }))
  mission.updatedAt = cancelledAt
  mission.state = deriveMissionState(mission.assignments)
  aggregateMissionTokenUsage(mission)
  writeStore(store)
  return { mission, assignment, changed: true }
}

export function cancelSwarmMission(input: {
  missionId?: string | null
  actor?: string | null
  reason?: string | null
}): { mission: SwarmMission; cancelledAssignmentIds: Array<string>; changed: boolean } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const cancelledAt = now()
  const cancelledAssignmentIds: Array<string> = []
  for (const assignment of mission.assignments) {
    if (isTerminalAssignment(assignment)) continue
    measureAssignmentTokenUsage(assignment, mission.budget?.tokenLimit ?? null)
    assignment.state = 'cancelled'
    assignment.completedAt = cancelledAt
    assignment.reviewedAt = cancelledAt
    assignment.reviewedBy = input.actor?.trim() || 'system-cancel'
    cancelledAssignmentIds.push(assignment.id)
  }
  mission.state = 'cancelled'
  mission.updatedAt = cancelledAt
  aggregateMissionTokenUsage(mission)
  mission.events.push(event('mission_cancelled', `Cancelled mission${input.reason ? `: ${input.reason}` : ''}`, {
    data: {
      actor: input.actor?.trim() || 'system-cancel',
      reason: input.reason?.trim() || null,
      cancelledAssignmentIds,
    },
  }))
  writeStore(store)
  return { mission, cancelledAssignmentIds, changed: cancelledAssignmentIds.length > 0 }
}

export function markMissionAssignmentReviewed(input: { missionId?: string | null; assignmentId: string; reviewerId?: string }): SwarmMission | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const assignment = mission.assignments.find((item) => item.id === input.assignmentId)
  if (!assignment) return null
  assignment.state = 'done'
  assignment.reviewedAt = now()
  assignment.reviewedBy = input.reviewerId ?? null
  mission.events.push(event('review', `Reviewed ${assignment.id}${input.reviewerId ? ` by ${input.reviewerId}` : ''}`, { workerId: input.reviewerId, assignmentId: assignment.id }))
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

export function markMissionAssignmentsReviewedByWorker(input: {
  missionId?: string | null
  reviewerId: string
  excludeAssignmentId?: string | null
}): { mission: SwarmMission; reviewedAssignmentIds: Array<string> } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null

  const reviewedAt = now()
  const reviewed = mission.assignments.filter((assignment) => (
    assignment.id !== input.excludeAssignmentId
    && assignment.workerId !== input.reviewerId
    && assignment.reviewRequired
    && assignment.state === 'checkpointed'
  ))

  if (reviewed.length === 0) return { mission, reviewedAssignmentIds: [] }

  for (const assignment of reviewed) {
    assignment.state = 'done'
    assignment.reviewedAt = reviewedAt
    assignment.reviewedBy = input.reviewerId
    mission.events.push(event('review', `Reviewed ${assignment.id} by ${input.reviewerId}`, {
      workerId: input.reviewerId,
      assignmentId: assignment.id,
    }))
  }

  mission.updatedAt = reviewedAt
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return { mission, reviewedAssignmentIds: reviewed.map((assignment) => assignment.id) }
}

export function listSwarmReports(input?: {
  missionId?: string | null
  workerId?: string | null
  limit?: number
}): Array<SwarmCheckpointReport> {
  const limit = Math.max(1, Math.min(500, input?.limit ?? 100))
  const mission = input?.missionId ? getSwarmMission(input.missionId) : null
  const missions = mission ? [mission] : readStore().missions

  return missions
    .flatMap((entry) => entry.events)
    .filter((event) => event.type === 'checkpoint' && event.data)
    .map((event) => event.data as SwarmCheckpointReport)
    .filter((report) => !input?.workerId || report.workerId === input.workerId)
    .sort((a, b) => b.recordedAt - a.recordedAt)
    .slice(0, limit)
}
