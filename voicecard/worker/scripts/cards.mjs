// Card administration against D1 (the Workers counterpart of voicecard/cli.py).
//
//   npm run cards -- mint -n 20 --base-url https://voice.example.com [--batch 2026-10] [-o cards.csv] [--local]
//   npm run cards -- list [--local]
//   npm run cards -- unclaim <card_id> [--local]   release ownership (e.g. owner lost their account)
//   npm run cards -- revoke <card_id> [--local]    disable a card whose URL leaked
//
// Minted URLs are printed once and never stored (only their hashes are), so keep the
// CSV until the URLs are written to the NFC tags, then delete it.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const DB = "voicecard-db";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    count: { type: "string", short: "n", default: "1" },
    "base-url": { type: "string" },
    batch: { type: "string", default: new Date().toISOString().slice(0, 7) },
    output: { type: "string", short: "o" },
    local: { type: "boolean", default: false },
  },
});

function d1(args) {
  const where = opts.local ? "--local" : "--remote";
  const out = execFileSync("npx", ["wrangler", "d1", "execute", DB, where, "--json", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out).flatMap((r) => r.results ?? []);
}

const sql = (command) => d1(["--command", command]);
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function mint() {
  const base = (opts["base-url"] ?? "").replace(/\/$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("需要 --base-url，例如 https://voice.example.com");
  const count = Number(opts.count);
  const now = Date.now() / 1000;
  const tokens = Array.from({ length: count }, () => randomBytes(16).toString("base64url"));
  const inserts = tokens.map(
    (t) =>
      `INSERT INTO cards (token_hash, batch, created_at) VALUES (${quote(createHash("sha256").update(t).digest("hex"))}, ${quote(opts.batch)}, ${now});`,
  );
  const dir = mkdtempSync(join(tmpdir(), "voicecard-"));
  try {
    const file = join(dir, "mint.sql");
    writeFileSync(file, inserts.join("\n"));
    d1(["--file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const csv = ["url", ...tokens.map((t) => `${base}/c/${t}`)].join("\n") + "\n";
  if (opts.output) {
    writeFileSync(opts.output, csv);
    console.error(`已生成 ${count} 张卡片 → ${opts.output}`);
  } else {
    process.stdout.write(csv);
  }
}

function list() {
  const rows = sql(
    "SELECT cards.id, cards.batch, cards.title, cards.revoked, users.username AS owner, " +
      "(SELECT COUNT(*) FROM messages WHERE messages.card_id = cards.id) AS msgs " +
      "FROM cards LEFT JOIN users ON users.id = cards.owner_id ORDER BY cards.id",
  );
  console.table(
    rows.map((r) => ({
      id: r.id,
      batch: r.batch,
      status: r.revoked ? "revoked" : r.owner ? "claimed" : "new",
      owner: r.owner ?? "-",
      msgs: r.msgs,
      title: r.title,
    })),
  );
}

function update(statement, done) {
  const id = Number(positionals[1]);
  if (!Number.isInteger(id)) throw new Error("需要卡片编号，例如 unclaim 3");
  const rows = sql(`${statement} WHERE id = ${id} RETURNING id`);
  console.log(rows.length ? done : "卡片不存在");
}

const commands = {
  mint,
  list,
  unclaim: () => update("UPDATE cards SET owner_id = NULL, claimed_at = NULL", "已解除认领"),
  revoke: () => update("UPDATE cards SET revoked = 1", "已停用"),
};

const command = commands[positionals[0]];
if (!command) {
  console.error("用法: npm run cards -- <mint|list|unclaim|revoke> …（见 scripts/cards.mjs 顶部说明）");
  process.exit(1);
}
command();
