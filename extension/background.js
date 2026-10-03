const API = 'http://127.0.0.1:3001/api'
let polling = false

async function report(payload) {
  try { await fetch(`${API}/extension/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }) } catch {}
}

async function findTargetTab(url = '') {
  const tabs = await chrome.tabs.query({})
  if (url) {
    try {
      const origin = new URL(url).origin
      const match = tabs.find((tab) => tab.url?.startsWith(origin) && !tab.url.startsWith('chrome-extension://'))
      if (match) return match
    } catch {}
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return active
}

async function sendToTab(tabId, message) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try { return await chrome.tabs.sendMessage(tabId, message) } catch { await new Promise((resolve) => setTimeout(resolve, 350)) }
  }
  throw new Error('EvolveOS could not connect to the target tab. Reload the page and try again.')
}

async function runCommand(command) {
  if (command.type === 'record_start') {
    let tab
    try { tab = await chrome.tabs.create({ url: command.targetUrl, active: true }) } catch { tab = await findTargetTab(command.targetUrl) }
    if (!tab?.id) throw new Error('No target browser tab available')
    await sendToTab(tab.id, { type: 'EVOLVE_RECORD_START', recordingId: command.recordingId })
    await chrome.storage.local.set({ recordingId: command.recordingId, recordingTabId: tab.id })
    await report({ type: 'RECORDER_CONNECTED', recordingId: command.recordingId, tabId: tab.id, pageUrl: tab.url })
  }
  if (command.type === 'record_stop') {
    const { recordingTabId } = await chrome.storage.local.get('recordingTabId')
    if (recordingTabId) await sendToTab(recordingTabId, { type: 'EVOLVE_RECORD_STOP' }).catch(() => {})
    await chrome.storage.local.remove(['recordingId', 'recordingTabId'])
  }
  if (command.type === 'workflow_replay') {
    const tab = await findTargetTab(command.targetUrl)
    if (!tab?.id) throw new Error('Open the recorded website in a browser tab, then run again')
    await sendToTab(tab.id, { type: 'EVOLVE_REPLAY', ...command })
    await report({ type: 'REPLAY_CONNECTED', runId: command.runId, tabId: tab.id, pageUrl: tab.url })
  }
  if (command.type === 'cancel_run' && command.tabId) await chrome.tabs.sendMessage(command.tabId, { type: 'EVOLVE_CANCEL_RUN', runId: command.runId }).catch(() => {})
}

async function poll() {
  if (polling) return
  polling = true
  try {
    const response = await fetch(`${API}/extension/poll`)
    const { commands = [] } = await response.json()
    for (const command of commands) {
      try { await runCommand(command) }
      catch (error) { await report({ type: 'EXTENSION_ERROR', runId: command.runId, recordingId: command.recordingId, message: error.message }) }
    }
  } catch {}
  polling = false
}

async function pollLoop() {
  while (true) {
    await poll()
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('evolve-poll', { periodInMinutes: 0.5 }); poll() })
chrome.alarms.onAlarm.addListener(poll)
chrome.runtime.onStartup.addListener(poll)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'EVOLVE_CAPTURED') report(message.event)
  if (message.type === 'EVOLVE_RUN_EVENT') report(message.event)
})
pollLoop()
