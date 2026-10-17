"""Card administration.

  python cli.py mint -n 20 --base-url https://voice.example.com [--batch 2026-10] [-o cards.csv]
  python cli.py list
  python cli.py unclaim <card_id>     release ownership (e.g. owner lost their account)
  python cli.py revoke <card_id>      disable a card whose URL leaked

Minted URLs are printed once and never stored (only their hashes are), so keep the
CSV until the URLs are written to the NFC tags, then delete it.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from pathlib import Path

from db import Database
from security import hash_token, new_token

ROOT = Path(__file__).resolve().parent


def open_db() -> Database:
    data_dir = Path(os.environ.get("VOICECARD_DATA_DIR", str(ROOT / "data"))).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    return Database(data_dir / "voicecard.db")


def mint(args: argparse.Namespace) -> None:
    db = open_db()
    base = args.base_url.rstrip("/")
    out = open(args.output, "w", newline="") if args.output else sys.stdout
    writer = csv.writer(out)
    writer.writerow(["card_id", "url"])
    for _ in range(args.count):
        token = new_token()
        card_id = db.create_card(hash_token(token), args.batch)
        writer.writerow([card_id, f"{base}/c/{token}"])
    if args.output:
        out.close()
        print(f"已生成 {args.count} 张卡片 → {args.output}", file=sys.stderr)


def list_cards(_: argparse.Namespace) -> None:
    fmt = "{:>5}  {:<10} {:<8} {:<16} {:>4}  {}"
    print(fmt.format("id", "batch", "status", "owner", "msgs", "title"))
    for row in open_db().list_cards():
        status = "revoked" if row["revoked"] else ("claimed" if row["owner_name"] else "new")
        print(fmt.format(row["id"], row["batch"][:10], status, (row["owner_name"] or "-")[:16], row["messages"], row["title"]))


def unclaim(args: argparse.Namespace) -> None:
    ok = open_db().unclaim_card(args.card_id)
    print("已解除认领" if ok else "卡片不存在")


def revoke(args: argparse.Namespace) -> None:
    ok = open_db().revoke_card(args.card_id)
    print("已停用" if ok else "卡片不存在")


def main() -> None:
    parser = argparse.ArgumentParser(description="VoiceCard 卡片管理")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("mint", help="生成新卡片 URL")
    p.add_argument("-n", "--count", type=int, default=1)
    p.add_argument("--base-url", required=True, help="例如 https://voice.example.com")
    p.add_argument("--batch", default=time.strftime("%Y-%m"), help="批次备注")
    p.add_argument("-o", "--output", help="输出 CSV 文件（默认打印到终端）")
    p.set_defaults(func=mint)

    sub.add_parser("list", help="列出卡片（不含 URL）").set_defaults(func=list_cards)

    p = sub.add_parser("unclaim", help="解除认领")
    p.add_argument("card_id", type=int)
    p.set_defaults(func=unclaim)

    p = sub.add_parser("revoke", help="停用卡片")
    p.add_argument("card_id", type=int)
    p.set_defaults(func=revoke)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
