# PortraitShift — Real Video Converter

Converts landscape (16:9) videos to portrait (9:16) using **FFmpeg on the backend**.  
No browser tricks. Real H.264 encoding. Audio preserved. All formats supported.

---

## Requirements

- **Node.js** v16+ → https://nodejs.org
- **FFmpeg** installed on your system:
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt install ffmpeg`
  - Windows: https://ffmpeg.org/download.html

---

## Run It

```bash
# Install dependencies (first time only)
npm install

# Start the server
node server.js

# Or use the startup script:
bash start.sh
```

Open **http://localhost:3000** in your browser.

---

## How It Works

1. **Upload** — Video sent via multipart POST to `/api/convert`
2. **Probe** — `ffprobe` reads source dimensions, duration, codec
3. **Convert** — FFmpeg spawned with `filter_complex` for your chosen fill mode:
   - **Blur** — `boxblur=luma_radius=40:luma_power=2` background
   - **Mirror** — `hflip` background behind centered video
   - **Black bars** — `pad` with black fill
   - **Solid color** — `color=` source as background
   - **Stretch** — simple scale to 9:16
4. **Encode** — H.264 / libx264, `yuv420p`, `+faststart` for web
5. **Download** — MP4 streamed back, temp files cleaned up

## API

| Endpoint | Method | Description |
|---|---|---|
| `POST /api/convert` | multipart/form-data | Upload + start conversion |
| `GET /api/status/:jobId` | GET | Poll progress (0-100%) |
| `GET /api/download/:jobId` | GET | Download converted MP4 |

## Options (POST body)

| Field | Values | Default |
|---|---|---|
| `fillMode` | `blur`, `black`, `mirror`, `color`, `stretch` | `blur` |
| `quality` | `high` (CRF 18), `medium` (CRF 23), `low` (CRF 28) | `medium` |
| `resolution` | `auto`, `1080x1920`, `720x1280`, `1440x2560` | `auto` |
| `bgColor` | hex without `#` e.g. `ff0000` | `000000` |
