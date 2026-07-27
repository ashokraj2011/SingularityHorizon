/**
 * Proves the UI is host-agnostic.
 *
 * Drives the real store against a fake `AcpStudioApi` — no Electron, no agent
 * process, no filesystem. If this passes, the interface can be embedded
 * anywhere that can implement one object.
 *
 * Run with: npm run embed:check
 */
import { setApi } from '../src/renderer/src/api'
import { useStore } from '../src/renderer/src/store'
import type {
  AcpStudioApi,
  MainEvent,
  PromptRequest,
  SessionSnapshot
} from '../src/shared/ipc'

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => {
  checks.push([n, p, d])
}

/* ------------------------------------------------ a host with no runtime */

const calls: string[] = []
let emit: (e: MainEvent) => void = () => {}

function makeSession(id: string, cwd: string): SessionSnapshot {
  return {
    id,
    acpSessionId: `acp-${id}`,
    title: cwd.split('/').pop() ?? cwd,
    cwd,
    agentId: 'fake',
    status: 'idle',
    createdAt: 0,
    blocks: [],
    models: [],
    configOptions: [
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        currentValue: 'fake-1',
        options: [
          { value: 'fake-1', name: 'Fake One' },
          { value: 'fake-2', name: 'Fake Two' }
        ]
      }
    ],
    commands: [{ name: 'plan', description: 'agent-owned' }]
  }
}

const fakeApi: AcpStudioApi = {
  listAgents: async () => [{ id: 'fake', name: 'Fake Agent', command: 'fake', args: [] }],
  listSessions: async () => [],
  listToolProfiles: async () => [
    { id: 'full', name: 'Full', description: 'everything', measuredOverhead: 14839 },
    { id: 'lean', name: 'Lean', description: 'bash + view', measuredOverhead: 4306 }
  ],
  createSession: async ({ cwd, toolProfile }) => {
    calls.push(`createSession:${toolProfile ?? 'default'}`)
    const s = { ...makeSession('s1', cwd), toolProfile }
    emit({ type: 'session:created', session: s })
    return s
  },
  closeSession: async (id) => {
    emit({ type: 'session:removed', sessionId: id })
  },
  restartSession: async () => null,
  prompt: async (sessionId: string, request: PromptRequest) => {
    calls.push(`prompt:${request.displayText ?? request.text}`)
    emit({
      type: 'session:blocks',
      sessionId,
      blocks: [
        {
          id: 'b1',
          kind: 'user',
          text: request.displayText ?? request.text,
          at: 0,
          attachments: request.attachments?.map((a) => ({
            path: a.path,
            name: a.path.split('/').pop() ?? a.path,
            kind: a.kind
          }))
        }
      ]
    })
    emit({ type: 'session:turnEnded', sessionId, stopReason: 'end_turn' })
  },
  runCommandSilent: async () => '',
  refreshContext: async (sessionId) => {
    calls.push(`refreshContext:${sessionId}`)
  },
  listSkills: async () => [
    {
      name: 'demo-skill',
      description: 'a fake skill',
      source: 'repo',
      path: '/fake/demo-skill/SKILL.md'
    }
  ],
  expandSkill: async (_cwd, name) => ({
    text: `EXPANDED BODY FOR ${name}`,
    skill: { name, description: '', source: 'repo', path: '/fake' }
  }),
  setConfigOption: async (sessionId, optionId, value) => {
    calls.push(`config:${optionId}=${value}`)
    emit({
      type: 'session:patch',
      sessionId,
      patch: {
        configOptions: [
          {
            type: 'select',
            id: optionId,
            name: 'Model',
            currentValue: value,
            options: [
              { value: 'fake-1', name: 'Fake One' },
              { value: 'fake-2', name: 'Fake Two' }
            ]
          }
        ]
      }
    })
  },
  cancel: async () => {
    calls.push('cancel')
  },
  respondPermission: async (requestId, optionId) => {
    calls.push(`perm:${requestId}=${optionId}`)
  },
  pickDirectory: async () => '/fake/project',
  pickFiles: async () => ['/fake/project/a.ts', '/fake/project/b.ts'],
  statPaths: async (paths) =>
    paths.map((p) => ({
      path: p,
      name: p.split('/').pop() ?? p,
      kind: 'file' as const,
      bytes: 100
    })),
  readDir: async () => [],
  readFile: async () => '',
  searchFiles: async () => [],
  homeDir: async () => '/fake',
  onEvent: (listener) => {
    emit = listener
    return () => {
      emit = () => {}
    }
  }
}

/* ------------------------------------------------------------------ drive */

setApi(fakeApi)
const store = useStore.getState()
fakeApi.onEvent(store.applyEvent)

await store.bootstrap()
ok('bootstrap loaded agents from the host', useStore.getState().agents.length === 1)

ok('tool profiles loaded from the host', useStore.getState().toolProfiles.length === 2)

await store.newSession('/fake/project', 'fake', 'lean')
const created = useStore.getState()
ok('tool profile reached the host on create', calls.includes('createSession:lean'))
ok('tool profile recorded on the session', created.sessions.s1?.toolProfile === 'lean')
ok('session created and became active', created.activeId === 's1')
ok('session title derived from cwd', created.sessions.s1?.title === 'project')
ok('skills loaded for the new session', (created.skills.s1?.length ?? 0) === 1)

/* attachments */
await useStore.getState().addAttachments('file')
ok('attachments staged', (useStore.getState().attachments.s1?.length ?? 0) === 2)
useStore.getState().removeAttachment('/fake/project/a.ts')
ok('attachment removed', (useStore.getState().attachments.s1?.length ?? 0) === 1)

/* a plain send carries the staged attachment and then clears it */
await useStore.getState().send('hello there')
ok('plain prompt reached the host', calls.includes('prompt:hello there'))
ok(
  'attachments cleared after send',
  (useStore.getState().attachments.s1?.length ?? 0) === 0
)
const userBlock = useStore.getState().sessions.s1?.blocks[0]
ok(
  'attachment travelled with the prompt',
  userBlock?.kind === 'user' && userBlock.attachments?.length === 1
)
ok('turnEnded triggered a context refresh', calls.includes('refreshContext:s1'))

/* skill expansion happens client-side, before the host is called */
await useStore.getState().send('/demo-skill do a thing')
ok(
  'skill invocation displayed as typed, not expanded',
  calls.includes('prompt:/demo-skill do a thing')
)
const skillBlock = useStore.getState().sessions.s1?.blocks[0]
ok(
  'transcript shows the short form',
  skillBlock?.kind === 'user' && skillBlock.text === '/demo-skill do a thing'
)

/* agent-owned names are not hijacked by local skills */
await useStore.getState().send('/plan something')
ok('agent command passed through untouched', calls.includes('prompt:/plan something'))

/* config round-trip */
await useStore.getState().setConfigOption('model', 'fake-2')
ok('config change reached the host', calls.includes('config:model=fake-2'))
ok(
  'config patch applied to the snapshot',
  useStore.getState().sessions.s1?.configOptions[0]?.currentValue === 'fake-2'
)

/* teardown */
await useStore.getState().closeSession('s1')
const after = useStore.getState()
ok('session removed', after.sessions.s1 === undefined)
ok('skills cleaned up with the session', after.skills.s1 === undefined)
ok('attachments cleaned up with the session', after.attachments.s1 === undefined)
ok('active id cleared', after.activeId === null)

/* -------------------------------------------------------------- report */

console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (${detail})` : ''}`)
  if (!pass) failed++
}
console.log(`\nhost calls observed: ${calls.length}`)
console.log(failed === 0 ? `all ${checks.length} passed` : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
