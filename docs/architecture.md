# Technical Architecture

## System: `wa-duty-sync`

Validated: 22 October 2026. Product behavior is defined in `docs/project_prd.md`. This document says how that behavior is implemented, including the library and API constraints the first draft got wrong.

---

## 1. Design rules

- **One message, one row.** The primary key is the serialized WhatsApp message id (`message.id._serialized`), not the short `message.id.id` and not a guessed spreadsheet row.
- **Regex first.** Gemini runs only after a message has already qualified as a duty log and the local parser is missing site, duty date, start, or finish.
- **Deletes are status changes.** `DELETED` sets countable hours to `0`. Reported hours, calculated hours, and the raw text stay on the row.
- **The sheet row cache is a hint.** Every edit and delete re-reads column C of the cached row before writing. A human sort or insert must not update the wrong technician.
- **The process may be off.** Catch-up reconciles the current text and revoked state of recent messages. It does not skip a message only because its original timestamp is old.
- **The WhatsApp client is read-only.** No send path is wired up. `sendSeen` is never called.

The daemon is a single Node.js process on a Windows laptop. A sleeping laptop drops the WhatsApp socket. `pm2` is not part of the design. On the next `ready` event, catch-up runs.

---

## 2. Pipeline

```
Technicians in WhatsApp groups
        │
        ▼
whatsapp-web.js  (linked device, LocalAuth, headless Chrome)
        │
        ├── message_create ───────────────┐
        ├── message_edit ─────────────────┤
        ├── message_revoke_everyone ──────┤
        └── ready → fetchMessages ────────┘
                          │
                          ▼
                 Chat filter + candidate gate
                          │
            ┌─────────────┴─────────────┐
            │ revoke of a stored id     │ candidate text
            ▼                           ▼
     soft-delete that row        Tier 1 regex + clock resolver
                                        │
                         complete? ─────┤
                         yes            │ no, but still a candidate
                          │             ▼
                          │      Tier 2 Gemini JSON schema
                          │             │
                          ▼             ▼
                 state lookup by serialized id
                          │
           ┌──────────────┼──────────────┐
           │ new          │ same body    │ body changed or revoked
           ▼              ▼              ▼
      Sheets append    no write     verify row, then update
           │                             │
           └──────── sync_state.json ────┘
```

---

## 3. Repository layout

```
duty_log_whatsapp/
├── .env.sample
├── .gitignore
├── .nvmrc                           # Node 24.14.0
├── credentials.json                 # gitignored service-account key
├── package.json
├── tsconfig.json
├── docs/
│   ├── architecture.md
│   └── project_prd.md
├── scripts/
│   ├── list-groups.ts               # print group names and ids
│   ├── setup-sheet.ts               # create Raw_Logs, the header row, and month tabs
│   └── check.ts                     # verify env, credentials, sheet, optional Gemini
├── data/                            # created at runtime, contents gitignored
│   ├── sync_state.json
│   └── failed_messages.log
└── src/
    ├── index.ts                     # process signals, ready/disconnect
    ├── config/env.ts                # environment schema
    ├── core/
    │   ├── client.ts                # Client, LocalAuth, Chrome launch
    │   ├── events.ts                # create, edit, revoke
    │   ├── catchup.ts               # reconcile fetchMessages results
    │   └── sync.ts                  # shared insert / edit / delete decisions
    ├── parser/
    │   ├── types.ts
    │   ├── candidate.ts             # gate before any parse or model call
    │   ├── regex.ts
    │   ├── time.ts                  # clock resolver used by the regex tier
    │   ├── record.ts                # fields to sheet record
    │   ├── gemini.ts
    │   └── index.ts
    ├── services/
    │   ├── headers.ts               # Raw_Logs columns A–W and the month-view columns
    │   ├── months.ts                # month tab title and FILTER formula
    │   ├── state.ts                 # atomic JSON map
    │   └── sheets.ts                # append, verified update, rebuild, month tabs
    └── utils/logger.ts
```

Target runtime is Node.js 24 LTS (`.nvmrc` is `24.14.0`). Dependency direction is `events/catchup → sync → parser → state/sheets`. The parser does not import the Sheets client.

---

## 4. WhatsApp client

### 4.1 Library pin

Published npm `whatsapp-web.js@1.34.7` (24 April 2026) still reads `id._serialized`. WhatsApp Web renamed that field to `$1` in July 2026. The fix is commit `58ddf1561cd783d6a548fa812eb70a05944604b4` on `wwebjs/whatsapp-web.js`, merged 26 September 2026, and it is not in the npm tarball.

Install `main` at or after that commit (or apply the equivalent patch locally) and record the commit in `package.json`. A WhatsApp Web release can break event delivery again. The operational response is: update the dependency, restart, and scan a new QR if `auth_failure` fires. Do not pin an ancient `webVersion` to paper over a broken client. Old bundles stop authenticating.

### 4.2 Launch

`LocalAuth` stores the linked-device profile in `.wwebjs_auth/`. That directory is a credential. One profile, one machine. Copying it to a second machine logs the other session out.

On Windows, launch the installed Chrome with Puppeteer's `channel: 'chrome'` and only these extra args: `--disable-gpu`, `--no-first-run`, `--disable-extensions`. Do not use `--single-process`, `--no-zygote`, `--no-sandbox`, or `--disable-dev-shm-usage` on this host. Those flags are for root in a small Linux container, and the first two make Chrome unstable.

`headless: true`. The first login prints the QR with `qrcode-terminal`. There is no outbound message code.

`takeoverOnConflict: false`. If someone opens WhatsApp Web for this number in a normal browser, the daemon should disconnect and log it, not fight for the session.

### 4.3 Ids and chat routing

For a group message the serialized id has four underscore-separated parts:

```text
false_<groupJid>_<messageId>_<participantJid>
```

`false` means another member sent it. `true` means the linked account sent it. The participant may be `@c.us` or `@lid`. Store the serialized string as received. Do not reconstruct it, and do not parse a phone number out of it.

Route with the chat id, matching the library's `_getChatId()`:

```typescript
const chatId = message.fromMe ? message.to : message.from;
```

Filtering on `message.from` alone drops a log that the linked account sent, and it can accept the wrong chat. The sender inside a group is `message.author`. The display name is `message._data.notifyName` when present. A contact lookup is optional and must not block ingestion when it fails.

Column C stores `_serialized`. The state file also indexes the short `id.id`, because revoke events sometimes only hand back that form.

### 4.4 Events

| Event | Payload | Action |
| --- | --- | --- |
| `message_create` | `Message` | Candidate gate, then insert or ignore. Fires for the linked account's own messages too. The `message` event does not, so it is the wrong hook. |
| `message_edit` | `(message, newBody, prevBody)` | Parse `newBody`. Update the row when the id is known. Append when the id is new and the text is a candidate. Ignore when the type is `revoked`. The library already returns before emit in that case. |
| `message_revoke_everyone` | `(message, revokedMsg)` | Resolve the original id, then soft-delete. `revokedMsg` is undefined when the previous in-memory message was not the one revoked. The tombstone `message.id` is not a reliable primary key. |
| `ready` | none | Run catch-up once. A module-level lock ignores overlapping `ready` events. |
| `disconnected` / `auth_failure` | reason | Log and let the client retry. On `auth_failure`, the operator re-scans the QR. Do not delete `.wwebjs_auth/` automatically. |

Original id for a revoke, first hit wins:

1. `revokedMsg.id._serialized`
2. Serialized form of `message.protocolMessageKey` (the library copies this onto `revokedMsg.id` only when it still held the previous message)
3. Short-id index lookup of `message.protocolMessageKey.id` or `revokedMsg.id.id`
4. Give up and log the raw ids. Do not soft-delete a random row.

### 4.5 Catch-up

`chat.fetchMessages({ limit })` returns the current body, oldest first. Only `limit` and `fromMe` are supported. There is no `since` parameter. Default limit is 300 per target group.

For each loaded message, in order:

| Current fetch result | State | Write |
| --- | --- | --- |
| `type === 'revoked'` | id present, not already `DELETED` | Soft-delete |
| `type === 'revoked'` | id absent | Ignore. The body is gone. |
| Same body hash | any open status | Nothing |
| Different body, still a candidate | id present | Re-parse and update, status `EDITED` |
| Different body | id absent | Parse and append |
| Not a candidate | id absent | Ignore |
| Any | status already `DELETED` | Nothing. Do not resurrect a deleted log from a stale cache. |

`latestEditSenderTimestampMs` on the message model is a useful signal, and the body hash is the decision. An edit does not change `message.timestamp`.

After a sweep whose oldest loaded timestamp is still newer than `last_sync_timestamp`, log `catchup_window_incomplete` with the group id. Then set `last_sync_timestamp` to the newest loaded timestamp. The timestamp is a diagnostic. It is not the deduplication key.

A log created and edited during an outage is appended once, as `ACTIVE`, because the fetch only contains the latest text. A log created and deleted during an outage produces no row.

---

## 5. Parser

### 5.1 Candidate gate

Run this before regex-field requirements and before Gemini. A message qualifies when either:

- an anchored `Site` label is present, and so is `Start duty`, `Finish duty`, or `Total working`, or
- both `Start duty` and `Finish duty` labels are present.

Compare labels at the start of a line so a sentence about a technician does not qualify. Captions of `image` and `video` messages use the same body text. Other media without a caption stops here.

### 5.2 Regex tier

Labels are case-insensitive. The colon or hyphen may have spaces around it. Each extractor is anchored to a line and uses a negative lookbehind where one label contains another:

```typescript
const line = String.raw`^[^\S\r\n]*`;

const site = new RegExp(line + String.raw`site\s*[:\-]\s*(.+?)\s*,?\s*$`, "im");
const date = new RegExp(line + String.raw`date\s*[:\-]\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s*$`, "im");
const clock = (label: string) =>
  new RegExp(line + label + String.raw`\s*[:\-]\s*(\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm)?)\s*$`, "im");
const hours = new RegExp(line + String.raw`total(?:\s*working)?\s*hrs?\s*[:\-]\s*(\d+(?:\.\d+)?)`, "im");
const technicians = new RegExp(line + String.raw`(?<!associate\s)technicians?\s*[:\-]\s*(.+)\s*$`, "im");
const associates = new RegExp(line + String.raw`associate\s*technicians?\s*[:\-]\s*(.+)\s*$`, "im");
const heading = /^\s*([A-Za-z][A-Za-z .'-]*?)\.?\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*$/im;
```

`(?<!associate\s)` is required. Without it, `Technician` matches the word inside `Associate technician:` and the staff lists are swapped. Apply the associate pattern first, then the technician pattern, even with the lookbehind.

Dates are day, then month, then year. `20.10.26` is `2026-10-20`. A two-digit year `00`–`69` maps to `2000`–`2069`. `Date.parse` is not used. An impossible day or month fails the date field rather than rolling over.

Staff cells are split on `,`, trimmed, and joined back with `, `.

### 5.3 Clock resolver

A token is hours and minutes. The dot in `6.53` is a separator, the same as a colon. It is not a decimal hour. Decimal hours exist only on the `Total working hrs` line. Minute values above `59` fail the field.

Resolved order is start, pause, resume, finish.

1. An explicit `am` or `pm` converts in the usual way. `12am` is `00:00`. `12pm` is `12:00`.
2. An hour of `13` or more is already 24-hour time.
3. Otherwise the token is ambiguous. Keep the AM reading and the PM reading (plus 12 hours when the hour is 1–11).
4. For the start time, choose the reading in `05:00`–`11:59` when one candidate is in that range. `6.53` therefore stays `06:53`. If neither candidate is in that range, leave the field unresolved and set `AMBIGUOUS_TIME`. Do not use a rule of the form "hour less than 7 means PM". That rule turns this start time into `18:53`.
5. For each later token, choose the candidate that is strictly after the previous resolved time and at most 16 hours after it. `5.04` after a `14:38` resume becomes `17:04`. If neither candidate fits, set `AMBIGUOUS_TIME` and leave calculated hours blank.

Calculated hours:

- With start, pause, resume, and finish: `(pause − start) + (finish − resume)`.
- With start and finish and no break fields: `finish − start`.
- With only one of pause or resume: set `INCOMPLETE_BREAK`, do not subtract a break, and use `finish − start` when both ends exist.
- Round the stored number to 2 decimal places. The sample is 556 minutes, stored as `9.27`.

`HOURS_MISMATCH` is set when both numbers exist and the absolute gap is greater than `HOURS_MISMATCH_THRESHOLD` (default `0.5`). The sample gap is `0.27`, so the sample has no mismatch note.

A clean Tier 1 result has site, duty date, start, and finish. That result does not call Gemini. Parser column is `REGEX`.

### 5.4 Gemini tier

Call only when the candidate gate passed, Tier 1 is not clean, `ENABLE_AI_FALLBACK=true`, and `GEMINI_API_KEY` is set. Default model id: `gemini-3.5-flash-lite`. Structured output uses `responseMimeType: "application/json"` and a `responseSchema` that matches `DutyLogRecord`. Set the model's thinking control to its minimum, when the SDK exposes one, so a 10-line log does not spend the free quota on reasoning.

Shut down and not acceptable: `gemini-1.5-flash`, `gemini-2.0-flash` (shut down 1 June 2026). `gemini-2.5-flash` is a poor default for a new key. Access is limited to projects that already used 2.5, and the Vertex retirement date was 20 October 2026. The model id stays in configuration so it can move to a later Flash-Lite id without a code change.

The prompt contains the message text and the same field rules as section 5.3, including day-month-year dates and the instruction that `6.53` is a morning start. The model is not asked to invent a duty date from the WhatsApp timestamp.

On success, the returned clocks still pass through `time.ts`. The model does not get to skip the sequence rules. Parser column is `GEMINI`.

On failure, or when the fallback is disabled: append the candidate as `NEEDS_REVIEW`, countable hours `0` unless a reported number was parsed, and append the raw text to `data/failed_messages.log`. A non-candidate never reaches this branch.

Free-tier requests may be used by Google to improve its products. That is why the fallback is off unless the operator turns it on.

### 5.5 Review notes computed with the row

Overlap and duplicate checks use the state map, not the sheet.

- `POSSIBLE_DUPLICATE` when another row with status `ACTIVE` or `EDITED` has the same sender id, the same normalized site, and the same duty date.
- `OVERLAP` when another open row on that duty date lists the same technician or associate name (trim and case-fold) and the clock intervals overlap. Names that are not exact do not match.
- `FORWARDED` when `message.isForwarded` is true.

Notes are joined with ` | ` into column T.

---

## 6. State file

`data/sync_state.json` is the full set of ingested logs. Nothing is evicted. Writes go to `sync_state.json.tmp` and then rename over the target.

```json
{
  "last_sync_timestamp": 1761000000,
  "records": {
    "false_120363000000000000@g.us_3EB0C1234567890ABC_971500000000@c.us": {
      "shortId": "3EB0C1234567890ABC",
      "row": 2,
      "status": "ACTIVE",
      "bodyHash": "sha256-of-normalized-body",
      "dutyDate": "2026-10-20",
      "site": "al barsha ns147",
      "senderId": "971500000000@c.us",
      "names": ["sibirajan", "vicky", "arjun", "sathish", "nitiesh"],
      "startMinute": 413,
      "endMinute": 1024,
      "updatedAt": "2026-10-22T14:35:10.000Z"
    }
  },
  "byShortId": {
    "3EB0C1234567890ABC": "false_120363000000000000@g.us_3EB0C1234567890ABC_971500000000@c.us"
  }
}
```

`startMinute` and `endMinute` are minutes from midnight for the overlap check. Breaks are not modeled in the overlap interval. A same-day overlap of the outer start and finish is enough for a review note.

In-process, a mutex per serialized id serializes a live event against catch-up so the same message cannot append twice.

If the file is missing or fails to parse, `sheets.rebuildState()` reads column C and the fields needed above, writes a new file, and only then subscribes to live events. A corrupt file is renamed aside, not overwritten in place before the rebuild succeeds.

---

## 7. Google Sheets

### 7.1 Auth and tab

A service account JSON key, Sheets API enabled, spreadsheet shared with the key's `client_email` as Editor. Scope is `https://www.googleapis.com/auth/spreadsheets`.

`Raw_Logs` row 1 is the header in `project_prd.md` section 6. The daemon writes columns A–W except that it owns every column, including countable hours. There are no pre-filled formulas on this tab. A formula column that extends down the sheet changes the range `values.append` treats as the table, and new logs land far below the real data. Managers build `SUM` and pivot tables on a different tab, pointed at `Raw_Logs!Q:Q` for countable hours and `Raw_Logs!J:J` for the duty date.

`valueInputOption` is `USER_ENTERED` so dates and hour numbers become real values. Duty dates are written `YYYY-MM-DD`. Clock times are written `HH:mm`. Message ids contain `@` and `_`, so Sheets will not coerce them into numbers. Set the spreadsheet locale to a day-month locale anyway.

Append uses `insertDataOption: INSERT_ROWS` and range `Raw_Logs!A:W`.

### 7.2 Row identity

Append response `updates.updatedRange` looks like `Raw_Logs!A14:W14`. Parse that row and store it.

Update path:

1. `values.get` of `C{cachedRow}`.
2. If it equals the serialized id, `values.update` that row.
3. Otherwise `values.get` of `Raw_Logs!C2:C`, find the id, update that row, and repair the cache.
4. If the id is not in the column, append and replace the cache entry.

A 429 or 500 retries up to 3 times with jittered delays of about 2s, 4s, and 8s. State is written only after the Sheets call returns.

Delete update writes status, last-event time, countable hours `0`, and the validation notes. It does not clear columns O, P, or W.

At this volume the Sheets write quota (60 requests per minute per user) is not a design constraint. Catch-up still updates only rows whose body hash or revoked state changed, so a reboot does not rewrite the whole tab.

### 7.3 Month tabs

`Raw_Logs` stays the only stored copy. After a row is appended or updated, the daemon ensures a tab named `2026-06 (JUNE)` for that duty date. The tab is created the first time that month is seen. Startup and `setup-sheet` do the same for duty dates already on `Raw_Logs`, skipping `DELETED` rows and rows with no duty date.

Row 1 is a header. `A2` is one formula:

```text
=IFERROR(SORT(FILTER({Raw_Logs!A2:A,Raw_Logs!G2:T},(Raw_Logs!A2:A<>"DELETED")*(Raw_Logs!J2:J>=DATE(2026,6,1))*(Raw_Logs!J2:J<DATE(2026,7,1))),5,TRUE),"")
```

The view keeps Status and columns G–T (Log Name through Validation Notes). It hides the message id, sender, group, parser, and raw text. `DELETED` rows stay on `Raw_Logs` only. A duty-date change from June to July drops the row from the June tab and shows it on the July tab, because both formulas read column J. Rows are sorted by duty date. No formula is written onto `Raw_Logs`.

An existing month tab is left alone, including its formula. A spilled formula shows duty dates and clock times as raw serials, so the view formats Duty Date as `yyyy-mm-dd` and Start through Finish as `hh:mm`. A new tab freezes row 1 and colors `NEEDS_REVIEW` with `=$A2="NEEDS_REVIEW"` over columns A–O. The `Monthly` pivot is not moved or rewritten. New month tabs are inserted in calendar order among themselves.

A failure to create the month tab is logged. The `Raw_Logs` row and the state entry stay.

---

## 8. Failure behavior

| Failure | Result |
| --- | --- |
| Ordinary chat | Dropped at the candidate gate. No Sheets call, no Gemini call. |
| Candidate, regex incomplete, Gemini disabled or down | `NEEDS_REVIEW` row, raw text kept, countable hours `0` unless a total was parsed. Copy appended to `failed_messages.log`. |
| Sheets write fails | Event is logged. State is unchanged, so the next catch-up tries again. |
| Month tab create fails | The `Raw_Logs` row stays. The error is logged. A later append or edit for that month tries again. |
| State file missing | Rebuild from column C, then open the event listeners. |
| Cached row is stale | Column C search repairs it. |
| Fetch window shorter than the outage | Warning log. No guessed rows. |
| WhatsApp Web markup change | Events stop or `auth_failure`. Update the library pin and re-link. |
| Laptop sleep | Socket drops. The following `ready` runs catch-up under the same lock. |

---

## 9. Security boundaries

- `credentials.json`, `.env`, and `.wwebjs_auth/` are gitignored.
- The service account is Editor on this spreadsheet only.
- No WhatsApp send or seen method is referenced from `src/`. A unit test can grep for `sendMessage` and `sendSeen` and fail if either appears.
- Gemini is off by default because the free tier can retain employee names from the prompt.
- The linked number is a dedicated observer. It is a member of the target groups and is not used as a personal WhatsApp account.
