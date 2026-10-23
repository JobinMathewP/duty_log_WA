# Product Requirements Document

## Project: WhatsApp Duty Log Sheet Sync (`wa-duty-sync`)

Validated: 22 October 2026, against the canonical field log, current WhatsApp client limits, `whatsapp-web.js` 1.34.7 plus the 26 September 2026 session fix on `main`, the Gemini Developer API, and Google Sheets API v4.

This document is the product contract. Implementation detail lives in `docs/architecture.md`.

---

## 1. Problem and outcome

Field leads post an end-of-shift duty log into a WhatsApp group. Managers and peers read that message in the group, question bad timings there, and later retype the same text into a spreadsheet for weekly and monthly hours.

The text is the system of record, and it changes after it is posted. A lead edits a time, deletes a wrong log for everyone, or posts a replacement. A spreadsheet filled by copy-paste keeps the old figures.

Build a local Node.js/TypeScript daemon that watches the existing groups, turns each duty log into one spreadsheet row, and follows that message when it is edited or deleted for everyone. Technicians keep posting in WhatsApp. The daemon never sends a message, reply, reaction, or read receipt.

Success looks like this:

- A normal log becomes one row managers can sum and pivot.
- An in-window edit updates that same row.
- "Delete for everyone" keeps the row for audit and removes its hours from totals.
- Hours the daemon missed while the laptop was asleep or shut down appear after the next successful login, without duplicates.
- Ordinary group chat never becomes a row and never triggers a paid or free model call.

---

## 2. Users and the message they already send

The writer is a lead or technician posting from WhatsApp on their phone. The reader is a manager who already lives in the group and in Google Sheets. The operator is one person who runs this daemon on a Windows laptop that is allowed to sleep.

Canonical log, copied from the field:

```text
Nagarajan. Tuesday
Site: Al barsha NS147,
Date: 20.10.26
Start duty : 6.53
Pause duty : 1.43pm
Resume duty : 2.38pm
Finish duty: 5.04
Total working hrs: 9 Hrs
Associate technician: Sathish , Nitiesh
Technician: Sibirajan,Vicky, Arjun
```

Required reading of that message:

| Field | Value | Rule |
| --- | --- | --- |
| Log name | Nagarajan | First line, before the weekday. This is the name typed in the log. It can differ from the WhatsApp profile name. |
| Weekday | Tuesday | Display only. The duty date comes from the `Date` line. |
| Site | Al barsha NS147 | Drop the trailing comma. |
| Duty date | 2026-10-20 | `20.10.26` is day.month.year. The site is in Al Barsha, so this is not a US month-first date. |
| Start | 06:53 | `6.53` is 6:53 in the morning. It is a clock time, not 6.53 decimal hours. |
| Pause | 13:43 | `pm` is explicit. |
| Resume | 14:38 | `pm` is explicit. |
| Finish | 17:04 | No `pm` was typed. 05:04 is before resume, so the afternoon reading 17:04 is the one that continues the shift. |
| Reported hours | 9 | Taken from `Total working hrs`. The word `Hrs` is not part of the number. |
| Calculated hours | 9.27 | `(13:43 − 06:53) + (17:04 − 14:38)` = 9 hours 16 minutes. |
| Associates | Sathish, Nitiesh | Split on commas and trim. |
| Technicians | Sibirajan, Vicky, Arjun | This line is not the associate line. |

Reported hours and calculated hours are both stored. Managers currently total the number the lead wrote, so sheet totals use reported hours. Calculated hours exist so a wrong clock is visible without anyone redoing the arithmetic. A gap of 0.27 hours does not raise a review flag. The default flag threshold is half an hour, and it is configurable.

Clock times are stored as the wall time written in the message. They are not converted to UTC or to the laptop's timezone. WhatsApp's own send time is stored separately, because a log is often posted after the shift and sometimes after midnight.

---

## 3. Scope

### In scope

- One local daemon, signed into WhatsApp Web as a linked device, watching a configured list of group chats.
- Create, edit, and delete-for-everyone for text logs, including a log typed as a photo or video caption.
- A regex parser for the field format, with Gemini used only when a message is clearly a duty log and the regex still missed a required field.
- Google Sheets as the only reporting surface: one raw tab the daemon maintains, and any pivot or summary the managers build on other tabs.
- Catch-up after the process, the laptop, or the network was down.
- Silent per-row review notes for a hours mismatch, an ambiguous time, a possible duplicate, or an overlapping name on the same date.

### Out of scope

- Any message, reply, reaction, or read receipt sent back to WhatsApp.
- WhatsApp Business API, Twilio, Wati, or any other paid WhatsApp provider.
- A web app, login system, or billing system.
- "Delete for me". That deletion never reaches the other members, so the daemon cannot see it.
- Reading a photo of a paper log. WhatsApp also cannot edit a media message, only a text message or a caption at send time.
- A follow-up sentence such as "sorry finish was 6". If the lead does not edit the original log or post a full new log, the correction stays in the chat.
- More than one duty log inside a single message. The row is stored as `NEEDS_REVIEW` with the raw text.
- Perfect overlap detection across spelling variants. `Vicky` and `Vicky K` are not treated as the same person.

---

## 4. What WhatsApp will and will not deliver

These limits come from WhatsApp's own help center and from the events `whatsapp-web.js` actually emits.

- A sender can edit their own text message for **15 minutes**. The message id stays the same. The group sees the new text marked edited. There is no edit history.
- After 15 minutes the lead cannot edit. A real correction is a new message, or "Delete for everyone" plus a new message. The product must handle both. A late correction is not an edit event.
- "Delete for everyone" is available for **two days** on a message the sender wrote. A group admin can delete another member's message for everyone, also within two days. The bubble becomes "This message was deleted".
- "Delete for me" does not change anyone else's phone and must not change the sheet.
- The daemon is online as a linked device of one WhatsApp account. That account has to be a member of each target group. Use a dedicated number for this. While the daemon is connected, that account can appear online. It must not be a technician's personal phone.

Library behavior that the product depends on:

- New messages arrive on `message_create`, including a log sent from the linked phone itself.
- Edits arrive on `message_edit` as `(message, newBody, prevBody)`.
- Delete-for-everyone arrives on `message_revoke_everyone` as `(message, revokedMsg)`. `revokedMsg` is often missing. The id on the tombstone is not always the original message id. The architecture specifies how the original id is recovered.
- History is loaded with `chat.fetchMessages({ limit })`. The call returns the **current** text, oldest first. It has no date filter and no paging cursor. A limit that is too small silently misses an outage.
- `fetchMessages` does not by itself mark a chat read. The daemon must never call `sendMessage` or `sendSeen`. On the dedicated number, read receipts are turned off.

---

## 5. Lifecycle

One WhatsApp message id maps to one sheet row for the life of that log.

1. **Create.** A new candidate message is parsed and appended. Status is `ACTIVE`. Countable hours equal the reported hours. If required fields are missing after both parse tiers, status is `NEEDS_REVIEW` and countable hours are `0` unless a reported number was extracted.
2. **Edit.** The same message id is parsed again and the same row is overwritten. Status becomes `EDITED`. Countable hours follow the new reported hours. This applies to a live `message_edit` and to a catch-up that finds a new body for an id already stored.
3. **Delete for everyone.** The same row stays. Status becomes `DELETED`. Reported hours, calculated hours, and the raw text stay so the audit is intact. Countable hours become `0`. Totals sum the countable column, so a deleted log no longer adds hours.
4. **Unknown delete.** A revoke for a message that was never stored is ignored. The text is already gone, so the daemon cannot know whether it was a duty log. A log that is posted and deleted entirely while the laptop is off therefore leaves no row. A log that was stored, then deleted during the outage, is marked `DELETED` on catch-up.
5. **Replacement after the edit window.** The old row remains. The new message becomes its own row. When the sender, site, and duty date match an existing `ACTIVE` or `EDITED` row, both rows get the review note `POSSIBLE_DUPLICATE`. The daemon does not merge or drop either row, because two crews can work the same site on the same day.

---

## 6. Sheet contract

The daemon owns a tab named `Raw_Logs`. Managers put pivots, filters, and weekly formulas on other tabs. They do not insert, delete, or sort rows on `Raw_Logs`. If they do, the next edit still finds the row by message id.

| Column | Header | Contents |
| --- | --- | --- |
| A | Status | `ACTIVE`, `EDITED`, `DELETED`, or `NEEDS_REVIEW` |
| B | Last Event At | ISO-8601 UTC time of the last create, edit, or delete handled |
| C | WhatsApp Message ID | Full serialized id. Primary key |
| D | Group ID | Group chat id |
| E | Sender Name | WhatsApp display name |
| F | Sender ID | Author id as WhatsApp sent it, including a `@lid` id when that is what the client provides |
| G | Log Name | Name from the first line |
| H | Weekday | Weekday token from the first line |
| I | Site | Site text |
| J | Duty Date | `YYYY-MM-DD` |
| K | Start | `HH:mm` |
| L | Pause | `HH:mm` or blank |
| M | Resume | `HH:mm` or blank |
| N | Finish | `HH:mm` |
| O | Reported Hours | Number written by the lead. Kept after delete |
| P | Calculated Hours | Clock math, 2 decimal places. Blank when the clocks are incomplete |
| Q | Countable Hours | Reported hours, or calculated hours when no total was written. `0` when status is `DELETED` or the row is not trustworthy |
| R | Technicians | Comma-separated, trimmed |
| S | Associate Technicians | Comma-separated, trimmed |
| T | Validation Notes | Zero or more notes, separated by ` \| ` |
| U | Posted At | WhatsApp message timestamp, ISO-8601 UTC |
| V | Parser | `REGEX` or `GEMINI` |
| W | Raw Message | Exact text or caption |

Validation notes the daemon may set:

| Note | Meaning |
| --- | --- |
| `HOURS_MISMATCH` | Reported and calculated hours differ by more than the configured threshold (default 0.5). |
| `AMBIGUOUS_TIME` | A clock time has no `am`/`pm` and the shift order does not resolve it. |
| `INCOMPLETE_BREAK` | Pause is present without resume, or the reverse. The break is not subtracted. |
| `MISSING_REPORTED` | No total was written. Countable hours fall back to calculated hours. |
| `POSSIBLE_DUPLICATE` | Another open row has the same sender, site, and duty date. |
| `OVERLAP` | The same technician name, on the same duty date, already has a stored interval that overlaps this one. Match is exact after trim and case-folding. |
| `FORWARDED` | WhatsApp marked the message as forwarded. It is still ingested. |

The daemon also keeps one view tab per duty month, named `2026-06 (JUNE)`. That tab is a live filter of `Raw_Logs`, not a second copy. Managers read hours there. They do not type below its header.

The view shows Status, Log Name, Weekday, Site, Duty Date, Start, Pause, Resume, Finish, Reported Hours, Calculated Hours, Countable Hours, Technicians, Associate Technicians, and Validation Notes. It hides Last Event At, WhatsApp Message ID, Group ID, Sender Name, Sender ID, Posted At, Parser, and Raw Message. A `DELETED` row stays on `Raw_Logs` only. A row with no duty date stays on `Raw_Logs` only. `NEEDS_REVIEW` and `EDITED` rows that have a duty date stay on the month tab. An edit in WhatsApp updates `Raw_Logs`, and the month tab follows, including when the duty date moves the log into another month.

---

## 7. Functional requirements

### 7.1 Session

- **FR-1.** Persist the WhatsApp Web session with `LocalAuth` under `.wwebjs_auth/`.
- **FR-2.** On first run, or after logout, print a QR code in the terminal and wait for the dedicated phone to link it.
- **FR-3.** Run headless on the operator's Windows laptop. Browser flags that are only meaningful in a Linux container are not the Windows default.
- **FR-4.** Never call `sendMessage`, `sendSeen`, or any other write to WhatsApp.

### 7.2 Live events

- **FR-5.** Handle `message_create` for every target group. The chat id is `message.to` when `fromMe` is true and `message.from` otherwise. In a group, `message.from` is the group only for other people's messages.
- **FR-6.** Ignore a message unless it is a duty-log candidate: a `Site` label plus at least one of start, finish, or total hours, or both a start and a finish label. Photo and video captions are eligible. Stickers, polls, and messages without a caption are not.
- **FR-7.** Handle `message_edit` by updating the stored row for that message id. If the id was never stored and the new text is a candidate, append it.
- **FR-8.** Handle `message_revoke_everyone` by resolving the original message id (see the architecture) and applying the delete rules. A revoke that does not match a stored id is discarded.

### 7.3 Catch-up

- **FR-9.** After every `ready` event, load the newest `HISTORICAL_FETCH_LIMIT` messages from each target group (default 300) and reconcile them oldest-first.
- **FR-10.** Reconciliation is by message id and current body, not by "skip anything older than last sync". An edit does not change the original send time. Skipping old timestamps would drop a correction made while the laptop was off.
- **FR-11.** A stored id whose current body differs is updated and marked `EDITED`. A stored id whose current type is revoked is marked `DELETED`. A stored id with the same body is left untouched. A new candidate is appended.
- **FR-12.** If the oldest loaded message is still newer than the last successful sync, log a warning that the outage may be longer than the fetch window. Do not invent the missing messages.

### 7.4 Parsing

- **FR-13.** Tier 1 is local regex plus the clock rules in the architecture. Labels are case-insensitive. Spaces around the colon are optional. `6.53` and `6:53` are both `06:53`.
- **FR-14.** The `Technician` label must not match the word inside `Associate technician`.
- **FR-15.** A clean row requires site, duty date, start, and finish. When regex produces those four, Gemini is not called.
- **FR-16.** Tier 2 calls Gemini only for a candidate that failed FR-15, and only when `ENABLE_AI_FALLBACK` is true and an API key is set. The default model is `gemini-3.5-flash-lite` with a JSON schema. `gemini-2.0-flash` and `gemini-1.5-flash` are shut down. `gemini-2.5-flash` is not the default for a new project.
- **FR-17.** A candidate that both tiers fail to structure is appended as `NEEDS_REVIEW` with the raw text and countable hours `0`, so the log is not dropped on the floor. Messages that fail FR-6 are not appended and are not sent to Gemini.
- **FR-18.** The free Gemini tier may use submitted prompts to improve Google's products. The prompt contains employee names. Regex handles the standard log so that text stays on the machine. The operator can set `ENABLE_AI_FALLBACK=false`.

### 7.5 Sheets and state

- **FR-19.** Authenticate with a Google service account. The spreadsheet is shared with that account's `client_email` as Editor. No end-user OAuth.
- **FR-20.** Append with `spreadsheets.values.append`, then read the written row from `updates.updatedRange`. Do not assume the new row number is "last cached row + 1".
- **FR-21.** Before an update, confirm the cached row still holds that message id. If it does not, find the id in column C and repair the cache. If the id is gone from the sheet, append a new row.
- **FR-22.** Persist `message id → row, status, body hash, hours, names, interval` in `data/sync_state.json` using a temp-file rename. The map is the full history of ingested logs. It is not an LRU cache.
- **FR-23.** If the state file is missing, rebuild it from column C before serving live events.
- **FR-24.** Sheet writes that return 429 are retried with backoff. A failed write does not update the state file.
- **FR-25.** After a successful append or edit, ensure a month view tab for that duty date. Do not copy cell values. Do not write a formula on `Raw_Logs`. A delete does not remove the `Raw_Logs` row and does not show that row on the month tab.

---

## 8. Configuration

Copy `.env.sample` to `.env`. The sample lists every key. `npm run check` reports which ones are still missing.

```bash
# Group chat ids, comma-separated. Discover them once from the linked session.
# Do not guess. Newer sessions may use @lid participant ids; store ids as received.
TARGET_GROUP_IDS="120363000000000000@g.us"

# Messages loaded per group on every ready event. No date filter exists.
HISTORICAL_FETCH_LIMIT=300

# Duty-log clock mismatch that raises HOURS_MISMATCH, in decimal hours.
HOURS_MISMATCH_THRESHOLD=0.5

GOOGLE_SPREADSHEET_ID="your-spreadsheet-id"
GOOGLE_SHEET_TAB_NAME="Raw_Logs"
GOOGLE_SERVICE_ACCOUNT_KEY_FILE="./credentials.json"

# Optional. Standard logs never call this.
GEMINI_API_KEY=""
GEMINI_MODEL="gemini-3.5-flash-lite"
ENABLE_AI_FALLBACK=false

LOG_LEVEL="info"
STATE_FILE_PATH="./data/sync_state.json"
```

The sample spreadsheet id published in Google's API docs is a real public sheet and must not be used as a placeholder default.

---

## 9. Acceptance tests

1. **Canonical create.** Posting the sample log appends one `ACTIVE` row with the values in section 2, parser `REGEX`, countable hours `9`, calculated hours `9.27`, and no `HOURS_MISMATCH` at the default threshold. Gemini is not called.
2. **Morning start stays morning.** `Start duty : 6.53` is stored as `06:53`.
3. **Associate line stays separate.** Associates are Sathish and Nitiesh. Technicians are Sibirajan, Vicky, and Arjun.
4. **Live edit.** Within 15 minutes, changing the total from `9 Hrs` to `10 Hrs` updates that row, sets `EDITED`, and sets countable hours to `10`. It does not add a row.
5. **Delete for everyone.** The row remains. Status is `DELETED`. Reported hours remain `9`. Countable hours become `0`. A sum of countable hours excludes it.
6. **Edit after shutdown.** Ingest a log, stop the daemon, edit the message, start the daemon. The existing row shows the edited text. This is the case a "skip already synced ids" sweep gets wrong.
7. **Create while shut down.** Stop the daemon, post a log, start it. One row appears.
8. **Delete while shut down.** Ingest a log, stop the daemon, delete the message for everyone, start the daemon. The row becomes `DELETED` with countable hours `0`.
9. **Late correction.** After the 15-minute edit window, a second full log for the same sender, site, and date creates a second row and marks both `POSSIBLE_DUPLICATE`.
10. **Noise.** A chat line that merely mentions a site or a technician does not append a row and does not call Gemini.
11. **Silence.** During all of the above, the linked account sends nothing and does not call `sendSeen`.

---

## 10. Operating risks

- `whatsapp-web.js` drives the real WhatsApp Web page. It is not the Business API. WhatsApp can log the linked device out, or restrict the number, after a Web update or a terms enforcement. The mitigation is a dedicated number, no outbound traffic, and one session.
- npm `whatsapp-web.js@1.34.7` (24 April 2026) does not contain the September 2026 fix for WhatsApp's renamed id field. A current install has to track `main` at or after commit `58ddf15`, or carry that patch. Plan on the session breaking when WhatsApp Web changes, then updating the client and scanning the QR again.
- The laptop may sleep. Real-time sync exists only while the process is connected. Catch-up covers the gap up to `HISTORICAL_FETCH_LIMIT` messages per group.
- Gemini free tier is optional and has project quotas. It is not required for the standard log.
- Service-account keys, `.env`, and `.wwebjs_auth/` are credentials. They stay out of git.
