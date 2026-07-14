import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { ParsedSwarmCheckpoint } from './swarm-checkpoints'
import { getSwarmProfilePath } from './swarm-foundation'
import { publishChatEvent } from './chat-event-bus'

const ORCHESTRATOR_WORKER_ID = process.env.SWARM_ORCHESTRATOR_WORKER_ID?.trim() || 'orchestrator'
const ORCHESTRATOR_TMUX_SESSION = `swarm-${ORCHESTRATOR_WORKER_ID}`
const MAIN_SESSION_KEY = process.env.SWARM_MAIN_SESSION_KEY?.trim() || 'main'

function tmuxSessionExists(session: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function tmuxSendText(session: string, text: string): { sent: boolean; error?: string } {
  if (!tmuxSessionExists(session)) {
    return { sent: false, error: `tmux session ${session} not found` }
  }
  try {
    // Use literal mode so multi-line content sends without shell interpretation, then send Enter to submit.
    execFileSync('tmux', ['send-keys', '-t', session, '-l', text], { stdio: 'ignore' })
    execFileSync('tmux', ['send-keys', '-t', session, 'Enter'], { stdio: 'ignore' })
    return { sent: true }
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function orchestratorPromptForCheckpoint(input: {
  workerId: string
  checkpoint: ParsedSwarmCheckpoint
  missionId?: string | null
}): string {
  const lines: Array<string> = [
    `## Checkpoint from ${input.workerId}`,
    `STATE: ${input.checkpoint.stateLabel}`,
  ]
  if (input.missionId) lines.push(`Mission: ${input.missionId}`)
  if (input.checkpoint.result) lines.push(`Result: ${input.checkpoint.result}`)
  if (input.checkpoint.blocker && input.checkpoint.blocker.toLowerCase() !== 'none') {
    lines.push(`Blocker: ${input.checkpoint.blocker}`)
  }
  if (input.checkpoint.nextAction && input.checkpoint.nextAction.toLowerCase() !== 'none') {
    lines.push(`Next: ${input.checkpoint.nextAction}`)
  }
  lines.push('')
  lines.push(`Decide next action per the swarm review spec for ${input.workerId} and the swarm auto-repair playbook:`)
  lines.push(`- DONE → mark mission complete, assign next from lane priority`)
  lines.push(`- HANDOFF → dispatch to named worker per next_action`)
  lines.push(`- BLOCKED → consult auto-repair.yaml; if not in playbook, escalate to the main agent (publish to '${MAIN_SESSION_KEY}')`)
  lines.push(`- NEEDS_INPUT → escalate to the main agent`)
  lines.push(`- NEEDS_REVIEW → queue Inbox card, route to Eric`)
  lines.push('')
  lines.push(`Reply with the dispatch you fired (POST /api/swarm-dispatch on http://localhost:3002) OR the escalation summary.`)
  return lines.join('\n')
}

export function publishCheckpointToOrchestrator(input: {
  workerId: string
  checkpoint: ParsedSwarmCheckpoint
  missionId?: string | null
}): { sent: boolean; session: string; error?: string; skippedSelf?: boolean } {
  // Don't echo a checkpoint into the orchestrator's own pane.
  if (input.workerId === ORCHESTRATOR_WORKER_ID) {
    return { sent: false, session: ORCHESTRATOR_TMUX_SESSION, skippedSelf: true }
  }
  const text = orchestratorPromptForCheckpoint(input)
  const result = tmuxSendText(ORCHESTRATOR_TMUX_SESSION, text)
  return { ...result, session: ORCHESTRATOR_TMUX_SESSION }
}

function publishChatStatus(sessionKey: string, text: string): void {
  publishChatEvent('status', {
    type: 'status',
    sessionKey,
    transport: 'chat-events',
    text,
  })
}

function readRuntime(runtimePath: string): Record<string, unknown> {
  if (!existsSync(runtimePath)) return {}
  try {
    return JSON.parse(readFileSync(runtimePath, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeRuntime(runtimePath: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(runtimePath), { recursive: true })
  const tmp = `${runtimePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, runtimePath)
}

function checkpointSummary(checkpoint: ParsedSwarmCheckpoint): string {
  const parts = [
    checkpoint.result,
    checkpoint.blocker && checkpoint.blocker.toLowerCase() !== 'none' ? `Blocker: ${checkpoint.blocker}` : null,
    checkpoint.nextAction && checkpoint.nextAction.toLowerCase() !== 'none' ? `Next: ${checkpoint.nextAction}` : null,
  ].filter(Boolean)
  return parts.join(' | ')
}

export function publishSwarmActionPrompt(input: {
  sessionKey?: string | null
  missionId?: string | null
  title: string
  text: string
  details?: Record<string, unknown>
}): { published: boolean; sessionKey: string } {
  const sessionKey = input.sessionKey?.trim() || 'main'
  const headline = input.missionId ? `[Swarm] ${input.title} — Mission: ${input.missionId}` : `[Swarm] ${input.title}`
  const messageText = [headline, input.text].filter(Boolean).join('\n')

  publishChatEvent('message', {
    type: 'message',
    sessionKey,
    transport: 'chat-events',
    message: {
      role: 'assistant',
      timestamp: Date.now(),
      content: [{ type: 'text', text: messageText }],
      details: {
        source: 'swarm-orchestrator',
        missionId: input.missionId ?? null,
        ...input.details,
      },
    },
  })

  publishChatStatus(sessionKey, `${headline} — ${input.text}`)
  return { published: true, sessionKey }
}

function isTerminalCheckpoint(stateLabel: string): boolean {
  return stateLabel === 'DONE' || stateLabel === 'BLOCKED' || stateLabel === 'HANDOFF' || stateLabel === 'NEEDS_INPUT'
}

export function publishSwarmCheckpointNotification(input: {
  workerId: string
  checkpoint: ParsedSwarmCheckpoint
  missionId?: string | null
  assignmentId?: string | null
  notifySessionKey?: string | null
}): { published: boolean; sessionKey: string; route: 'orchestrator' | 'desktop' | 'noop'; orchestrator?: { sent: boolean; session: string; error?: string; skippedSelf?: boolean } } {
  const profilePath = getSwarmProfilePath(input.workerId)
  const runtimePath = join(profilePath, 'runtime.json')
  const current = readRuntime(runtimePath)
  const currentRaw = typeof current.lastNotifiedCheckpointRaw === 'string' ? current.lastNotifiedCheckpointRaw : null
  const currentSig = typeof current.lastNotifiedCheckpointSignature === 'string' ? current.lastNotifiedCheckpointSignature : null
  const notifiedSignatures = Array.isArray(current.notifiedCheckpointSignatures)
    ? current.notifiedCheckpointSignatures.filter((value): value is string => typeof value === 'string')
    : []
  const checkpointRaw = input.checkpoint.raw?.trim() || ''
  const sessionKey = input.notifySessionKey?.trim() || (typeof current.notifySessionKey === 'string' && current.notifySessionKey.trim()) || MAIN_SESSION_KEY

  // Build a checkpoint signature that includes state + status + raw + result, so dedupe
  // doesn't suppress a notification when raw text is empty/recycled but the semantic
  // state actually changed (e.g. worker went executing -> done with same scraped raw).
  const checkpointSignature = [
    input.missionId ?? '',
    input.assignmentId ?? '',
    input.checkpoint.stateLabel,
    input.checkpoint.checkpointStatus ?? '',
    input.checkpoint.result ?? '',
    input.checkpoint.blocker ?? '',
    input.checkpoint.nextAction ?? '',
    checkpointRaw,
  ].join('|')

  if ((currentSig && currentSig === checkpointSignature) || notifiedSignatures.includes(checkpointSignature)) {
    return { published: false, sessionKey, route: 'noop' }
  }
  // Backwards-compat: if no signature was ever stored but raw matches AND nothing else
  // could have changed (raw is non-empty + state matches a 'no progress' shape), still skip.
  // Otherwise, fall through and publish.
  if (!currentSig && checkpointRaw && currentRaw === checkpointRaw && (input.checkpoint.stateLabel === 'IN_PROGRESS' || !input.checkpoint.stateLabel)) {
    return { published: false, sessionKey, route: 'noop' }
  }

  const headline = `[${input.workerId}] ${input.checkpoint.stateLabel}`
  const text = [
    headline,
    input.missionId ? `Mission: ${input.missionId}` : null,
    checkpointSummary(input.checkpoint),
  ].filter(Boolean).join(' — ')

  // 1. Route to orchestrator by default.
  const orchestratorResult = publishCheckpointToOrchestrator({
    workerId: input.workerId,
    checkpoint: input.checkpoint,
    missionId: input.missionId,
  })

  // Terminal evidence is always visible in the originating Desktop session.
  // IN_PROGRESS remains orchestrator-only unless that route is unavailable.
  const mustPublishToDesktop = isTerminalCheckpoint(input.checkpoint.stateLabel) || (!orchestratorResult.sent && !orchestratorResult.skippedSelf)
  let publishedToDesktop = false

  if (mustPublishToDesktop) {
    publishChatEvent('message', {
      type: 'message',
      sessionKey,
      transport: 'chat-events',
      message: {
        role: 'assistant',
        timestamp: Date.now(),
        content: [{ type: 'text', text }],
        details: {
          source: 'swarm-checkpoint',
          workerId: input.workerId,
          missionId: input.missionId ?? null,
          assignmentId: input.assignmentId ?? null,
          checkpointState: input.checkpoint.stateLabel,
          escalationReason: isTerminalCheckpoint(input.checkpoint.stateLabel)
            ? `terminal state ${input.checkpoint.stateLabel} published to originating Desktop session`
            : `orchestrator unreachable: ${orchestratorResult.error ?? 'unknown'}`,
        },
      },
    })
    publishChatStatus(sessionKey, text)
    publishedToDesktop = true
  }

  const latest = readRuntime(runtimePath)
  const latestSignatures = Array.isArray(latest.notifiedCheckpointSignatures)
    ? latest.notifiedCheckpointSignatures.filter((value): value is string => typeof value === 'string')
    : notifiedSignatures
  writeRuntime(runtimePath, {
    ...latest,
    notifySessionKey: sessionKey,
    lastNotifiedCheckpointRaw: checkpointRaw || null,
    lastNotifiedCheckpointSignature: checkpointSignature,
    notifiedCheckpointSignatures: [...new Set([...latestSignatures, checkpointSignature])].slice(-50),
    lastNotifiedAt: new Date().toISOString(),
    lastCheckpointRoute: publishedToDesktop ? 'desktop' : 'orchestrator',
    lastOrchestratorSendOk: orchestratorResult.sent,
  })

  const route: 'orchestrator' | 'desktop' | 'noop' = publishedToDesktop ? 'desktop' : (orchestratorResult.sent || orchestratorResult.skippedSelf ? 'orchestrator' : 'noop')
  return { published: publishedToDesktop || orchestratorResult.sent, sessionKey, route, orchestrator: orchestratorResult }
}

export function publishSwarmCancellationNotification(input: {
  missionId: string
  sessionKey?: string | null
  reason: string
  assignmentId?: string | null
}): { published: boolean; sessionKey: string } {
  return publishSwarmActionPrompt({
    sessionKey: input.sessionKey,
    missionId: input.missionId,
    title: input.assignmentId ? 'Assignment cancelled' : 'Mission cancelled',
    text: input.reason,
    details: { source: 'swarm-cancellation', assignmentId: input.assignmentId ?? null },
  })
}
