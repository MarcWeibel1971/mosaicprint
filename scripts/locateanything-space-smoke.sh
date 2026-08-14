#!/usr/bin/env bash
set -euo pipefail

# INTERNAL R&D ONLY: This script sends only the public Hugging Face bee sample
# to NVIDIA's public LocateAnything demo. Never use customer or staff images here.
SPACE_URL="https://nvidia-locateanything.hf.space"
WORK_DIR="$(mktemp -d)"
IMAGE_FILE="$WORK_DIR/bee.jpg"
trap 'rm -rf "$WORK_DIR"' EXIT

curl -fsS --max-time 30 \
  "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/bee.jpg" \
  -o "$IMAGE_FILE"

UPLOAD_JSON="$(curl -fsS --max-time 30 -X POST "$SPACE_URL/gradio_api/upload" \
  -F "files=@$IMAGE_FILE;type=image/jpeg")"
UPLOAD_PATH="$(printf '%s' "$UPLOAD_JSON" | jq -r '.[0]')"

if [[ -z "$UPLOAD_PATH" || "$UPLOAD_PATH" == "null" ]]; then
  echo "Upload to public demo failed" >&2
  exit 1
fi

REQUEST_JSON="$(jq -n --arg path "$UPLOAD_PATH" '{
  input_type: "Image",
  image_file: {path: $path, url: null, size: null, orig_name: "bee.jpg", mime_type: "image/jpeg", is_stream: false, meta: {_type: "gradio.FileData"}},
  video_file: null,
  task_type: "Detection",
  category: "bee",
  model_mode: "hybrid",
  temp: 0.0,
  top_p: 0.9,
  top_k: 20,
  short_size: 512,
  question_override: null,
  max_video_frames: 1
}')"

EVENT_JSON="$(curl -fsS --max-time 30 -X POST "$SPACE_URL/gradio_api/call/v2/run_inference" \
  -H "Content-Type: application/json" \
  --data "$REQUEST_JSON")"
EVENT_ID="$(printf '%s' "$EVENT_JSON" | jq -r '.event_id')"

if [[ -z "$EVENT_ID" || "$EVENT_ID" == "null" ]]; then
  echo "The public demo did not return an event id" >&2
  printf '%s\n' "$EVENT_JSON" >&2
  exit 1
fi

curl -fsS -N --max-time 180 "$SPACE_URL/gradio_api/call/run_inference/$EVENT_ID" \
  | sed -n '/^data: /p' \
  | tail -1 \
  | sed 's/^data: //'
