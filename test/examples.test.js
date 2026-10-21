import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the Next.js example answers Vercel cron's GET and refuses when CRON_SECRET is unset", async () => {
  const md = await readFile(new URL("../examples/next-route-handler.md", import.meta.url), "utf8");
  assert.match(md, /export async function GET\(request\)/);
  assert.match(md, /export async function POST\(request\)/);
  assert.match(md, /if \(!secret \|\| request\.headers\.get\("authorization"\) !== `Bearer \$\{secret\}`\)/);
});
