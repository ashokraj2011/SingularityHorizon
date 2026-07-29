/**
 * M4 exit criteria.
 *
 * The golden-path conversation compiles to an IR that diffs near-empty against
 * the hand-written M3 version, in at most six elicitation questions.
 *
 * "Near-empty" is made checkable by classifying differences rather than
 * counting them. A compiled workflow whose prompts are worded differently is
 * the same workflow; one whose timeouts differ permits exactly the same
 * actions; one whose capability modes differ does not. Only the last kind has
 * to be zero, and it is asserted at zero.
 *
 * Note what the draft below does *not* carry: timeouts. A conversation does not
 * state them, so they come from the playbook, and where the playbook's
 * convention differs from the timeout picked by hand in M3 the diff says so.
 * Those differences are real and reported — they just do not change what the
 * run is permitted to do, which is the thing that has to match exactly.
 *
 * The extraction pass is scripted. A live model would make the question count
 * an assertion about that model's mood, and the property under test is the
 * binding — which holes close from the playbook, which from the fabric, and
 * which genuinely need a person.
 *
 * Run with: npm run compiler:check
 */
import { goldenPath } from '../src/main/workflow/goldenPath'
import { validate } from '../src/main/workflow/ir'
import { holesOf, maturityOf, seal, type PartialWorkflow } from '../src/main/workflow/partial'
import { answer, compile, type CompileResult, type Fabric } from '../src/main/workflow/compiler'
import { DEFAULT_PLAYBOOK } from '../src/main/workflow/playbook'
import { capabilityOnly, diffWorkflows, summarize } from '../src/main/workflow/diff'
import { applyPlanEdit, toPlan } from '../src/main/workflow/projection'

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => {
  checks.push([n, p, d])
}

/**
 * What a first pass over the golden-path conversation plausibly yields.
 *
 * "Look at STORY-128, help me understand whether pricing needs changes… ok
 * let's do it, get it reviewed, and open a PR."
 *
 * It has the shape: the steps, their order, what each is for. It does not have
 * the things nobody said out loud — who approves, when to stop retrying, what
 * "verified" means mechanically. Those are the holes.
 */
function extracted(): PartialWorkflow {
  return {
    id: 'golden-path-v1',
    objective: 'Take a story to a reviewed pull request',
    nodes: [
      {
        id: 'analyse',
        type: 'agent',
        role: 'analyst',
        prompt:
          'Read the story and the code it refers to. Describe what needs to ' +
          'change and why. Your reply is the design note.',
        inputs: [],
        output: 'design',
        artifactPath: 'design.md',
        contextSlice: [
          { kind: 'document', ref: 'story' },
          { kind: 'repo', ref: '**' }
        ],
        effects: { writes: [{ kind: 'repo', path: 'design.md' }] }
        // reads: unstated. agentId, toolProfile, mode, workspace, budget: unstated.
      },
      {
        id: 'approve-design',
        type: 'humanGate',
        artifact: 'design',
        contextSlice: [{ kind: 'artifact', ref: 'design' }]
        // requiredRole: nobody said who signs off.
      },
      {
        id: 'implement',
        type: 'agent',
        role: 'implementer',
        prompt: 'Implement the approved design. Do not run commands; verification is a later step.',
        inputs: ['design'],
        output: 'implementation',
        contextSlice: [
          { kind: 'artifact', ref: 'design' },
          { kind: 'repo', ref: 'src/**' }
        ],
        // Inferred from "pricing" in the conversation, and unconfirmed — which
        // is different from absent, and must not bind silently.
        effects: { writes: [{ kind: 'repo', path: 'src/**' }], inferred: ['writes'] }
      },
      {
        id: 'verify',
        type: 'loop',
        contextSlice: [{ kind: 'repo', ref: 'src/**' }],
        effects: {
          reads: [{ kind: 'repo', path: '**' }],
          writes: [{ kind: 'repo', path: 'src/**' }],
          emits: ['unit', 'lint']
        },
        // maxIterations and until: "get it reviewed" says nothing about either.
        body: [
          {
            id: 'run-tests',
            type: 'tool',
            command: 'npm test',
            output: 'unit',
            contextSlice: [],
            effects: { reads: [{ kind: 'repo', path: '**' }], writes: [] }
          },
          {
            id: 'run-lint',
            type: 'tool',
            command: 'npm run lint',
            output: 'lint',
            contextSlice: [],
            effects: { reads: [{ kind: 'repo', path: '**' }], writes: [] }
          },
          {
            id: 'repair',
            type: 'agent',
            role: 'repair',
            prompt: 'The verification step failed. Fix the cause. Change nothing else.',
            inputs: ['implementation'],
            output: 'repair-attempt',
            contextSlice: [{ kind: 'repo', ref: 'src/**' }],
            effects: { reads: [{ kind: 'repo', path: '**' }], writes: [{ kind: 'repo', path: 'src/**' }] }
          }
        ]
      },
      {
        id: 'open-pr',
        type: 'tool',
        command: 'echo "PR would open here"',
        output: 'pr',
        contextSlice: [],
        effects: { reads: [{ kind: 'repo', path: '**' }], writes: [{ kind: 'external' }] }
      }
    ]
  }
}

/* ------------------------------------------------------ holes are derived */

const draft = extracted()
const initialHoles = holesOf(draft)

// The design point. The extraction pass never says "I omitted the analyst's
// reads" — a pass that failed to notice a field omits it from its own hole list
// with equal confidence. Holes come from the schema, so the omission is found.
ok('a field the extractor silently omitted is still found as a hole',
   initialHoles.some((h) => h.nodeId === 'analyse' && h.field === 'effects.reads'))
ok('an unstated approver is a hole',
   initialHoles.some((h) => h.nodeId === 'approve-design' && h.field === 'requiredRole'))
ok('an unstated loop bound is a hole',
   initialHoles.some((h) => h.nodeId === 'verify' && h.field === 'maxIterations'))
ok('an unstated exit condition is a hole',
   initialHoles.some((h) => h.nodeId === 'verify' && h.field === 'until'))

// An inferred value is not a bound value.
const inferredHole = initialHoles.find(
  (h) => h.nodeId === 'implement' && h.field === 'effects.writes'
)
ok('an inferred effect is a hole, not a binding', !!inferredHole)
ok('and is marked partial rather than missing', inferredHole?.state === 'PARTIAL')
ok('carrying what was inferred, so it can be confirmed', Array.isArray(inferredHole?.inferred))

ok('a node with holes is not SPEC_BOUND',
   maturityOf('approve-design', initialHoles) !== 'SPEC_BOUND')
// Identity settled, configuration open.
ok('a node whose identity is settled reads as REQUIREMENT',
   maturityOf('analyse', initialHoles) === 'REQUIREMENT',
   maturityOf('analyse', initialHoles))
ok('a node missing what it even is reads as FRAGMENT',
   maturityOf('verify', initialHoles) === 'FRAGMENT', maturityOf('verify', initialHoles))

// The guarantee the separate type buys: an unbound draft cannot become a
// Workflow at all, so it cannot reach the runtime through a missed check.
ok('an unbound draft cannot be sealed into a runnable workflow', seal(draft) === null)

/* ------------------------------------------------------------- the fabric */

// Stands in for the repository world model: it knows what the pricing service
// looks like, and says so rather than being asked.
const fabric: Fabric = {
  effectsFor(node) {
    if (node.role === 'analyst') return { reads: [{ kind: 'repo', path: '**' }] }
    if (node.role === 'implementer') return { reads: [{ kind: 'repo', path: '**' }] }
    return null
  }
}

/* ------------------------------------------------- round one of questions */

const round1 = compile(draft, { fabric })

ok('the compiler does not produce a workflow while holes remain', round1.workflow === null)
ok('and reports it as not runnable', !round1.runnable)

// The point of the playbook: an org convention is not a question.
const askedAbout = (r: CompileResult, field: string): boolean =>
  r.questions.some((q) => q.hole.field === field)

ok('it does not ask which agent to use', !askedAbout(round1, 'agentId'))
ok('it does not ask for a tool profile', !askedAbout(round1, 'toolProfile'))
ok('it does not ask for a capability mode', !askedAbout(round1, 'mode'))
ok('it does not ask for a step timeout', !askedAbout(round1, 'budget.timeoutSec'))
// And the fabric: what the repository already knows is not a question either.
ok('it does not ask what the analyst reads', !askedAbout(round1, 'effects.reads'))
ok('it does not ask what a step emits', !askedAbout(round1, 'effects.emits'))

ok('it does ask who approves', askedAbout(round1, 'requiredRole'))
ok('it does ask how many attempts', askedAbout(round1, 'maxIterations'))
ok('it does ask what ends the loop', askedAbout(round1, 'until'))
ok('it does ask to confirm the inferred effect',
   round1.questions.some((q) => q.hole.field === 'effects.writes' && q.hole.state === 'PARTIAL'))

// Every closure is attributable — "why did this step run in edit mode" has to
// be answerable after the playbook has moved on.
const modeBinding = round1.bindings.find((b) => b.nodeId === 'implement' && b.field === 'mode')
ok('a playbook binding records its route', modeBinding?.route === 'playbook')
ok('and the playbook version that supplied it',
   String(modeBinding?.source).includes(DEFAULT_PLAYBOOK.version), String(modeBinding?.source))
ok('a fabric binding is attributed to the repository model',
   round1.bindings.some((b) => b.route === 'fabric' && b.field === 'effects.reads'))

// Capability is bound from the role, not from the conversation.
ok('the analyst was bound to a read-only capability',
   round1.bindings.some((b) => b.nodeId === 'analyse' && b.field === 'mode' && b.value === 'explore'))
ok('the implementer was bound to edit',
   round1.bindings.some((b) => b.nodeId === 'implement' && b.field === 'mode' && b.value === 'edit'))

const questionsRound1 = round1.questions.length

/* --------------------------------------------------- answering, and round two */

const answers1 = {
  'approve-design.requiredRole': 'tech-lead',
  'verify.maxIterations': 3,
  'verify.until': [{ claimId: 'unit-tests' }, { claimId: 'no-lint-errors' }],
  'implement.effects.writes': [{ kind: 'repo', path: 'src/**' }]
}

const round2 = answer(round1, draft, answers1, { fabric })

// Naming the claims creates new holes: what those claims actually check.
ok('answering surfaces the next layer of holes',
   round2.questions.some((q) => q.hole.field === 'predicate'),
   round2.questions.map((q) => q.hole.field).join(','))
ok('the confirmed effect is no longer a hole',
   !round2.holes.some((h) => h.nodeId === 'implement' && h.field === 'effects.writes'))
ok('and it is recorded as answered by a person',
   round2.bindings.some((b) => b.nodeId === 'implement' && b.field === 'effects.writes' && b.route === 'question'))

const answers2 = {
  'claim:unit-tests.predicate': { select: 'unit.exitCode', op: 'eq', value: 0 },
  'claim:no-lint-errors.predicate': { select: 'lint.exitCode', op: 'eq', value: 0 }
}

const final = answer(round2, draft, answers2, { fabric })
const questionsAsked = questionsRound1 + round2.questions.length

ok('the workflow compiles once every hole is closed', final.workflow !== null,
   final.holes.map((h) => `${h.nodeId}.${h.field}`).join(', '))
ok('and the deterministic gate passes it', final.runnable,
   final.issues.map((i) => `${i.nodeId}: ${i.problem}`).join('; '))
ok('every node reached SPEC_BOUND',
   Object.values(final.maturity).every((m) => m === 'SPEC_BOUND'),
   JSON.stringify(final.maturity))

// The exit criterion.
ok('it asked at most six questions', questionsAsked <= 6, `${questionsAsked} questions`)
ok('and it did ask some — silence would mean it guessed', questionsAsked > 0)

/* ------------------------------------------------------------- the diff */

const differences = diffWorkflows(goldenPath(), final.workflow!)
const capability = capabilityOnly(differences)

ok('nothing that changes what the run may do differs from the hand-written version',
   capability.length === 0, summarize(capability))
ok('the diff is near-empty overall', differences.length <= 4,
   `${differences.length}:\n${summarize(differences)}`)
// Anything left should be a timeout somebody picked by hand, not a capability.
ok('and what remains is only budgets or wording',
   differences.every((d) => d.kind === 'budget' || d.kind === 'prose'),
   summarize(differences.filter((d) => d.kind === 'capability')))

// The diff has to be able to see a real difference, or "zero" means nothing.
const tampered = JSON.parse(JSON.stringify(goldenPath()))
tampered.nodes[0].mode = 'deliver'
ok('the diff detects a raised capability',
   capabilityOnly(diffWorkflows(goldenPath(), tampered)).some((d) => d.path.includes('mode')))
ok('and ignores a reworded prompt', (() => {
  const reworded = JSON.parse(JSON.stringify(goldenPath()))
  reworded.nodes[0].prompt = 'Completely different wording, same step.'
  return capabilityOnly(diffWorkflows(goldenPath(), reworded)).length === 0
})())

/* --------------------------------------------------------- the projection */

const plan = toPlan(final.workflow!)
ok('the plan renders every step', plan.steps.length === 8, `${plan.steps.length}`)
ok('loop bodies are nested in the plan', plan.steps.some((s) => s.depth === 1))
ok('the plan shows the capability of each agent step',
   plan.steps.filter((s) => s.kind === 'agent').every((s) => s.fields.some((f) => f.path === 'mode')))

const edited = applyPlanEdit(final.workflow!, { nodeId: 'implement', path: 'mode', value: 'verify' })
ok('a plan edit is an edit to the IR', !edited.refused &&
   toPlan(edited.workflow).steps.find((s) => s.nodeId === 'implement')
     ?.fields.find((f) => f.path === 'mode')?.value === 'verify')
ok('and the edited workflow is revalidated', edited.validation.runnable)
// The plan is a view. A field it renders as derived cannot be written through
// it, or "editable" would be a styling decision a hand-made request ignores.
const refusedEdit = applyPlanEdit(final.workflow!, { nodeId: 'implement', path: 'maturity', value: 'SPEC_BOUND' })
ok('a derived field cannot be edited through the plan', !!refusedEdit.refused, refusedEdit.refused)
ok('and the refusal explains why', String(refusedEdit.refused).includes('derived'))
const badValue = applyPlanEdit(final.workflow!, { nodeId: 'implement', path: 'mode', value: 'god-mode' })
ok('a value outside the allowed set is refused', !!badValue.refused, badValue.refused)
ok('an edit to a step that does not exist is refused',
   !!applyPlanEdit(final.workflow!, { nodeId: 'nope', path: 'mode', value: 'edit' }).refused)
// No second source of truth: the projection holds nothing of its own.
ok('the plan is derived, never stored',
   JSON.stringify(toPlan(final.workflow!)) === JSON.stringify(toPlan(final.workflow!)))

/* --------------------------------------- the gate is a validator, not a model */

const sneaky = JSON.parse(JSON.stringify(final.workflow!))
sneaky.nodes[0].maturity = 'FRAGMENT'
ok('a workflow marked unbound is refused however plausible it reads',
   !validate(sneaky).runnable)

console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(`\nquestions asked: ${questionsAsked}`)
console.log(`residual diff vs the hand-written workflow: ${differences.length ? '' : 'none'}`)
for (const d of differences) console.log(`  [${d.kind}] ${d.path}: ${JSON.stringify(d.expected)} -> ${JSON.stringify(d.actual)}`)
console.log(failed === 0 ? `all ${checks.length} passed` : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
