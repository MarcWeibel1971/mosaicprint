#!/usr/bin/env python3
"""
backfill-tile256.py – Upload 256px thumbnails to R2 for all existing LHQ tiles
                      that have a local source file but no tile256_url yet.

Usage:
  python3 scripts/backfill-tile256.py \
    --lhq-dir /home/ubuntu/data/lhq_1024_jpg \
    --workers 20

Strategy:
  1. Query DB for all LHQ tiles where tile256_url IS NULL and tile128_url IS NOT NULL
  2. For each tile, find the local LHQ source file by tile_id mapping
  3. Resize to 256x256 JPEG (quality 90) and upload to R2
  4. Update tile256_url in DB
"""

import os
import sys
import io
import threading
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
import psycopg2
from PIL import Image
from tqdm import tqdm

# ── Config ────────────────────────────────────────────────────────────────────
DATABASE_URL         = os.environ.get("DATABASE_URL", "")
R2_ACCOUNT_ID        = os.environ.get("R2_ACCOUNT_ID",        "3c6cf2572af3074af502ba34849a7408")
R2_ACCESS_KEY_ID     = os.environ.get("R2_ACCESS_KEY_ID",     "80d1c766ace5c7290a95af28b0b6b2d7")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY",
                       "e622fcf66644172f20612718b2d1bf6763886650db0e49a996a45ff93e138e97")
R2_BUCKET_NAME       = os.environ.get("R2_BUCKET_NAME",       "mosaicprint-tiles")
R2_PUBLIC_URL        = os.environ.get("R2_PUBLIC_URL",        "https://tiles.mosaicprint.ch").rstrip("/")

# ── Thread-local storage ──────────────────────────────────────────────────────
_r2_local = threading.local()
_db_local = threading.local()

def get_r2():
    if not hasattr(_r2_local, "client"):
        _r2_local.client = boto3.client(
            "s3",
            endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            region_name="auto",
        )
    return _r2_local.client

def get_db(dsn: str):
    if not hasattr(_db_local, "conn") or _db_local.conn.closed:
        _db_local.conn = psycopg2.connect(dsn)
        _db_local.conn.autocommit = False
    return _db_local.conn

# ── Helpers ───────────────────────────────────────────────────────────────────

def find_lhq_file(lhq_dir: str, tile_id: int) -> str | None:
    """Find the local LHQ source file for a given tile_id.
    
    LHQ files are named like 000001.jpg, 000002.jpg, etc.
    The tile_id in the DB corresponds to the LHQ image number stored in source_url.
    We look up the source_url to get the original filename.
    """
    return None  # Will be resolved via source_url lookup below


def upload_256(tile_id: int, source_path: str, dsn: str) -> bool:
    """Resize source image to 256px and upload to R2, then update DB."""
    try:
        with Image.open(source_path) as img:
            img = img.convert("RGB")
            img = img.resize((256, 256), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=90, optimize=True)
            buf.seek(0)
        
        key = f"tiles/256/{tile_id}.jpg"
        r2 = get_r2()
        r2.put_object(
            Bucket=R2_BUCKET_NAME,
            Key=key,
            Body=buf.getvalue(),
            ContentType="image/jpeg",
            CacheControl="public, max-age=31536000",
        )
        tile256_url = f"{R2_PUBLIC_URL}/{key}"
        
        # Update DB
        conn = get_db(dsn)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE mosaic_images SET tile256_url = %s WHERE id = %s",
                (tile256_url, tile_id)
            )
        conn.commit()
        return True
    except Exception as e:
        print(f"\n  ⚠️  tile {tile_id}: {e}", flush=True)
        return False


def main():
    parser = argparse.ArgumentParser(description="Backfill tile256_url for LHQ tiles")
    parser.add_argument("--lhq-dir", default="/home/ubuntu/data/lhq_1024_jpg",
                        help="Directory containing LHQ 1024px JPEG files")
    parser.add_argument("--workers", type=int, default=20,
                        help="Number of parallel workers")
    parser.add_argument("--limit", type=int, default=0,
                        help="Limit number of tiles to process (0 = all)")
    args = parser.parse_args()

    dsn = DATABASE_URL
    if not dsn:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    lhq_dir = args.lhq_dir
    if not os.path.isdir(lhq_dir):
        print(f"ERROR: LHQ directory not found: {lhq_dir}", file=sys.stderr)
        sys.exit(1)

    # ── Build LHQ filename index ───────────────────────────────────────────────
    print(f"📂 Scanning LHQ directory: {lhq_dir}", flush=True)
    lhq_files: dict[str, str] = {}  # basename (without ext) → full path
    # LHQ files are in a 'dataset' subdirectory
    search_dirs = [lhq_dir, os.path.join(lhq_dir, 'dataset')]
    for search_dir in search_dirs:
        if not os.path.isdir(search_dir):
            continue
        for fname in os.listdir(search_dir):
            if fname.lower().endswith((".jpg", ".jpeg", ".png")):
                stem = os.path.splitext(fname)[0]
                lhq_files[stem] = os.path.join(search_dir, fname)
    print(f"  Found {len(lhq_files):,} local LHQ files", flush=True)

    # ── Query DB for tiles needing tile256_url ─────────────────────────────────
    print("🔍 Querying DB for LHQ tiles without tile256_url...", flush=True)
    conn = psycopg2.connect(dsn)
    with conn.cursor() as cur:
        query = """
            SELECT id, source_url
            FROM mosaic_images
            WHERE source_provider = 'lhq'
              AND tile256_url IS NULL
              AND tile128_url IS NOT NULL
            ORDER BY id ASC
        """
        if args.limit > 0:
            query += f" LIMIT {args.limit}"
        cur.execute(query)
        rows = cur.fetchall()
    conn.close()

    print(f"  Found {len(rows):,} LHQ tiles without tile256_url", flush=True)
    if not rows:
        print("✅ Nothing to do – all LHQ tiles already have tile256_url", flush=True)
        return

    # ── Match tile IDs to local files via source_url ───────────────────────────
    # source_url format: e.g. "lhq:000001" or a URL containing the filename
    tasks: list[tuple[int, str]] = []
    skipped = 0
    for tile_id, source_url in rows:
        # Extract filename stem from source_url
        # Possible formats:
        #   "lhq:000001"
        #   "/path/to/000001.jpg"
        #   "https://...000001.jpg"
        stem = None
        if source_url:
            # Try to extract numeric stem
            import re
            # source_url format: 'lhq://85228.jpg' (5-digit number)
            m = re.search(r'(\d{4,6})', str(source_url))
            if m:
                stem = m.group(1)
        
        if stem and stem in lhq_files:
            tasks.append((tile_id, lhq_files[stem]))
        else:
            # Try different zero-padding variants (LHQ uses 5-digit names: 42008.jpg)
            found = False
            if stem:
                # Try stripping leading zeros (e.g. '042008' -> '42008')
                stripped = stem.lstrip('0') or '0'
                if stripped in lhq_files:
                    tasks.append((tile_id, lhq_files[stripped]))
                    found = True
                else:
                    for pad in [5, 6, 4, 7]:
                        padded = stem.lstrip('0').zfill(pad) if stem.lstrip('0') else '0'.zfill(pad)
                        if padded in lhq_files:
                            tasks.append((tile_id, lhq_files[padded]))
                            found = True
                            break
            if not found:
                skipped += 1

    print(f"  Matched {len(tasks):,} tiles to local files ({skipped} skipped – no local file)", flush=True)
    if not tasks:
        print("⚠️  No tasks to process", flush=True)
        return

    # ── Process in parallel ────────────────────────────────────────────────────
    print(f"🚀 Starting upload with {args.workers} parallel workers...", flush=True)
    updated = 0
    failed = 0

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(upload_256, tid, path, dsn): tid for tid, path in tasks}
        with tqdm(total=len(tasks), unit="tile", dynamic_ncols=True) as pbar:
            for future in as_completed(futures):
                ok = future.result()
                if ok:
                    updated += 1
                else:
                    failed += 1
                pbar.set_postfix(updated=updated, failed=failed)
                pbar.update(1)

    print(f"\n✅ Done: {updated:,} tile256_url uploaded, {failed:,} failed", flush=True)


if __name__ == "__main__":
    main()
