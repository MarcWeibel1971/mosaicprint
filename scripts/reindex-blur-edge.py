"""
reindex-blur-edge.py – Nachberechnung von blur_score und edge_energy für alle Tiles in der DB.

Für Tiles mit R2-URL: Bild von R2 herunterladen, Features berechnen, DB updaten.
Für LHQ-Tiles: Bild aus lokalem Verzeichnis laden (falls vorhanden).

Usage:
  python3 scripts/reindex-blur-edge.py [--lhq-dir /path/to/lhq_1024_jpg] [--batch N] [--limit N]

Examples:
  # Alle Tiles reindexieren (lädt von R2)
  python3 scripts/reindex-blur-edge.py --batch 20

  # LHQ-Tiles aus lokalem Verzeichnis (schneller, keine Downloads)
  python3 scripts/reindex-blur-edge.py --lhq-dir /home/ubuntu/data/lhq_1024_jpg --batch 30
"""

import os
import sys
import math
import time
import io
import argparse
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import psycopg2
import requests
from PIL import Image
from tqdm import tqdm

# ── Credentials ────────────────────────────────────────────────────────────────
DATABASE_URL = os.environ.get("DATABASE_URL",
    "postgresql://postgres:pyoancyKSzLOcqsCwbEybfcKVvbkRivE@nozomi.proxy.rlwy.net:57735/railway")

# ── Thread-local DB connections ────────────────────────────────────────────────
_thread_local = threading.local()

def get_thread_conn():
    if not hasattr(_thread_local, "conn") or _thread_local.conn.closed:
        _thread_local.conn = psycopg2.connect(DATABASE_URL, sslmode="require")
    return _thread_local.conn


# ── Feature computation ────────────────────────────────────────────────────────
def compute_blur_and_edge(img: Image.Image) -> tuple[float, float]:
    """
    Compute blur_score and edge_energy from a PIL Image.

    Returns:
      blur_score  – Laplacian variance on 128x128 (higher = sharper, 0 = blurry)
      edge_energy – Sobel magnitude on 64x64, normalized 0-1
    """
    img = img.convert("RGB")

    # ── edge_energy: Sobel on 64x64 ──────────────────────────────────────────
    SIZE = 64
    gray64 = img.resize((SIZE, SIZE), Image.LANCZOS).convert("L")
    g64 = list(gray64.getdata())

    def idx64(r, c): return g64[r * SIZE + c]

    sobel_sum = 0
    sobel_count = 0
    for y in range(1, SIZE - 1):
        for x in range(1, SIZE - 1):
            gx = (-idx64(y-1,x-1) + idx64(y-1,x+1)
                  - 2*idx64(y,x-1) + 2*idx64(y,x+1)
                  - idx64(y+1,x-1) + idx64(y+1,x+1))
            gy = (-idx64(y-1,x-1) - 2*idx64(y-1,x) - idx64(y-1,x+1)
                  + idx64(y+1,x-1) + 2*idx64(y+1,x) + idx64(y+1,x+1))
            sobel_sum += math.sqrt(gx*gx + gy*gy)
            sobel_count += 1

    raw_edge = sobel_sum / sobel_count if sobel_count else 0
    edge_energy = raw_edge / 1442.0  # normalize to 0-1

    # ── blur_score: Laplacian variance on 128x128 ─────────────────────────────
    BLUR_SIZE = 128
    gray128 = img.resize((BLUR_SIZE, BLUR_SIZE), Image.LANCZOS).convert("L")
    g128 = list(gray128.getdata())

    def idx128(r, c): return g128[r * BLUR_SIZE + c]

    lap_vals = []
    for y in range(1, BLUR_SIZE - 1):
        for x in range(1, BLUR_SIZE - 1):
            lap = (idx128(y-1,x) + idx128(y+1,x) + idx128(y,x-1) + idx128(y,x+1)
                   - 4 * idx128(y,x))
            lap_vals.append(lap)

    if lap_vals:
        mean_lap = sum(lap_vals) / len(lap_vals)
        variance = sum((v - mean_lap)**2 for v in lap_vals) / len(lap_vals)
        blur_score = math.sqrt(variance)
    else:
        blur_score = 0.0

    return blur_score, edge_energy


def load_image_from_url(url: str, timeout: int = 10) -> Image.Image | None:
    """Download image from URL and return PIL Image."""
    try:
        resp = requests.get(url, timeout=timeout, stream=True)
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content))
    except Exception:
        return None


def load_image_from_lhq(source_url: str, lhq_dir: Path) -> Image.Image | None:
    """Load LHQ image from local directory given source_url like 'lhq://00000.jpg'."""
    if not source_url.startswith("lhq://"):
        return None
    filename = source_url[len("lhq://"):]
    path = lhq_dir / filename
    if path.exists():
        try:
            return Image.open(str(path))
        except Exception:
            return None
    return None


def update_tile(tile_id: int, blur_score: float, edge_energy: float):
    """Update blur_score and edge_energy in DB."""
    conn = get_thread_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE mosaic_images SET blur_score=%s, edge_energy=%s WHERE id=%s",
                (blur_score, edge_energy, tile_id)
            )
            conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass
        _thread_local.conn = None


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Reindex blur_score and edge_energy for all tiles")
    parser.add_argument("--lhq-dir", type=str, default="",
                        help="Local LHQ image directory (faster for LHQ tiles)")
    parser.add_argument("--batch",   type=int, default=20,
                        help="Parallel workers (default: 20)")
    parser.add_argument("--limit",   type=int, default=0,
                        help="Max tiles to process (0 = all)")
    parser.add_argument("--provider", type=str, default="",
                        help="Only process tiles from this provider (e.g. lhq, pexels)")
    parser.add_argument("--missing-only", action="store_true",
                        help="Only process tiles where blur_score IS NULL")
    args = parser.parse_args()

    lhq_dir = Path(args.lhq_dir) if args.lhq_dir else None

    # Load tiles from DB
    print(f"🔌 Connecting to PostgreSQL...")
    conn = psycopg2.connect(DATABASE_URL, sslmode="require")
    cur = conn.cursor()

    where_clauses = []
    if args.missing_only:
        where_clauses.append("blur_score IS NULL")
    if args.provider:
        where_clauses.append(f"source_provider = '{args.provider}'")

    where_sql = "WHERE " + " AND ".join(where_clauses) if where_clauses else ""
    limit_sql = f"LIMIT {args.limit}" if args.limit > 0 else ""

    cur.execute(f"""
        SELECT id, source_url, tile128_url, source_provider
        FROM mosaic_images
        {where_sql}
        ORDER BY id
        {limit_sql}
    """)
    rows = cur.fetchall()
    conn.close()

    print(f"✅ Found {len(rows)} tiles to reindex")
    if lhq_dir:
        print(f"📁 LHQ local dir: {lhq_dir}")

    updated = 0
    failed  = 0
    start_time = time.time()

    def process_one(row) -> str:
        tile_id, source_url, tile128_url, provider = row

        img = None

        # Try local LHQ directory first (much faster)
        if lhq_dir and provider == "lhq":
            img = load_image_from_lhq(source_url, lhq_dir)

        # Fallback: download from R2/URL
        if img is None and tile128_url:
            img = load_image_from_url(tile128_url)

        if img is None:
            return "failed"

        try:
            blur_score, edge_energy = compute_blur_and_edge(img)
            update_tile(tile_id, blur_score, edge_energy)
            return "updated"
        except Exception:
            return "failed"

    print(f"\n🚀 Starting reindex with {args.batch} parallel workers...\n")

    with tqdm(total=len(rows), unit="tile", dynamic_ncols=True) as pbar:
        with ThreadPoolExecutor(max_workers=args.batch) as executor:
            futures = {executor.submit(process_one, row): row for row in rows}
            for future in as_completed(futures):
                result = future.result()
                if result == "updated":
                    updated += 1
                else:
                    failed += 1
                pbar.set_postfix(updated=updated, failed=failed)
                pbar.update(1)

    elapsed = time.time() - start_time
    print(f"\n✅ Reindex complete!")
    print(f"   Updated: {updated}")
    print(f"   Failed:  {failed}")
    print(f"   Time:    {elapsed:.0f}s ({elapsed/max(1,len(rows)):.2f}s/tile)")


if __name__ == "__main__":
    main()
