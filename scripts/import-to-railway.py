#!/usr/bin/env python3
"""Import all tiles from TiDB Cloud into Railway PostgreSQL."""
import mysql.connector
import psycopg2
import psycopg2.extras
import os
import sys

TIDB_URL = os.environ.get("TIDB_URL", "")
RAILWAY_URL = "postgresql://postgres:tefqgEojwfidKfEluQNlqOQeEArcQCEv@interchange.proxy.rlwy.net:24827/railway"
BATCH_SIZE = 500

def main():
    # Connect to TiDB
    print("Connecting to TiDB...")
    tidb = mysql.connector.connect(
        host=os.environ.get("TIDB_HOST", ""),
        port=int(os.environ.get("TIDB_PORT", "4000")),
        user=os.environ.get("TIDB_USER", ""),
        password=os.environ.get("TIDB_PASSWORD", ""),
        database=os.environ.get("TIDB_DATABASE", ""),
        ssl_ca=None,
        ssl_disabled=False,
    )
    cursor = tidb.cursor(dictionary=True)
    
    # Get total count
    cursor.execute("SELECT COUNT(*) as cnt FROM mosaic_images")
    total = cursor.fetchone()["cnt"]
    print(f"Total tiles in TiDB: {total}")
    
    # Connect to Railway PostgreSQL
    print("Connecting to Railway PostgreSQL...")
    pg = psycopg2.connect(RAILWAY_URL)
    pg_cur = pg.cursor()
    
    # Import in batches
    offset = 0
    imported = 0
    
    while offset < total:
        cursor.execute(f"""
            SELECT source_url, tile128_url, avg_l, avg_a, avg_b,
                   tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
                   bl_l, bl_a, bl_b, br_l, br_a, br_b
            FROM mosaic_images ORDER BY id ASC LIMIT {BATCH_SIZE} OFFSET {offset}
        """)
        rows = cursor.fetchall()
        if not rows:
            break
        
        data = [(
            r["source_url"], r["tile128_url"],
            r["avg_l"], r["avg_a"], r["avg_b"],
            r["tl_l"], r["tl_a"], r["tl_b"],
            r["tr_l"], r["tr_a"], r["tr_b"],
            r["bl_l"], r["bl_a"], r["bl_b"],
            r["br_l"], r["br_a"], r["br_b"],
        ) for r in rows]
        
        psycopg2.extras.execute_values(pg_cur, """
            INSERT INTO mosaic_images 
              (source_url, tile128_url, avg_l, avg_a, avg_b,
               tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
               bl_l, bl_a, bl_b, br_l, br_a, br_b)
            VALUES %s
            ON CONFLICT DO NOTHING
        """, data)
        pg.commit()
        
        imported += len(rows)
        offset += BATCH_SIZE
        print(f"  Imported: {imported}/{total}", end="\r", flush=True)
    
    print(f"\nDone! Imported {imported} tiles into Railway PostgreSQL.")
    
    # Verify
    pg_cur.execute("SELECT COUNT(*) FROM mosaic_images")
    count = pg_cur.fetchone()[0]
    print(f"Verified: {count} tiles in Railway DB")
    
    pg.close()
    tidb.close()

if __name__ == "__main__":
    main()
