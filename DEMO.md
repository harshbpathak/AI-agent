# Video demo: spreadsheet → customer portal

## Demo story

An operations assistant receives a small spreadsheet of customer updates. Instead of copying each row by hand, they show EvolveOS one customer update, map the portal fields to spreadsheet columns, and replay the task for the remaining rows. The names and phone numbers are synthetic.

## One-time setup

1. Start the API with `npm run server` and the UI with `npm run dev`.
2. In Chrome, load the project's `extension` folder from `chrome://extensions` with Developer mode enabled.
3. Reload EvolveOS and make sure the header says **Browser ready**.

## Record the walkthrough

1. Click **Demo guide** so the audience sees the use case, then close it.
2. Click **Use synthetic demo rows**. The sheet preview shows two sample customers: Riya Sample and Noah Example.
3. Leave the target set to `http://127.0.0.1:3001/demo-portal`; click **Start recording**.
4. In the opened portal tab, change **Full name** and **Phone**, then click **Save Changes** once. The entered example values are not captured.
5. Return to EvolveOS and click **Finish & ask AI**. Show the Coral Bricks / ResilientLLM status and the generated workflow plan.
6. Map the captured **Full name** field to **Full name**, and **Phone** to **Phone**.
7. Set **Start at row** to 1 and **Rows** to 2, then click **Run 2 rows**.
8. Show the browser filling each row, the portal's “Customer updated successfully” confirmation, and EvolveOS activity reporting both rows complete.

## 45-second narration

> “Here are two customer updates in a spreadsheet. I’ll teach EvolveOS the task on our demo portal by changing the name and phone fields and saving once. The AI turns that browser capture into a plan, and I map each website field to its sheet column. Now EvolveOS repeats the real browser actions for both rows and checks the portal’s success message. No copy-paste between systems.”

## If the demo pauses

- **Browser not ready:** make sure the extension is enabled and reload the EvolveOS tab.
- **No captured fields:** change each field and move focus away before clicking Save; password fields are intentionally ignored.
- **Target needs review:** leave the run paused, inspect the demo portal, and record again if its layout changed.
- **Local compiler shown:** the demo still works without Coral. To show the Coral model name, configure the server-side `.env` key before recording.
