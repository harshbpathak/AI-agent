import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { getState, persist } from './store.js'

const runs = new Map()

export function emitRunEvent(runId, payload) {
  const run = runs.get(runId)
  if (!run) return null
  const message = { at: new Date().toISOString(), ...payload }
  run.history.push(message)
  run.emitter.emit('event', message)
  if (message.type === 'RUN_COMPLETED') {
    run.state = 'complete'
    const workflow = getState().workflows.find((item) => item.id === run.workflowId)
    if (workflow) { workflow.runs = (workflow.runs || 0) + 1; workflow.successRate = 1 }
    if (getState().portal) getState().portal.status = 'verified'
    persist()
  }
  if (message.type === 'RUN_FAILED' || message.type === 'EXTENSION_ERROR') run.state = 'failed'
  if (message.type === 'REPAIR_REQUIRED') run.state = 'repairing'
  if (message.type === 'RUN_STOPPED') run.state = 'stopped'
  return message
}

export function getRun(id) {
  return runs.get(id)
}

export async function startRun(workflowId) {
  const workflow = getState().workflows.find((item) => item.id === workflowId)
  if (!workflow) throw new Error('Workflow not found')
  if (!workflow.recordedActions?.length) throw new Error('This workflow has no captured browser actions. Install the extension and record the target website first.')
  const run = { id: `run_${crypto.randomUUID()}`, workflowId, state: 'running', history: [], emitter: new EventEmitter(), stopped: false }
  runs.set(run.id, run)
  emitRunEvent(run.id, { type: 'RUN_STARTED', message: 'Browser replay queued' })
  return run
}

export function stopRun(id) {
  const run = runs.get(id)
  if (!run || ['complete', 'failed', 'stopped'].includes(run.state)) return false
  run.stopped = true
  run.state = 'stopped'
  emitRunEvent(id, { type: 'RUN_STOPPED', runId: id, message: 'Run stopped by user' })
  return true
}
