import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  cancelSwarmAssignment,
  cancelSwarmMission,
} from '../../server/swarm-missions'

type WorkerControlAction = 'pause' | 'resume' | 'redirect' | 'stop'
type WorkerControlBody = {
  workerId?: unknown
  sessionName?: unknown
  action?: unknown
  prompt?: unknown
  missionId?: unknown
  assignmentId?: unknown
  cancel?: unknown
}

const TMUX_BIN_CANDIDATES = [
  process.env.HERMES_TMUX_BIN,
  process.env.CLAUDE_TMUX_BIN,
  process.env.TMUX_BIN,
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  join(homedir(), '.local', 'bin', 'tmux'),
].filter((value): value is string => Boolean(value))

function resolveTmuxBin(): string | null {
  return (
    TMUX_BIN_CANDIDATES.find(
      (candidate) => candidate.startsWith('/') && existsSync(candidate),
    ) ?? null
  )
}

function validName(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)
}

function runTmux(
  tmuxBin: string,
  args: Array<string>,
  input?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      tmuxBin,
      args,
      { timeout: 8_000 },
      (error, _stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: stderr.toString().trim() || error.message,
          })
          return
        }
        resolve({ ok: true })
      },
    )
    if (input !== undefined) child.stdin?.end(input)
  })
}

export const Route = createFileRoute('/api/swarm-worker-control')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request))
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })

        let body: WorkerControlBody
        try {
          body = (await request.json()) as WorkerControlBody
        } catch {
          return json(
            { ok: false, error: 'Invalid JSON body' },
            { status: 400 },
          )
        }

        const workerId =
          typeof body.workerId === 'string' ? body.workerId.trim() : ''
        const action = body.action as WorkerControlAction
        const expectedSessionName = `swarm-${workerId}`
        const sessionName =
          typeof body.sessionName === 'string'
            ? body.sessionName.trim()
            : expectedSessionName
        if (
          !validName(workerId) ||
          !validName(sessionName) ||
          sessionName !== expectedSessionName
        ) {
          return json(
            { ok: false, error: 'workerId/sessionName invalid or mismatched' },
            { status: 400 },
          )
        }
        if (!['pause', 'resume', 'redirect', 'stop'].includes(action)) {
          return json(
            {
              ok: false,
              error: 'action must be pause, resume, redirect, or stop',
            },
            { status: 400 },
          )
        }

        const tmuxBin = resolveTmuxBin()
        if (!tmuxBin)
          return json(
            { ok: false, error: 'tmux not installed on this host' },
            { status: 503 },
          )

        const commands: Array<Array<string>> = []
        const execute = async (args: Array<string>, input?: string) => {
          commands.push(args)
          return runTmux(tmuxBin, args, input)
        }
        let failure: { ok: false; error: string } | null = null
        let promptCharacters: number | undefined

        if (action === 'pause') {
          const result = await execute(['send-keys', '-t', sessionName, 'C-z'])
          if ('error' in result) failure = result
        } else if (action === 'resume') {
          const result = await execute([
            'send-keys',
            '-t',
            sessionName,
            'fg',
            'C-m',
          ])
          if ('error' in result) failure = result
        } else if (action === 'redirect') {
          const prompt =
            typeof body.prompt === 'string'
              ? body.prompt.replace(/\r\n/g, '\n')
              : ''
          if (!prompt.trim() || prompt.length > 32_000)
            return json(
              {
                ok: false,
                error: 'prompt required (maximum 32000 characters)',
              },
              { status: 400 },
            )
          promptCharacters = prompt.length
          const bufferName = `swarm-control-${workerId}`
          for (const [args, input] of [
            [['load-buffer', '-b', bufferName, '-'], prompt],
            [['send-keys', '-t', sessionName, 'C-u'], undefined],
            [
              ['paste-buffer', '-d', '-b', bufferName, '-t', sessionName],
              undefined,
            ],
            [['send-keys', '-t', sessionName, 'C-m'], undefined],
          ] as Array<[Array<string>, string | undefined]>) {
            const result = await execute(args, input)
            if ('error' in result) {
              failure = result
              break
            }
          }
        } else {
          const result = await execute(['kill-session', '-t', sessionName])
          if ('error' in result) failure = result
        }

        if (failure)
          return json(
            {
              ok: false,
              action,
              workerId,
              sessionName,
              tmuxBin,
              commands,
              error: failure.error,
            },
            { status: 500 },
          )

        let cancellation: {
          requested: boolean
          changed: boolean
          target: string | null
        } = { requested: false, changed: false, target: null }
        if (action === 'stop' && body.cancel === true) {
          const missionId =
            typeof body.missionId === 'string' &&
            validName(body.missionId.trim())
              ? body.missionId.trim()
              : null
          const assignmentId =
            typeof body.assignmentId === 'string' &&
            validName(body.assignmentId.trim())
              ? body.assignmentId.trim()
              : null
          if (!missionId)
            return json(
              {
                ok: false,
                error: 'valid missionId required when cancel is true',
              },
              { status: 400 },
            )
          const cancelled = assignmentId
            ? cancelSwarmAssignment({
                missionId,
                assignmentId,
                workerId,
                actor: 'desktop-control',
                reason: 'Worker stopped from Desktop control API',
              })
            : cancelSwarmMission({
                missionId,
                actor: 'desktop-control',
                reason: 'Worker stopped from Desktop control API',
              })
          cancellation = {
            requested: true,
            changed: cancelled?.changed === true,
            target: assignmentId ?? missionId,
          }
        }

        return json({
          ok: true,
          action,
          workerId,
          sessionName,
          tmuxBin,
          commands,
          promptCharacters,
          cancellation,
          completedAt: Date.now(),
        })
      },
    },
  },
})
