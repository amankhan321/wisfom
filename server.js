const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active jobs and their progress
const jobs = new Map();

// Multer: store uploads in temp dir
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB max
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska',
                     'video/avi', 'video/x-msvideo', 'video/mpeg', 'video/3gpp'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

// Generate unique job ID
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Get video info using ffprobe
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath
    ];
    const proc = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try {
        const info = JSON.parse(stdout);
        const video = info.streams.find(s => s.codec_type === 'video');
        const audio = info.streams.find(s => s.codec_type === 'audio');
        resolve({
          width: video?.width,
          height: video?.height,
          duration: parseFloat(info.format?.duration || 0),
          fps: video?.r_frame_rate,
          codec: video?.codec_name,
          audioCodec: audio?.codec_name,
          size: parseInt(info.format?.size || 0),
          bitrate: parseInt(info.format?.bit_rate || 0)
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Build FFmpeg args for landscape→portrait conversion
function buildFFmpegArgs(inputPath, outputPath, options, videoInfo) {
  const { fillMode, quality, resolution } = options;
  const { width: srcW, height: srcH } = videoInfo;

  // Output dimensions: 9:16 portrait
  let outW, outH;
  if (resolution === 'auto') {
    // Keep source height, compute width for 9:16
    outH = srcW; // landscape width becomes portrait height
    outW = Math.round(outH * 9 / 16);
    // Make even numbers
    outW = outW % 2 === 0 ? outW : outW - 1;
    outH = outH % 2 === 0 ? outH : outH - 1;
  } else {
    const parts = resolution.split('x');
    outW = parseInt(parts[0]);
    outH = parseInt(parts[1]);
  }

  // Quality/CRF settings
  const crfMap = { high: 18, medium: 23, low: 28 };
  const crf = crfMap[quality] || 23;

  // Scale for the main (centered) video to fit in portrait canvas
  // Fit landscape video inside portrait frame
  const scaleMain = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black`;

  let filterComplex = '';
  let mapArgs = [];

  if (fillMode === 'black') {
    // Simple: fit video centered with black bars
    filterComplex = `[0:v]${scaleMain}[out]`;
    mapArgs = ['-map', '[out]'];

  } else if (fillMode === 'blur') {
    // Background: scale to fill, blur heavily
    // Foreground: fit centered
    filterComplex = [
      `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},boxblur=luma_radius=40:luma_power=2[bg]`,
      `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[out]`
    ].join(';');
    mapArgs = ['-map', '[out]'];

  } else if (fillMode === 'mirror') {
    // Mirrored background + centered foreground
    filterComplex = [
      `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},hflip[bg]`,
      `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[out]`
    ].join(';');
    mapArgs = ['-map', '[out]'];

  } else if (fillMode === 'stretch') {
    // Just stretch to fill the 9:16 frame
    filterComplex = `[0:v]scale=${outW}:${outH}[out]`;
    mapArgs = ['-map', '[out]'];

  } else if (fillMode === 'color') {
    // Color background
    const color = options.bgColor || '000000';
    filterComplex = [
      `color=c=#${color}:size=${outW}x${outH}:rate=30[bg]`,
      `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[out]`
    ].join(';');
    mapArgs = ['-map', '[out]'];
  }

  const args = [
    '-i', inputPath,
    '-filter_complex', filterComplex,
    ...mapArgs,
    '-map', '0:a?',         // include audio if present
    '-c:v', 'libx264',
    '-crf', String(crf),
    '-preset', 'fast',
    '-pix_fmt', 'yuv420p',  // max compatibility
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart', // web-optimized MP4
    '-y',
    outputPath
  ];

  return { args, outW, outH };
}

// POST /api/convert — upload + start conversion
app.post('/api/convert', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });

  const jobId = genId();
  const inputPath = req.file.path;
  const outputPath = path.join(os.tmpdir(), `portrait_${jobId}.mp4`);

  const options = {
    fillMode: req.body.fillMode || 'blur',
    quality: req.body.quality || 'medium',
    resolution: req.body.resolution || 'auto',
    bgColor: req.body.bgColor || '000000'
  };

  // Init job state
  jobs.set(jobId, {
    status: 'probing',
    progress: 0,
    inputPath,
    outputPath,
    error: null,
    videoInfo: null,
    outDims: null,
    startTime: Date.now()
  });

  res.json({ jobId });

  // Async: probe then convert
  try {
    const videoInfo = await getVideoInfo(inputPath);
    const job = jobs.get(jobId);
    job.videoInfo = videoInfo;
    job.status = 'converting';
    job.progress = 5;

    const { args, outW, outH } = buildFFmpegArgs(inputPath, outputPath, options, videoInfo);
    job.outDims = { outW, outH };

    const duration = videoInfo.duration;
    const ffmpeg = spawn('ffmpeg', args);

    ffmpeg.stderr.on('data', data => {
      const line = data.toString();
      // Parse time= from FFmpeg progress output
      const match = line.match(/time=(\d+):(\d+):([\d.]+)/);
      if (match && duration > 0) {
        const secs = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
        const pct = Math.min(95, 5 + (secs / duration) * 90);
        job.progress = Math.round(pct);
      }
    });

    ffmpeg.on('close', code => {
      const job = jobs.get(jobId);
      if (code === 0) {
        const stat = fs.statSync(outputPath);
        job.status = 'done';
        job.progress = 100;
        job.outputSize = stat.size;
      } else {
        job.status = 'error';
        job.error = 'FFmpeg conversion failed';
        fs.unlink(inputPath, () => {});
      }
    });

    ffmpeg.on('error', err => {
      const job = jobs.get(jobId);
      job.status = 'error';
      job.error = err.message;
    });

  } catch (err) {
    const job = jobs.get(jobId);
    job.status = 'error';
    job.error = err.message;
  }
});

// GET /api/status/:jobId — poll progress
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const { status, progress, error, videoInfo, outDims, outputSize } = job;
  res.json({ status, progress, error, videoInfo, outDims, outputSize });
});

// GET /api/download/:jobId — stream the converted file
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'File not ready' });

  const filename = `portrait_video_${req.params.jobId}.mp4`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', job.outputSize);

  const stream = fs.createReadStream(job.outputPath);
  stream.pipe(res);

  // Cleanup files after download
  stream.on('end', () => {
    setTimeout(() => {
      fs.unlink(job.inputPath, () => {});
      fs.unlink(job.outputPath, () => {});
      jobs.delete(req.params.jobId);
    }, 5000);
  });
});

// Cleanup stale jobs older than 1 hour
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.startTime > 3600000) {
      fs.unlink(job.inputPath, () => {});
      fs.unlink(job.outputPath, () => {});
      jobs.delete(id);
    }
  }
}, 600000);

app.listen(PORT, () => {
  console.log(`\n🎬 PortraitShift backend running at http://localhost:${PORT}\n`);
});
