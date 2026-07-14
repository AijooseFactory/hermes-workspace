import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrUpdateMission, getSwarmMission } from '../../server/swarm-missions'
import {
  buildHermesChatQueryArgs,
  buildHermesTmuxLaunchCommand,
  buildWorkerPrompt,
  checkpointFromRuntimeSnapshot,
  dispatchBlockReason,
  dispatchSwarmAssignments,
  runtimeCheckpointSignature,
  runtimeSnapshotIsFresh,
} from './swarm-dispatch'

const tempRoot = vi.hoisted(() => `/tmp/swarm-dispatch-test-${process.pid}-${Date.now()}`)
const execScenario = vi.hoisted(() => ({ mode: 'unavailable' as 'unavailable' | 'delayed-oneshot' | 'live' }))
const publishCheckpoint = vi.hoisted(() => vi.fn())

vi.mock('../../server/swarm-environment', () => ({
  SWARM_CANONICAL_REPO: tempRoot,
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: Array<unknown>) => {
    const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void
    const commandArgs = args[1] as Array<string>
    if (execScenario.mode === 'delayed-oneshot' && commandArgs[0] === 'chat') {
      setTimeout(() => callback(null as unknown as Error, 'STATE: DONE\nFILES_CHANGED: none\nCOMMANDS_RUN: test\nRESULT: delayed complete\nBLOCKER: none\nNEXT_ACTION: none', ''), 120)
    } else if (execScenario.mode === 'live') queueMicrotask(() => callback(null as unknown as Error, '', ''))
    else queueMicrotask(() => callback(new Error('command unavailable in test'), '', ''))
    return { stdin: { end: vi.fn() }, on: vi.fn() }
  }),
}))

vi.mock('../../server/swarm-notifications', () => ({ publishSwarmCheckpointNotification: publishCheckpoint }))

vi.mock('../../server/swarm-memory', () => ({
  appendSwarmMemoryEvent: vi.fn(),
  buildSwarmStartupSnapshot: vi.fn(() => ({ rendered: '' })),
}))

vi.mock('../../server/swarm-profile-config', () => ({
  ensureSwarmProfileConfig: vi.fn(),
}))

const originalHermesHome = process.env.HERMES_HOME

afterEach(() => {
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  rmSync(tempRoot, { recursive: true, force: true })
  execScenario.mode = 'unavailable'
  publishCheckpoint.mockClear()
})

describe('dispatchSwarmAssignments', () => {
  it('returns before a delayed one-shot fallback and completes the mission in the background', async () => {
    process.env.HERMES_HOME = join(tempRoot, 'hermes')
    const workerId = 'async-fallback-worker'
    mkdirSync(join(tempRoot, 'hermes', 'profiles', workerId), { recursive: true })
    execScenario.mode = 'delayed-oneshot'
    const startedAt = Date.now()
    const result = await dispatchSwarmAssignments({ missionId: 'mission-async-fallback', returnSessionKey: 'desktop-return', assignments: [{ workerId, task: 'Finish later', reviewRequired: false }], waitForCheckpoint: false, allowAsync: true })
    expect(Date.now() - startedAt).toBeLessThan(100)
    expect(result.results[0]).toMatchObject({ workerId, accepted: true })
    expect(getSwarmMission(result.missionId)?.state).not.toBe('complete')
    await vi.waitFor(() => expect(getSwarmMission(result.missionId)?.state).toBe('complete'), { timeout: 1_000 })
    expect(getSwarmMission(result.missionId)?.assignments[0]?.checkpoint?.result).toBe('delayed complete')
    expect(publishCheckpoint).toHaveBeenCalledTimes(1)
    expect(publishCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ notifySessionKey: 'desktop-return' }))
  })

  it('monitors a live async tmux dispatch after returning and records its terminal checkpoint once', async () => {
    process.env.HERMES_HOME = join(tempRoot, 'hermes')
    const workerId = 'live-worker'
    const profilePath = join(tempRoot, 'hermes', 'profiles', workerId)
    mkdirSync(profilePath, { recursive: true })
    writeFileSync(join(profilePath, 'runtime.json'), '{}')
    execScenario.mode = 'live'
    const result = await dispatchSwarmAssignments({ missionId: 'mission-live-monitor', assignments: [{ workerId, task: 'Complete live', reviewRequired: false }], waitForCheckpoint: false, allowAsync: true, checkpointPollSeconds: 5 })
    expect(result.results[0]).toMatchObject({ accepted: true })
    expect(getSwarmMission(result.missionId)?.state).not.toBe('complete')
    setTimeout(() => writeFileSync(join(profilePath, 'runtime.json'), JSON.stringify({ checkpointStatus: 'done', state: 'idle', lastResult: 'live complete', lastCheckIn: new Date().toISOString(), lastOutputAt: Date.now() })), 3_200)
    await vi.waitFor(() => expect(getSwarmMission(result.missionId)?.state).toBe('complete'), { timeout: 7_000, interval: 100 })
    expect(getSwarmMission(result.missionId)?.events.filter((event) => event.type === 'checkpoint')).toHaveLength(1)
    expect(publishCheckpoint).toHaveBeenCalledTimes(1)
  }, 8_000)

  it('accepts autonomous work mode and project authority while keeping token limits advisory', async () => {
    process.env.HERMES_HOME = join(tempRoot, 'hermes')
    const result = await dispatchSwarmAssignments({
      missionId: 'mission-autonomous-controls', missionTitle: 'Autonomous controls', workMode: 'autonomous',
      authoritySystem: 'project', authorityId: 'AIJ', authorityUrl: 'project://AIJ',
      returnSessionKey: 'desktop-session-42', tokenLimit: 10,
      assignments: [{ workerId: 'missing-test-worker', task: 'Continue without a hard token gate' }],
      waitForCheckpoint: false, allowAsync: true,
    })
    expect(result.notifySessionKey).toBe('desktop-session-42')
    expect(result.mission).toMatchObject({ workMode: 'autonomous', authority: { system: 'project', id: 'AIJ' }, budget: { mode: 'advisory', tokenLimit: 10 } })
  })

  it('preserves mission initiator metadata when an update omits both fields', async () => {
    process.env.HERMES_HOME = join(tempRoot, 'hermes')
    const existingMission = createOrUpdateMission({
      missionId: 'mission-metadata-1',
      title: 'Preserve dispatch metadata',
      initiatedBy: 'hermes-desktop',
      returnSessionKey: 'desktop-session-1',
      assignments: [{ workerId: 'missing-test-worker', task: 'Start existing mission' }],
    })

    const result = await dispatchSwarmAssignments({
      missionId: existingMission.id,
      assignments: [{ workerId: 'missing-test-worker', task: 'Continue existing mission' }],
      waitForCheckpoint: false,
      allowAsync: true,
    })

    expect(result.mission).toMatchObject({
      initiatedBy: 'hermes-desktop',
      returnSessionKey: 'desktop-session-1',
    })
    expect(result.notifySessionKey).toBe('desktop-session-1')
  })
})

describe('checkpointFromRuntimeSnapshot', () => {
  it('maps runtime lifecycle fields into a structured checkpoint', () => {
    const checkpoint = checkpointFromRuntimeSnapshot({
      checkpointStatus: 'done',
      state: 'idle',
      lastSummary: 'Patched dispatch polling',
      lastResult: 'Structured checkpoint returned to RouterChat',
      nextAction: 'Verify in UI flow',
      blockedReason: null,
      lastCheckIn: '2026-04-28T20:00:00.000Z',
      lastOutputAt: 1_746_000_000_000,
      checkpointRaw: null,
    })

    expect(checkpoint).not.toBeNull()
    expect(checkpoint?.stateLabel).toBe('DONE')
    expect(checkpoint?.checkpointStatus).toBe('done')
    expect(checkpoint?.result).toBe('Structured checkpoint returned to RouterChat')
    expect(checkpoint?.nextAction).toBe('Verify in UI flow')
    expect(checkpoint?.raw).toContain('STATE: DONE')
  })

  it('returns null when runtime has no meaningful checkpoint fields yet', () => {
    const checkpoint = checkpointFromRuntimeSnapshot({
      checkpointStatus: 'in_progress',
      state: 'executing',
      lastSummary: null,
      lastResult: null,
      nextAction: null,
      blockedReason: null,
      lastCheckIn: '2026-04-28T20:00:00.000Z',
      lastOutputAt: 1_746_000_000_000,
      checkpointRaw: null,
    })

    expect(checkpoint).toBeNull()
  })
})

describe('dispatchBlockReason', () => {
  it('turns failed or timed-out dispatch results into mission blocker text', () => {
    expect(dispatchBlockReason({ ok: false, error: 'Command failed: worker exited', output: '', checkpointStatus: undefined })).toBe('Command failed: worker exited')
    expect(dispatchBlockReason({ ok: true, error: null, output: 'Delivered', checkpointStatus: 'timeout' })).toBe('No fresh checkpoint before poll timeout.')
    expect(dispatchBlockReason({ ok: true, error: null, output: 'Checkpoint DONE', checkpointStatus: 'checkpointed' })).toBeNull()
  })
})

describe('runtimeSnapshotIsFresh', () => {
  it('requires a changed snapshot with post-dispatch activity', () => {
    const baseline = {
      checkpointStatus: 'in_progress' as const,
      state: 'executing',
      lastSummary: 'Dispatched task',
      lastResult: null,
      nextAction: 'Wait for worker',
      blockedReason: null,
      lastCheckIn: '2026-04-28T19:59:00.000Z',
      lastOutputAt: 1_745_999_900_000,
      checkpointRaw: null,
    }
    const dispatchedAt = 1_746_000_000_000

    expect(runtimeSnapshotIsFresh(baseline, runtimeCheckpointSignature(baseline), dispatchedAt)).toBe(false)

    const updated = {
      ...baseline,
      checkpointStatus: 'done' as const,
      lastResult: 'Completed backend patch',
      nextAction: 'Hand off to UI',
      lastCheckIn: '2026-04-28T20:00:01.000Z',
      lastOutputAt: 1_746_000_001_000,
    }

    expect(runtimeSnapshotIsFresh(updated, runtimeCheckpointSignature(baseline), dispatchedAt)).toBe(true)
  })
})

describe('checkpoint filtering', () => {
  it('still parses IN_PROGRESS runtime snapshots but leaves terminal filtering to the poller', () => {
    const checkpoint = checkpointFromRuntimeSnapshot({
      checkpointStatus: 'in_progress',
      state: 'executing',
      lastSummary: 'Task is running',
      lastResult: null,
      nextAction: 'Wait for worker output',
      blockedReason: null,
      lastCheckIn: '2026-04-28T20:00:01.000Z',
      lastOutputAt: 1_746_000_001_000,
      checkpointRaw: null,
    })

    expect(checkpoint?.stateLabel).toBe('IN_PROGRESS')
  })
})

describe('buildHermesTmuxLaunchCommand', () => {
  it('keeps the tmux shell alive so startup failures leave readable output', () => {
    const command = buildHermesTmuxLaunchCommand({
      profilePath: '/tmp/hermes profiles/swarm1',
      hermesBin: '/opt/homebrew/bin/hermes',
      ghToken: 'ghp_te...3456',
    })

    expect(command).toContain("HERMES_HOME='/tmp/hermes profiles/swarm1'")
    expect(command).toContain("'/opt/homebrew/bin/hermes' chat --tui")
    expect(command).toContain('[Hermes worker exited with status %s]')
    expect(command).not.toContain('exec ')
  })
})

describe('buildHermesChatQueryArgs', () => {
  it('passes the prompt immediately after -q so flags are not parsed as the query', () => {
    const prompt = 'STATE: DONE\nRESULT: ok'
    const args = buildHermesChatQueryArgs(prompt)

    expect(args.slice(0, 3)).toEqual(['chat', '-q', prompt])
    expect(args).toContain('-Q')
    expect(args).toContain('--source')
    expect(args[1]).toBe('-q')
    expect(args[2]).toBe(prompt)
    expect(args[3]).toBe('-Q')
  })
})

describe('buildWorkerPrompt', () => {
  const roster = {
    id: 'swarm5',
    name: 'Builder',
    role: 'Primary Builder',
    specialty: 'full-stack implementation across Hermes Workspace and Swarm2',
    model: 'GPT-5.5',
    mission: 'Ship focused product slices with tests and clean diffs.',
    modes: [],
    tools: [],
    skills: ['swarm-ui-worker', 'swarm-worker-core'],
    plugins: [],
    pluginToolsets: [],
    mcpServers: [],
    capabilities: ['code-editing', 'ui-implementation', 'build-verification'],
    preferredTaskTypes: ['implementation'],
    greenlightRequiredFor: [],
    maxConcurrentTasks: 1,
    acceptsBroadcast: true,
    reviewRequired: false,
  }

  it('uses Name — Role as the human-facing label while preserving swarmN as machine ID', () => {
    const prompt = buildWorkerPrompt({
      workerId: 'swarm5',
      task: 'Patch the conductor card copy.',
      rationale: 'Builder executes implementation work.',
      roster,
    })

    expect(prompt).toContain('Worker: Builder — Primary Builder')
    expect(prompt).toContain('Machine ID: swarm5')
    expect(prompt).toContain('Mission: Ship focused product slices with tests and clean diffs.')
    expect(prompt).toContain('Capabilities: code-editing, ui-implementation, build-verification')
    expect(prompt).toContain('Skills: swarm-ui-worker, swarm-worker-core')
  })

  it('still injects role context for direct one-shot dispatch unless raw mode is explicit', () => {
    const prompt = buildWorkerPrompt({
      workerId: 'swarm5',
      task: 'Reply with exactly: BUILDER_OK',
      roster,
      direct: true,
    })

    expect(prompt).toContain('Worker: Builder — Primary Builder')
    expect(prompt).toContain('## Assigned Task')
    expect(prompt).toContain('Reply with exactly: BUILDER_OK')
  })

  it('keeps explicit raw/smoke dispatch unwrapped for minimal probes', () => {
    const prompt = buildWorkerPrompt({
      workerId: 'swarm5',
      task: 'RAW_PING_ONLY',
      roster,
      direct: true,
      raw: true,
    })

    expect(prompt).toBe('RAW_PING_ONLY')
  })
})