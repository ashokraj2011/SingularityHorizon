/**
 * End-to-end check of the skill pipeline, from disk to the text the agent
 * receives. Run with: npm run skills:check [cwd]
 */
import type { AvailableCommand } from '../src/shared/acp'
import { expandSkill, listSkills } from '../src/main/skills'
import { buildSlashItems, resolveSkillInvocation } from '../src/renderer/src/slashMenu'

const cwd = process.argv[2] ?? process.cwd()
const checks: Array<[string, boolean, string?]> = []
const ok = (name: string, pass: boolean, detail?: string): void => {
  checks.push([name, pass, detail])
}

const skills = await listSkills(cwd)
const bySource: Record<string, number> = {}
for (const s of skills) bySource[s.source] = (bySource[s.source] ?? 0) + 1

console.log(`cwd: ${cwd}`)
console.log(`skills discovered: ${skills.length} ${JSON.stringify(bySource)}`)

ok('discovered at least one skill', skills.length > 0, `${skills.length}`)
ok(
  'every skill has a name and a path',
  skills.every((s) => !!s.name && !!s.path)
)
ok(
  'frontmatter description was parsed',
  skills.filter((s) => s.description).length > skills.length / 2,
  `${skills.filter((s) => s.description).length}/${skills.length} have descriptions`
)

// Stand in for what Copilot actually advertises, including a deliberate clash.
const agentCommands: AvailableCommand[] = [
  { name: 'plan', description: 'built-in plan' },
  { name: 'review', description: 'built-in review' },
  { name: 'skills', description: 'built-in skills' }
]
const clash = skills[0]?.name
const withClash: AvailableCommand[] = clash
  ? [...agentCommands, { name: clash, description: 'agent-owned clash' }]
  : agentCommands

const menuEmpty = buildSlashItems(agentCommands, skills, '')
ok(
  'empty query lists agent commands first',
  menuEmpty[0]?.local === false,
  menuEmpty[0]?.label
)
ok(
  'empty query still includes skills',
  menuEmpty.some((i) => i.local)
)

const menuSflow = buildSlashItems(agentCommands, skills, 'sflow')
ok(
  'typed query surfaces skills first',
  menuSflow.length > 0 && menuSflow[0].local,
  `${menuSflow.length} matches, first = ${menuSflow[0]?.label}`
)
ok(
  'skill entries carry a source badge',
  menuSflow.every((i) => !i.local || !!i.badge),
  menuSflow[0]?.badge
)

ok(
  'agent command wins a name clash in the menu',
  !clash ||
    buildSlashItems(withClash, skills, clash)
      .filter((i) => i.label === `/${clash}`)
      .every((i) => !i.local)
)
ok(
  'agent command wins a name clash on send',
  !clash || resolveSkillInvocation(`/${clash} args`, withClash, skills) === null
)

const target = skills.find((s) => s.name === 'sflow-implement') ?? skills[0]
if (target) {
  const inv = resolveSkillInvocation(
    `/${target.name} add login endpoint`,
    agentCommands,
    skills
  )
  ok('send path resolves the skill', inv?.skill.name === target.name)
  ok('send path captures arguments', inv?.args.trim() === 'add login endpoint', inv?.args)

  const { text } = await expandSkill(cwd, target.name, 'add login endpoint')
  ok(
    'expansion is substantially longer than the invocation',
    text.length > 500,
    `${text.length} chars`
  )
  ok('expansion names the skill', text.includes(target.name))
  ok('expansion carries the arguments', text.includes('add login endpoint'))
  ok('expansion strips frontmatter', !text.includes('disable-model-invocation'))
  ok('expansion is delimited', text.includes('<skill') && text.includes('</skill>'))
}

ok(
  'plain prose is never treated as a skill',
  resolveSkillInvocation('explain this repo', agentCommands, skills) === null
)
ok(
  'unknown slash command falls through to the agent',
  resolveSkillInvocation('/definitely-not-a-skill', agentCommands, skills) === null
)

console.log('\n--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
