#!/usr/bin/env node
/* global console, process */
// `npm run typecheck`: type-checks both TypeScript projects and gates on a
// baseline of known errors.
//
// The root tsconfig.json is solution-style ("files": [] + references), and a
// plain `tsc --noEmit` doesn't follow references, so it checked zero files.
// This runs each referenced project instead. The code base still carries
// type errors from before that was noticed (#143), so rather than fail on
// all of them, the run fails when any (project, file, error code) count rises
// above scripts/typecheck-baseline.json — and also when one falls below it,
// so a fix lands together with its smaller baseline and the baseline only
// ever shrinks.
//
//   npm run typecheck               check against the baseline
//   npm run typecheck -- --update   rewrite the baseline to the current errors
//
// Keys leave out line/column so unrelated edits don't churn the baseline.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(root, 'scripts', 'typecheck-baseline.json')
const PROJECTS = ['tsconfig.node.json', 'tsconfig.web.json']
const update = process.argv.includes('--update')

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const current = {}
const firstSeen = {}
for (const project of PROJECTS) {
  const run = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', project], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (run.error) throw run.error
  const errors = {}
  let parsed = 0
  for (const line of run.stdout.split('\n')) {
    // src/x.ts(12,5): error TS2322: Type ...   — also bare "error TS…" lines
    // for config errors, which carry no file.
    const m = line.match(/^(.*?)(?:\((\d+),(\d+)\))?: error (TS\d+): (.*)$/) ?? line.match(/^()()()error (TS\d+): (.*)$/)
    if (!m) continue
    parsed++
    const file = m[1] ? relative(root, join(root, m[1])).split('\\').join('/') : '(config)'
    const key = `${file} ${m[4]}`
    errors[key] = (errors[key] ?? 0) + 1
    firstSeen[`${project} ${key}`] ??= m[2] ? `${file}(${m[2]},${m[3]}): ${m[4]}: ${m[5]}` : `${m[4]}: ${m[5]}`
  }
  // tsc exits non-zero with errors; anything else unparsed (a crash, a bad
  // flag) must not pass as "no errors".
  if (run.status !== 0 && parsed === 0) {
    console.error(`typecheck: tsc -p ${project} failed without reporting type errors:\n${run.stdout}${run.stderr}`)
    process.exit(1)
  }
  current[project] = sortKeys(errors)
}

const total = (byProject) => Object.values(byProject).reduce((n, errs) => n + Object.values(errs).reduce((a, b) => a + b, 0), 0)

if (update) {
  writeFileSync(baselinePath, JSON.stringify(current, null, 2) + '\n')
  console.log(`typecheck: baseline written — ${total(current)} known errors (${PROJECTS.map((p) => `${p}: ${total({ [p]: current[p] })}`).join(', ')})`)
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'))
const added = []
const fixed = []
for (const project of PROJECTS) {
  const was = baseline[project] ?? {}
  const now = current[project]
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const diff = (now[key] ?? 0) - (was[key] ?? 0)
    if (diff > 0) added.push(`  ${project}: ${key} +${diff}  e.g. ${firstSeen[`${project} ${key}`]}`)
    if (diff < 0) fixed.push(`  ${project}: ${key} ${diff}`)
  }
}

if (added.length) {
  console.error(`typecheck: new type errors (not in scripts/typecheck-baseline.json):\n${added.join('\n')}`)
  console.error('Fix them. (Only if an error is deliberate and unavoidable: npm run typecheck -- --update, and say why in the PR.)')
}
if (fixed.length) {
  console.error(`typecheck: fewer errors than the baseline — nice. Lock that in with \`npm run typecheck -- --update\` and commit the baseline:\n${fixed.join('\n')}`)
}
if (added.length || fixed.length) process.exit(1)
console.log(`typecheck: OK — no new errors (${total(current)} known, see scripts/typecheck-baseline.json)`)

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)))
}
