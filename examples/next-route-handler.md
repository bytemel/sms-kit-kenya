# Calling the kit from a Next.js app

This is a sketch, not wired into any build. Copy `lib/` into your app (for example `src/lib/sms/`) and import from there. The kit has no dependencies, so nothing else to install.

The route below sends a class reminder. A Vercel cron (which sends GET) or a staff button (POST) calls it. It runs on the Node.js runtime, because the kit uses `node:crypto`.

```js
// app/api/reminders/route.js
import { createSmsClient } from "@/lib/sms/client.js";
import { createPostgresLedger, createPostgresOptOuts } from "@/lib/sms/postgres.js"; // your adapters, see the README
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Vercel cron calls the route with GET and sends "Authorization: Bearer <CRON_SECRET>".
// A staff button can POST to the same handler.
export async function GET(request) {
  return sendReminder(request);
}

export async function POST(request) {
  return sendReminder(request);
}

async function sendReminder(request) {
  // Route handlers are public endpoints. Check the caller on the server, every time. With CRON_SECRET
  // unset, the comparison would accept "Bearer undefined", so refuse outright.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, message: "Not allowed." }, { status: 401 });
  }

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: people, error } = await db
    .from("enrolments")
    .select("first_name, phone")
    .eq("cohort", "evening");
  if (error) return Response.json({ ok: false, message: "Could not load the class list." }, { status: 500 });

  const live = process.env.AT_ENV === "live";
  const sms = createSmsClient({
    mode: live ? "live" : "sandbox",
    username: live ? process.env.AT_USERNAME : "sandbox",
    apiKey: process.env.AT_API_KEY,
    senderId: process.env.AT_SENDER_ID || undefined,
    rate: process.env.SMS_RATE_PER_SEGMENT || undefined,
    ledger: createPostgresLedger(db), // get, claim, settle on the sms_ledger table
    optOuts: createPostgresOptOuts(db), // has, add, remove, list on the sms_optouts table
    timeoutMs: 10000, // stay inside the function time limit
  });

  const result = await sms.send({
    campaign: "evening-class-2026-10-24", // one key per real-world reminder
    template: "Hi {{first_name}}, the evening class starts at 6pm today.",
    recipients: people,
  });

  return Response.json({
    ok: true,
    message: `${result.sent.length} sent, ${result.failed.length} failed, ${result.skipped.length} skipped, ${result.needsChecking.length} need checking.`,
  });
}
```

Points that matter:

- **The campaign key** is what stops a double send. If the cron fires twice, or someone presses the button again, the second call finds every message in the ledger and skips it. Use one key per real reminder, such as the class date.
- **The ledger must outlive the function.** Serverless functions start fresh, so the memory store forgets everything. Back the ledger and the opt-outs with tables. The README has the Postgres tables and the queries each method needs.
- **`needsChecking`** lists people whose send timed out or broke mid way. The kit will not send to them again by itself. Show the list to a person, who checks the Africa's Talking dashboard.
- **Delivery reports** go to `server.js`, or to your own route handler built from `lib/dlr.js` the same way: check the token, parse the form body, store the status, answer 200.
