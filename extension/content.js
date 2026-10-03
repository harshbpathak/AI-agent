let recordingId = null
let replaying = false
let lastClickAt = 0
const cancelledRuns = new Set()

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180) }
function selectorFor(element) {
  if (element.id) return `#${CSS.escape(element.id)}`
  const stable = ['data-testid', 'name', 'aria-label', 'placeholder'].find((key) => element.getAttribute(key))
  if (stable) return `${element.tagName.toLowerCase()}[${stable}="${CSS.escape(element.getAttribute(stable))}"]`
  const path = []
  let node = element
  while (node && node !== document.body && path.length < 5) {
    let part = node.tagName.toLowerCase()
    if (node.classList.length) part += `.${[...node.classList].slice(0, 2).map(CSS.escape).join('.')}`
    const siblings = node.parentElement ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName) : []
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
    path.unshift(part)
    node = node.parentElement
  }
  return path.join(' > ')
}
function describe(element) {
  const label = element.labels?.[0]?.innerText || element.closest('label')?.innerText || ''
  const text = element.isContentEditable ? '' : element.innerText || ''
  const tag = element.tagName.toLowerCase()
  const placeholder = element.getAttribute('placeholder') || ''
  const aria = element.getAttribute('aria-label') || ''
  const name = element.getAttribute('name') || ''
  const type = element.getAttribute('type') || ''
  const target = clean(label || aria || placeholder || element.getAttribute('title') || text || name || tag)
  const key = clean(element.id || name || aria || placeholder || label || `${tag}_${type}_${selectorFor(element)}`).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return { target, locator: { selector: selectorFor(element), tag, id: element.id || '', name, placeholder, ariaLabel: aria, label: clean(label), text: clean(text), type, contentEditable: element.isContentEditable, key } }
}
function emit(type, element) {
  if (!recordingId || replaying) return
  const detail = describe(element)
  chrome.runtime.sendMessage({ type: 'EVOLVE_CAPTURED', event: { recordingId, type, target: detail.target, locator: detail.locator, pageUrl: location.href, pageTitle: document.title } })
}
document.addEventListener('click', (event) => {
  if (!recordingId || replaying || Date.now() - lastClickAt < 250) return
  const element = event.target.closest('button,a,[role="button"],input[type="submit"],input[type="button"]')
  if (!(element instanceof HTMLElement)) return
  lastClickAt = Date.now()
  emit('click', element)
}, true)
document.addEventListener('change', (event) => {
  const element = event.target
  if (!recordingId || replaying || !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element instanceof HTMLElement && element.isContentEditable)) return
  const sensitive = element.type === 'password' || element.autocomplete?.toLowerCase().includes('password')
  if (sensitive) return
  emit('field', element)
}, true)

function words(value) { return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((word) => word.length > 1) }
function findElement(locator = {}, target = '') {
  if (locator.selector) {
    try { const exact = document.querySelector(locator.selector); if (exact && exact.getClientRects().length) return { element: exact, repaired: false } } catch {}
  }
  const isField = ['input', 'textarea', 'select'].includes(String(locator.tag || '').toLowerCase()) || locator.contentEditable
  const selector = isField ? 'input:not([type=password]),textarea,select,[contenteditable="true"]' : 'button,a,[role=button],input[type=submit],input[type=button]'
  const candidates = [...document.querySelectorAll(selector)].filter((element) => element.getClientRects().length && !element.disabled)
  const expected = [locator.label, locator.ariaLabel, locator.placeholder, locator.name, target].map((part) => clean(part).toLowerCase()).filter(Boolean)
  const actionWords = words(target)
  const equivalences = [['save', 'submit', 'update', 'apply', 'confirm', 'done'], ['customer', 'contact', 'client', 'record', 'details', 'information']]
  const scored = candidates.map((element) => {
    const info = describe(element).locator
    const available = [info.label, info.ariaLabel, info.placeholder, info.name, element.innerText, element.value].map((part) => clean(part).toLowerCase()).filter(Boolean)
    let score = expected.reduce((total, term) => total + (available.includes(term) ? 5 : available.some((item) => item && item.length > 2 && (item.includes(term) || term.includes(item)) ? 2 : 0)), 0)
    const actualWords = new Set(available.flatMap(words))
    score += actionWords.filter((word) => actualWords.has(word)).length * 2
    if (!isField) score += equivalences.filter((group) => group.some((word) => actionWords.includes(word)) && group.some((word) => actualWords.has(word))).length * 3
    return { element, score }
  }).sort((a, b) => b.score - a.score)
  if (!scored[0]?.score || (scored[1] && scored[0].score - scored[1].score < 2)) return null
  return { element: scored[0].element, repaired: true }
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function inputValue(element, value) {
  if (element instanceof HTMLElement && element.isContentEditable) {
    element.innerText = String(value ?? '')
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value ?? '') }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }
  if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
    const normalized = String(value ?? '').trim().toLowerCase()
    const checkedValues = ['1', 'true', 'yes', 'y', 'on', 'checked']
    element.checked = element.type === 'radio' && !checkedValues.includes(normalized) && !['0', 'false', 'no', 'n', 'off', ''].includes(normalized)
      ? element.value.toLowerCase() === normalized
      : checkedValues.includes(normalized)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }
  if (element instanceof HTMLSelectElement) {
    const normalized = String(value ?? '').trim().toLowerCase()
    const options = [...element.options]
    const match = options.find((option) => option.value.trim().toLowerCase() === normalized || clean(option.label || option.textContent).toLowerCase() === normalized)
    value = match?.value ?? value
  }
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
  setter ? setter.call(element, value) : element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}
async function replay(command) {
  replaying = true
  const actions = command.actions || []
  const rows = command.rows || [{}]
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]
    for (let stepIndex = 0; stepIndex < actions.length; stepIndex += 1) {
      if (cancelledRuns.has(command.runId)) { cancelledRuns.delete(command.runId); replaying = false; chrome.runtime.sendMessage({ type: 'EVOLVE_RUN_EVENT', event: { type: 'RUN_STOPPED', runId: command.runId, message: 'Browser replay stopped.' } }); return }
      const action = actions[stepIndex]
      chrome.runtime.sendMessage({ type: 'EVOLVE_RUN_EVENT', event: { type: 'STEP_STARTED', runId: command.runId, stepIndex, rowIndex, message: `Row ${rowIndex + 1}/${rows.length}: locating ${action.target}` } })
      const located = findElement(action.locator || {}, action.target)
      if (!located) {
        chrome.runtime.sendMessage({ type: 'EVOLVE_RUN_EVENT', event: { type: 'REPAIR_REQUIRED', runId: command.runId, stepIndex, rowIndex, target: action.target, message: `Couldn't find ${action.target}; semantic locator search failed.` } })
        replaying = false
        return
      }
      const element = located.element
      if (located.repaired) chrome.runtime.sendMessage({ type: 'EVOLVE_RUN_EVENT', event: { type: 'TARGET_REPAIRED', runId: command.runId, stepIndex, rowIndex, target: action.target, message: `Re-found “${action.target}” using its visible label.` } })
      if (action.type === 'field') {
        const column = command.mapping?.[action.locator?.key] || command.mapping?.[action.target]
        const value = column ? row[column] : ''
        if (value !== undefined) inputValue(element, String(value ?? ''))
      } else if (action.type === 'click') {
        element.scrollIntoView({ block: 'center', behavior: 'instant' })
        element.click()
      }
      chrome.runtime.sendMessage({ type: 'EVOLVE_RUN_EVENT', event: { type: 'STEP_COMPLETED', runId: command.runId, stepIndex, rowIndex, message: `Row ${rowIndex + 1}/${rows.length}: ${action.type === 'field' ? 'filled' : 'clicked'} ${action.target}` } })
      await wait(180)
    }
    await wait(450)
    const confirmation = [...document.querySelectorAll('[role=alert],[role=status],[aria-live],.toast,.notification,.success')].map((element) => clean(element.innerText)).join(' ')
    const pageText = clean(document.body.innerText).toLowerCase()
    const submitAction = /save|update|submit|create/i.test(actions.at(-1)?.target || '')
    const successVisible = /success|saved successfully|changes saved|updated successfully|update complete|submitted successfully|created successfully/i.test(confirmation) || /success|saved successfully|changes saved|updated successfully|update complete|submitted successfully|created successfully/i.test(pageText)
    const failureVisible = /something went wrong|unable to save|could not save|submission failed|validation error/i.test(confirmation) || /something went wrong|unable to save|could not save|submission failed/i.test(pageText)
    if (submitAction && (!successVisible || failureVisible)) {
      chrome.runtime.sendMessage({ type: 'EVOLVE_RUN_EVENT', event: { type: 'REPAIR_REQUIRED', runId: command.runId, rowIndex, message: `The page did not show a clear success confirmation for row ${rowIndex + 1}. Review the website before continuing.` } })
      replaying = false
      return
    }
    chrome.runtime.sendMessage({ type: 'EVOLVE_RUN_EVENT', event: { type: 'ROW_COMPLETED', runId: command.runId, rowIndex, message: `Completed row ${rowIndex + 1} of ${rows.length}` } })
  }
  replaying = false
  chrome.runtime.sendMessage({ type: 'EVOLVE_RUN_EVENT', event: { type: 'RUN_COMPLETED', runId: command.runId, message: `Finished ${rows.length} rows in the browser.` } })
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'EVOLVE_RECORD_START') { recordingId = message.recordingId; chrome.runtime.sendMessage({ type: 'EVOLVE_CAPTURED', event: { recordingId, type: 'page', target: document.title, pageUrl: location.href, pageTitle: document.title } }) }
  if (message.type === 'EVOLVE_RECORD_STOP') recordingId = null
  if (message.type === 'EVOLVE_CANCEL_RUN') cancelledRuns.add(message.runId)
  if (message.type === 'EVOLVE_REPLAY') replay(message).catch((error) => chrome.runtime.sendMessage({ type: 'EVOLVE_RUN_EVENT', event: { type: 'RUN_FAILED', runId: message.runId, message: error.message } }))
})
