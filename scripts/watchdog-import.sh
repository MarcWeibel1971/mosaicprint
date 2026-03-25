#!/bin/bash
# Watchdog für LHQ-Import: prüft alle 5 Minuten, startet bei Absturz neu
# Nach Abschluss: Railway-Backup erstellen

DATABASE_URL="postgresql://postgres:pyoancyKSzLOcqsCwbEybfcKVvbkRivE@nozomi.proxy.rlwy.net:57735/railway"
SCRIPT_DIR="/home/ubuntu/mosaicprint-repo"
IMAGE_DIR="/home/ubuntu/data/lhq_1024_jpg/dataset"
LOG="/tmp/lhq_watchdog.log"
IMPORT_LOG="/tmp/lhq_import_v6.log"
TOTAL=90000
BATCH=20

export DATABASE_URL

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG"
}

count_lhq() {
  python3 -c "
import psycopg2
try:
    conn = psycopg2.connect('$DATABASE_URL', connect_timeout=10)
    cur = conn.cursor()
    cur.execute(\"SELECT COUNT(*) FROM mosaic_images WHERE source_provider='lhq'\")
    print(cur.fetchone()[0])
    conn.close()
except Exception as e:
    print(0)
" 2>/dev/null
}

start_import() {
  log "▶ Starte LHQ-Import (batch=$BATCH)..."
  cd "$SCRIPT_DIR"
  nohup bash -c "python3 scripts/import-lhq.py $IMAGE_DIR --batch $BATCH 2>&1 | tee -a $IMPORT_LOG" > /dev/null 2>&1 &
  echo $!
}

log "=== Watchdog gestartet ==="

while true; do
  # Prüfen ob Import-Prozess läuft
  RUNNING=$(ps aux | grep "import-lhq.py" | grep -v grep | wc -l)

  if [ "$RUNNING" -eq 0 ]; then
    # Prozess nicht aktiv – prüfen ob fertig
    COUNT=$(count_lhq)
    log "Import-Prozess nicht aktiv. LHQ in DB: $COUNT / $TOTAL"

    if [ "$COUNT" -ge "$TOTAL" ]; then
      log "✅ Import abgeschlossen! $COUNT LHQ-Tiles in DB."
      log "🗄 Erstelle Railway-Backup..."
      cd "$SCRIPT_DIR"
      railway backup 2>&1 | tee -a "$LOG" || log "⚠️ Railway-Backup fehlgeschlagen – bitte manuell erstellen."
      log "=== Watchdog beendet ==="
      exit 0
    else
      log "⚠️ Import abgestürzt bei $COUNT/$TOTAL – starte neu..."
      PID=$(start_import)
      log "Neuer PID: $PID"
    fi
  else
    COUNT=$(count_lhq)
    PCT=$(( COUNT * 100 / TOTAL ))
    log "✓ Import läuft. LHQ: $COUNT/$TOTAL ($PCT%)"
  fi

  sleep 300  # 5 Minuten warten
done
