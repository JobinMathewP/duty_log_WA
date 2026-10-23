# Run wa-duty-sync on a Windows laptop

The program watches the duty-log WhatsApp groups and writes each log into a Google Sheet tab named `Raw_Logs`. It never sends a WhatsApp message.

You receive the project folder and a `.env` file. The `.env` file has no `GOOGLE_SPREADSHEET_ID` yet. You create that, plus a Google key file named `credentials.json`.

Keep `.env` and `credentials.json` on this laptop only. Do not email them or put them in a shared drive.

Use Windows PowerShell for every command below. In File Explorer, open the project folder, click the address bar, type `powershell`, and press Enter.

## 1. Install three programs

Install these, then close and reopen PowerShell.

1. [Google Chrome](https://www.google.com/chrome/). The program drives Chrome. Edge is not a substitute.
2. [Git for Windows](https://git-scm.com/download/win). Keep the installer defaults. One dependency is downloaded from GitHub, and that download needs Git.
3. [Node.js 24 LTS](https://nodejs.org/) (the Windows Installer, 64-bit). Do not install the "Current" line.

Check:

```powershell
node -v
git --version
```

`node -v` must start with `v24`. If PowerShell says `node` is not recognized, close it and open it again.

## 2. Install the project packages

In the project folder:

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD="true"
npm install
```

The first line stops npm from downloading a second copy of Chrome. Wait until it finishes. `npm install` is required even if a `node_modules` folder came with the code.

## 3. Create the Google key

1. Open [Google Cloud Console](https://console.cloud.google.com/) with the Google account that will own the sheet.
2. Create a project named `wa-duty-sync`.
3. **APIs & Services → Library**. Search **Google Sheets API**. Open it. Click **Enable**.
4. **IAM & Admin → Service accounts → Create service account**. Name it `wa-duty-sync`. Skip the optional permission steps. Click **Done**.
5. Open that service account. **Keys → Add key → Create new key → JSON**. A file downloads.
6. Move that file into the project folder and rename it `credentials.json`.
7. Open `credentials.json`, copy the `client_email` value (`wa-duty-sync@....iam.gserviceaccount.com`), then close the file. Do not copy the `private_key` anywhere.

## 4. Create the sheet and share it

1. Create a blank Google Sheet. Name it whatever you want, for example `Duty logs`.
2. Click **Share**. Paste the `client_email`. Role: **Editor**. Turn off the notify checkbox. Click **Share**.
3. Copy the spreadsheet id from the address bar. In this URL, the id is the middle part:

   `https://docs.google.com/spreadsheets/d/THIS_PART/edit`

4. Open `.env` in Notepad. Set that id:

   ```bash
   GOOGLE_SPREADSHEET_ID="THIS_PART"
   ```

   Leave the other lines as they were shared. Save the file.

## 5. Prepare the sheet tab

```powershell
npm run setup-sheet
npm run check
```

`setup-sheet` adds a tab named `Raw_Logs` and writes the column headers. It also adds a tab for each month already stored, named like `2026-06 (JUNE)`.

`check` must show PASS for `env`, `credentials`, and `sheet`.

- `groups` PASS means group ids are present. If the id is `120363000000000000@g.us`, it is a sample, not a real group. Run `npm run list-groups` after step 6, copy the real id from the printed list (`Group name    1203...@g.us`), and put it in `TARGET_GROUP_IDS` in `.env`.
- `gemini` PASS with `disabled` is expected.

Do not insert, delete, or sort rows on `Raw_Logs`. Read each month on its own tab. Do not type below that tab's header. The month tab follows `Raw_Logs` when a log is edited. A delete for everyone stays on `Raw_Logs` only. Sum the **Countable Hours** column.

## 6. Link WhatsApp

Use a WhatsApp account that is already a member of the duty groups. A spare number is safer than a technician's personal phone. While this program is running, that account can show as online.

On that phone: WhatsApp → **Settings → Privacy → Read receipts → off**.

Then:

```powershell
npm run dev
```

The first run prints a QR code.

On the phone: WhatsApp → **Linked devices → Link a device**, and scan the QR code in the PowerShell window.

Wait until the window prints `whatsapp ready`. The link is saved in the `.wwebjs_auth` folder. Later runs usually skip the QR. If the phone logs this device out, `npm run dev` prints a new QR.

## 7. Confirm one log

Post a normal duty log in the group. Within a few seconds, `Raw_Logs` gets one row with status `ACTIVE`.

- Edit that message within 15 minutes. The same row becomes `EDITED`. No second row.
- Delete it for everyone. The row stays. Status becomes `DELETED`. Countable hours become `0`. The reported hours stay, so the audit is still there.

Ordinary chat does not create rows.

## Each working day

Open PowerShell in the project folder and run:

```powershell
npm run dev
```

Leave that window open. Closing it, or letting the laptop sleep, stops live updates. The next `npm run dev` picks up logs posted while it was off, up to the last 300 messages in each group.

Stop it with Ctrl+C in that window.

If `npm run dev` says `node` is not recognized, reopen PowerShell. If it says `auth_failure`, scan the QR again with the same phone.
