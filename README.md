# EvolveOS

EvolveOS records a real browser demonstration, maps detected form fields to a local CSV/XLSX sheet, and replays the captured browser targets one row at a time. It uses your existing EvolveOS interface, with Coral Bricks for workflow compilation and ResilientLLM for retry, backoff, and circuit-breaker behavior.

## Start the app

Install dependencies once, then run the API and UI in two terminals:

```bash
npm install
npm run server
```

```bash
npm run dev
```

Open `http://localhost:5173`.

## Connect Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the project's `extension` folder.
3. Reload `http://localhost:5173`. The header should show **Browser connected**.
4. Keep the local API server running at `http://localhost:3000` while recording or replaying.

The extension uses broad HTTP/HTTPS site access because it must interact with the site you choose. Browser actions stay on your machine; password fields are not captured. Review the extension's permissions and use a test account before running a batch against a production site.

## Teach and run a workflow

1. Upload a CSV or Excel file with a header row and at least one data row.
2. Enter the target page URL and start recording.
3. On the opened site, complete one representative example. EvolveOS records visible element labels and selectors, not the values you type.
4. Stop capture, then choose **Finish & evolve**. Coral Bricks compiles the event sequence when configured; a deterministic local compiler fallback is used if Coral is unavailable.
5. Map each captured website field to its spreadsheet column. Review the compiled playbook.
6. Run one row first. Confirm the website's result, then process additional rows in batches of up to 100. The server rejects out-of-range row selections.

Replay fills recorded fields with the selected row values and uses captured locators, with a unique visible-label fallback when a locator has changed. It pauses and reports a missing or ambiguous element, or an unverified save, rather than reporting a false success. Website-specific login, multi-page navigation, MFA, and unusual widgets may require a fresh recording or a site-specific adapter; do not use this as unattended automation for consequential changes without human review.

The included `http://localhost:3000/demo-portal` is a safe local page for trying the capture and replay flow.

## Coral Bricks

Create `.env` from `.env.example` and set `CORAL_API_KEY` locally. The key is used only by the server and is not returned to the browser. EvolveOS tries `CORAL_MODEL` first (default `deepseek-v4-flash-lite`) and then `CORAL_FALLBACK_MODEL` (default `deepseek-v4.1-flash-fast-fp4`). The model availability depends on your Coral account. `CORAL_BASE_URL` can override the OpenAI-compatible gateway URL.

ResilientLLM wraps the Coral call with bounded retries, exponential backoff, and a circuit breaker. Browser interaction and row-by-row execution are handled by the local Chrome extension, not by the language model.

## Local data

Workflow definitions and the uploaded sheet are stored in `data/evolveos.json` on this computer. Keep that file private if your sheet contains personal or business data. The server binds to loopback (`127.0.0.1`) and is intended for a single local user.
