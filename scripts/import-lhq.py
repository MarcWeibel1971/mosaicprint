"""
import-lhq.py – Import LHQ-1024 landscape images into MosaicPrint DB + Cloudflare R2.

Improvements v2:
  - blur_score now written to DB (was computed but never stored)
  - edge_energy computed on 64x64 (was 16x16 – too coarse)
  - tile256_url uploaded to R2 (256px JPEG for better mosaic quality)
  - mosaic_score formula updated to use normalized edge_energy

Usage:
  python3 scripts/import-lhq.py <image_dir> [--limit N] [--skip N] [--batch N]

Example:
  python3 scripts/import-lhq.py ./data/lhq_1024_jpg --limit 1000 --batch 20
"""

import os
import sys
import math
import time
import argparse
import io
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import psycopg2
import psycopg2.extras
import boto3
from botocore.config import Config
from PIL import Image
from tqdm import tqdm

# ── Credentials from Railway env ──────────────────────────────────────────────
DATABASE_URL = os.environ.get("DATABASE_URL",
    "postgresql://postgres:tefqgEojwfidKfEluQNlqOQeEArcQCEv@interchange.proxy.rlwy.net:24827/railway")
R2_ACCOUNT_ID        = os.environ.get("R2_ACCOUNT_ID",        "3c6cf2572af3074af502ba34849a7408")
R2_ACCESS_KEY_ID     = os.environ.get("R2_ACCESS_KEY_ID",     "80d1c766ace5c7290a95af28b0b6b2d7")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY",
    "e622fcf66644172f20612718b2d1bf6763886650db0e49a996a45ff93e138e97")
R2_BUCKET_NAME       = os.environ.get("R2_BUCKET_NAME",       "mosaicprint-tiles")
R2_PUBLIC_URL        = os.environ.get("R2_PUBLIC_URL",        "https://tiles.mosaicprint.ch").rstrip("/")

# ── Thread-local storage for DB connections and R2 clients ────────────────────
_thread_local = threading.local()

def get_thread_conn():
    """Get or create a per-thread DB connection."""
    if not hasattr(_thread_local, "conn") or _thread_local.conn.closed:
        _thread_local.conn = psycopg2.connect(DATABASE_URL, sslmode="require")
    return _thread_local.conn

def close_thread_conn():
    """Close the per-thread DB connection if open."""
    if hasattr(_thread_local, "conn") and not _thread_local.conn.closed:
        _thread_local.conn.close()

# ── LAB conversion helpers ─────────────────────────────────────────────────────
def srgb_to_linear(c: float) -> float:
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def rgb_to_lab(r: int, g: int, b: int):
    """Convert single RGB pixel to CIE L*a*b*."""
    rl = srgb_to_linear(r)
    gl = srgb_to_linear(g)
    bl = srgb_to_linear(b)
    X = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375
    Y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750
    Z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041
    X /= 0.95047; Z /= 1.08883
    def f(t):
        return t ** (1/3) if t > 0.008856 else 7.787 * t + 16/116
    fx, fy, fz = f(X), f(Y), f(Z)
    L = 116 * fy - 16
    a = 500 * (fx - fy)
    b_ = 200 * (fy - fz)
    return L, a, b_

def pixels_to_avg_lab(pixels):
    """Average LAB over a list of (r,g,b) tuples."""
    if not pixels:
        return 50.0, 0.0, 0.0
    Ls, As, Bs = [], [], []
    for r, g, b in pixels:
        L, a, b_ = rgb_to_lab(r, g, b)
        Ls.append(L); As.append(a); Bs.append(b_)
    return sum(Ls)/len(Ls), sum(As)/len(As), sum(Bs)/len(Bs)


def compute_features(img_path: str) -> dict | None:
    """
    Compute all tile features from a local image file.

    Returns dict with:
      - avg/quadrant LAB values
      - edge_energy  (Sobel on 64x64, normalized 0-1)
      - blur_score   (Laplacian variance on 128x128, higher = sharper)
      - tile_type, mosaic_score, phash
    """
    try:
        img = Image.open(img_path).convert("RGB")
    except Exception:
        return None

    # ── 8x8 for LAB quadrants ──────────────────────────────────────────────────
    small = img.resize((8, 8), Image.LANCZOS)
    px = list(small.getdata())

    avg_L, avg_a, avg_b = pixels_to_avg_lab(px)

    def quad(sx, sy):
        return [px[y*8+x] for y in range(sy, sy+4) for x in range(sx, sx+4)]

    tl_L, tl_a, tl_b = pixels_to_avg_lab(quad(0, 0))
    tr_L, tr_a, tr_b = pixels_to_avg_lab(quad(4, 0))
    bl_L, bl_a, bl_b = pixels_to_avg_lab(quad(0, 4))
    br_L, br_a, br_b = pixels_to_avg_lab(quad(4, 4))

    # ── 64x64 Sobel edge detection (improved from 16x16) ──────────────────────
    # Using 64x64 gives 16x more pixels → much more reliable edge_energy
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

    # Normalize: max Sobel magnitude per pixel is ~1442 (255*sqrt(32))
    # Divide by 1442 to get 0-1 range
    raw_edge = sobel_sum / sobel_count if sobel_count else 0
    edge_energy = raw_edge / 1442.0  # normalized 0-1

    # ── Blur detection: Laplacian variance on 128x128 ─────────────────────────
    # Higher variance = sharper image. Typical range: 0 (blurry) to ~2000 (very sharp)
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
        blur_score = math.sqrt(variance)  # 0 = blurry, ~50+ = sharp
    else:
        blur_score = 0.0

    # ── Tile type classification ───────────────────────────────────────────────
    chroma = math.sqrt(avg_a**2 + avg_b**2)
    if avg_L < 20:
        tile_type = "dark"
    elif avg_L > 85:
        tile_type = "bright"
    elif chroma > 30:
        tile_type = "colorful"
    else:
        tile_type = "neutral"

    # ── Mosaic score (0-100, higher = better for mosaics) ─────────────────────
    # blur_score: normalize to 0-1 (typical max ~100 for very sharp images)
    # edge_energy: already 0-1
    # chroma: normalize to 0-1 (typical max ~60)
    blur_norm  = min(1.0, blur_score / 80.0)
    edge_norm  = min(1.0, edge_energy / 0.15)  # 0.15 ≈ typical "busy" image
    chroma_norm = min(1.0, chroma / 40.0)

    mosaic_score = min(1.0, (
        0.4 * blur_norm +
        0.3 * edge_norm +
        0.3 * chroma_norm
    ))

    # ── pHash (8x8 average hash) ───────────────────────────────────────────────
    gray8 = img.resize((8, 8), Image.LANCZOS).convert("L")
    g8 = list(gray8.getdata())
    mean_g8 = sum(g8) / len(g8)
    bits = [1 if v >= mean_g8 else 0 for v in g8]
    phash_int = int("".join(str(b) for b in bits), 2)
    phash = format(phash_int, '016x')

    return {
        "avg_L": avg_L, "avg_a": avg_a, "avg_b": avg_b,
        "tl_L": tl_L, "tl_a": tl_a, "tl_b": tl_b,
        "tr_L": tr_L, "tr_a": tr_a, "tr_b": tr_b,
        "bl_L": bl_L, "bl_a": bl_a, "bl_b": bl_b,
        "br_L": br_L, "br_a": br_a, "br_b": br_b,
        "edge_energy": edge_energy,
        "blur_score": blur_score,
        "tile_type": tile_type,
        "mosaic_score": mosaic_score,
        "phash": phash,
    }


# ── R2 helpers ─────────────────────────────────────────────────────────────────
def make_r2_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
        config=Config(
            signature_version="s3v4",
            retries={"max_attempts": 3, "mode": "adaptive"},
        ),
    )

_r2_local = threading.local()

def get_thread_r2():
    """Get or create a per-thread R2 client."""
    if not hasattr(_r2_local, "client"):
        _r2_local.client = make_r2_client()
    return _r2_local.client


def upload_tiles_to_r2(tile_id: int, img_path: str) -> tuple[str | None, str | None]:
    """
    Upload 128px and 256px thumbnails to R2.
    Returns (tile128_url, tile256_url) – either may be None on failure.
    """
    try:
        r2 = get_thread_r2()
        img = Image.open(img_path).convert("RGB")

        results = {}
        for size, key_suffix in [(128, "tiles"), (256, "tiles256")]:
            resized = img.copy()
            resized.thumbnail((size, size), Image.LANCZOS)
            buf = io.BytesIO()
            resized.save(buf, format="JPEG", quality=88, optimize=True)
            buf.seek(0)
            key = f"{key_suffix}/{tile_id}.jpg"
            r2.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=key,
                Body=buf.getvalue(),
                ContentType="image/jpeg",
                CacheControl="public, max-age=31536000, immutable",
            )
            results[size] = f"{R2_PUBLIC_URL}/{key}"

        return results.get(128), results.get(256)
    except Exception as e:
        print(f"  ⚠️  R2 upload failed for tile {tile_id}: {e}", flush=True)
        return None, None


# ── DB helpers ─────────────────────────────────────────────────────────────────
def derive_semantic_theme(avg_L, avg_a, avg_b, tile_type):
    """Simple semantic theme derivation matching server logic."""
    chroma = math.sqrt(avg_a**2 + avg_b**2)
    if avg_L < 25:
        return "night"
    if avg_L > 80 and chroma < 15:
        return "bright"
    if avg_b > 15 and avg_L > 50:
        return "sky"
    if avg_a < -5 and avg_b > 5:
        return "nature"
    if avg_b < -5:
        return "water"
    if avg_a > 5 and avg_b > 5 and avg_L < 60:
        return "warm"
    return "general"


def insert_image(img_path: str, lab: dict) -> tuple[bool, int | None]:
    """Insert image into DB using thread-local connection. Returns (inserted, id)."""
    source_url = f"lhq://{Path(img_path).name}"
    theme = "landscape"
    semantic_theme = derive_semantic_theme(lab["avg_L"], lab["avg_a"], lab["avg_b"], lab["tile_type"])
    mosaic_score_int = round(lab["mosaic_score"] * 100)

    conn = get_thread_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO mosaic_images
                  (source_url, tile128_url, r2_url,
                   avg_l, avg_a, avg_b,
                   tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
                   bl_l, bl_a, bl_b, br_l, br_a, br_b,
                   subject, theme, source_provider, import_query,
                   url_hash, imported_at,
                   tile_type, semantic_theme, edge_energy,
                   blur_score, phash, ai_mosaic_score, quality_status)
                VALUES
                  (%s, NULL, NULL,
                   %s, %s, %s,
                   %s, %s, %s, %s, %s, %s,
                   %s, %s, %s, %s, %s, %s,
                   %s, %s, %s, %s,
                   MD5(%s), NOW(),
                   %s, %s, %s,
                   %s, %s, %s, 'pending')
                ON CONFLICT (source_url) DO NOTHING
                RETURNING id
            """, (
                source_url,
                lab["avg_L"], lab["avg_a"], lab["avg_b"],
                lab["tl_L"], lab["tl_a"], lab["tl_b"],
                lab["tr_L"], lab["tr_a"], lab["tr_b"],
                lab["bl_L"], lab["bl_a"], lab["bl_b"],
                lab["br_L"], lab["br_a"], lab["br_b"],
                theme, theme, "lhq", "landscape",
                source_url,
                lab["tile_type"], semantic_theme, lab["edge_energy"],
                lab["blur_score"], lab["phash"], mosaic_score_int,
            ))
            row = cur.fetchone()
            conn.commit()
            if row:
                return True, row[0]
            return False, None
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
        raise e


def update_tile_urls(tile_id: int, tile128_url: str | None, tile256_url: str | None):
    """Update tile URLs in DB after R2 upload."""
    if not tile128_url and not tile256_url:
        return
    conn = get_thread_conn()
    try:
        with conn.cursor() as cur:
            if tile256_url:
                cur.execute(
                    "UPDATE mosaic_images SET tile128_url=%s, r2_url=%s, tile256_url=%s WHERE id=%s",
                    (tile128_url, tile128_url, tile256_url, tile_id)
                )
            else:
                cur.execute(
                    "UPDATE mosaic_images SET tile128_url=%s, r2_url=%s WHERE id=%s",
                    (tile128_url, tile128_url, tile_id)
                )
            conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Import LHQ landscape images into MosaicPrint (v2)")
    parser.add_argument("image_dir", help="Directory containing LHQ JPEG images")
    parser.add_argument("--limit",  type=int, default=0,  help="Max images to import (0 = all)")
    parser.add_argument("--skip",   type=int, default=0,  help="Skip first N images")
    parser.add_argument("--batch",  type=int, default=10, help="Parallel workers (default: 10)")
    args = parser.parse_args()

    image_dir = Path(args.image_dir)
    if not image_dir.exists():
        print(f"❌ Directory not found: {image_dir}")
        sys.exit(1)

    files = sorted(image_dir.glob("*.jpg")) + sorted(image_dir.glob("*.jpeg"))
    if not files:
        print(f"❌ No JPEG files found in {image_dir}")
        sys.exit(1)

    files = files[args.skip:]
    if args.limit > 0:
        files = files[:args.limit]

    print(f"📂 Found {len(files)} images to import (skip={args.skip}, limit={args.limit or 'all'})")

    # Test DB connection
    print(f"🔌 Connecting to PostgreSQL...")
    test_conn = psycopg2.connect(DATABASE_URL, sslmode="require")
    with test_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM mosaic_images WHERE source_provider = 'lhq'")
        existing = cur.fetchone()[0]
        # Check if tile256_url column exists
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='mosaic_images' AND column_name='tile256_url'
        """)
        has_tile256 = cur.fetchone() is not None
    test_conn.close()
    print(f"✅ Connected to DB (existing LHQ tiles: {existing}, tile256_url: {has_tile256})")

    # Test R2 connection
    print(f"☁️  Connecting to Cloudflare R2...")
    test_r2 = make_r2_client()
    test_r2.head_bucket(Bucket=R2_BUCKET_NAME)
    print(f"✅ R2 ready (bucket: {R2_BUCKET_NAME})")

    imported = 0
    skipped  = 0
    errors   = 0
    start_time = time.time()

    def process_one(img_path: Path) -> str:
        """Process a single image: compute features, insert into DB, upload to R2."""
        try:
            features = compute_features(str(img_path))
            if features is None:
                return "error"

            # Skip very blurry images (blur_score < 5 means essentially no detail)
            if features["blur_score"] < 5:
                return "skip"

            # Insert into DB to get tile ID
            inserted, tile_id = insert_image(str(img_path), features)
            if not inserted or tile_id is None:
                return "skip"  # duplicate

            # Upload 128px + 256px to R2
            t128, t256 = upload_tiles_to_r2(tile_id, str(img_path))
            update_tile_urls(tile_id, t128, t256)

            return "inserted"
        except Exception as e:
            return "error"

    print(f"\n🚀 Starting import v2 with {args.batch} parallel workers...\n")
    print(f"   Improvements: blur_score stored, edge_energy on 64x64, tile256 uploaded\n")

    with tqdm(total=len(files), unit="img", dynamic_ncols=True) as pbar:
        with ThreadPoolExecutor(max_workers=args.batch) as executor:
            futures = {executor.submit(process_one, f): f for f in files}
            for future in as_completed(futures):
                result = future.result()
                if result == "inserted":
                    imported += 1
                elif result == "skip":
                    skipped += 1
                elif result == "error":
                    errors += 1
                pbar.set_postfix(imported=imported, skipped=skipped, errors=errors)
                pbar.update(1)

    elapsed = time.time() - start_time
    per_img = elapsed / max(1, len(files))
    print(f"\n✅ Import v2 complete!")
    print(f"   Imported: {imported}")
    print(f"   Skipped:  {skipped} (duplicates/blurry)")
    print(f"   Errors:   {errors}")
    print(f"   Time:     {elapsed:.0f}s ({per_img:.2f}s/image)")


if __name__ == "__main__":
    main()
