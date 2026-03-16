#!/bin/bash
# Batch import light/neutral tiles for better white hair portrait matching
BASE="https://mosaicprint-production.up.railway.app/api/trpc/targetedImport"

import_tile() {
  local source="$1"
  local query="$2"
  local count="${3:-80}"
  echo -n "[$source] $query: "
  result=$(curl -s "$BASE" -X POST -H "Content-Type: application/json" \
    -d "{\"sourceId\":\"$source\",\"query\":\"$query\",\"count\":$count}" 2>/dev/null)
  started=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('data',{}).get('started','FAIL'))" 2>/dev/null)
  echo "$started"
  sleep 3
}

# Pexels - light/white focused
import_tile pexels "bright studio portrait" 80
import_tile pexels "high key photography" 80
import_tile pexels "white background product" 80
import_tile pexels "bright white room" 80
import_tile pexels "white cat fluffy" 80
import_tile pexels "snow field winter" 80
import_tile pexels "white dress bride" 80
import_tile pexels "bright window light" 80
import_tile pexels "white ceramic pottery" 80
import_tile pexels "light skin face closeup" 80

# Unsplash - light/white focused
import_tile unsplash "white architecture minimal" 80
import_tile unsplash "bright sunlight portrait" 80
import_tile unsplash "pale skin beauty" 80
import_tile unsplash "white flowers bouquet" 80
import_tile unsplash "bright pastel colors" 80
import_tile unsplash "light beige wall" 80
import_tile unsplash "cream coffee latte" 80
import_tile unsplash "white cotton sheets" 80
import_tile unsplash "bright sky clouds" 80
import_tile unsplash "white stone marble" 80

# More elderly/gray hair portraits
import_tile pexels "senior citizen portrait" 80
import_tile pexels "aging gracefully portrait" 80
import_tile pexels "wise old man face" 80
import_tile unsplash "elderly person smile" 80
import_tile unsplash "gray haired woman" 80
import_tile unsplash "old couple love" 80

echo ""
echo "All imports started! Checking tile count..."
sleep 5
curl -s "https://mosaicprint-production.up.railway.app/api/trpc/getDbStats" | python3 -c "
import sys,json
d=json.load(sys.stdin)
data=d.get('result',{}).get('data',d)
print(f'Total tiles: {data[\"total\"]}')
print(f'Hell: {data[\"byBrightness\"][\"hell\"]}')
print(f'Extrem hell: {data[\"byBrightness5\"][\"extrem_hell\"]}')
print(f'Weiss: {data[\"byColor\"][\"weiss\"]}')
" 2>/dev/null
