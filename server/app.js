import express from 'express'
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getState, initStore, persist } from './store.js'
import { emitRunEvent, getRun, startRun, stopRun } from './agent.js'
import { coralConfig, compileWithCoral } from './coral.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 3001)

app.use(express.json({ limit: '20mb' }))
app.use((req, res, next) => {
  const origin = req.headers.origin || ''
  if (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173' || /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
app.use(express.static(path.join(__dirname, 'public')))

const publicState = () => {
  const state = getState()
  return { workflows: state.workflows, portal: state.portal, recording: state.recording, dataSource: { name: state.dataSource?.name, columns: state.dataSource?.columns, rowCount: state.dataSource?.rows?.length || 0 }, extension: { ...extensionStatus, connected: Boolean(extensionStatus.lastSeen && Date.now() - Date.parse(extensionStatus.lastSeen) < 30000) } }
}

let extensionStatus = { connected: false, lastSeen: null }
let extensionCommands = []
let extensionPollers = []
function queueExtensionCommand(command) {
  const poller = extensionPollers.shift()
  if (poller) { clearTimeout(poller.timer); poller.res.json({ commands: [command] }) }
  else extensionCommands.push(command)
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'evolveos-agent', coral: coralConfig(), time: new Date().toISOString() }))
app.get('/api/coral/status', (_req, res) => res.json(coralConfig()))
app.get('/api/state', (_req, res) => res.json(publicState()))
app.get('/api/workflows', (_req, res) => res.json({ workflows: getState().workflows }))

app.post('/api/source', async (req, res) => {
  const { name, columns, rows } = req.body || {}
  const cleanColumns = Array.isArray(columns) ? columns.map((column) => String(column || '').trim()).filter(Boolean) : []
  if (!cleanColumns.length || new Set(cleanColumns).size !== cleanColumns.length || !Array.isArray(rows) || rows.length > 5000 || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) return res.status(400).json({ error: 'Upload a tabular file with unique column names and at most 5,000 data rows.' })
  const cleanRows = rows.map((row) => Object.fromEntries(cleanColumns.map((column) => [column, row[column] == null ? '' : String(row[column]).slice(0, 10000)])))
  getState().dataSource = { name: String(name || 'Uploaded sheet').slice(0, 150), columns: cleanColumns, rows: cleanRows }
  await persist()
  res.json({ name: getState().dataSource.name, columns: cleanColumns, rowCount: cleanRows.length, preview: cleanRows.slice(0, 5) })
})

app.put('/api/workflows/:id/mapping', async (req, res) => {
  const workflow = getState().workflows.find((item) => item.id === req.params.id)
  if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
  workflow.mapping = req.body?.mapping || {}
  await persist()
  res.json({ mapping: workflow.mapping })
})

app.get('/api/extension/poll', (_req, res) => {
  extensionStatus = { connected: true, lastSeen: new Date().toISOString() }
  if (extensionCommands.length) return res.json({ commands: extensionCommands.splice(0), api: `http://localhost:${port}` })
  const poller = { res, timer: setTimeout(() => { extensionStatus.lastSeen = new Date().toISOString(); extensionPollers = extensionPollers.filter((item) => item !== poller); res.json({ commands: [] }) }, 12000) }
  extensionPollers.push(poller)
  res.on('close', () => { clearTimeout(poller.timer); extensionPollers = extensionPollers.filter((item) => item !== poller) })
})

app.post('/api/extension/command', (req, res) => {
  const command = req.body || {}
  queueExtensionCommand({ ...command, queuedAt: new Date().toISOString() })
  res.status(202).json({ queued: true })
})

app.post('/api/extension/event', async (req, res) => {
  extensionStatus = { connected: true, lastSeen: new Date().toISOString() }
  const event = req.body || {}
  if (event.runId) {
    if (event.type === 'REPLAY_CONNECTED') {
      const run = getRun(event.runId)
      if (run) run.tabId = event.tabId
    }
    emitRunEvent(event.runId, event)
  }
  if (event.recordingId) {
    const recording = getState().recording
    if (recording?.id === event.recordingId && recording.active) {
      recording.events.push({ ...event, recordedAt: new Date().toISOString() })
      await persist()
    }
  }
  res.status(202).json({ accepted: true })
})

app.post('/api/workflows', async (req, res) => {
  const workflow = { id: `wf_${Date.now()}`, name: req.body?.name || 'Untitled Workflow', goal: req.body?.goal || '', runs: 0, successRate: 0, steps: [] }
  getState().workflows.unshift(workflow)
  await persist()
  res.status(201).json({ workflow })
})

app.post('/api/recordings/start', async (req, res) => {
  const state = getState()
  let target
  try { target = new URL(req.body?.targetUrl) } catch { return res.status(400).json({ error: 'Enter a valid website URL, including https://.' }) }
  if (!['http:', 'https:'].includes(target.protocol)) return res.status(400).json({ error: 'Only HTTP and HTTPS websites can be recorded.' })
  if (state.recording?.active) return res.status(409).json({ error: 'Stop the current recording before starting another.' })
  state.recording = { id: `rec_${Date.now()}`, targetUrl: target.href, startedAt: new Date().toISOString(), events: [], active: true }
  await persist()
  queueExtensionCommand({ type: 'record_start', recordingId: state.recording.id, targetUrl: state.recording.targetUrl })
  res.status(201).json({ recording: state.recording })
})

app.post('/api/recordings/current/events', async (req, res) => {
  const recording = getState().recording
  if (!recording) return res.status(404).json({ error: 'No active recording' })
  const event = { ...req.body, at: new Date().toISOString(), type: req.body?.type || 'unknown', target: req.body?.target || null }
  recording.events.push(event)
  await persist()
  res.status(201).json({ event, count: recording.events.length })
})

app.post('/api/recordings/:id/events', async (req, res) => {
  const recording = getState().recording
  if (!recording || (req.params.id !== 'current' && recording.id !== req.params.id)) return res.status(404).json({ error: 'Recording not found' })
  const event = { ...req.body, at: new Date().toISOString(), type: req.body?.type || 'unknown', target: req.body?.target || null }
  recording.events.push(event)
  await persist()
  res.status(201).json({ event, count: recording.events.length })
})

app.post('/api/recordings/:id/stop', async (req, res) => {
  const recording = getState().recording
  if (!recording || recording.id !== req.params.id) return res.status(404).json({ error: 'Recording not found' })
  recording.active = false
  await persist()
  queueExtensionCommand({ type: 'record_stop', recordingId: recording.id })
  res.json({ recording })
})

app.post('/api/workflows/:id/extract', async (req, res) => {
  const workflow = getState().workflows.find((item) => item.id === req.params.id)
  if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
  const observed = req.body?.events || getState().recording?.events || []
  const capturedActions = observed.filter((event) => ['click', 'field'].includes(event.type) && event.locator)
  if (!capturedActions.some((event) => event.type === 'field')) return res.status(400).json({ error: 'No form fields were captured. Start a recording, change at least one non-password field, then stop and evolve again.' })
  if (!capturedActions.some((event) => event.type === 'click')) return res.status(400).json({ error: 'No button or link actions were captured. Record the form submission or navigation action before evolving.' })
  let compiled = null
  let provider = 'local deterministic compiler'
  try {
    compiled = await compileWithCoral(observed)
    if (compiled) provider = `${compiled.provider} · ${compiled.model}`
  } catch (error) {
    console.warn(`Coral compiler unavailable: ${error.message}`)
  }
  workflow.name = compiled?.name || (workflow.name === 'Untitled Workflow' ? 'Recorded workflow' : workflow.name)
  workflow.goal = compiled?.goal || `Replay ${capturedActions.length} captured browser actions with mapped spreadsheet data`
  workflow.recordedActions = capturedActions.map(({ type, target, locator, pageUrl }) => ({ type, target, locator, pageUrl }))
  const fallbackSteps = workflow.recordedActions.map((action, index) => ({ action: action.type === 'field' ? 'fill' : 'click', label: `${action.type === 'field' ? 'Fill' : 'Click'} ${action.target}`, target: action.target, expected: action.type === 'field' ? `The ${action.target} field contains the mapped row value` : `${action.target} was activated` }))
  const semanticSteps = [...(compiled?.steps?.length ? compiled.steps : fallbackSteps)]
  if (!semanticSteps.some((step) => step.action === 'verify')) semanticSteps.push({ action: 'verify', label: 'Review website result', target: 'visible completion state', expected: 'Confirm the website accepted the change', recovery: 'Pause and inspect the target site before continuing' })
  workflow.steps = semanticSteps.map((step, index) => ({ ...step, id: `step_${index + 1}`, state: 'queued' }))
  workflow.fields = [...new Map(observed.filter((event) => event.type === 'field' || event.type === 'input').map((event) => [event.locator?.key || event.target, { key: event.locator?.key || event.target, label: event.target, locator: event.locator }])).values()]
  workflow.targetUrl = observed.find((event) => event.pageUrl)?.pageUrl || workflow.targetUrl || ''
  workflow.observedActions = observed.length
  workflow.compiler = provider
  await persist()
  res.json({ workflow, compiler: provider, compression: { observed: workflow.observedActions, semantic: workflow.steps.length } })
})

app.post('/api/workflows/:id/run', async (req, res) => {
  try {
    const workflow = getState().workflows.find((item) => item.id === req.params.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    const { rows = [], columns = [] } = getState().dataSource || {}
    if (!rows.length) return res.status(400).json({ error: 'Upload a spreadsheet before running rows.' })
    const missingMap = (workflow.fields || []).filter((field) => !workflow.mapping?.[field.key] || !columns.includes(workflow.mapping[field.key]))
    if (missingMap.length) return res.status(400).json({ error: `Map sheet columns for: ${missingMap.map((field) => field.label).join(', ')}` })
    const rowIndices = Array.isArray(req.body?.rowIndices) ? req.body.rowIndices : rows.map((_, index) => index)
    if (rowIndices.length > 100 || rowIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= rows.length)) return res.status(400).json({ error: 'Choose between 1 and 100 valid spreadsheet rows per run.' })
    const selectedRows = rowIndices.map((index) => rows[index])
    if (!selectedRows.length) return res.status(400).json({ error: 'Select at least one data row.' })
    if (!workflow.fields?.length) return res.status(400).json({ error: 'Record at least one website input field before running spreadsheet rows.' })
    const run = await startRun(req.params.id)
    queueExtensionCommand({ type: 'workflow_replay', runId: run.id, targetUrl: workflow.targetUrl, actions: workflow.recordedActions, mapping: workflow.mapping, rows: selectedRows })
    res.status(202).json({ runId: run.id, state: run.state })
  } catch (error) { res.status(400).json({ error: error.message }) }
})

app.post('/api/runs/:id/stop', (req, res) => {
  const stopped = stopRun(req.params.id)
  const run = getRun(req.params.id)
  if (stopped && run?.tabId) queueExtensionCommand({ type: 'cancel_run', runId: run.id, tabId: run.tabId })
  res.json({ stopped })
})

app.get('/api/runs/:id/events', (req, res) => {
  const run = getRun(req.params.id)
  if (!run) return res.status(404).end()
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  run.history.forEach(send)
  const listener = (payload) => send(payload)
  run.emitter.on('event', listener)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => { clearInterval(heartbeat); run.emitter.off('event', listener) })
})

app.post('/api/portal/reset', async (_req, res) => {
  Object.assign(getState().portal, { buttonLabel: 'Save Changes', status: 'ready', lastAction: null })
  await persist()
  res.json({ portal: getState().portal })
})

app.post('/api/portal/mutate', async (_req, res) => {
  const portal = getState().portal
  portal.buttonLabel = portal.buttonLabel === 'Save Changes' ? 'Apply Update' : 'Save Changes'
  portal.status = 'ready'
  await persist()
  res.json({ portal })
})

app.get('/demo-portal', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')))

initStore().then(() => app.listen(port, '127.0.0.1', () => console.log(`EvolveOS agent server listening on http://localhost:${port}`))).catch((error) => { console.error(error); process.exit(1) })
