# sms-kit-kenya

Bulk SMS in Kenya through Africa's Talking without the surprises: plain Node, zero dependencies, with the checks that keep a send cheap, single and traceable.

## Why I built this

I wire SMS into the apps I build for programmes and communities in Kenya: event reminders, alumni outreach, payment receipts. Sending an SMS looks like one API call. Then it bites you.

One curly apostrophe pasted from a phone, or one emoji, quietly switches the message to Unicode. Each SMS then holds 70 characters instead of 160, and the same reminder costs two or three times as many units. Phone numbers arrive as 07, 01, +254, 254 and with spaces, so the same person is on the list twice or not at all. People who replied STOP keep getting messages. A retry after a timeout sends the same reminder twice, and you pay twice. And after the send, nobody knows which messages actually arrived.

This repo is the small amount of careful code that fixes each of those, with tests, so I can point to one place and say "do it like this".

## Quick start (sandbox)

```sh
git clone https://github.com/bytemel/sms-kit-kenya.git
cd sms-kit-kenya
npm test                                   # node --test, no network needed

node bin/sms.js check "Hi Akinyi, don't forget: class is at 6pm"
node bin/sms.js send --csv sample/people.csv \
  --template "Hi {{first_name}}, the {{cohort}} cohort meets on Saturday at 10am." --dry-run --rate 0.8
```

Neither command touches the network. To send through the Africa's Talking sandbox, create a sandbox app, copy its API key into `.env` (see `.env.example`), open the sandbox simulator in their dashboard with a test number, and run:

```sh
node --env-file=.env bin/sms.js send --csv my-test-list.csv --template "Hi {{first_name}}" \
  --campaign first-test --sandbox
```

The sandbox username is always `sandbox`; the kit sets it for you. Node 20.6 or newer.

The names and numbers in `sample/people.csv` are made up. Some of the numbers may belong to real people, so never send live to that file.

## The command line

`node bin/sms.js check "message"` prints the encoding, the length, the number of SMS parts, every character that forced Unicode with a plain swap where one exists, the characters that cost 2, and a GSM-safe version of the message if swapping helps.

`node bin/sms.js send --csv FILE --template TEXT` reads a CSV with a header row (the phone column is `phone`; change it with `--phone-column`) and works in one of three modes:

| Flag | What happens |
|---|---|
| `--dry-run` (or no flag) | Prints the plan as a table: each number, the final text, encoding, parts and characters, warnings, who is skipped and why, and the total parts. With `--rate` it adds the estimated cost. Nothing is sent. |
| `--sandbox` | Sends through the sandbox. Needs `AT_API_KEY` (the sandbox key) and `--campaign`. |
| `--live` | Sends for real, and costs money. Needs `AT_USERNAME`, `AT_API_KEY` and `--campaign`. Add `--sender-id` or `AT_SENDER_ID` once your sender ID is approved. |

Other options: `--rate` (KES per SMS part), `--batch-size` (default 100), `--data-dir` (where the ledger and opt-out JSON files live, default `data/`).

`node bin/sms.js pending` lists sends whose outcome is unknown, and `node bin/sms.js resolve <key> --sent` or `--failed` settles one after you check the dashboard (see "Settling a pending send" below).

A real send prints each number as sent (with the message id and cost Africa's Talking reported) or failed (with the reason), then everyone skipped or needing a check. It exits with 1 when anything failed or needs checking.

## What each part does

| File | What it does |
|---|---|
| `lib/phone.js` | `parsePhone` and `normalisePhone`: any common way of writing a Kenyan mobile number becomes `+2547...` or `+2541...`. Wrong lengths, letters, other countries and landlines are refused with a plain reason. |
| `lib/segments.js` | `analyse(text)`: GSM-7 or UCS-2, length, SMS parts, the characters that forced Unicode, the extension characters that cost 2. `toGsmSafe(text)` swaps curly quotes, long dashes, the ellipsis, odd spaces and invisible characters for plain ones. `estimateCost` multiplies parts by recipients by your rate. |
| `lib/template.js` | `{{first_name}}` merge. Missing or blank fields are listed per person and stop that person's message. Each merged message gets its own part count, with a warning when a long name or a name like Zoë makes it longer or switches it to Unicode. |
| `lib/optout.js` | STOP style replies, an opt-out store in memory or in a JSON file, and `filterOptedOut`. |
| `lib/client.js` | `createSmsClient(...).send(...)`: the whole send, with dry run, batching, the idempotency ledger, timeouts and retries. |
| `lib/dlr.js` | Parses delivery reports, incoming messages and opt-out notifications, and keeps the last status per message id. |
| `lib/store.js` | The small key value store behind the ledger, opt-outs and statuses: memory, or one JSON file guarded by a lock file. |
| `server.js` | The callback server. |
| `bin/sms.js` | The command line. |
| `examples/next-route-handler.md` | Calling the kit from a Next.js route handler. |

### Encoding and segments

A message stays in GSM-7 when every character is in the GSM 03.38 default alphabet: 160 characters in one SMS, 153 per part when longer (the other 7 hold the header that joins the parts). One character outside it switches the whole message to UCS-2: 70 in one SMS, 67 per part. Africa's Talking bills each part as one SMS.

Characters from the GSM extension table (`^ { } \ [ ~ ] |`, the euro sign and form feed) stay in GSM-7 but count as 2. Emoji count as 2 in UCS-2 because they are surrogate pairs. A part never splits either pair, so the count is done by packing parts one character at a time, not by dividing the length. The tests cover exactly 160, 161, 70, 71, a euro sign on the boundary and emoji at the edge of a part.

By default `send` runs `toGsmSafe` on every merged message. Turn it off with `gsmSafe: false`. Emoji and letters such as ë are never changed; the plan lists them so a person decides.

### Sending

```js
import { createSmsClient } from "./lib/client.js";

const sms = createSmsClient({ apiKey: process.env.AT_API_KEY }); // sandbox unless mode: "live"
const result = await sms.send({
  campaign: "class-reminder-2026-10-24",
  template: "Hi {{first_name}}, class starts at 6pm today.",
  recipients: [{ first_name: "Akinyi", phone: "0700 000 101" }],
  dryRun: true,
});
// result: { messages, skipped, needsChecking, totals: { recipients, segments, rate, estimatedCost } }
// without dryRun: { sent, failed, skipped, needsChecking, totals }
```

Before anything is sent, each person is checked in this order: a valid number, no missing fields, not listed twice, not opted out, not already sent in this campaign. Everyone left out gets a reason.

Messages with the same final text go out together, in batches of `batchSize` numbers per request. Personalised messages go one request each, because the bulk API takes one message for many numbers.

The request is `POST /version1/messaging`, form encoded, with the `apiKey` and `Accept: application/json` headers and the fields `username`, `to` (comma separated), `message`, `bulkSMSMode=1`, plus `from` when you have a sender ID and `enqueue=1` when you set `enqueue: true`. Each number in the response becomes sent (statusCode 100, 101 or 102) or failed, with Africa's Talking's status as the reason (for example `InvalidSenderId` or `InsufficientBalance`).

## How idempotency works

Every message gets a key: a SHA-256 of the normalised number, the campaign key and a hash of the template. Same person, same campaign, same template: same key.

Before a request goes out, each key is claimed in the ledger as `pending`. After the answer it becomes `sent` (with the message id) or `failed`. A second run, a double click or a cron that fires twice finds the key and skips the person with "Already sent in this campaign". Two runs at the same moment cannot both claim the same key: inside one process the store queues its writes, and separate processes on one machine sharing the JSON ledger take turns through a lock file (`ledger.json.lock`, created with the `wx` flag, removed after each write, cleared if older than 30 seconds). A lock file does not work across machines; there, use the database ledger below.

Africa's Talking charges once it accepts a message, so the kit never sends again when it cannot tell what happened:

- **Timeout** (no answer within `timeoutMs`, default 15 seconds): not retried. The person goes to `needsChecking` and stays `pending`, so later runs keep skipping them until a person checks the dashboard.
- **Connection dropped mid request** (`ECONNRESET` and similar): the same.
- **Connection never made** (`ECONNREFUSED`, DNS failure, connect timeout): the request never left, so it is retried with backoff, and marked failed if it never gets through.
- **HTTP 503** (service unavailable): retried with backoff (`retries`, default 2; `backoffMs`, default 500, doubling), because a 503 means the request was not taken. If every attempt gets a 503, the people go to `needsChecking`.
- **Any other HTTP 5xx** (500, 502, 504 and so on): not retried. It can come back after the message was accepted, so the people go to `needsChecking`. `retryStatuses` changes the list if you know better.
- **Other HTTP errors** (bad key, bad request): failed with the reason, not retried.
- **A number missing from the response**: `needsChecking`.

`failed` keys can be claimed again by a later run, so fixing a low balance and re-running sends only to the people who did not get it.

**Settling a pending send.** A `pending` entry stays skipped until a person decides. `node bin/sms.js pending` lists them with their keys (a real send also prints the key next to each person that needs checking). Find the message in the Africa's Talking dashboard, then run `node bin/sms.js resolve <key> --sent --message-id <id>` if it went out, so it stays skipped, or `node bin/sms.js resolve <key> --failed` if it did not, so the next run sends it. In code, `ledger.resolve(key, "sent" | "failed")` does the same. Only `pending` entries can be resolved.

The campaign key is your decision: use one per real reminder (`class-reminder-2026-10-24`), never a timestamp of the run.

## How opt-out works

There are two ways a person in Kenya stops your messages, and the kit handles both.

1. **They reply STOP to your short code.** Africa's Talking posts the reply to your incoming messages callback. `parseOptOut` treats these as opt-outs, forgiving case, extra spaces and trailing punctuation: `STOP`, `STOP ALL`, `STOPALL`, `UNSUBSCRIBE`, `SIMAMA` and `ACHA` (Swahili for stop). The stop word may be followed by one more word, because people often add the sender name (`STOP EPICPRIME`). A longer sentence is not an opt-out: in Swahili "Acha nikuambie..." means "let me tell you...". The list is `STOP_WORDS` in `lib/optout.js`; add to it if your audience uses other words.
2. **They block your sender ID through their network.** People cannot reply to an alphanumeric sender ID such as `EpicPrime`. They opt out through their network instead. Africa's Talking's help centre gives the `*456*9#` menu for this (it does not say which networks it covers, so check with your provider). Africa's Talking can notify you of these bulk SMS opt-outs, and the server takes them on `/sms/optout`. Later sends to that number come back as `UserInBlacklist` (statusCode 406); the kit adds the number to the opt-out list the first time that happens.

So "Reply STOP to opt out" only makes sense when you send from a short code. From an alphanumeric sender ID, say how to opt out through the network, or leave the line out.

Every send filters the list against the opt-out store first, and the plan names each person skipped. `remove(phone)` takes a number off the list; use it only when the person asks to hear from you again.

## The callback server

```sh
cp .env.example .env      # set CALLBACK_TOKEN: openssl rand -hex 24
npm start                 # node --env-file=.env server.js, port 3000
```

| Route | What it does |
|---|---|
| `GET /health` | `{ "ok": true }` |
| `POST /sms/delivery/<token>` | Delivery reports. Stores the last status per message id: `Sent`, `Submitted`, `Buffered`, then a final `Success`, `Failed`, `Rejected` or `Expired`. A final status is never replaced by a late in-between one, because callbacks can arrive out of order. |
| `POST /sms/incoming/<token>` | Messages sent to your short code. A STOP style reply adds the sender to the opt-out list. |
| `POST /sms/optout/<token>` | Bulk SMS opt-out notifications for your alphanumeric sender ID. |

**Pointing Africa's Talking at it.** In the Africa's Talking dashboard, under SMS, set the delivery reports callback URL to `https://<your domain>/sms/delivery/<your token>`, and the incoming messages and bulk SMS opt-out callback URLs to the matching paths. Africa's Talking cannot reach `localhost`; while building, expose the server with a tunnel (for example `cloudflared tunnel --url http://localhost:3000`) and use that address.

**Why a token in the path.** I found no sign that Africa's Talking signs its callbacks, so anyone who learns the URL could post a fake delivery report or opt someone out. The token is a long random string only you and the dashboard know. It is compared in constant time, and a wrong or missing token gets a 403 with nothing stored. A proxy in front of the server can send it as an `x-callback-token` header instead. Use letters and digits only. The server will not start without a token of at least 16 characters.

**Answers.** A well formed request with the right token always gets a 200, even when its content is ignored (for example a report with no message id), so Africa's Talking stops retrying. The status is stored first, which takes milliseconds, and your hooks (`onDelivery`, `onIncoming`, `onOptOut`) run after the answer has gone. Bodies are read as form encoded, with JSON accepted too, and capped at 16 KB.

Statuses and opt-outs live in `data/statuses.json` and `data/optouts.json` (the `data/` folder is gitignored). Use the same `data/optouts.json` for the command line and the server on one machine, or a database for both. The server's log shows only the last 4 digits of a phone number.

## Swapping the stores for Postgres or Supabase

The JSON files work for one machine: one process, or several sharing the file through the lock. Several machines, or serverless functions, need a database. These are the tables, and the queries each method needs.

```sql
create table if not exists sms_ledger (
  key         text primary key,
  phone       text not null,
  campaign    text not null,
  status      text not null check (status in ('pending', 'sent', 'failed')),
  attempts    integer not null default 1,
  message_id  text,
  cost        text,
  reason      text,
  claimed_at  timestamptz not null default now(),
  settled_at  timestamptz
);

create table if not exists sms_optouts (
  phone      text primary key,
  source     text not null,
  created_at timestamptz not null default now()
);

create table if not exists sms_statuses (
  message_id     text primary key,
  status         text not null,
  phone          text,
  network_code   text,
  failure_reason text,
  updated_at     timestamptz not null default now()
);

insert into sms_ledger (key, phone, campaign, status)
values ($1, $2, $3, 'pending')
on conflict (key) do update
  set status = 'pending', attempts = sms_ledger.attempts + 1, claimed_at = now()
  where sms_ledger.status = 'failed'
returning key;

update sms_ledger
set status = $2, message_id = $3, cost = $4, reason = $5, settled_at = now()
where key = $1;

insert into sms_optouts (phone, source) values ($1, $2) on conflict (phone) do nothing;
```

`claim` returns `{ claimed: true }` only when the first insert returned a row. The `where sms_ledger.status = 'failed'` is the whole idempotency story: the database decides which run won. On Supabase, enable RLS on these tables with no public policies and call them only from the server with the service role key.

## Check before you go live

I could not read developers.africastalking.com from a script on 2026-10-21 (it shows a browser check), so the facts below come from Africa's Talking's own SDKs, its Power Platform connector and its help centre (see Sources). These were **not** confirmed, and the code is written so a wrong guess fails safe:

- **Delivery report fields.** Confirmed: `id` and `status`. Not confirmed: `phoneNumber`, `networkCode`, `failureReason` and `retryCount`. The kit stores them when present and does not need them.
- **Callback encoding.** The send API is form encoded. I could not confirm that callbacks are; the server accepts form encoded and JSON.
- **Bulk SMS opt-out notification fields.** The notification exists, but I could not confirm its field names. The server looks for the number in `phoneNumber`, then `phone`, `number` and `from`. Post a test from the dashboard and check your log.
- **Callback signing.** I found no signature or documented IP list. The path token is the guard.
- **Recipients per request.** I found no documented maximum. The default batch of 100 is a cautious choice; raise it only after testing.
- **The newer bulk endpoint.** Africa's Talking also has `POST /version1/messaging/bulk`, which takes JSON with a `phoneNumbers` list. Their own Node SDK still uses the form encoded `/version1/messaging`, with a note that it will move. This kit uses the endpoint the SDK uses today.
- **Which 5xx answers are safe to retry.** I found nothing from Africa's Talking on this. The kit retries only 503 and treats every other 5xx as "may have gone out". Set `retries: 0` to never retry at all.

And the things only you can do:

- **Sender ID approval.** Apply for an alphanumeric sender ID in the dashboard. Each network approves it, which takes time. Set `AT_SENDER_ID` exactly as approved, capitals included, or sends fail with `InvalidSenderId`. Without one, Africa's Talking's connector definition says the sender defaults to `AFRICASTKNG`; check with Africa's Talking what your recipients will see.
- **Promotional or transactional.** Ask Africa's Talking which type suits you. Promotional sender IDs are refused by people who blocked promotional messages.
- **Rates.** There is no price in this code. Put your rate per SMS part from your own Africa's Talking price list in `SMS_RATE_PER_SEGMENT` or `--rate`; it changes with network, volume and time.
- **Test with real phones.** One live message per network you send to, read on the handset, before the first big send.
- **The live username.** `AT_USERNAME` is your app's username, not `sandbox`; the kit refuses that mix.
- **Consent.** Send only to people who agreed to hear from you, and keep the opt-out list for good.

## Sources

All read on 2026-10-21.

- Africa's Talking Node SDK, `lib/common.js` and `lib/sms.js`: <https://github.com/AfricasTalkingLtd/africastalking-node.js>. Live base `https://api.africastalking.com/version1`, sandbox `https://api.sandbox.africastalking.com/version1`, SMS path `/messaging`, form encoded body, `apikey` and `Accept` headers, the fields `username`, `to` (comma joined), `message`, `from`, `bulkSMSMode=1`, `enqueue`, and for premium SMS `keyword`, `linkId`, `retryDurationInHours`. Success comes back as HTTP 201.
- The same SDK's README: the sandbox username is always `sandbox`.
- Africa's Talking SMS connector definition (published by Africa's Talking): <https://github.com/AfricasTalkingLtd/PowerPlatformConnectors/tree/HEAD/certified-connectors/Africa's%20Talking%20SMS>, and its page on Microsoft Learn: <https://learn.microsoft.com/en-us/connectors/africastalkingsms/>. The response shape `SMSMessageData.Message` and `SMSMessageData.Recipients[]` with `number`, `status`, `statusCode`, `cost`, `messageId`, `messageParts`; the newer `/version1/messaging/bulk` JSON endpoint; the default sender `AFRICASTKNG` when `from` is empty; and the three notifications: delivery reports, incoming messages, and bulk SMS opt-outs from an alphanumeric sender ID.
- Help centre, Messaging Error Codes: <https://help.africastalking.com/en/articles/16150386-messaging-error-codes>. statusCodes 100 Processed, 101 Sent, 102 Queued, 401 RiskHold, 402 InvalidSenderId, 403 InvalidPhoneNumber, 404 UnsupportedNumberType, 405 InsufficientBalance, 406 UserInBlacklist, 407 CouldNotRoute, 500 InternalServerError, 501 GatewayError, 502 RejectedByGateway; delivery statuses Sent, Submitted, Buffered, Success, Rejected, Failed, Expired.
- Help centre, Why did my messages fail: <https://help.africastalking.com/en/articles/742491-why-did-my-messages-fail>. A sample send response, delivery statuses, failure reasons, and that messages with a % sign have failed.
- Help centre, Making your SMS characters count: <https://help.africastalking.com/en/articles/2964644-making-your-sms-characters-count>. 160 characters in GSM-7, 70 otherwise, and extension characters counting as 2.
- Help centre, Why was my message billed twice: <https://help.africastalking.com/en/articles/796314-why-was-my-message-billed-twice>. Each part is billed as one message.
- Help centre, Where are my incoming messages: <https://help.africastalking.com/en/articles/742510-where-are-my-incoming-messages>. Incoming messages go to your callback URL, retried every minute until a 200 or 12 hours.
- Help centre, UserInBlacklist: <https://help.africastalking.com/en/articles/5209677-userinblacklist>. A number is blacklisted when the person opted out of a sender ID or blocked all messages through the opt-out code, and the `*456*9#` menu to undo it. And What is a link Id: <https://help.africastalking.com/en/articles/2249217-what-is-a-link-id>.
- Africa's Talking sample app athena, `routes/dlrs.js` and `routes/sms.js`: <https://github.com/AfricasTalkingLtd/athena>. Delivery reports carry `id` and `status`; incoming messages carry `from`, `to`, `text` and `date`. The Java and Go SDK message models add `id` and `linkId`.
- The GSM 03.38 alphabet in `lib/segments.js` follows 3GPP TS 23.038, which I did not re-read today. The help centre's list differs in two small ways (it includes the backtick and a different delta character); the kit follows the standard, and `toGsmSafe` swaps both.

## Tests

```sh
npm test
```

77 tests with `node:test`, no network: phone formats and refusals, segment edges (160, 161, 70, 71, a euro sign on the boundary, emoji surrogate pairs), templates, STOP parsing, both stores, the CSV reader, the client against a fake Africa's Talking (request shape, batching, the same send twice sending once, two runs at once, timeouts, 503 retried and other 5xx not, refused and dropped connections, UserInBlacklist, resolving pending sends), separate processes sharing one JSON ledger, stale and live lock files, delivery report parsing, every server route on a random port, masked phone numbers in logs, and the command line.

## Limits

- The JSON file stores are for one machine. Use the Postgres tables above for more than that, or for serverless functions.
- No quiet hours, daily cap or rate limit. Add them where you schedule sends.
- Premium SMS (`keyword`, `linkId`) and fetching the inbox are not covered.
- Kenyan numbers only. Other countries are refused on purpose.
- Africa's Talking changes its API over time. Check the points above before you go live.

## License

MIT. Copyright 2026 Timothy Mwangi.
