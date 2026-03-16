#!/bin/bash
# Import extrem helle, neutrale Tiles (L>90, Sättigung<15)
# Ziel: +2000 Tiles um die 1% Extrem-Hell auf 10% zu bringen

QUERIES_UNSPLASH=(
  "white snow landscape"
  "white fog mist"
  "white cloud sky"
  "white sand beach"
  "white cotton fabric"
  "white ceramic bowl"
  "white linen texture"
  "white plaster wall"
  "overexposed portrait"
  "bright white studio"
  "white salt flat"
  "white birch tree"
)

QUERIES_PEXELS=(
  "white background minimal"
  "white snow winter"
  "white cloud bright"
  "white fabric texture"
  "white wall clean"
  "white paper bright"
  "white foam texture"
  "white flower petal"
  "bright overexposed"
  "white light abstract"
  "white marble clean"
  "white ceiling interior"
)

echo "=== Starting extreme bright tile imports ==="
echo "Total queries: $((${#QUERIES_UNSPLASH[@]} + ${#QUERIES_PEXELS[@]}))"

for query in "${QUERIES_UNSPLASH[@]}"; do
  echo "Unsplash: $query"
  curl -s -X POST 'https://mosaicprint-production.up.railway.app/api/trpc/admin.targetedImport' \
    -H 'Content-Type: application/json' \
    -d "{\"source\":\"unsplash\",\"query\":\"$query\",\"maxCount\":80}" > /dev/null 2>&1
  sleep 3
done

for query in "${QUERIES_PEXELS[@]}"; do
  echo "Pexels: $query"
  curl -s -X POST 'https://mosaicprint-production.up.railway.app/api/trpc/admin.targetedImport' \
    -H 'Content-Type: application/json' \
    -d "{\"source\":\"pexels\",\"query\":\"$query\",\"maxCount\":80}" > /dev/null 2>&1
  sleep 3
done

echo "=== All imports done ==="
