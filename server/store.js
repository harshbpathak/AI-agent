import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(here, '..', 'data')
const dataFile = path.join(dataDir, 'evolveos.json')

const seed = {
  workflows: [{
    id: 'customer',
    name: 'Customer Update',
    goal: 'Update customer information in the legacy CRM',
    runs: 7,
    successRate: 1,
    steps: [
      { id: 'step_1', action: 'open_url', label: 'Open customer portal', target: 'legacy CRM', expected: 'Customer portal is visible', state: 'done' },
      { id: 'step_2', action: 'find', label: 'Search customer', target: 'customer search input', expected: 'Matching customer appears', state: 'done' },
      { id: 'step_3', action: 'click', label: 'Open customer record', target: 'matching customer result', expected: 'Customer record is open', state: 'done' },
      { id: 'step_4', action: 'fill', label: 'Fill customer details', target: 'name and phone fields', input: '{{customer_name}}, {{phone}}', expected: 'Fields contain the new values', state: 'active' },
      { id: 'step_5', action: 'click', label: 'Save changes', target: 'Save Changes button', expected: 'Update is accepted', state: 'queued', recovery: 'semantic_regrounding' },
      { id: 'step_6', action: 'verify', label: 'Verify success', target: 'success confirmation', expected: 'Customer updated successfully', state: 'queued' },
    ],
  }],
  portal: {
    buttonLabel: 'Save Changes',
    selectedCustomer: 'CUS-00428',
    customerName: 'Maya Patel',
    phone: '+91 98765 43210',
    status: 'ready',
    lastAction: null,
  },
  recording: null,
  dataSource: { name: null, columns: [], rows: [] },
}

let state = null

export async function initStore() {
  await fs.mkdir(dataDir, { recursive: true })
  try {
    state = JSON.parse(await fs.readFile(dataFile, 'utf8'))
  } catch {
    state = structuredClone(seed)
  }
  if (!state.dataSource) state.dataSource = { name: null, columns: [], rows: [] }
  if (!state.dataSource.rows) state.dataSource.rows = []
  if (state.fieldMapping && state.workflows[0] && !state.workflows[0].mapping) state.workflows[0].mapping = state.fieldMapping
  delete state.fieldMapping
  await persist()
  return state
}

export function getState() {
  if (!state) throw new Error('Store has not been initialized')
  return state
}

export async function persist() {
  await fs.writeFile(dataFile, JSON.stringify(state, null, 2), 'utf8')
}

export async function update(mutator) {
  const result = await mutator(state)
  await persist()
  return result
}

export { dataFile }
