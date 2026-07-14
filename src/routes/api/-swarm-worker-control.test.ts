import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFile = vi.hoisted(() => vi.fn())
const authenticated = vi.hoisted(() => ({ value: true }))
const cancelSwarmAssignment = vi.hoisted(() => vi.fn())
const cancelSwarmMission = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))
vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: () => authenticated.value,
}))
vi.mock('../../server/swarm-missions', () => ({
  cancelSwarmAssignment,
  cancelSwarmMission,
}))
vi.mock('node:child_process', () => ({ execFile }))

async function post(body: unknown) {
  const mod = await import('./swarm-worker-control')
  return (mod.Route as any).server.handlers.POST({
    request: new Request('http://localhost/api/swarm-worker-control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
}

beforeEach(() => {
  authenticated.value = true
  cancelSwarmAssignment.mockReset()
  cancelSwarmMission.mockReset()
  execFile.mockReset().mockImplementation((_cmd, _args, options, callback) => {
    const cb = typeof options === 'function' ? options : callback
    queueMicrotask(() => cb(null, '', ''))
    return { stdin: { end: vi.fn() }, on: vi.fn() }
  })
})

describe('POST /api/swarm-worker-control', () => {
  it('requires authentication', async () => {
    authenticated.value = false
    expect((await post({ workerId: 'builder', action: 'pause' })).status).toBe(
      401,
    )
  })

  it.each([
    ['pause', ['send-keys', '-t', 'swarm-builder', 'C-z']],
    ['resume', ['send-keys', '-t', 'swarm-builder', 'fg', 'C-m']],
  ])(
    'performs %s with argv-only tmux evidence',
    async (action, expectedArgs) => {
      const response = await post({ workerId: 'builder', action })
      expect(response.status).toBe(200)
      expect(execFile).toHaveBeenCalledWith(
        expect.stringContaining('/tmux'),
        expectedArgs,
        expect.anything(),
        expect.any(Function),
      )
      expect(await response.json()).toMatchObject({
        ok: true,
        action,
        workerId: 'builder',
        sessionName: 'swarm-builder',
        commands: [expectedArgs],
      })
    },
  )

  it('redirects by loading prompt through stdin and pasting a named buffer', async () => {
    const response = await post({
      workerId: 'builder',
      action: 'redirect',
      prompt: 'Fix it; $(touch /tmp/nope)',
    })
    expect(response.status).toBe(200)
    expect(execFile.mock.calls.map((call) => call[1])).toEqual([
      ['load-buffer', '-b', 'swarm-control-builder', '-'],
      ['send-keys', '-t', 'swarm-builder', 'C-u'],
      [
        'paste-buffer',
        '-d',
        '-b',
        'swarm-control-builder',
        '-t',
        'swarm-builder',
      ],
      ['send-keys', '-t', 'swarm-builder', 'C-m'],
    ])
    expect(execFile.mock.results[0]?.value.stdin.end).toHaveBeenCalledWith(
      'Fix it; $(touch /tmp/nope)',
    )
  })

  it('stops tmux and optionally cancels the referenced assignment', async () => {
    cancelSwarmAssignment.mockReturnValue({
      changed: true,
      assignment: { id: 'assignment-1' },
      mission: { id: 'mission-1' },
    })
    const response = await post({
      workerId: 'builder',
      action: 'stop',
      missionId: 'mission-1',
      assignmentId: 'assignment-1',
      cancel: true,
    })
    expect(execFile.mock.calls[0]?.[1]).toEqual([
      'kill-session',
      '-t',
      'swarm-builder',
    ])
    expect(cancelSwarmAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'mission-1',
        assignmentId: 'assignment-1',
        workerId: 'builder',
      }),
    )
    expect(await response.json()).toMatchObject({
      ok: true,
      action: 'stop',
      cancellation: { requested: true, changed: true },
    })
  })

  it.each([
    { workerId: '../builder', action: 'pause' },
    { workerId: 'builder', sessionName: 'other;bad', action: 'pause' },
  ])('rejects unsafe names: %j', async (body) => {
    expect((await post(body)).status).toBe(400)
    expect(execFile).not.toHaveBeenCalled()
  })
})
