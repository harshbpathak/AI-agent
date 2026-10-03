# EvolveOS

EvolveOS learns a browser task once, maps spreadsheet columns to website fields, then repeats the task for selected rows. The browser extension performs the actions locally; Coral Bricks helps turn a recording into a readable plan, with ResilientLLM providing retries and fallback behavior.

## Start

```powershell
npm install
npm run server
```

In a second terminal:

```powershell
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). The API uses port `3001`, separate from other local services.

## Connect Chrome once

1. Visit `chrome://extensions` and turn on Developer mode.
2. Choose **Load unpacked** and select this project's `extension` folder.
3. Reload the EvolveOS page and confirm **Browser ready**.

The extension needs access to the website you want to automate. It captures element labels/selectors, not typed field values or passwords. Use a test account and review the requested permissions.

## Try the sample use case

Use the built-in **Spreadsheet → website** demo: two synthetic customer rows go into the local customer portal. Click **Demo guide** in the app for the on-screen walkthrough, or follow [DEMO.md](DEMO.md) for the video shot list and narration. Sample data is in [demo/customers.csv](demo/customers.csv).

The sample button replaces the currently loaded sheet with those demo rows. It does not replace your workflows.

## Simple project map

```text
src/                 EvolveOS screen and styles
server/              Local API, persistence, workflow runner, Coral adapter
  public/             Local demo website
extension/           Chrome recorder and browser replay agent
demo/                Synthetic spreadsheet for the product walkthrough
```

## Coral Bricks

Copy `.env.example` to `.env` and set `CORAL_API_KEY`. The key stays on the server. EvolveOS tries `deepseek-v4-flash-lite`, then `deepseek-v4.1-flash-fast-fp4` if needed. Model access depends on the Coral account. Without a key, the app uses its local deterministic workflow compiler.

ResilientLLM wraps Coral requests with bounded retries and backoff. The model organizes the recorded steps; it does not operate the browser.

## Data and safety

The uploaded sheet and saved workflows are stored locally in `data/evolveos.json`. Replay is limited to 100 rows per batch. EvolveOS pauses on missing/ambiguous targets or an unverified save; inspect the site before continuing. Login, MFA, multi-page flows, and unusual widgets may need a new recording or a site-specific adapter.
