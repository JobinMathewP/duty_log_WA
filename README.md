# wa-duty-sync

A local program that watches duty-log messages in WhatsApp groups and writes them to a Google Sheet. Technicians keep posting in WhatsApp. The program never sends a message.

`Raw_Logs` stores every log. A tab such as `2026-06 (JUNE)` is a live view of that month. Edits in WhatsApp update the row. A delete for everyone stays on `Raw_Logs` only.

## Run it

Node.js 24, Google Chrome, and Git. Copy `.env.sample` to `.env`, then:

```powershell
npm install
npm run setup-sheet
npm run check
npm run dev
```

The first `npm run dev` prints a QR code. Scan it from the dedicated WhatsApp account with **Linked devices**. Leave that window open. Stop it with Ctrl+C.

The full Windows setup, including the Google Cloud key and the spreadsheet share, is in [docs/setup.md](docs/setup.md).

Keep `.env`, `credentials.json`, and `.wwebjs_auth` on this laptop. They are not in git.
