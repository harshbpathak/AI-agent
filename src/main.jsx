import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import sampleCsv from '../demo/customers.csv?raw'
import './styles.css'

const API = '/api'

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, options)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`)
  return payload
}

function csvRows(text) {
  const result = []
  let row = [], cell = '', quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '"' && quoted && text[index + 1] === '"') { cell += '"'; index += 1 }
    else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) { row.push(cell); cell = '' }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && text[index + 1] === '\n') index += 1; row.push(cell); result.push(row); row = []; cell = '' }
    else cell += char
  }
  if (cell || row.length) { row.push(cell); result.push(row) }
  return result
}

function toTable(matrix) {
  const headers = (matrix.shift() || []).map((value, index) => String(value || `Column ${index + 1}`).trim())
  const rows = matrix.filter((row) => row.some((value) => String(value ?? '').trim())).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] instanceof Date ? row[index].toISOString() : String(row[index] ?? '')])))
  if (!headers.length || !rows.length) throw new Error('Choose a sheet with a header row and at least one data row.')
  if (new Set(headers).size !== headers.length) throw new Error('Column names must be unique. Please rename duplicate headers and try again.')
  return { columns: headers, rows }
}

const displayName = (workflow) => workflow?.name === 'Untitled Workflow' ? 'Untitled workflow' : workflow?.name || 'New workflow'

function App() {
  const [workflows, setWorkflows] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [workflow, setWorkflow] = useState(null)
  const [mode, setMode] = useState('loading')
  const [recordingId, setRecordingId] = useState(null)
  const [runId, setRunId] = useState(null)
  const [logs, setLogs] = useState([])
  const [dataSource, setDataSource] = useState({ name: '', columns: [], rowCount: 0 })
  const [preview, setPreview] = useState([])
  const [mapping, setMapping] = useState({})
  const [extension, setExtension] = useState({ connected: false })
  const [coral, setCoral] = useState({ enabled: false, model: 'deepseek-v4-flash-lite' })
  const [targetUrl, setTargetUrl] = useState('http://127.0.0.1:3001/demo-portal')
  const [runLimit, setRunLimit] = useState(1)
  const [batchStart, setBatchStart] = useState(1)
  const [recordingCount, setRecordingCount] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const fields = workflow?.fields || []
  const actions = workflow?.recordedActions || []
  const hasMapping = fields.length > 0 && fields.every((field) => mapping[field.key])
  const canRun = extension.connected && dataSource.rowCount > 0 && actions.length > 0 && hasMapping
  const readyCount = Number(dataSource.rowCount > 0) + Number(actions.length > 0) + Number(canRun)
  const log = useCallback((text, type = 'info') => setLogs((current) => [{ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), text, type }, ...current].slice(0, 40)), [])

  const loadState = useCallback(async () => {
    try {
      const [state, health] = await Promise.all([request('/state'), request('/health')])
      const loaded = state.workflows || []
      setWorkflows(loaded)
      setDataSource({ name: state.dataSource?.name || '', columns: state.dataSource?.columns || [], rowCount: state.dataSource?.rowCount || 0 })
      setExtension(state.extension || { connected: false })
      setCoral(health.coral || { enabled: false })
      const chosen = loaded.find((item) => item.id === selectedId) || loaded.find((item) => !item.recordedActions?.length) || loaded[0]
      if (chosen) { setSelectedId(chosen.id); setWorkflow(chosen); setMapping(chosen.mapping || {}) }
      setMode((current) => current === 'loading' || current === 'offline' ? 'ready' : current)
    } catch (loadError) { setError(loadError.message); setMode('offline') }
  }, [selectedId])

  useEffect(() => { loadState() }, [loadState])
  useEffect(() => { setRunLimit((current) => Math.max(1, Math.min(current, 100, dataSource.rowCount - batchStart + 1 || 1))) }, [batchStart, dataSource.rowCount])
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const state = await request('/state')
        setExtension(state.extension || { connected: false })
        if (recordingId && state.recording?.id === recordingId) {
          setRecordingCount(state.recording.events?.length || 0)
          const currentWorkflow = state.workflows.find((item) => item.id === selectedId)
          if (currentWorkflow) setWorkflow(currentWorkflow)
        }
      } catch {}
    }, 1600)
    return () => clearInterval(timer)
  }, [recordingId, selectedId])

  useEffect(() => {
    if (!runId) return undefined
    const source = new EventSource(`${API}/runs/${runId}/events`)
    source.onmessage = (message) => {
      const event = JSON.parse(message.data)
      if (event.type === 'RUN_STARTED') setMode('running')
      if (event.type === 'STEP_STARTED') setWorkflow((current) => current && ({ ...current, steps: current.steps.map((step, index) => ({ ...step, state: index === event.stepIndex ? 'active' : index < event.stepIndex ? 'done' : 'queued' })) }))
      if (event.type === 'STEP_COMPLETED' && Number.isInteger(event.stepIndex)) setWorkflow((current) => current && ({ ...current, steps: current.steps.map((step, index) => index === event.stepIndex ? { ...step, state: 'done' } : step) }))
      if (event.type === 'REPAIR_REQUIRED') { setMode('repairing'); log(`Needs your review: ${event.message}`, 'warning') }
      if (event.type === 'TARGET_REPAIRED') log(event.message, 'warning')
      if (event.type === 'ROW_COMPLETED') log(event.message, 'success')
      if (event.type === 'RUN_COMPLETED') { setMode('complete'); log(event.message, 'success'); loadState(); source.close() }
      if (event.type === 'RUN_FAILED' || event.type === 'EXTENSION_ERROR') { setMode('failed'); setError(event.message); source.close() }
      if (event.type === 'RUN_STOPPED') { setMode('ready'); source.close() }
      if (event.message) log(event.message, event.type?.includes('REPAIR') ? 'warning' : event.type === 'RUN_STARTED' ? 'info' : 'success')
    }
    source.onerror = () => { if (!['running', 'recording'].includes(mode)) source.close() }
    return () => source.close()
  }, [runId, loadState, log])

  const chooseWorkflow = (id) => {
    const chosen = workflows.find((item) => item.id === id)
    if (!chosen) return
    setSelectedId(id); setWorkflow(chosen); setMapping(chosen.mapping || {}); setMode('ready')
  }

  const newWorkflow = async () => {
    setBusy(true); setError('')
    try {
      const result = await request('/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'New workflow' }) })
      setWorkflows((current) => [result.workflow, ...current]); setWorkflow(result.workflow); setSelectedId(result.workflow.id); setMapping({}); setMode('ready')
      log('Created a fresh workflow. Add data, then record the browser steps.', 'info')
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  const saveSource = async (name, columns, rows) => {
    const saved = await request('/source', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, columns, rows }) })
    setDataSource({ name: saved.name, columns: saved.columns, rowCount: saved.rowCount }); setPreview(saved.preview); setRunLimit(1); setBatchStart(1)
    log(`Loaded ${saved.rowCount} rows from ${saved.name}`, 'success')
  }

  const useDemoSheet = async () => {
    setBusy(true); setError('')
    try { const { columns, rows } = toTable(csvRows(sampleCsv)); await saveSource('demo-customers.csv', columns, rows) }
    catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  const handleSheet = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    setBusy(true); setError('')
    try {
      const buffer = await file.arrayBuffer()
      let matrix
      if (/\.csv$/i.test(file.name)) matrix = csvRows(new TextDecoder().decode(buffer))
      else {
        const XLSX = await import('xlsx')
        const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
        matrix = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '', raw: false })
      }
      const { columns, rows } = toTable(matrix)
      await saveSource(file.name, columns, rows)
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false); event.target.value = '' }
  }

  const startRecording = async () => {
    if (!extension.connected) { setError('Load the EvolveOS extension in Chrome first. See the demo guide.'); return }
    let url
    try { url = new URL(targetUrl).href } catch { setError('Enter a full website address starting with http:// or https://.'); return }
    setBusy(true); setError('')
    try {
      const result = await request('/recordings/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetUrl: url }) })
      setRecordingId(result.recording.id); setRecordingCount(0); setMode('recording'); log('Recording started. Complete one example in the opened browser tab.', 'info')
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  const stopRecording = async () => {
    if (!recordingId) return
    setBusy(true); setError('')
    try {
      const result = await request(`/recordings/${recordingId}/stop`, { method: 'POST' })
      setMode('ready'); setRecordingCount(result.recording.events.length); setRecordingId(null); log(`Capture saved · ${result.recording.events.length} events`, 'success')
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  const evolve = async () => {
    if (!selectedId) return
    setMode('analyzing'); setBusy(true); setError('')
    try {
      const result = await request(`/workflows/${selectedId}/extract`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
      setWorkflow(result.workflow); setWorkflows((current) => current.map((item) => item.id === selectedId ? result.workflow : item)); setMapping(result.workflow.mapping || {}); setMode('ready')
      log(`AI organized ${result.compression.observed} observations into ${result.compression.semantic} steps · ${result.compiler}`, 'success')
    } catch (requestError) { setMode('failed'); setError(requestError.message) } finally { setBusy(false) }
  }

  const finishCapture = async () => { await stopRecording(); await evolve() }

  const updateMapping = async (fieldKey, column) => {
    const next = { ...mapping, [fieldKey]: column }
    setMapping(next); setWorkflow((current) => current && ({ ...current, mapping: next }))
    try { await request(`/workflows/${selectedId}/mapping`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mapping: next }) }) }
    catch (requestError) { setError(requestError.message) }
  }

  const runWorkflow = async () => {
    setBusy(true); setError('')
    try {
      const count = Math.max(1, Math.min(100, Number(runLimit) || 1, dataSource.rowCount - Number(batchStart) + 1))
      const rowIndices = Array.from({ length: count }, (_, index) => Number(batchStart) - 1 + index)
      const result = await request(`/workflows/${selectedId}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rowIndices }) })
      setRunId(result.runId); setMode('running'); setWorkflow((current) => current && ({ ...current, steps: current.steps.map((step) => ({ ...step, state: 'queued' })) })); log(`Starting rows ${batchStart}–${Number(batchStart) + count - 1}`, 'info')
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  const stopRun = async () => { if (!runId) return; try { await request(`/runs/${runId}/stop`, { method: 'POST' }) } catch (requestError) { setError(requestError.message) } }
  const uploadDescription = useMemo(() => dataSource.name ? `${dataSource.name} · ${dataSource.rowCount} rows · ${dataSource.columns.length} columns` : 'CSV or Excel with a header row', [dataSource])
  const planReady = Boolean(workflow?.compiler && actions.length)
  const statusLabel = ({ loading: 'Connecting', offline: 'API offline', recording: 'Recording', analyzing: 'AI organizing', running: 'Running in browser', repairing: 'Needs review', complete: 'Run complete', failed: 'Needs attention' })[mode] || 'Ready'

  return <div className="app-shell">
    <header className="topbar"><a className="wordmark" href="#top"><span className="brand-glyph">e</span><span>Evolve<span className="mark-light">OS</span></span></a><div className="top-actions"><label className="workflow-picker"><span>WORKFLOW</span><select aria-label="Choose workflow" value={selectedId} onChange={(event) => chooseWorkflow(event.target.value)}>{workflows.map((item) => <option key={item.id} value={item.id}>{displayName(item)}</option>)}</select></label><button className="text-button" onClick={newWorkflow} disabled={busy}>＋ New</button><span className={`connection ${extension.connected ? 'connected' : ''}`}><i/>{extension.connected ? 'Browser ready' : 'Connect browser'}</span><button className="text-button" onClick={() => setShowGuide(true)}>Demo guide</button></div></header>

    <main className="page" id="top">
      <section className="intro"><div><span className="eyebrow">BROWSER WORKFLOWS, WITHOUT THE BUSYWORK</span><h1>Move rows into<br/><em>real websites.</em></h1><p>Show EvolveOS once. It maps your sheet, repeats the browser work, and checks the result.</p></div><div className="progress-summary"><span className="progress-count">0{readyCount}<small>/03</small></span><span>STEPS READY</span></div></section>

      {error && <div className="error-message" role="alert"><span>!</span>{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}

      <section className="ai-strip" aria-label="AI workflow engine"><div className="ai-glyph">✳</div><div className="ai-copy"><span className="eyebrow">YOUR AI OPERATOR</span><h2>{planReady ? `${displayName(workflow)} is understood` : actions.length ? 'Your capture is ready to understand' : 'Ready to learn your workflow'}</h2><p>{coral.enabled ? `Coral Bricks · ${coral.model} · resilient retries and recovery` : 'Local fallback · add your Coral Bricks key to enable AI compilation'}</p></div><button className="ai-button" onClick={evolve} disabled={!actions.length || busy || mode === 'recording'}>{mode === 'analyzing' ? 'Thinking…' : planReady ? 'Refresh plan' : 'Understand capture'}<span>↗</span></button></section>

      <section className="flow-section"><div className="section-head"><span className="section-number">01</span><div><h2>Bring your sheet</h2><p>Choose the rows EvolveOS will enter into the website.</p></div><span className={`section-status ${dataSource.rowCount ? 'ready' : ''}`}>{dataSource.rowCount ? `${dataSource.rowCount} rows ready` : 'Waiting for data'}</span></div>
        <div className="source-actions"><label className="upload-control"><input type="file" accept=".csv,.xlsx,.xls" onChange={handleSheet} disabled={busy}/><span className="upload-icon">↑</span><span><b>{uploadDescription}</b><small>Choose CSV or Excel</small></span><span className="browse-link">Browse</span></label><button className="sample-button" onClick={useDemoSheet} disabled={busy}>Use synthetic demo rows <span>↗</span></button></div>
        {preview.length > 0 && <div className="preview-table"><div className="table-label">SHEET PREVIEW <span>{dataSource.columns.length} COLUMNS</span></div><div className="table-scroll"><table><thead><tr>{dataSource.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{preview.slice(0, 3).map((row, index) => <tr key={index}>{dataSource.columns.map((column) => <td key={column}>{String(row[column] ?? '')}</td>)}</tr>)}</tbody></table></div></div>}
      </section>

      <section className="flow-section"><div className="section-head"><span className="section-number">02</span><div><h2>Teach the browser</h2><p>Record one example on the actual page. Typed values are not saved.</p></div><span className={`section-status ${extension.connected ? 'ready' : ''}`}>{extension.connected ? 'Extension connected' : 'Extension needed'}</span></div>
        <div className="target-line"><label><span>WEBSITE</span><input value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="https://your-website.com/form" disabled={mode === 'recording'}/></label><a href={targetUrl} target="_blank" rel="noreferrer">Open site ↗</a><a href="/demo-portal" target="_blank" rel="noreferrer">Open demo ↗</a></div>
        <div className="teach-line"><div className={`record-indicator ${mode === 'recording' ? 'live' : ''}`}><i/></div><div className="teach-copy"><b>{mode === 'recording' ? `Recording · ${recordingCount} events captured` : actions.length ? `${actions.length} actions · ${fields.length} fields captured` : 'Record the task you want repeated'}</b><span>{mode === 'recording' ? 'Complete one example on the website tab, then finish the capture.' : 'Change the fields once and click the site’s submit button.'}</span></div><div className="teach-actions">{mode === 'recording' ? <><button className="button secondary" onClick={stopRecording} disabled={busy}>Stop</button><button className="button primary" onClick={finishCapture} disabled={busy}>Finish & ask AI <span>↗</span></button></> : <button className="button primary" onClick={startRecording} disabled={!extension.connected || busy || mode === 'running'}><span className="record-dot"/>Start recording</button>}</div></div>
        {actions.length > 0 && <details className="capture-details"><summary>Captured actions <span>{actions.length}</span></summary><div className="action-list">{actions.map((action, index) => <div className="action-row" key={`${action.locator?.key || action.target}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><b>{action.type === 'field' ? 'FIELD' : 'CLICK'}</b><p>{action.target}</p></div>)}</div></details>}
      </section>

      <section className="flow-section last-section"><div className="section-head"><span className="section-number">03</span><div><h2>Map, then repeat</h2><p>Connect each website field to a column and run a small batch first.</p></div><span className={`section-status ${canRun ? 'ready' : ''}`}>{canRun ? 'Ready to run' : 'Setup needed'}</span></div>
        {fields.length > 0 ? <div className="mapping-list"><div className="mapping-labels"><span>WEBSITE FIELD</span><span>SHEET COLUMN</span></div>{fields.map((field) => <label className="mapping-row" key={field.key}><span><b>{field.label}</b><small>{field.locator?.tag || 'form field'}</small></span><i>→</i><select value={mapping[field.key] || ''} onChange={(event) => updateMapping(field.key, event.target.value)} disabled={!dataSource.columns.length}><option value="">Choose column</option>{dataSource.columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label>)}</div> : <p className="empty-hint">Captured website fields will appear here after you teach a workflow.</p>}
        {planReady && <details className="plan-details"><summary>AI workflow plan <span>{workflow.steps.length} steps · {workflow.compiler}</span></summary><ol>{workflow.steps.map((step, index) => <li key={step.id || index}><span>{String(index + 1).padStart(2, '0')}</span><b>{step.label || step.target}</b><small>{step.expected || step.target}</small></li>)}</ol></details>}
        <div className="run-bar"><div className="batch-settings"><label><span>START AT ROW</span><input type="number" min="1" max={Math.max(1, dataSource.rowCount)} value={batchStart} onChange={(event) => setBatchStart(Math.max(1, Math.min(dataSource.rowCount || 1, Number(event.target.value) || 1)))}/></label><label><span>ROWS · MAX 100</span><input type="number" min="1" max={Math.min(100, Math.max(1, dataSource.rowCount - batchStart + 1))} value={runLimit} onChange={(event) => setRunLimit(Math.max(1, Math.min(100, dataSource.rowCount - batchStart + 1, Number(event.target.value) || 1)))}/></label></div><div className="run-action"><button className="button primary run-button" onClick={runWorkflow} disabled={!canRun || busy || mode === 'running'}>{mode === 'running' ? 'Working in browser…' : mode === 'complete' ? 'Run again' : `Run ${runLimit} ${Number(runLimit) === 1 ? 'row' : 'rows'}`}<span>→</span></button>{['running', 'repairing'].includes(mode) && <button className="text-button stop-button" onClick={stopRun}>Stop run</button>}<small>{mode === 'complete' ? 'Website confirmed success.' : 'The browser pauses if a target or result needs your review.'}</small></div></div>
      </section>

      <footer className="page-footer"><span><i className={`status-dot ${mode === 'offline' ? 'off' : ''}`}/>{statusLabel}</span><button className="text-button" onClick={() => setShowHistory(true)}>Recent activity</button><span>{coral.enabled ? 'Coral Bricks × ResilientLLM' : 'Local AI fallback'}</span></footer>
    </main>

    {(showGuide || showHistory) && <div className="modal-backdrop" onClick={() => { setShowGuide(false); setShowHistory(false) }}><section className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => { setShowGuide(false); setShowHistory(false) }} aria-label="Close">×</button>{showGuide ? <><span className="eyebrow">A TWO-MINUTE PRODUCT DEMO</span><h2>Spreadsheet → website</h2><p className="modal-lede">Use the local customer portal and synthetic rows. No customer account or real data needed.</p><ol className="guide-steps"><li><span>01</span><div><b>Load the sample</b><small>Click “Use synthetic demo rows” to load two fake customers.</small></div></li><li><span>02</span><div><b>Connect Chrome</b><small>Load the unpacked <code>extension</code> folder from <code>chrome://extensions</code>. If it is already installed, reload the extension.</small></div></li><li><span>03</span><div><b>Teach the task</b><small>Record on the local demo portal, change Full name and Phone, then click Save Changes.</small></div></li><li><span>04</span><div><b>Let AI organize it</b><small>Finish capture, map Full name and Phone to the matching sheet columns, inspect the plan.</small></div></li><li><span>05</span><div><b>Replay two rows</b><small>Run both rows and show the website’s success confirmation and activity.</small></div></li></ol><div className="video-line"><b>Suggested narration</b><p>“We start with two spreadsheet rows. I teach EvolveOS one customer update in the browser. Coral Bricks turns the recording into a plan; ResilientLLM makes the AI call more reliable. Then the extension maps each row into the form, submits it, and checks that the website confirms success.”</p></div></> : <><span className="eyebrow">SESSION</span><h2>Recent activity</h2><div className="history-list">{logs.length ? logs.map((entry) => <div className="history-row" key={entry.id}><time>{entry.time}</time><p>{entry.text}</p></div>) : <p className="modal-lede">No activity yet. Capture a workflow to see progress here.</p>}</div></>}</section></div>}
  </div>
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)
