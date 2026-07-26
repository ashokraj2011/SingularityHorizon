import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { SkillInfo } from '../shared/ipc'

/**
 * Client-side skill loading.
 *
 * Copilot CLI 1.0.75's ACP server advertises its 32 built-in slash commands but
 * does NOT advertise skills — `/skills` over ACP reports only the single
 * builtin, and installed-plugin skills never appear, even inside the plugin's
 * own repo. (The plugin's *agents* do show up in the agent config option, so
 * the server loads plugins; it just doesn't expose their skills.)
 *
 * A skill is only a markdown file with frontmatter, so we read them ourselves
 * and expand an invocation into the prompt. That is what the agent-side
 * implementation does anyway — it injects SKILL.md into the conversation.
 */

const SKILL_FILE = 'SKILL.md'

interface SkillRoot {
  dir: string
  source: string
}

function skillRoots(cwd: string): SkillRoot[] {
  const home = homedir()
  return [
    { dir: join(cwd, '.github', 'skills'), source: 'repo' },
    { dir: join(cwd, '.copilot', 'skills'), source: 'repo' },
    { dir: join(home, '.copilot', 'skills'), source: 'user' }
  ]
}

/** Plugin layout is ~/.copilot/installed-plugins/<plugin>/<pkg>/skills/<skill>/SKILL.md */
async function pluginRoots(): Promise<SkillRoot[]> {
  const base = join(homedir(), '.copilot', 'installed-plugins')
  const roots: SkillRoot[] = []
  let plugins: string[]
  try {
    plugins = (await readdir(base, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return roots
  }

  for (const plugin of plugins) {
    // The plugin directory usually nests one package directory before `skills`.
    const candidates = [join(base, plugin)]
    try {
      for (const inner of await readdir(join(base, plugin), { withFileTypes: true })) {
        if (inner.isDirectory()) candidates.push(join(base, plugin, inner.name))
      }
    } catch {
      /* unreadable plugin dir — skip */
    }
    for (const candidate of candidates) {
      roots.push({ dir: join(candidate, 'skills'), source: plugin })
    }
  }
  return roots
}

/**
 * Frontmatter is only ever a handful of scalar keys here, so a full YAML parser
 * would be a dependency for nothing. Values may be quoted; nested structures
 * are not supported and are simply ignored.
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: raw }

  const block = raw.slice(3, end)
  const body = raw.slice(end + 4).replace(/^\r?\n/, '')
  const meta: Record<string, string> = {}

  for (const line of block.split('\n')) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    meta[match[1]] = value
  }
  return { meta, body }
}

async function loadFrom(root: SkillRoot): Promise<SkillInfo[]> {
  let entries: string[]
  try {
    entries = (await readdir(root.dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }

  const skills = await Promise.all(
    entries.map(async (name): Promise<SkillInfo | null> => {
      const path = join(root.dir, name, SKILL_FILE)
      try {
        const raw = await readFile(path, 'utf8')
        const { meta } = parseFrontmatter(raw)
        return {
          name: meta.name || name,
          description: meta.description || '',
          argumentHint: meta['argument-hint'] || undefined,
          source: root.source,
          path
        }
      } catch {
        return null
      }
    })
  )
  return skills.filter((s): s is SkillInfo => s !== null)
}

export async function listSkills(cwd: string): Promise<SkillInfo[]> {
  const roots = [...skillRoots(cwd), ...(await pluginRoots())]
  const found = (await Promise.all(roots.map(loadFrom))).flat()

  // Repo-local skills win over user, user over plugin — nearest scope first.
  const rank = (s: SkillInfo): number =>
    s.source === 'repo' ? 0 : s.source === 'user' ? 1 : 2
  const byName = new Map<string, SkillInfo>()
  for (const skill of found.sort((a, b) => rank(a) - rank(b))) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Build the text actually sent to the agent. The transcript still shows the
 * short invocation the user typed — see `displayText` on the prompt path — so
 * this expansion is what the model reads, not what the user has to scroll past.
 */
export async function expandSkill(
  cwd: string,
  name: string,
  args: string
): Promise<{ text: string; skill: SkillInfo }> {
  const skill = (await listSkills(cwd)).find((s) => s.name === name)
  if (!skill) throw new Error(`Unknown skill: ${name}`)

  const raw = await readFile(skill.path, 'utf8')
  const { body } = parseFrontmatter(raw)
  const dir = basename(skill.path.replace(`/${SKILL_FILE}`, ''))

  const text = [
    `Follow the "${skill.name}" skill below. Its instructions take precedence over`,
    `your default workflow for this request.`,
    '',
    `<skill name="${skill.name}" path="${skill.path}">`,
    body.trim(),
    '</skill>',
    '',
    args.trim()
      ? `Arguments provided by the user: ${args.trim()}`
      : 'The user provided no arguments.',
    '',
    `Skill files live in ${dir}/. Begin now.`
  ].join('\n')

  return { text, skill }
}
