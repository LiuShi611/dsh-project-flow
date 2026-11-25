/**
 * Project flow: five-stage gated delivery with one status light.
 *
 * Stage 1 (intent) and stage 5 (acceptance report) run in the main conversation,
 * because a child agent cannot reach the human. Stages 2-4 run as isolated child
 * agents: the planner writes a build ticket, the builder executes it, the checker
 * verifies it and either passes or hands back a correction ticket. Only tickets and
 * verdicts cross stage boundaries, never transcripts, so the parent conversation
 * grows by one tool result instead of by the whole pipeline.
 *
 * @module dsh-project-flow
 */

/**
 * Copyright © 2026 刘适 (Liu Shi). All rights reserved.
 * dsh-project-flow 由刘适开发与维护。
 *
 * 许可：仅限非商业用途。严禁任何商业用途与非法用途，违者责任自负。
 * 本软件按「现状」提供，作者不对使用后果承担任何责任。
 * 完整条款见包根目录 LICENSE。
 */
import { mkdir, readFile, writeFile, readdir, appendFile, rename, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, isAbsolute, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import z from '@deepseek-ai/schemastery'

/** Shown by project_models, /flow-models, and every plugin surface that reports identity. */
export const COPYRIGHT = '© 2026 刘适'

/** One line every surface shows, so the restriction is never out of sight. */
export const LICENSE_NOTICE = '仅限非商业用途使用；禁止任何商业用途与非法用途；按「现状」提供，作者不承担使用后果'

export const name = 'project-flow'
export const inject = ['tools', 'subagents', 'systemPrompt', 'commands']

/**
 * Build a registry-ready tool definition without importing `@deepseek-ai/dsh-tools`.
 *
 * The Harness injects a fixed set of built-in packages into a profile plugin's
 * module scope, and `dsh-tools` is not in that set, so a bare import fails at
 * load time even though the package exists in the installation. `register()`
 * only needs a plain object, so the definition is assembled here: the parameter
 * map is compiled to the JSON Schema subset the registry validates against, and
 * the body still receives parsed arguments from the pipeline.
 */
function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: compileParameters(options.parameters ?? {}),
    output: options.output,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    async execute(args, exec) {
      return options.execute(args ?? {}, exec)
    },
  }
}

/** Compile an implicit parameter map into an object-rooted JSON Schema. */
function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, property] of Object.entries(spec)) {
    const { required: isRequired, description, ...schema } = property
    properties[key] = description === undefined ? schema : { ...schema, description }
    if (isRequired === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
  }
}

export const Config = z.object({
  provider: z.string().default('spawn'),
  intentModel: z.string().default(''),
  planModel: z.string().default(''),
  buildModel: z.string().default(''),
  checkModel: z.string().default(''),
  planProvider: z.string().default(''),
  buildProvider: z.string().default(''),
  checkProvider: z.string().default(''),
  maxRework: z.natural().default(2),
  maxConcurrentProjects: z.natural().default(2),
  // Self-healing knobs: retry a stage that ended abnormally, put a deadline on
  // it, and treat a lock file older than staleLockMs as leftover from a crash.
  maxStageRetries: z.natural().default(2),
  stageRetryDelayMs: z.natural().default(3000),
  stageTimeoutMs: z.natural().default(900000),
  staleLockMs: z.natural().default(1800000),
  // Snapshot / rollback knobs. Snapshots need git; without it the pipeline still
  // runs and simply reports that rollback is unavailable.
  snapshotEnabled: z.boolean().default(true),
  snapshotExcludes: z.string().default(''),
})

const STAGE_LABEL = {
  1: '问意图',
  2: '规划',
  3: '实施',
  4: '自检',
  5: '验收',
}

/** In-memory run registry so a second call on the same project cannot interleave. */
const running = new Map()

/** Resolve the parent conversation's working directory without a hard dependency. */
function cwdOf(ctx, agent) {
  if (agent !== undefined) {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory !== undefined) {
      try {
        return workingDirectory.get(agent.session)
      } catch {
        // fall through to the session header
      }
    }
    const recorded = agent.session?.header?.cwd
    if (typeof recorded === 'string' && isAbsolute(recorded)) return recorded
  }
  return process.cwd()
}

function stateDir(cwd, project) {
  return join(cwd, '.project-flow', project)
}

function nowIso() {
  return new Date().toISOString()
}

async function writeState(cwd, project, patch) {
  const dir = stateDir(cwd, project)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'state.json')
  let previous = {}
  try {
    previous = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    previous = {}
  }
  const next = { ...previous, ...patch, project, updatedAt: nowIso() }
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

async function readState(cwd, project) {
  try {
    return JSON.parse(await readFile(join(stateDir(cwd, project), 'state.json'), 'utf8'))
  } catch {
    return undefined
  }
}

async function saveArtifact(cwd, project, fileName, content) {
  const dir = stateDir(cwd, project)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, fileName), `${content}\n`, 'utf8')
}

/** Concatenate the text blocks of a settled child result. */
function textOf(output) {
  if (!Array.isArray(output)) return ''
  return output
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** Pull the last fenced JSON block, or parse the whole text as JSON. */
function parseJsonBlock(text) {
  const fence = /```json\s*([\s\S]*?)```/gi
  let last
  let match
  while ((match = fence.exec(text)) !== null) last = match[1]
  const candidate = (last ?? text).trim()
  if (candidate === '') return undefined
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return undefined
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

/**
 * Run one isolated stage and return its text plus stop reason. The child gets its
 * own context, so nothing it reads or writes reaches the parent conversation.
 *
 * This function never throws: an abnormal end becomes `ok: false` with a
 * diagnostic, so the caller decides whether to retry, heal, or stop. A stage that
 * fails is retried up to `maxStageRetries`, each attempt under its own deadline,
 * because most failures here are a dropped upstream response, not a bad ticket.
 */
async function runStage(ctx, options) {
  const {
    provider, model, label, prompt, parent, signal, cwd,
    retries = 0, retryDelayMs = 0, timeoutMs = 0, onAttempt,
  } = options
  const notes = []

  const attemptOnce = async () => {
    const deadline = stageDeadline(signal, timeoutMs)
    const start = async route => ctx.subagents.startActivation({
      provider: route.provider,
      label,
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal: deadline.signal,
      delivery: 'caller',
      ...(cwd === undefined ? {} : { cwd }),
      ...(route.model === '' ? {} : { agentOptions: { model: route.model } }),
    })

    let routeNote = ''
    try {
      let activation
      try {
        activation = await start({ provider, model })
      } catch (error) {
        // A route the profile does not authorize must degrade to the parent route
        // instead of killing the whole pipeline: the work matters more than the model.
        if (model === '') throw error
        activation = await start({ provider, model: '' })
        routeNote = `${label}：指定的模型 ${model} 不可用（${messageOf(error).slice(0, 160)}），已回退到当前模型`
      }

      let result
      try {
        result = await activation.result
      } finally {
        try {
          await activation.dispose()
        } catch {
          // teardown failure does not change the captured result
        }
      }
      const stopReason = deadline.timedOut() ? 'timeout' : result.stopReason
      return {
        ok: result.stopReason === 'completed' && !deadline.timedOut(),
        stopReason,
        diagnostic: deadline.timedOut()
          ? `${label}：超过 ${Math.round(timeoutMs / 1000)} 秒仍未结束，已取消`
          : result.diagnostic,
        text: textOf(result.output),
        routeNote,
      }
    } catch (error) {
      return {
        ok: false,
        stopReason: deadline.timedOut() ? 'timeout' : 'error',
        diagnostic: deadline.timedOut()
          ? `${label}：超过 ${Math.round(timeoutMs / 1000)} 秒仍未结束，已取消`
          : `${label}：启动或等待环节时出错（${messageOf(error).slice(0, 240)}）`,
        text: '',
        routeNote,
      }
    } finally {
      deadline.dispose()
    }
  }

  for (let attempt = 0; ; attempt += 1) {
    onAttempt?.(attempt)
    const outcome = await attemptOnce()
    if (outcome.routeNote !== '') notes.push(outcome.routeNote)
    if (outcome.ok) {
      return { ...outcome, routeNote: notes.join('；') }
    }
    // A caller-side abort is the user stopping the run: never retry it.
    if (signal?.aborted === true) {
      return { ...outcome, routeNote: notes.join('；'), diagnostic: outcome.diagnostic ?? '已被取消' }
    }
    if (attempt >= retries) {
      return {
        ...outcome,
        routeNote: notes.join('；'),
        diagnostic: notes.length === 0 || outcome.diagnostic === undefined
          ? outcome.diagnostic
          : `${outcome.diagnostic}（共试 ${attempt + 1} 次）`,
      }
    }
    if (retryDelayMs > 0) {
      try {
        await sleep(retryDelayMs * (attempt + 1), signal)
      } catch {
        return { ...outcome, routeNote: notes.join('；'), diagnostic: '已被取消' }
      }
    }
  }
}

function ticketBlock(title, body) {
  return `# ${title}\n\n${body.trim()}\n`
}

// ── resilience ────────────────────────────────────────────────
//
// Three failure shapes are treated separately, because they need different
// medicine: a stage that ends abnormally is retried; a stage that hangs is put
// on a deadline; a run that dies with the process (crash, plugin reload, killed
// window) leaves artifacts and a stale lock behind, and is healed before the
// next run touches that project.

const LOG_ROTATE_BYTES = 512 * 1024

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'))
      return
    }
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      finish()
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      finish()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Compose the caller's signal with a per-stage deadline. */
function stageDeadline(parent, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const forward = () => controller.abort(new Error('aborted by caller'))
  if (parent?.aborted === true) forward()
  else parent?.addEventListener('abort', forward, { once: true })
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true
      controller.abort(new Error('stage deadline exceeded'))
    }, timeoutMs)
    : undefined
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer)
      parent?.removeEventListener('abort', forward)
    },
  }
}

/** Append one line to the project's run log. A logging failure never breaks a run. */
async function logLine(cwd, project, message) {
  if (typeof project !== 'string' || project === '') return
  try {
    const dir = stateDir(cwd, project)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'run.log')
    let size = 0
    try {
      size = (await readFile(file, 'utf8')).length
    } catch {
      size = 0
    }
    if (size > LOG_ROTATE_BYTES) {
      try {
        await rename(file, `${file}.1`)
      } catch {
        // rotation is best effort
      }
    }
    const line = `${nowIso()} ${String(message).replace(/\r?\n/gu, ' ')}\n`
    await appendFile(join(dir, 'run.log'), line, 'utf8')
  } catch {
    // logging is diagnostics only
  }
}

function isAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function lockFile(cwd, project) {
  return join(stateDir(cwd, project), 'run.lock')
}

async function readLock(cwd, project) {
  try {
    const parsed = JSON.parse(await readFile(lockFile(cwd, project), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** A live holder blocks; a dead holder's lock is evidence, then it is moved aside. */
async function acquireLock(cwd, project, settings) {
  await mkdir(stateDir(cwd, project), { recursive: true })
  const file = lockFile(cwd, project)
  const existing = await readLock(cwd, project)
  if (existing !== undefined) {
    const beat = Date.parse(existing.heartbeatAt ?? existing.startedAt ?? '')
    const age = Number.isFinite(beat) ? Date.now() - beat : Number.POSITIVE_INFINITY
    const other = existing.pid !== process.pid && isAlive(existing.pid)
    if (other && age < settings.staleLockMs) return { ok: false, holder: existing }
    try {
      await rename(file, `${file}.stale-${Date.now()}`)
    } catch {
      // if it cannot be moved, the write below still claims it
    }
  }
  await writeFile(file, `${JSON.stringify({
    pid: process.pid,
    project,
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
  }, null, 2)}\n`, 'utf8')
  return { ok: true, file }
}

/** Refresh the heartbeat so another window can tell a slow run from a dead one. */
async function touchLock(cwd, project) {
  const holder = await readLock(cwd, project)
  if (holder === undefined || holder.pid !== process.pid) return
  try {
    await writeFile(lockFile(cwd, project), `${JSON.stringify({
      ...holder,
      heartbeatAt: nowIso(),
    }, null, 2)}\n`, 'utf8')
  } catch {
    // heartbeat is advisory
  }
}

async function releaseLock(cwd, project) {
  const holder = await readLock(cwd, project)
  if (holder !== undefined && holder.pid !== process.pid) return
  try {
    await rm(lockFile(cwd, project), { force: true })
  } catch {
    // nothing to release
  }
}

/** Infer a usable state.json from whatever artifacts survived. */
async function repairState(cwd, project) {
  const dir = stateDir(cwd, project)
  let files
  try {
    files = await readdir(dir)
  } catch {
    return undefined
  }
  const builds = files.filter(name => /^03-build-\d+\.md$/u.test(name)).length
  const corrections = files.filter(name => /^03-correction-\d+\.md$/u.test(name)).length
  const checks = files.filter(name => /^04-check-\d+\.md$/u.test(name)).length
  if (!files.includes('01-intent.md') && builds === 0) return undefined
  let stage = 1
  if (files.includes('02-plan.md')) stage = 2
  if (builds > 0) stage = 3
  if (checks > 0) stage = 4
  if (files.includes('05-report.md')) stage = 5

  // The intent and the requirement list are the only things a resume cannot
  // re-derive, so rebuild them from 01-intent.md instead of losing them.
  const intentArtifact = await readArtifact(cwd, project, '01-intent.md')
  const intent = withoutHeading(extractSection(intentArtifact, '## 用户要求', true))
  const requirementBlock = extractSection(intentArtifact, '## 用户要求')
  const requirements = requirementBlock
    .split(/\r?\n/u)
    .map(line => line.replace(/^\s*\d+[.)]\s*/u, '').trim())
    .filter(line => line !== '')

  if (files.includes('state.json')) {
    try {
      await rename(join(dir, 'state.json'), join(dir, `state.json.corrupt-${Date.now()}`))
    } catch {
      // keep going even when the broken file cannot be moved
    }
  }
  return writeState(cwd, project, {
    stage,
    status: 'rebuilt-from-artifacts',
    rework: Math.max(corrections, builds > 0 ? builds - 1 : 0),
    ...(intent === '' ? {} : { intent }),
    ...(requirements.length === 0 ? {} : { requirements }),
    rebuiltAt: nowIso(),
  })
}

/**
 * Heal a workspace before a run: clear locks whose owner is gone, quarantine a
 * corrupt state.json, and mark stages that never closed as interrupted.
 * `mutate: false` only reports.
 */
async function sweep(cwd, settings, projectFilter, mutate = true) {
  const actions = []
  let names = []
  try {
    const entries = await readdir(join(cwd, '.project-flow'), { withFileTypes: true })
    names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return actions
  }
  for (const project of names.sort()) {
    if (projectFilter !== undefined && project !== projectFilter) continue
    const holder = await readLock(cwd, project)
    if (holder !== undefined) {
      const beat = Date.parse(holder.heartbeatAt ?? holder.startedAt ?? '')
      const age = Number.isFinite(beat) ? Date.now() - beat : Number.POSITIVE_INFINITY
      const alive = holder.pid !== process.pid && isAlive(holder.pid)
      if (!alive && age >= settings.staleLockMs) {
        actions.push(`${project}：遗留锁（pid ${holder.pid}，心跳 ${holder.heartbeatAt ?? '无'}）`)
        if (mutate) {
          try {
            await rename(lockFile(cwd, project), `${lockFile(cwd, project)}.stale-${Date.now()}`)
            actions[actions.length - 1] += '，已移开'
          } catch {
            actions[actions.length - 1] += '，移开失败'
          }
        }
      }
    }
    const state = await readState(cwd, project)
    if (state === undefined) {
      actions.push(`${project}：state.json 缺失或损坏`)
      if (mutate) {
        const repaired = await repairState(cwd, project)
        actions[actions.length - 1] += repaired === undefined
          ? '，产物不足，无法重建'
          : `，已按产物重建为第 ${repaired.stage} 段`
      }
      continue
    }
    const open = typeof state.status === 'string' && /^(planning|building|checking)$|^(rework-\d+|checking R\d+)$/u.test(state.status)
    if (open && state.interruptedAt === undefined && !running.has(project)) {
      actions.push(`${project}：第 ${state.stage ?? '?'} 段的「${state.status}」没有收尾`)
      if (mutate) {
        await writeState(cwd, project, {
          interruptedAt: nowIso(),
          status: `${state.status}（中断）`,
        })
        actions[actions.length - 1] += '，已标记中断，可用 project_resume 续跑'
      }
    }
  }
  return actions
}

async function readArtifact(cwd, project, fileName) {
  try {
    return await readFile(join(stateDir(cwd, project), fileName), 'utf8')
  } catch {
    return undefined
  }
}

/** Every project under `.project-flow` as a status line, sorted by name. */
async function listProjectLines(cwd) {
  let names = []
  try {
    const entries = await readdir(join(cwd, '.project-flow'), { withFileTypes: true })
    names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
  const lines = []
  for (const project of names.sort()) {
    const state = await readState(cwd, project)
    lines.push(state === undefined ? `${project}：state.json 缺失，可用 project_doctor 修` : statusLine(state))
  }
  return lines
}

/** Slice a saved artifact: the part after a heading, or the part before it. */
function extractSection(text, heading, prefix = false) {
  if (typeof text !== 'string' || text === '') return ''
  const index = text.indexOf(heading)
  if (index === -1) return ''
  if (prefix) return text.slice(0, index).trim()
  return text.slice(index + heading.length).trim()
}

/** Drop the `# 标题` head that saveArtifact's ticketBlock wrote. */
function withoutHeading(text) {
  if (typeof text !== 'string') return ''
  const match = /^#\s[^\n]*\n+/u.exec(text)
  return (match === null ? text : text.slice(match[0].length)).trim()
}

/** The highest-numbered `prefix-N.md` in a project directory. */
async function latestNumbered(cwd, project, prefix) {
  let files
  try {
    files = await readdir(stateDir(cwd, project))
  } catch {
    return undefined
  }
  const pattern = new RegExp(`^${prefix}-(\\d+)\\.md$`, 'u')
  const found = files
    .map(name => {
      const match = pattern.exec(name)
      return match === null ? undefined : { name, index: Number(match[1]) }
    })
    .filter(entry => entry !== undefined)
    .sort((left, right) => left.index - right.index)
  return found.length === 0 ? undefined : found[found.length - 1]
}

// ── snapshots and rollback ────────────────────────────────────
//
// Rollback needs history the workspace does not have. The project's own files
// under `.project-flow` cannot answer "what did src/a.ts look like before the
// builder broke it", and a run may not even be inside a git repository.
//
// So each project keeps a bare repository of its own:
//
//   .project-flow/<project>/snap.git     ← the object store, not in your repo
//   --work-tree=<cwd>                    ← your actual workspace
//
// Nothing is initialised in the workspace itself: no `.git`, no commits you did
// not ask for. `info/exclude` keeps the snapshot repository and the usual
// heavyweight directories out of its own index, so a snapshot never snapshots
// itself.

const DEFAULT_SNAPSHOT_EXCLUDES = [
  '.project-flow/',
  '.git/',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.next/',
  '.nuxt/',
  'dist/',
  'build/',
  '.cache/',
  '.DS_Store',
  'Thumbs.db',
]

/** Run git without a shell, never throwing; the caller reads `ok`/`stderr`. */
function git(args, options = {}) {
  const { cwd, timeoutMs = 120000 } = options
  return new Promise(resolve => {
    execFile('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        // A user-level git config must not hijack the snapshot repo.
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    }, (error, stdout, stderr) => {
      resolve({
        ok: error === null || error === undefined,
        code: error?.code ?? 0,
        stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
        stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
        message: error === undefined ? '' : messageOf(error),
      })
    })
  })
}

function snapshotRepo(cwd, project) {
  return join(stateDir(cwd, project), 'snap.git')
}

/** True when git exists and answers; snapshots are optional, so this is checked once. */
let gitProbe
async function gitAvailable() {
  if (gitProbe === undefined) {
    const result = await git(['--version'], { timeoutMs: 15000 })
    gitProbe = result.ok && /git version/u.test(result.stdout)
  }
  return gitProbe
}

async function snapshotCommand(cwd, project, args, options = {}) {
  const dir = snapshotRepo(cwd, project)
  return git([`--git-dir=${dir}`, `--work-tree=${cwd}`, ...args], { cwd, ...options })
}

/**
 * Create the repository and its exclude list on first use. `core.worktree` is
 * recorded so plain git invocations against this directory also work.
 */
async function ensureSnapshotRepo(cwd, project, excludes) {
  const dir = snapshotRepo(cwd, project)
  await mkdir(dir, { recursive: true })
  const head = await git(['--git-dir', dir, 'rev-parse', '--git-dir'], { cwd })
  if (!head.ok) {
    const init = await git(['init', '--bare', '--quiet', dir], { cwd })
    if (!init.ok) return { ok: false, reason: `初始化快照仓库失败：${init.stderr.trim() || init.message}` }
    await git(['--git-dir', dir, 'config', 'core.worktree', cwd], { cwd })
    await git(['--git-dir', dir, 'config', 'user.name', 'dsh-project-flow'], { cwd })
    await git(['--git-dir', dir, 'config', 'user.email', 'project-flow@localhost'], { cwd })
    await git(['--git-dir', dir, 'config', 'core.autocrlf', 'false'], { cwd })
    await git(['--git-dir', dir, 'config', 'core.safecrlf', 'false'], { cwd })
  }
  const list = excludes.length === 0 ? DEFAULT_SNAPSHOT_EXCLUDES : excludes
  await mkdir(join(dir, 'info'), { recursive: true })
  await writeFile(join(dir, 'info', 'exclude'), `${list.join('\n')}\n`, 'utf8')
  return { ok: true, dir }
}

function snapshotLabel(label) {
  return String(label ?? '').replace(/\r?\n/gu, ' ').trim().slice(0, 200) || '未命名快照'
}

/**
 * Commit the whole workspace as `label`. Returns the commit id. A snapshot with
 * no changes reuses the previous commit instead of piling up empty ones.
 */
async function takeSnapshot(cwd, project, label, options = {}) {
  const { excludes = DEFAULT_SNAPSHOT_EXCLUDES, allowEmpty = false } = options
  if (await gitAvailable() !== true) {
    return { ok: false, reason: '这台机器上没有可用的 git，快照与回滚不可用' }
  }
  const prepared = await ensureSnapshotRepo(cwd, project, excludes)
  if (prepared.ok !== true) return prepared

  const add = await snapshotCommand(cwd, project, ['add', '-A'], { timeoutMs: 600000 })
  if (!add.ok) {
    return { ok: false, reason: `暂存工作区失败：${add.stderr.trim() || add.message}` }
  }
  const head = await snapshotCommand(cwd, project, ['rev-parse', 'HEAD'])
  const diff = await snapshotCommand(cwd, project, ['diff', '--cached', '--quiet'])
  const dirty = !diff.ok // `--quiet` exits 1 when there are staged changes
  if (!dirty && !allowEmpty && head.ok) {
    return { ok: true, commit: head.stdout.trim(), reused: true }
  }
  const commit = await snapshotCommand(cwd, project, ['commit', '--quiet', '--allow-empty', '-m', snapshotLabel(label)], { timeoutMs: 600000 })
  if (!commit.ok) {
    return { ok: false, reason: `建立快照失败：${commit.stderr.trim() || commit.message}` }
  }
  const after = await snapshotCommand(cwd, project, ['rev-parse', 'HEAD'])
  return { ok: true, commit: after.stdout.trim(), reused: false }
}

/** Every snapshot, newest first. */
async function listSnapshots(cwd, project, limit = 50) {
  if (await gitAvailable() !== true) return []
  const result = await snapshotCommand(cwd, project, [
    'log', `--max-count=${limit}`,
    '--pretty=format:%H%x09%cI%x09%s',
  ])
  if (!result.ok) return []
  return result.stdout
    .split(/\r?\n/u)
    .filter(line => line.trim() !== '')
    .map(line => {
      const [commit, at, ...rest] = line.split('\t')
      return { commit, at, label: rest.join('\t') }
    })
}

async function resolveSnapshot(cwd, project, rev) {
  if (typeof rev !== 'string' || rev.trim() === '') return undefined
  const result = await snapshotCommand(cwd, project, ['rev-parse', '--verify', `${rev.trim()}^{commit}`])
  if (!result.ok) return undefined
  return result.stdout.trim()
}

/** Files that differ between a snapshot and the current workspace. */
async function snapshotDiff(cwd, project, commit) {
  const result = await snapshotCommand(cwd, project, [
    'diff', '--name-status', '--no-renames', commit, '--',
  ], { timeoutMs: 300000 })
  if (!result.ok) return []
  const map = { A: '新增', M: '修改', D: '删除', T: '类型变化' }
  return result.stdout
    .split(/\r?\n/u)
    .filter(line => line.trim() !== '')
    .map(line => {
      const [status, ...rest] = line.split('\t')
      const path = rest.join('\t').trim()
      return { status: map[status?.[0]] ?? status, path }
    })
    .filter(entry => entry.path !== '')
}

/**
 * Restore paths to their state in `commit`. One path at a time, so a snapshot
 * that predates a file cannot abort the restore of the others.
 */
async function restorePaths(cwd, project, commit, paths) {
  const missing = []
  let restored = 0
  for (const path of paths) {
    const result = await snapshotCommand(cwd, project, ['checkout', commit, '--', path], { timeoutMs: 300000 })
    if (result.ok) restored += 1
    else missing.push(path)
  }
  return { ok: missing.length === 0, restored, missing }
}

/** Restore the whole workspace to `commit`, including files it did not have. */
async function restoreAll(cwd, project, commit) {
  // The diff has to be taken *before* the reset: afterwards the index equals the
  // target tree, so files created since the snapshot look merely untracked and
  // `git diff <commit>` stops naming them.
  const before = await snapshotDiff(cwd, project, commit)
  const read = await snapshotCommand(cwd, project, ['read-tree', '-u', '--reset', commit], { timeoutMs: 600000 })
  if (!read.ok) {
    return { ok: false, reason: `回滚失败：${read.stderr.trim() || read.message}` }
  }
  // `read-tree -u` removes what the index carried, but a file that was never
  // staged survives; anything the diff called new is deleted explicitly.
  const extra = before.filter(entry => entry.status === '新增').map(entry => entry.path)
  let removed = 0
  for (const path of extra) {
    try {
      await rm(join(cwd, path), { force: true })
      removed += 1
    } catch {
      // a file we could not delete is reported through the follow-up diff
    }
  }
  return { ok: true, removed, changes: before }
}

/** Turn a build stage's self-reported file list into workspace-relative paths. */
function normalizePaths(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .map(item => item.replace(/^\.\//u, '').replace(/\\/gu, '/'))
    .filter(item => item !== '' && !item.startsWith('/') && !/^[a-zA-Z]:/u.test(item) && !item.includes('..'))
}

const PLANNER_RULES = `你是流程里的「规划」环节。你看不到用户，也看不到上一个环节的全部过程，你只拿到这张任务书。

你的产出不是作品，而是给「实施」环节的施工任务书。它拿到的只有你写的东西，写少了它就会跑偏。

只输出一个 JSON 代码块，不要输出别的内容：
\`\`\`json
{
  "plan": "你打算怎么做的简述，给验收环节看，200 字以内",
  "buildTicket": "给实施环节的完整施工任务书：要做什么、动哪些文件、按什么顺序、每步的验收标准、边界与禁止事项。这里是主体，写详细。",
  "risks": ["你判断可能出问题的地方"]
}
\`\`\`
`

const PLANNER_PROMPT = (intent, requirements, constraints, files) => `${PLANNER_RULES}
## 用户确定的意图

${intent}

## 用户逐条列出的要求

${requirements.map((line, index) => `${index + 1}. ${line}`).join('\n')}

## 约束

${constraints === '' ? '（无）' : constraints}

## 工作目录现状

${files === '' ? '（空目录或未列出）' : files}
`

const BUILDER_RULES = rework => `你是流程里的「实施」环节。你看不到用户，也看不到规划者的思考过程，你只有这张施工任务书。任务书就是全部依据，不要自己扩大范围。

${rework ? '这次是返工：任务书里写了上一版哪里不合格，只改这些地方，不要顺手重写别的。' : '这是第一版实施。'}

完成后只输出一个 JSON 代码块：
\`\`\`json
{
  "summary": "你实际做了什么，逐条对应任务书",
  "files": ["改动的文件路径"],
  "deviations": ["与任务书不一致的地方；没有就空数组"],
  "unresolved": ["没做完或做不到的；没有就空数组"]
}
\`\`\`
`

const CHECKER_RULES = `你是流程里的「自检」环节。你的职责是挑毛病，不是确认通过。默认怀疑，逐条对照。

先看施工任务书要求的每一项是否真的做到了，再看有没有做错、做漏、做多余。必要时读文件核对，不要只信实施环节的自述。

只输出一个 JSON 代码块：
\`\`\`json
{
  "pass": true,
  "verdict": "一句话结论",
  "issues": [{"item": "哪一条要求", "problem": "具体哪里不对", "evidence": "你看到的事实依据"}],
  "correctionTicket": "若 pass 为 false：给实施环节的完整修正任务书，写清具体怎么改、改到什么样算合格。若 pass 为 true，留空字符串。"
}
\`\`\`
注意：pass 为 false 时 correctionTicket 必须是一份能直接照着干的完整任务书，不能只写「不合格」「请修改」。`

const CHECKER_PROMPT = (intent, requirements, plan, buildTicket, buildSummary) => `${CHECKER_RULES}
## 用户确定的意图

${intent}

## 用户逐条列出的要求

${requirements.map((line, index) => `${index + 1}. ${line}`).join('\n')}

## 规划环节的方案

${plan}

## 发给实施环节的施工任务书

${buildTicket}

## 实施环节的自述

${buildSummary}
`

/** Compact one-line status, used by both the runner and the status tool. */
function statusLine(state) {
  if (state === undefined) return '没有这个项目'
  const stage = state.stage === undefined ? '?' : state.stage
  if (stage === 0) return `${state.project}：还没开跑 —— ${state.status ?? '未开始'}`
  const label = STAGE_LABEL[stage] ?? '?'
  const rework = state.rework === undefined || state.rework === 0 ? '' : `，已返工 ${state.rework} 次`
  const line = `${state.project}：第 ${stage} 段「${label}」 · ${state.status}${rework}`
  const tail = []
  if (typeof state.interruptedAt === 'string' && state.interruptedAt !== '') {
    tail.push(`上次中断于 ${state.interruptedAt}，跑 project_resume 续上`)
  }
  if (typeof state.lastError === 'string' && state.lastError !== '') {
    tail.push(`最后错误：${state.lastError.slice(0, 200)}`)
  }
  return tail.length === 0 ? line : `${line}\n  └ ${tail.join('；')}`
}

async function listFiles(dir, limit = 60) {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
    return entries
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .filter(fileName => !fileName.includes('.project-flow'))
      .slice(0, limit)
  } catch {
    return []
  }
}

export function apply(ctx, config) {
  const pick = (value, fallback) => (value === undefined || value === '' ? fallback : value)

  /**
   * Live settings: the patch seeds them, but a JSON override file wins so the
   * model routes can be changed at runtime without restarting DSH. Resolved on
   * every use, so an edit applies to the next stage immediately.
   */
  const base = {
    provider: pick(config.provider, 'spawn'),
    intentModel: config.intentModel ?? '',
    planModel: config.planModel ?? '',
    buildModel: config.buildModel ?? '',
    checkModel: config.checkModel ?? '',
    planProvider: config.planProvider ?? '',
    buildProvider: config.buildProvider ?? '',
    checkProvider: config.checkProvider ?? '',
    maxRework: config.maxRework ?? 2,
    maxConcurrentProjects: config.maxConcurrentProjects ?? 2,
    maxStageRetries: config.maxStageRetries ?? 2,
    stageRetryDelayMs: config.stageRetryDelayMs ?? 3000,
    stageTimeoutMs: config.stageTimeoutMs ?? 900000,
    staleLockMs: config.staleLockMs ?? 1800000,
    snapshotEnabled: config.snapshotEnabled === undefined ? true : config.snapshotEnabled,
    snapshotExcludes: config.snapshotExcludes ?? '',
  }

  const overridePaths = () => {
    const home = process.env.DSH_HOME
      ?? join(homedir(), '.dsh')
    // A per-profile override next to the profile, plus one shared location.
    const candidates = [
      join(home, 'project-flow.json'),
    ]
    if (process.env.DSH_PROFILE !== undefined) {
      candidates.unshift(join(home, `project-flow.${process.env.DSH_PROFILE}.json`))
    }
    return candidates
  }

  const readOverride = () => {
    // Every candidate is merged, later files winning: a per-profile file sits
    // first only in write order, so a leftover shared file still contributes the
    // keys the profile file never set instead of being silently ignored.
    const merged = {}
    for (const file of overridePaths().slice().reverse()) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.assign(merged, parsed)
        }
      } catch {
        // A missing or malformed override simply yields no changes.
      }
    }
    return merged
  }

  /** The effective settings: patch values overlaid with any saved override. */
  const settingsOf = () => {
    const override = readOverride()
    const merged = { ...base }
    for (const key of Object.keys(base)) {
      const value = override[key]
      if (value === undefined || value === null || value === '') continue
      if (typeof base[key] === 'number') {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) merged[key] = value
        continue
      }
      if (typeof base[key] === 'boolean') {
        if (typeof value === 'boolean') merged[key] = value
        continue
      }
      if (typeof value === 'string') merged[key] = value
    }
    return merged
  }

  /** The configured exclude list, split into gitignore-style lines. */
  const snapshotExcludesOf = settings => {
    const raw = typeof settings.snapshotExcludes === 'string' ? settings.snapshotExcludes : ''
    const extra = raw.split(/[\n,]/u).map(line => line.trim()).filter(line => line !== '')
    return extra.length === 0 ? DEFAULT_SNAPSHOT_EXCLUDES : [...DEFAULT_SNAPSHOT_EXCLUDES, ...extra]
  }

  const writeOverride = async patch => {
    const target = overridePaths()[0]
    await mkdir(dirname(target), { recursive: true })
    let previous = {}
    try {
      previous = JSON.parse(await readFile(target, 'utf8'))
    } catch {
      previous = {}
    }
    const next = { ...previous, ...patch }
    await writeFile(target, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return { file: target, value: next }
  }

  const overrideFile = () => overridePaths()[0]


  const runTool = defineTool({
    name: 'project_run',
    description: '跑一个项目的规划、实施、自检三段流水，返回一份压缩结果。三段各开独立子会话，彼此只传任务书不传过程，所以对话里只留这一个结果。要在和用户确认完意图、列好要求清单之后再调用。',
    parameters: {
      project: {
        type: 'string',
        required: true,
        description: '项目简称，小写加连字符；会作为 .project-flow/ 下的产物目录名。',
      },
      intent: {
        type: 'string',
        required: true,
        description: '确认过的意图，一段话，用用户自己的说法。',
      },
      requirements: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '用户的要求，一条一行，要能逐条核对。自检环节会照着这些逐项验。',
      },
      constraints: {
        type: 'string',
        description: '边界：不能碰的文件、不要用的技术、预算或风格限制。',
      },
      maxRework: {
        type: 'integer',
        description: '最多返工几次，超过就停机问你。不填用配置里的值。',
      },
      cwd: {
        type: 'string',
        description: '产物放哪个绝对目录；不填就用当前对话的工作目录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['project', 'outcome', 'stage', 'rework', 'plan', 'buildSummary', 'verdict', 'issues', 'artifacts', 'note'],
        properties: {
          project: { type: 'string' },
          outcome: { type: 'string' },
          stage: { type: 'integer' },
          rework: { type: 'integer' },
          plan: { type: 'string' },
          buildSummary: { type: 'string' },
          verdict: { type: 'string' },
          issues: { type: 'array', items: { type: 'string' } },
          artifacts: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${statusLine({ project: value.project, stage: value.stage, status: value.outcome, rework: value.rework })}\n${value.verdict}\n${value.note}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('project_run requires a calling agent')
      const settings = settingsOf()
      if (running.has(args.project)) throw new Error(`项目 ${args.project} 正在运行，等这一轮结束`)
      if (running.size >= settings.maxConcurrentProjects) {
        throw new Error(`同时只能跑 ${settings.maxConcurrentProjects} 个项目，先等一个跑完`)
      }
      const cwd = args.cwd !== undefined && isAbsolute(args.cwd) ? args.cwd : cwdOf(ctx, parent)
      return executeRun({
        cwd,
        project: args.project,
        intent: args.intent,
        requirements: args.requirements,
        constraints: args.constraints ?? '',
        maxRework: args.maxRework ?? settings.maxRework,
        parent,
        signal: exec.signal,
        seed: undefined,
        mode: 'run',
      })
    },
  })

  // Continue a run that died with its process: the artifacts on disk are the
  // state, so nothing is repeated that already passed its stage.
  const resumeTool = defineTool({
    name: 'project_resume',
    description: '接续一个被中断的项目（进程崩溃、插件重载、窗口被杀、某一段报错后停机）。按 .project-flow 里留下的产物重建上下文，从中断的那一段接着跑，已经通过的段不重做。',
    parameters: {
      project: {
        type: 'string',
        required: true,
        description: '要续跑的项目名，即 .project-flow/ 下那个目录名。',
      },
      cwd: {
        type: 'string',
        description: '.project-flow 所在的绝对目录；不填就用当前对话的工作目录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['project', 'outcome', 'stage', 'rework', 'plan', 'buildSummary', 'verdict', 'issues', 'artifacts', 'note'],
        properties: {
          project: { type: 'string' },
          outcome: { type: 'string' },
          stage: { type: 'integer' },
          rework: { type: 'integer' },
          plan: { type: 'string' },
          buildSummary: { type: 'string' },
          verdict: { type: 'string' },
          issues: { type: 'array', items: { type: 'string' } },
          artifacts: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${statusLine({ project: value.project, stage: value.stage, status: value.outcome, rework: value.rework })}\n${value.verdict}\n${value.note}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('project_resume requires a calling agent')
      const settings = settingsOf()
      const cwd = args.cwd !== undefined && isAbsolute(args.cwd) ? args.cwd : cwdOf(ctx, parent)
      const project = args.project
      const artifacts = stateDir(cwd, project)
      const give = note => ({
        project,
        outcome: 'blocked',
        stage: 0,
        rework: 0,
        plan: '',
        buildSummary: '',
        verdict: '',
        issues: [],
        artifacts,
        note,
      })
      if (running.has(project)) throw new Error(`项目 ${project} 正在运行，等这一轮结束`)
      if (running.size >= settings.maxConcurrentProjects) {
        throw new Error(`同时只能跑 ${settings.maxConcurrentProjects} 个项目，先等一个跑完`)
      }

      let state = await readState(cwd, project)
      let healed = []
      if (state === undefined) {
        healed = await sweep(cwd, settings, project, true)
        state = await readState(cwd, project)
        if (state === undefined) {
          return give(`找不到 ${project} 的 state.json，按产物也重建不出来。先跑 project_doctor 看诊断，必要时重新 project_run。${healed.join('；')}`)
        }
      }

      const intent = typeof state.intent === 'string' ? state.intent : ''
      const requirements = Array.isArray(state.requirements) ? state.requirements.map(String) : []
      if (intent === '' || requirements.length === 0) {
        return give('state.json 里没记下当初的意图和要求。把 01-intent.md 补成一份完整任务书改掉 state.json，或者重新 project_run 一遍。')
      }

      const planArtifact = await readArtifact(cwd, project, '02-plan.md')
      const planText = withoutHeading(extractSection(planArtifact, '## 施工任务书', true))
      const planTicket = extractSection(planArtifact, '## 施工任务书')
      const corrections = await latestNumbered(cwd, project, '03-correction')
      const builds = await latestNumbered(cwd, project, '03-build')
      const currentTicket = corrections === undefined
        ? planTicket
        : withoutHeading(await readArtifact(cwd, project, corrections.name))
      const buildSummary = builds === undefined
        ? ''
        : withoutHeading(await readArtifact(cwd, project, builds.name))

      const stage = typeof state.stage === 'number' ? state.stage : 0
      if (stage >= 5) {
        return {
          ...give(''),
          outcome: 'passed',
          stage: 5,
          rework: typeof state.rework === 'number' ? state.rework : 0,
          plan: planText,
          buildSummary,
          verdict: typeof state.verdict === 'string' ? state.verdict : '这一轮已经通过自检',
          note: '第 5 段已经完成，没有要续的活。直接在主对话里做验收汇报。',
        }
      }
      if (currentTicket === '') {
        return give('没有可用的施工任务书（02-plan.md 缺失或格式不对），从实施段接不上。跑 project_doctor 检查产物，或重新 project_run。')
      }

      return executeRun({
        cwd,
        project,
        intent,
        requirements,
        constraints: '',
        maxRework: typeof state.maxRework === 'number' ? state.maxRework : settings.maxRework,
        parent,
        signal: exec.signal,
        seed: {
          startStage: Math.max(2, Math.min(stage, 4)),
          planText,
          currentTicket,
          buildSummary,
          rework: typeof state.rework === 'number' ? state.rework : 0,
          verdict: typeof state.verdict === 'string' ? state.verdict : '',
          issues: [],
          attempts: Array.isArray(state.attempts) ? state.attempts : [],
        },
        mode: `resume-from-stage-${stage}`,
      })
    },
  })

  // Diagnose-only by default: a self-heal that silently rewrites state is worse
  // than a stale state someone can look at.
  const doctorTool = defineTool({
    name: 'project_doctor',
    description: '检查 .project-flow 的健康状况：遗留锁、损坏的 state.json、开了头没收尾的阶段。默认只报告；fix=true 才动手，会移开死锁、按产物重建 state、把没收尾的段标成中断。',
    parameters: {
      project: {
        type: 'string',
        description: '只检查这一个项目；不填就检查工作目录下全部项目。',
      },
      fix: {
        type: 'boolean',
        description: 'true 才动手修；不填只报告，不改任何文件。',
      },
      cwd: {
        type: 'string',
        description: '.project-flow 所在的绝对目录；不填就用当前对话的工作目录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'actions'],
        properties: {
          line: { type: 'string' },
          actions: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [value.line, ...value.actions].join('\n'),
      }],
    },
    async execute(args, exec) {
      const settings = settingsOf()
      const cwd = args.cwd !== undefined && isAbsolute(args.cwd) ? args.cwd : cwdOf(ctx, exec.agent)
      const fix = args.fix === true
      const actions = await sweep(cwd, settings, args.project, fix)
      return {
        line: actions.length === 0
          ? '没发现问题：没有遗留锁，state.json 都在，也没有悬空没收尾的阶段。'
          : `${actions.length} 处需要处理（${fix ? '已尝试修复' : '只报告，未改动任何文件'}）：`,
        actions,
      }
    },
  })

  /**
   * Lock, heal, run, unlock. Shared by project_run and project_resume. Always
   * releases the lock in `finally`, so even a thrown error cannot leave the
   * project wedged for the next attempt.
   */
  const executeRun = async options => {
    const { cwd, project, signal } = options
    const settings = settingsOf()
    const claim = await acquireLock(cwd, project, settings)
    if (claim.ok !== true) {
      const holder = claim.holder ?? {}
      throw new Error(`项目 ${project} 有另一个实例在跑（pid ${holder.pid ?? '?'}，心跳 ${holder.heartbeatAt ?? '?'}）。等它结束；确认它已经死了就跑 project_doctor fix=true 清锁。`)
    }

    const healed = await sweep(cwd, settings, project, true)
    for (const line of healed) await logLine(cwd, project, `自愈：${line}`)

    const heartbeat = setInterval(() => {
      void touchLock(cwd, project)
    }, 60000)
    heartbeat.unref?.()

    const task = (async () => {
      try {
        return await runPipeline({ ...options, settings, healed })
      } catch (error) {
        await logLine(cwd, project, `异常退出：${messageOf(error)}`)
        if (signal?.aborted === true) {
          await writeState(cwd, project, { interruptedAt: nowIso(), lastError: `已取消：${messageOf(error)}` })
        } else {
          await writeState(cwd, project, { interruptedAt: nowIso(), lastError: messageOf(error) })
        }
        throw error
      } finally {
        clearInterval(heartbeat)
        await releaseLock(cwd, project)
      }
    })()

    running.set(project, task)
    try {
      return await task
    } finally {
      running.delete(project)
    }
  }

  /**
   * The actual five-stage body. `seed` continues an interrupted run: it supplies
   * the plan ticket, the current ticket, the last build summary and the rework
   * count, and says which stage to start from.
   */
  const runPipeline = async options => {
    const { cwd, project, intent, requirements, constraints, maxRework, parent, signal, seed, settings, healed, mode } = options
    const artifacts = stateDir(cwd, project)
    const routeNotes = []
    const noteRoute = note => {
      if (typeof note === 'string' && note !== '' && !routeNotes.includes(note)) routeNotes.push(note)
    }
    const healedNote = healed.length === 0 ? '' : `自愈记录：${healed.join('；')}`
    let snapshotNote = ''
    const craft = patch => ({
      project,
      artifacts,
      issues: [],
      ...patch,
      note: [patch.note, healedNote, snapshotNote, ...routeNotes]
        .filter(part => typeof part === 'string' && part !== '')
        .join(' '),
    })

    // Snapshots are the rollback substrate: one before every build attempt, so
    // the answer to "put the workspace back the way it was" already exists by
    // the time anyone asks. A missing git downgrades to a warning, never a stop.
    const excludes = snapshotExcludesOf(settings)
    const snapshotsOn = settings.snapshotEnabled === true
    const snap = async label => {
      if (!snapshotsOn) return ''
      const result = await takeSnapshot(cwd, project, label, { excludes })
      if (result.ok !== true) {
        if (snapshotNote === '') snapshotNote = `快照不可用：${result.reason}`
        await logLine(cwd, project, `快照失败（${label}）：${result.reason}`)
        return ''
      }
      await logLine(cwd, project, `快照 ${label} → ${result.commit.slice(0, 8)}${result.reused === true ? '（无变化，复用）' : ''}`)
      return result.commit
    }
    const stageOptions = extra => ({
      parent,
      signal,
      cwd,
      retries: settings.maxStageRetries,
      retryDelayMs: settings.stageRetryDelayMs,
      timeoutMs: settings.stageTimeoutMs,
      onAttempt: attempt => {
        if (attempt > 0) void logLine(cwd, project, `${extra.label} 第 ${attempt + 1} 次尝试`)
      },
      ...extra,
    })
    const cancelled = () => (signal?.aborted === true ? signal.reason ?? new Error('aborted') : undefined)

    let planText = seed?.planText ?? ''
    let currentTicket = seed?.currentTicket ?? ''
    let buildSummary = seed?.buildSummary ?? ''
    let rework = seed?.rework ?? 0
    let verdict = seed?.verdict ?? ''
    const fromStage = seed?.startStage ?? 2
    let needBuild = fromStage <= 3
    const attempts = Array.isArray(seed?.attempts) ? [...seed.attempts] : []

    await logLine(cwd, project, `开工（${mode}），从第 ${fromStage} 段起`)
    await writeState(cwd, project, {
      stage: Math.min(fromStage, 4),
      status: 'running',
      intent,
      requirements,
      maxRework,
      startedAt: nowIso(),
      interruptedAt: undefined,
      lastError: undefined,
      routes: {
        intent: settings.intentModel === '' ? '继承主对话' : settings.intentModel,
        plan: `${settings.planProvider === '' ? settings.provider : settings.planProvider}/${settings.planModel === '' ? '继承' : settings.planModel}`,
        build: `${settings.buildProvider === '' ? settings.provider : settings.buildProvider}/${settings.buildModel === '' ? '继承' : settings.buildModel}`,
        check: `${settings.checkProvider === '' ? settings.provider : settings.checkProvider}/${settings.checkModel === '' ? '继承' : settings.checkModel}`,
      },
    })

    if (fromStage <= 2) {
      await saveArtifact(cwd, project, '01-intent.md', ticketBlock(
        '确定的意图',
        `${intent}\n\n## 用户要求\n\n${requirements.map((line, index) => `${index + 1}. ${line}`).join('\n')}`,
      ))
      await writeState(cwd, project, { stage: 2, status: 'planning' })
      const planned = await runStage(ctx, stageOptions({
        provider: settings.planProvider === '' ? settings.provider : settings.planProvider,
        model: settings.planModel,
        label: `${project} 规划`,
        prompt: PLANNER_PROMPT(intent, requirements, constraints, (await listFiles(cwd)).join('\n')),
      }))
      noteRoute(planned.routeNote)
      cancelled()
      if (!planned.ok) {
        await writeState(cwd, project, {
          stage: 2,
          status: `规划失败：${planned.stopReason}`,
          lastError: planned.diagnostic ?? planned.stopReason,
        })
        await logLine(cwd, project, `规划失败：${planned.stopReason} ${planned.diagnostic ?? ''}`)
        return craft({
          outcome: 'blocked',
          stage: 2,
          rework: 0,
          plan: '',
          buildSummary: '',
          verdict: `规划环节重试 ${settings.maxStageRetries} 次后仍未正常结束（${planned.stopReason}）`,
          issues: planned.diagnostic === undefined ? [] : [planned.diagnostic],
          note: '停在这里，没有进入实施，避免无效消耗。修好上游后跑 project_resume 从这一段接着来。',
        })
      }
      const plan = parseJsonBlock(planned.text)
      planText = typeof plan?.plan === 'string' ? plan.plan : planned.text.slice(0, 600)
      currentTicket = typeof plan?.buildTicket === 'string' && plan.buildTicket.trim() !== ''
        ? plan.buildTicket
        : planned.text
      await saveArtifact(cwd, project, '02-plan.md', ticketBlock(
        '规划与施工任务书',
        `${planText}\n\n## 施工任务书\n\n${currentTicket}`,
      ))
    }

    if (currentTicket === '') {
      await writeState(cwd, project, { stage: 2, status: 'plan-ticket-missing' })
      return craft({
        outcome: 'blocked',
        stage: 2,
        rework,
        plan: planText,
        buildSummary: '',
        verdict: '没有拿到施工任务书，进不了实施',
        note: '02-plan.md 里没有可用的施工任务书。补上之后跑 project_resume。',
      })
    }

    for (;;) {
      cancelled()
      if (needBuild) {
        await writeState(cwd, project, {
          stage: 3,
          status: rework === 0 ? 'building' : `rework-${rework}`,
          rework,
        })
        // The pre-build snapshot is what "roll this attempt back" means later.
        const before = await snap(`实施前 R${rework + 1}`)
        const built = await runStage(ctx, stageOptions({
          provider: settings.buildProvider === '' ? settings.provider : settings.buildProvider,
          model: settings.buildModel,
          label: `${project} 实施${rework === 0 ? '' : ` R${rework}`}`,
          prompt: `# 施工任务书\n\n${currentTicket}\n\n${BUILDER_RULES(rework > 0)}`,
        }))
        noteRoute(built.routeNote)
        cancelled()
        if (!built.ok) {
          await writeState(cwd, project, {
            stage: 3,
            status: `实施失败：${built.stopReason}`,
            rework,
            lastError: built.diagnostic ?? built.stopReason,
          })
          await logLine(cwd, project, `实施失败：${built.stopReason}`)
          return craft({
            outcome: 'blocked',
            stage: 3,
            rework,
            plan: planText,
            buildSummary: '',
            verdict: `实施环节重试 ${settings.maxStageRetries} 次后仍未正常结束（${built.stopReason}）`,
            issues: built.diagnostic === undefined ? [] : [built.diagnostic],
            note: '停在这里，等你决定下一步。任务书和产物都在磁盘上，修好上游后跑 project_resume 接着干。',
          })
        }
        const build = parseJsonBlock(built.text)
        buildSummary = typeof build?.summary === 'string' ? build.summary : built.text.slice(0, 800)
        await saveArtifact(cwd, project, `03-build-${rework + 1}.md`, ticketBlock('实施自述', buildSummary))
        // Record what this attempt touched, so a precise rollback knows which
        // files to put back without needing the builder to be honest later.
        const claimed = normalizePaths(build?.files)
        let touched = claimed
        if (touched.length === 0 && before !== '') {
          touched = (await snapshotDiff(cwd, project, before)).map(entry => entry.path)
        }
        const after = await snap(`实施后 R${rework + 1}`)
        attempts.push({
          round: rework + 1,
          before: before === '' ? undefined : before,
          after: after === '' ? undefined : after,
          files: touched,
          claimedFiles: claimed,
          summary: buildSummary.slice(0, 400),
          at: nowIso(),
        })
        await writeState(cwd, project, { attempts })
        needBuild = false
      }

      await writeState(cwd, project, {
        stage: 4,
        status: rework === 0 ? 'checking' : `checking R${rework}`,
        rework,
      })
      const checked = await runStage(ctx, stageOptions({
        provider: settings.checkProvider === '' ? settings.provider : settings.checkProvider,
        model: settings.checkModel,
        label: `${project} 自检${rework === 0 ? '' : ` R${rework}`}`,
        prompt: CHECKER_PROMPT(intent, requirements, planText, currentTicket, buildSummary),
      }))
      noteRoute(checked.routeNote)
      cancelled()
      if (!checked.ok) {
        await writeState(cwd, project, {
          stage: 4,
          status: `自检失败：${checked.stopReason}`,
          rework,
          lastError: checked.diagnostic ?? checked.stopReason,
        })
        await logLine(cwd, project, `自检失败：${checked.stopReason}`)
        return craft({
          outcome: 'blocked',
          stage: 4,
          rework,
          plan: planText,
          buildSummary,
          verdict: `自检环节重试 ${settings.maxStageRetries} 次后仍未正常结束（${checked.stopReason}）`,
          issues: checked.diagnostic === undefined ? [] : [checked.diagnostic],
          note: '停在这里，等你决定下一步。跑 project_resume 可以从自检段重来。',
        })
      }

      const check = parseJsonBlock(checked.text)
      verdict = typeof check?.verdict === 'string' ? check.verdict : checked.text.slice(0, 400)
      const issues = Array.isArray(check?.issues)
        ? check.issues.map(item => (typeof item === 'string'
          ? item
          : `${item?.item ?? ''}：${item?.problem ?? ''}`.trim()))
        : []
      await saveArtifact(cwd, project, `04-check-${rework + 1}.md`, ticketBlock(
        '自检结论',
        `${verdict}\n\n${issues.map(line => `- ${line}`).join('\n')}`,
      ))

      if (check?.pass === true) {
        await writeState(cwd, project, { stage: 5, status: 'ready-for-acceptance', rework, verdict })
        await saveArtifact(cwd, project, '05-report.md', ticketBlock(
          '交接给验收',
          `结论：${verdict}\n\n## 方案\n\n${planText}\n\n## 实施自述\n\n${buildSummary}`,
        ))
        await logLine(cwd, project, `通过（返工 ${rework} 次）`)
        return craft({
          outcome: 'passed',
          stage: 5,
          rework,
          plan: planText,
          buildSummary,
          verdict,
          issues,
          note: rework === 0
            ? '一次自检通过。接下来在主对话里对照用户原始要求做验收汇报。'
            : `返工 ${rework} 次后通过。验收时说明返工原因。`,
        })
      }

      const correction = typeof check?.correctionTicket === 'string' ? check.correctionTicket.trim() : ''
      if (correction === '') {
        await writeState(cwd, project, { stage: 4, status: 'check-failed-no-ticket', rework })
        await logLine(cwd, project, '自检判不合格但没给修正任务书')
        return craft({
          outcome: 'blocked',
          stage: 4,
          rework,
          plan: planText,
          buildSummary,
          verdict,
          issues,
          note: '自检判不合格但没给出可执行的修正任务书，按规则停机，不盲目返工。',
        })
      }
      rework += 1
      if (rework > maxRework) {
        await writeState(cwd, project, { stage: 4, status: 'stopped-after-rework-limit', rework: rework - 1 })
        await logLine(cwd, project, `返工上限 ${maxRework} 次用完，停机`)
        return craft({
          outcome: 'stopped',
          stage: 4,
          rework: rework - 1,
          plan: planText,
          buildSummary,
          verdict,
          issues,
          note: `连续 ${rework - 1} 次返工仍未通过，按规则停机交给你定夺：放宽要求、改方案，还是放弃。继续循环只会空烧。`,
        })
      }
      currentTicket = correction
      await saveArtifact(cwd, project, `03-correction-${rework}.md`, ticketBlock('修正任务书', correction))
      needBuild = true
    }
  }

  const snapshotsTool = defineTool({
    name: 'project_snapshots',
    description: '列出某个项目的全部快照与每次实施动了哪些文件，供回滚选取目标。只读。',
    parameters: {
      project: {
        type: 'string',
        required: true,
        description: '项目名，即 .project-flow/ 下那个目录名。',
      },
      limit: {
        type: 'integer',
        description: '最多列几条，默认 20。',
      },
      cwd: {
        type: 'string',
        description: '.project-flow 所在的绝对目录；不填就用当前对话的工作目录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'entries'],
        properties: {
          line: { type: 'string' },
          entries: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [value.line, ...value.entries].join('\n'),
      }],
    },
    async execute(args, exec) {
      const cwd = args.cwd !== undefined && isAbsolute(args.cwd) ? args.cwd : cwdOf(ctx, exec.agent)
      const project = args.project
      const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 20
      if (await gitAvailable() !== true) {
        return { line: `项目 ${project}：这台机器上没有可用的 git，快照与回滚不可用。`, entries: [] }
      }
      const state = await readState(cwd, project)
      const attempts = Array.isArray(state?.attempts) ? state.attempts : []
      const snaps = await listSnapshots(cwd, project, limit)
      if (snaps.length === 0) {
        return {
          line: attempts.length === 0
            ? `项目 ${project}：还没有快照（第 3 段实施前才会打第一张）。`
            : `项目 ${project}：state.json 里有 ${attempts.length} 次实施记录，但快照仓库是空的（可能被删了）。`,
          entries: attempts.map(a => `第 ${a.round} 轮实施：${(a.files ?? []).length} 个文件 · ${a.summary ?? ''}`),
        }
      }
      const roundsAt = new Map()
      const tag = (commit, round) => {
        if (typeof commit !== 'string' || commit === '') return
        roundsAt.set(commit, [...(roundsAt.get(commit) ?? []), round])
      }
      for (const attempt of attempts) {
        tag(attempt.before, `第 ${attempt.round} 轮实施前`)
        tag(attempt.after, `第 ${attempt.round} 轮实施后`)
      }
      return {
        line: `项目 ${project}：${snaps.length} 张快照（新→旧），回滚时用 commit 或「第 N 轮」都行。`,
        entries: snaps.map(snap => {
          const marks = roundsAt.get(snap.commit)
          return `${snap.commit.slice(0, 8)}  ${snap.at}  ${snap.label}${marks === undefined ? '' : `　← ${marks.join(' / ')}`}`
        }),
      }
    },
  })

  const rollbackTool = defineTool({
    name: 'project_rollback',
    description: '把工作区回滚到某个快照。mode=full 整棵恢复到目标快照（连新增文件一起清掉）；mode=precise 只还原指定那次实施动过的文件，不碰你手改的其他东西。默认先干跑给 diff，dryRun=false 才真回滚；真回滚前会自动再打一张 pre-rollback 快照，回错了还能再回来。',
    parameters: {
      project: {
        type: 'string',
        required: true,
        description: '项目名。',
      },
      to: {
        type: 'string',
        description: '回滚目标：不填=最近一次实施之前；写「2」=第 2 轮实施之前；也可以写快照 commit 或标签里的关键字。',
      },
      mode: {
        type: 'string',
        description: 'full=整棵恢复（默认）；precise=只还原那一次实施动过的文件。',
      },
      dryRun: {
        type: 'boolean',
        description: '默认 true，只报告将要发生什么；false 才真的改文件。',
      },
      cwd: {
        type: 'string',
        description: '.project-flow 所在的绝对目录；不填就用当前对话的工作目录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'ok', 'dryRun', 'target', 'changes', 'details'],
        properties: {
          ok: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          target: { type: 'string' },
          line: { type: 'string' },
          changes: { type: 'array', items: { type: 'string' } },
          details: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.line,
          ...value.changes.map(line => `  ${line}`),
          value.details,
        ].filter(part => part !== '').join('\n'),
      }],
    },
    async execute(args, exec) {
      const cwd = args.cwd !== undefined && isAbsolute(args.cwd) ? args.cwd : cwdOf(ctx, exec.agent)
      const project = args.project
      const dryRun = args.dryRun !== false
      const mode = args.mode === 'precise' ? 'precise' : 'full'
      const fail = (line, details = '') => ({
        ok: false, dryRun, target: '', line, changes: [], details,
      })

      if (await gitAvailable() !== true) {
        return fail(`项目 ${project}：这台机器上没有可用的 git，回滚做不了。`)
      }
      const settings = settingsOf()
      const state = await readState(cwd, project)
      const attempts = Array.isArray(state?.attempts) ? state.attempts : []
      if (attempts.length === 0 && (args.to ?? '') === '') {
        return fail(
          `项目 ${project}：没有实施记录，不知道要回滚到哪。`,
          '用 project_snapshots 看有哪些快照，再用 to 指定 commit。',
        )
      }

      // Resolve the target: a round number, a commit, or the last attempt.
      const requested = (args.to ?? '').trim()
      let target
      let chosenAttempt
      if (requested === '' || requested === 'last' || requested === '最近') {
        chosenAttempt = attempts[attempts.length - 1]
        target = chosenAttempt?.before
      } else if (/^\d+$/u.test(requested)) {
        chosenAttempt = attempts.find(attempt => attempt.round === Number(requested))
        target = chosenAttempt?.before
        if (target === undefined) {
          return fail(`项目 ${project}：没有第 ${requested} 轮实施的记录。`, `现有轮次：${attempts.map(a => a.round).join('、')}`)
        }
      } else {
        target = await resolveSnapshot(cwd, project, requested)
        if (target === undefined) {
          const snaps = await listSnapshots(cwd, project, 20)
          return fail(
            `项目 ${project}：找不到快照「${requested}」。`,
            snaps.length === 0 ? '这个项目还没有快照。' : `可用快照：\n${snaps.map(s => `  ${s.commit.slice(0, 8)}  ${s.label}`).join('\n')}`,
          )
        }
      }

      if (typeof target !== 'string' || target === '') {
        return fail(
          `项目 ${project}：这一轮实施没有记录到快照（可能当时 git 不可用）。`,
          '用 project_snapshots 挑一个 commit 作为 to 再试。',
        )
      }

      const short = target.slice(0, 8)

      // Precise mode only touches the files that attempt reported or was seen
      // changing; full mode restores everything the snapshot knows about.
      const precisePaths = mode === 'precise'
        ? normalizePaths(chosenAttempt?.files)
        : []

      if (mode === 'precise' && precisePaths.length === 0) {
        return fail(
          `项目 ${project}：这一轮实施没有记录到改动文件清单，没法精准回滚。`,
          '改用 mode="full" 整棵恢复，或者用 project_snapshots 拿 commit 自己判断。',
        )
      }

      const changes = mode === 'precise'
        ? await snapshotDiff(cwd, project, target).then(list => list.filter(entry => precisePaths.includes(entry.path)))
        : await snapshotDiff(cwd, project, target)

      const describe = changes.map(entry => `${entry.status}  ${entry.path}`)
      const targetLine = `目标快照 ${short}${chosenAttempt === undefined ? '' : `（第 ${chosenAttempt.round} 轮实施之前）`}，模式 ${mode === 'full' ? '整棵恢复' : '只还原那一次动过的文件'}`

      if (changes.length === 0) {
        return {
          ok: true,
          dryRun,
          target,
          line: `${targetLine}：工作区已经和这个快照一致，不用回滚。`,
          changes: [],
          details: '',
        }
      }

      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          target,
          line: `${targetLine}：将要改动 ${changes.length} 个文件（干跑，未动任何文件）。`,
          changes: describe,
          details: mode === 'precise'
            ? `只动这些文件；其他内容保持原样。确认无误后用 dryRun=false 执行。`
            : `整棵恢复会把这些文件一起还原，快照里没有的文件会被删掉。确认无误后用 dryRun=false 执行。`,
        }
      }

      // Always keep an escape hatch: snapshot the current (bad) state first.
      const guard = await takeSnapshot(cwd, project, `pre-rollback ${short}`, {
        excludes: snapshotExcludesOf(settings),
      })
      const guardNote = guard.ok === true
        ? `回滚前的现场已存为快照 ${guard.commit.slice(0, 8)}，回错了还能再回去。`
        : `回滚前的现场没能存下来（${guard.reason}），这一步不可逆。`

      // Precise mode: only the files this attempt touched. Files it created do
      // not exist in the snapshot, so they are deleted rather than checked out.
      let result
      if (mode === 'precise') {
        const added = changes.filter(entry => entry.status === '新增').map(entry => entry.path)
        const existing = precisePaths.filter(path => !added.includes(path))
        const restored = await restorePaths(cwd, project, target, existing)
        let removed = 0
        const failed = [...restored.missing]
        for (const path of added) {
          try {
            await rm(join(cwd, path), { force: true })
            removed += 1
          } catch {
            failed.push(path)
          }
        }
        result = { ok: failed.length === 0, restored: restored.restored, removed, reason: failed.length === 0 ? undefined : `这些文件没能还原：${failed.join('、')}` }
      } else {
        result = await restoreAll(cwd, project, target)
      }

      if (result.ok !== true) {
        return fail(`回滚失败：${result.reason ?? '未知原因'}`, guardNote)
      }

      const left = await snapshotDiff(cwd, project, target)
      const leftPrecise = mode === 'precise'
        ? left.filter(entry => precisePaths.includes(entry.path))
        : left
      await logLine(cwd, project, `回滚到 ${short}（${mode}），剩 ${leftPrecise.length} 处差异`)
      await writeState(cwd, project, {
        rollbacks: [
          ...(Array.isArray(state?.rollbacks) ? state.rollbacks : []),
          { to: target, mode, at: nowIso(), remaining: leftPrecise.length },
        ],
      })

      return {
        ok: true,
        dryRun: false,
        target,
        line: leftPrecise.length === 0
          ? `${targetLine}：已回滚，工作区和目标快照一致。`
          : `${targetLine}：已回滚，但还有 ${leftPrecise.length} 处差异（多半是你自己的手改，或排除规则挡住了）。`,
        changes: describe,
        details: [
          result.removed === undefined ? '' : `删掉了 ${result.removed} 个快照里不存在的文件。`,
          leftPrecise.length === 0 ? '' : `剩下的差异：\n${leftPrecise.map(e => `  ${e.status}  ${e.path}`).join('\n')}`,
          guardNote,
        ].filter(part => part !== '').join('\n'),
      }
    },
  })

  const statusTool = defineTool({
    name: 'project_status',
    description: '看一个项目现在跑到第几段，或者列出全部项目。只给状态灯，不给过程日志。',
    parameters: {
      project: {
        type: 'string',
        description: '项目名；不填就列出工作目录下所有项目。',
      },
      cwd: {
        type: 'string',
        description: '.project-flow 所在的绝对目录；不填就用当前对话的工作目录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'projects'],
        properties: {
          line: { type: 'string' },
          projects: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.projects.length === 0 ? value.line : [value.line, ...value.projects].join('\n'),
      }],
    },
    async execute(args, exec) {
      const cwd = args.cwd !== undefined && isAbsolute(args.cwd) ? args.cwd : cwdOf(ctx, exec.agent)
      if (args.project !== undefined) {
        const state = await readState(cwd, args.project)
        return { line: statusLine(state), projects: [] }
      }
      const lines = await listProjectLines(cwd)
      return { line: lines.length === 0 ? '还没有项目' : `${lines.length} 个项目：`, projects: lines }
    },
  })

  const modelsTool = defineTool({
    name: 'project_models',
    description: '看五段各用什么模型。第 1 段标了插件改不了，只能你在界面顶部切。只读。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['lines'],
        properties: {
          lines: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.lines.join('\n') }],
    },
    async execute() {
      const settings = settingsOf()
      const stage = (number, label, provider, model, note) => {
        const route = model === '' ? `继承主对话模型（${provider}）` : `${provider}/${model}`
        return `${number} ${label}：${route}${note === '' ? '' : ` —— ${note}`}`
      }
      return {
        lines: [
          '当前各段模型：',
          stage(1, '问意图', '主对话', settings.intentModel, settings.intentModel === ''
            ? '由界面顶部的模型选择决定，插件改不了'
            : `期望 ${settings.intentModel}，但实际仍由界面顶部决定，插件改不了`),
          stage(2, '规划', settings.planProvider === '' ? settings.provider : settings.planProvider, settings.planModel, ''),
          stage(3, '实施', settings.buildProvider === '' ? settings.provider : settings.buildProvider, settings.buildModel, ''),
          stage(4, '自检', settings.checkProvider === '' ? settings.provider : settings.checkProvider, settings.checkModel, ''),
          stage(5, '验收', '主对话', '', '由界面顶部的模型选择决定，插件改不了'),
          `返工上限：${settings.maxRework} 次；并发项目：${settings.maxConcurrentProjects}`,
          `自愈：单段失败重试 ${settings.maxStageRetries} 次，单段超时 ${Math.round(settings.stageTimeoutMs / 1000)} 秒，锁超过 ${Math.round(settings.staleLockMs / 60000)} 分钟无心跳算遗留`,
          `快照：${settings.snapshotEnabled === true ? '每次实施前后各打一张，可用 project_rollback 回滚' : '已关闭（snapshotEnabled=false）'}`,
          `版权：${COPYRIGHT}`,
          `许可：${LICENSE_NOTICE}`,
        ],
      }
    },
  })

  // A tool rather than a slash command: tool results render in the
  // conversation, while a command's `text` has no surface that displays it.
  const setTool = defineTool({
    name: 'project_set_model',
    description: '改某一阶段用的模型，改完立即生效不用重启。stage 取 规划/实施/自检 或 plan/build/check；model 留空表示恢复成继承当前模型。',
    parameters: {
      stage: {
        type: 'string',
        required: true,
        description: '要改的阶段：规划（第2段）、实施（第3段）、自检（第4段）。',
      },
      model: {
        type: 'string',
        description: '模型 id，例如 hy4flash、deepseek-v4.1-flash、glm-5.3-flash。留空表示清空，恢复继承当前模型。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'ok'],
        properties: {
          ok: { type: 'boolean' },
          line: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.line }],
    },
    async execute(args) {
      const map = {
        规划: 'planModel', plan: 'planModel',
        实施: 'buildModel', build: 'buildModel',
        自检: 'checkModel', check: 'checkModel',
      }
      const key = map[args.stage]
      if (key === undefined) {
        return { ok: false, line: `不认识的阶段「${args.stage}」。用 规划 / 实施 / 自检。` }
      }
      const value = (args.model ?? '').trim()
      if (value === '' || value === '清空' || value === 'reset') {
        await writeOverride({ [key]: '' })
        return { ok: true, line: `已把「${args.stage}」恢复成继承当前模型，立即生效。` }
      }
      await writeOverride({ [key]: value })
      const settings = settingsOf()
      const now = key === 'planModel' ? settings.planModel : key === 'buildModel' ? settings.buildModel : settings.checkModel
      return {
        ok: true,
        line: `已把「${args.stage}」设成 ${now}，立即生效，不用重启。配置文件：${overrideFile()}`,
      }
    },
  })

  ctx.effect(() => {
    const offRun = ctx.tools.register(runTool)
    const offResume = ctx.tools.register(resumeTool)
    const offDoctor = ctx.tools.register(doctorTool)
    const offSnapshots = ctx.tools.register(snapshotsTool)
    const offRollback = ctx.tools.register(rollbackTool)
    const offStatus = ctx.tools.register(statusTool)
    const offModels = ctx.tools.register(modelsTool)
    const offSet = ctx.tools.register(setTool)
    return () => {
      offRun()
      offResume()
      offDoctor()
      offSnapshots()
      offRollback()
      offStatus()
      offModels()
      offSet()
    }
  })

  // Human-facing slash commands: the fastest route from the composer,
  // with no panel to crash and no client bundle to keep in sync.
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    ctx.effect(() => {
      const offFlow = commands.register({
        name: 'flow',
        description: '开工作模式：把当前任务按五段跑（问意图→规划→实施→自检→验收）',
        input: { hint: '直接描述任务；留空则先问你' },
        handler: invocation => {
          const text = invocation.rawInput.trim()
          const ask = text === ''
            ? '我要开工作模式跑一个任务，但我还没说是什么。请先问我一个问题，问出我要做什么。'
            : `我要开工作模式跑这个任务：${text}`
          return {
            kind: 'success',
            text: `${ask}\n\n从现在起按工作模式执行：一次只问一个问题，问清意图，和我确认逐条要求清单，然后调用 project_run。`,
          }
        },
      })
      const offStatusCmd = commands.register({
        name: 'flow-status',
        description: '看当前项目跑到第几段、返工几次',
        handler: async invocation => {
          const cwd = cwdOf(ctx, invocation.agent)
          const lines = await listProjectLines(cwd)
          return {
            kind: 'success',
            text: lines.length === 0 ? '还没有项目。用 /flow 开一个。' : lines.join('\n'),
          }
        },
      })
      const offModelsCmd = commands.register({
        name: 'flow-models',
        description: '看五段各用什么模型',
        handler: () => {
          const settings = settingsOf()
          const route = (provider, model) => (model === '' ? `继承（${provider}）` : `${provider}/${model}`)
          return {
            kind: 'success',
            text: [
              '五段分工与模型：',
              `1 问意图：${settings.intentModel === '' ? '主对话当前模型' : settings.intentModel}（问清你要什么；主对话模型，插件改不了）`,
              `2 规划：${route(settings.planProvider === '' ? settings.provider : settings.planProvider, settings.planModel)}（出施工任务书）`,
              `3 实施：${route(settings.buildProvider === '' ? settings.provider : settings.buildProvider, settings.buildModel)}（照任务书干活）`,
              `4 自检：${route(settings.checkProvider === '' ? settings.provider : settings.checkProvider, settings.checkModel)}（挑毛病，不合格打回）`,
              '5 验收：主对话当前模型（对照你的要求逐条核；主对话模型，插件改不了）',
              `返工上限 ${settings.maxRework} 次，并发 ${settings.maxConcurrentProjects} 个项目`,
              `自愈：单段失败重试 ${settings.maxStageRetries} 次，单段超时 ${Math.round(settings.stageTimeoutMs / 1000)} 秒，锁超过 ${Math.round(settings.staleLockMs / 60000)} 分钟无心跳算遗留`,
              `快照：${settings.snapshotEnabled === true ? '每次实施前自动打一张，可回滚' : '已关闭（snapshotEnabled=false）'}`,
              '',
              '改模型：/flow-set 实施 hy4flash',
              `配置存于：${overrideFile()}`,
              `版权：${COPYRIGHT}　dsh-project-flow 由刘适开发与维护`,
              `许可：${LICENSE_NOTICE}`,
            ].join('\n'),
          }
        },
      })
      // Continue a project that was interrupted: crash, reload, or an abnormal stop.
      const offResumeCmd = commands.register({
        name: 'flow-resume',
        description: '接续被中断的项目：按磁盘上的产物重建上下文，从中断那段接着跑',
        input: { hint: '项目名；留空则先列出所有项目' },
        handler: async invocation => {
          const cwd = cwdOf(ctx, invocation.agent)
          const project = invocation.rawInput.trim()
          if (project === '') {
            const lines = await listProjectLines(cwd)
            return {
              kind: 'success',
              text: lines.length === 0
                ? '还没有项目。用 /flow 开一个。'
                : ['要让哪个项目接着跑？用 /flow-resume 项目名', ...lines].join('\n'),
            }
          }
          const state = await readState(cwd, project)
          return {
            kind: 'success',
            text: [
              state === undefined
                ? `没找到项目「${project}」的 state.json。先跑 /flow-doctor 看看 .project-flow 里剩下什么。`
                : `项目「${project}」现在：${statusLine(state)}`,
              '',
              `接下来调 project_resume，project="${project}"。它会把遗留锁、损坏的 state 处理掉，从中断的那一段接着跑，已经通过的段不重做。`,
            ].join('\n'),
          }
        },
      })
      const offDoctorCmd = commands.register({
        name: 'flow-doctor',
        description: '体检 .project-flow：遗留锁、损坏的 state.json、没收尾的阶段',
        input: { hint: 'fix 表示顺手修；留空只报告' },
        handler: async invocation => {
          const cwd = cwdOf(ctx, invocation.agent)
          const fix = invocation.rawInput.trim().toLowerCase() === 'fix'
          const actions = await sweep(cwd, settingsOf(), undefined, fix)
          return {
            kind: 'success',
            text: actions.length === 0
              ? '没发现问题：没有遗留锁，state.json 都在，也没有悬空没收尾的阶段。'
              : [actions.length + ' 处需要处理（' + (fix ? '已尝试修复' : '只报告，未改动任何文件') + '）：', ...actions].join('\n'),
          }
        },
      })
      // Change a stage's model at runtime; no restart, no config editing.
      const offSetCmd = commands.register({
        name: 'flow-set',
        description: '改某一阶段用的模型，改完立即生效不用重启',
        input: { hint: '比如：实施 hy4flash' },
        handler: async invocation => {
          const settings = settingsOf()
          const raw = invocation.rawInput.trim()
          if (raw === '') {
            return {
              kind: 'success',
              text: [
                '当前模型：',
                `2 规划：${settings.planModel === '' ? '继承' : settings.planModel}`,
                `3 实施：${settings.buildModel === '' ? '继承' : settings.buildModel}`,
                `4 自检：${settings.checkModel === '' ? '继承' : settings.checkModel}`,
                `返工上限：${settings.maxRework} 次`,
                '',
                '改法（阶段 + 空格 + 模型名）：',
                '  /flow-set 规划 deepseek-v4.1-flash',
                '  /flow-set 实施 hy4flash',
                '  /flow-set 自检 deepseek-v4.1-flash',
                '  /flow-set 重试 3',
                '  /flow-set 清空          某段回到继承当前模型',
                '',
                '注意：第 1 段问意图和第 5 段验收跑在主对话，模型只能用界面顶部的选择器切，这里改不了。',
              ].join('\n'),
            }
          }
          const [stageRaw, ...rest] = raw.split(/\s+/u)
          const value = rest.join(' ').trim()
          const stageMap = {
            规划: 'planModel', plan: 'planModel',
            实施: 'buildModel', build: 'buildModel',
            自检: 'checkModel', check: 'checkModel',
            意图: 'intentModel', intent: 'intentModel',
            重试: 'maxRework', rework: 'maxRework',
            并发: 'maxConcurrentProjects', concurrent: 'maxConcurrentProjects',
          }
          const key = stageMap[stageRaw]
          if (key === undefined) {
            return { kind: 'error', text: `不认识的阶段「${stageRaw}」。用 规划 / 实施 / 自检 / 重试 / 并发。` }
          }
          if (value === '') return { kind: 'error', text: `要给「${stageRaw}」一个值。` }

          if (value === '清空' || value === 'reset') {
            await writeOverride({ [key]: '' })
            return { kind: 'success', text: `已把「${stageRaw}」恢复成继承当前模型。` }
          }
          if (key === 'maxRework' || key === 'maxConcurrentProjects') {
            const number = Number(value)
            if (!Number.isInteger(number) || number < 0) {
              return { kind: 'error', text: `「${stageRaw}」要一个非负整数，你给的是「${value}」。` }
            }
            await writeOverride({ [key]: number })
            return { kind: 'success', text: `已设「${stageRaw}」= ${number}，立即生效。` }
          }
          await writeOverride({ [key]: value })
          return {
            kind: 'success',
            text: `已把「${stageRaw}」设成 ${value}，立即生效，不用重启。下次跑任务就用它。`,
          }
        },
      })
      // Snapshot and rollback are read-only-ish helpers: the first does not
      // touch the workspace at all, the second is a separate explicit tool.
      const offSnapshotsCmd = commands.register({
        name: 'flow-snapshots',
        description: '列出一个项目的全部快照，回滚时挑目标用',
        input: { hint: '项目名' },
        handler: async invocation => {
          const cwd = cwdOf(ctx, invocation.agent)
          const project = invocation.rawInput.trim()
          if (project === '') {
            const lines = await listProjectLines(cwd)
            return {
              kind: 'success',
              text: lines.length === 0
                ? '还没有项目。用 /flow 开一个。'
                : ['要让哪个项目的快照？用 /flow-snapshots 项目名', ...lines].join('\n'),
            }
          }
          const result = await snapshotsTool.execute({ project }, { agent: invocation.agent })
          return { kind: 'success', text: [result.line, ...result.entries].join('\n') }
        },
      })
      return () => {
        offFlow()
        offStatusCmd()
        offModelsCmd()
        offResumeCmd()
        offDoctorCmd()
        offSnapshotsCmd()
        offSetCmd()
      }
    })
  }

  ctx.systemPrompt.section({
    name: 'project-flow:policy',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 1,
    text: () => `## 工作模式（项目流程）

遇到需要产出或改动的任务，先问用户一句「这次开工作模式吗」。开了就按五段走，没开就正常做。

已开启时：

1. 第 1 段在主对话完成：一次只问一个问题，问出真实意图，并和用户确认一份逐条可核对的「要求清单」。不确认完不进入第 2 段。
2. 第 2 至 4 段调用 \`project_run\` 一次完成：规划、实施、自检都在独立子会话里跑，彼此只传任务书，不传过程。你不参与其中，也不要把中间产物搬进对话。这三段各自用哪个模型由插件配置决定；用户问起时用 \`project_models\` 查，不要凭印象回答。
3. 第 5 段在主对话完成：拿 \`project_run\` 返回的结果对照用户最初的要求逐条核，说清哪几条做到了、哪几条没做到、额外做了什么、返工几次、代价和残留风险。不要只说好话。
4. \`project_run\` 返回 \`stopped\` 或 \`blocked\` 时应停手把情况交给用户，不要自己加循环重跑。查进度用 \`project_status\`。
5. 第 1 段和用户对话时，如果用户指定的意图模型不是当前主对话模型，提醒他先在界面顶部切换——这一段插件切不了。
6. 插件自带自愈：单段异常会自动重试并带超时；进程崩了、插件重载、窗口被杀之后，用 \`project_resume\` 按磁盘产物从中断那段接着跑，不要从头重来。怀疑工作区有问题（遗留锁、state.json 损坏、悬空阶段）时先跑 \`project_doctor\`，默认只报告，\`fix: true\` 才动手。
7. 每次实施前后会自动打快照。用户说「改废了」「回滚」「退回刚才的样子」时，先用 \`project_snapshots\` 列出目标，再用 \`project_rollback\` 干跑给 diff，用户确认后才 \`dryRun: false\` 真回滚。\`mode: "full"\` 整棵恢复、\`mode: "precise"\` 只还原那一轮动过的文件；说不清就用 full。

子 agent 问不了用户，所以只有你能问；把答案压成要求清单再交给流程。
（${COPYRIGHT} · dsh-project-flow · ${LICENSE_NOTICE}）`,
  })
}
