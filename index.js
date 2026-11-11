import express from 'express';
import axios from 'axios';
import multer from 'multer';
import fs from 'fs';
import path from 'path';

const app = express();
app.set('trust proxy', true); // Render par https detect karne ke liye
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(process.cwd(), 'database.json');
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
// Optional: Render env me BASE_URL daalo, jaise https://your-app.onrender.com
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

// WhatsApp Gateway Settings
const GATEWAY_URL = 'https://rp-digital-tribes-wa-api.onrender.com/api/send';
const SESSION = 'rp-01';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Uploaded images public URL par serve honge (gateway yahin se image uthayega)
app.use('/uploads', express.static(UPLOAD_DIR));

// ---------- Image upload setup ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // max 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Sirf image file allowed hai'));
  }
});

// ---------- Database helpers ----------
function readQueue() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveQueue(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ---------- IST helpers ----------
function getISTTimestamp(date = new Date()) {
  return new Date(date).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium'
  });
}

// Abhi ka IST time "YYYY-MM-DDTHH:mm" format me (datetime-local input ke liye)
function nowISTInputValue(offsetMinutes = 0) {
  const d = new Date(Date.now() + offsetMinutes * 60000);
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16).replace(' ', 'T');
}

// "2026-11-11T15:30" (IST) -> timestamp (ms)
function istInputToMs(value) {
  if (!value) return NaN;
  return new Date(`${value}:00+05:30`).getTime();
}

const esc = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// ---------- Message dispatch ----------
async function dispatchMessage(item) {
  console.log(`[${getISTTimestamp()}] Sending to: ${item.number}`);
  try {
    const params = {
      session: SESSION,
      number: item.number,
      text: item.message
    };
    if (item.imageUrl && item.imageUrl.trim() !== '') {
      params.url = item.imageUrl;
      params.media = item.imageUrl;
    }

    const response = await axios.get(GATEWAY_URL, { params, timeout: 30000 });

    item.status = 'SENT';
    item.sentAt = getISTTimestamp();
    item.gatewayResponse = response.data;
  } catch (error) {
    item.status = 'FAILED';
    item.failedAt = getISTTimestamp();
    item.error = error.response ? JSON.stringify(error.response.data) : error.message;
  }
}

// Startup par atke hue SENDING messages ko wapas PENDING karo
(function recoverStuck() {
  const q = readQueue();
  let changed = false;
  for (const i of q) {
    if (i.status === 'SENDING') {
      i.status = 'PENDING';
      changed = true;
    }
  }
  if (changed) saveQueue(q);
})();

// Background worker: har 15 second me scheduled messages check karta hai
let workerBusy = false;
setInterval(async () => {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const queue = readQueue();
    const now = Date.now();
    let updated = false;

    for (const item of queue) {
      if (item.status === 'PENDING' && now >= item.executeAt) {
        item.status = 'SENDING';
        saveQueue(queue);
        await dispatchMessage(item);
        updated = true;
      }
    }
    if (updated) saveQueue(queue);
  } finally {
    workerBusy = false;
  }
}, 15000);

// ---------- Schedule logic (form + API dono ke liye) ----------
function createItem(req) {
  const { number, message, scheduleTime } = req.body;

  if (!number || !message || !scheduleTime) {
    throw new Error('Number, message aur time teeno zaroori hain');
  }

  const executeAt = istInputToMs(scheduleTime);
  if (Number.isNaN(executeAt)) throw new Error('Time galat format me hai');
  if (executeAt < Date.now() - 60000) throw new Error('Time past me hai, aage ka time chuno');

  let imageUrl = '';
  let imageFile = '';
  if (req.file) {
    const base = BASE_URL || `${req.protocol}://${req.get('host')}`;
    imageFile = req.file.filename;
    imageUrl = `${base}/uploads/${req.file.filename}`;
  }

  return {
    id: 'MSG_' + Date.now(),
    number: number.trim().replace(/[^0-9]/g, ''),
    message: message.trim(),
    imageUrl,
    imageFile,
    scheduledAt: getISTTimestamp(),
    executeAtTimeIST: getISTTimestamp(executeAt),
    executeAt,
    status: 'PENDING',
    sentAt: null,
    error: null
  };
}

function handleSchedule(req, res, isApi) {
  try {
    const item = createItem(req);
    const queue = readQueue();
    queue.push(item);
    saveQueue(queue);
    if (isApi) return res.json({ success: true, data: item });
    return res.redirect('/');
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    if (isApi) return res.status(400).json({ error: err.message });
    return res.redirect('/?error=' + encodeURIComponent(err.message));
  }
}

// API: multipart/form-data (fields: number, message, scheduleTime, image)
app.post('/api/schedule', upload.single('image'), (req, res) => handleSchedule(req, res, true));

// HTML form submit
app.post('/schedule-form', upload.single('image'), (req, res) => handleSchedule(req, res, false));

// Pending message cancel
app.post('/cancel/:id', (req, res) => {
  const queue = readQueue();
  const item = queue.find((i) => i.id === req.params.id);
  if (item && item.status === 'PENDING') {
    item.status = 'CANCELLED';
    saveQueue(queue);
  }
  res.redirect('/');
});

// JSON status
app.get('/api/status', (req, res) => {
  const queue = readQueue();
  res.json({
    total: queue.length,
    pending: queue.filter((i) => i.status === 'PENDING').length,
    sent: queue.filter((i) => i.status === 'SENT').length,
    failed: queue.filter((i) => i.status === 'FAILED').length,
    data: [...queue].reverse()
  });
});

// ---------- Dashboard ----------
app.get('/', (req, res) => {
  const queue = readQueue().reverse();
  const error = req.query.error ? esc(req.query.error) : '';

  const badge = (s) => {
    const map = {
      SENT: 'background:#dcfce7;color:#166534;',
      PENDING: 'background:#fef9c3;color:#854d0e;',
      SENDING: 'background:#dbeafe;color:#1e40af;',
      CANCELLED: 'background:#e5e7eb;color:#374151;',
      FAILED: 'background:#fee2e2;color:#991b1b;'
    };
    return map[s] || map.FAILED;
  };

  const rows = queue
    .map(
      (m) => `
    <tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:10px;">${esc(m.id)}</td>
      <td style="padding:10px;font-weight:bold;">${esc(m.number)}</td>
      <td style="padding:10px;max-width:250px;">${esc(m.message)}</td>
      <td style="padding:10px;">${
        m.imageFile
          ? `<a href="/uploads/${encodeURIComponent(m.imageFile)}" target="_blank"><img src="/uploads/${encodeURIComponent(m.imageFile)}" style="width:50px;height:50px;object-fit:cover;border-radius:6px;" /></a>`
          : '-'
      }</td>
      <td style="padding:10px;">${esc(m.scheduledAt)}</td>
      <td style="padding:10px;color:#2563eb;">${esc(m.executeAtTimeIST)}</td>
      <td style="padding:10px;">
        <span style="padding:4px 8px;border-radius:4px;font-size:12px;font-weight:bold;${badge(m.status)}">${esc(m.status)}</span>
      </td>
      <td style="padding:10px;font-size:12px;color:#6b7280;">${esc(m.sentAt || m.error || '-')}</td>
      <td style="padding:10px;">${
        m.status === 'PENDING'
          ? `<form method="POST" action="/cancel/${encodeURIComponent(m.id)}"><button class="small red">Cancel</button></form>`
          : ''
      }</td>
    </tr>`
    )
    .join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp Message Scheduler</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: system-ui, sans-serif; background:#f9fafb; padding:20px; color:#1f2937; }
        .card { background:white; padding:24px; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); max-width:1150px; margin:auto; }
        input, textarea, button { width:100%; padding:10px; margin-top:6px; margin-bottom:14px; border:1px solid #d1d5db; border-radius:6px; box-sizing:border-box; font-size:15px; }
        button { background:#16a34a; color:white; font-weight:bold; border:none; cursor:pointer; }
        button:hover { background:#15803d; }
        button.small { width:auto; padding:5px 10px; margin:0; font-size:12px; }
        button.red { background:#dc2626; }
        .err { background:#fee2e2; color:#991b1b; padding:10px; border-radius:6px; margin-bottom:14px; }
        #preview { max-width:180px; max-height:180px; border-radius:8px; display:none; margin-bottom:14px; }
        table { width:100%; border-collapse:collapse; margin-top:20px; text-align:left; }
        th { background:#f3f4f6; padding:10px; font-size:13px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Schedule WhatsApp Message (IST)</h2>
        ${error ? `<div class="err">${error}</div>` : ''}
        <form method="POST" action="/schedule-form" enctype="multipart/form-data">
          <label>Recipient Number (country code ke saath):</label>
          <input type="text" name="number" placeholder="919876543210" required />

          <label>Message Text:</label>
          <textarea name="message" rows="3" placeholder="Apna message yahan likhein..." required></textarea>

          <label>Image Upload (Optional):</label>
          <input type="file" name="image" id="image" accept="image/*" />
          <img id="preview" alt="preview" />

          <label>Kab bhejna hai (Indian Time - IST):</label>
          <input type="datetime-local" name="scheduleTime" value="${nowISTInputValue(120)}" min="${nowISTInputValue(0)}" required />

          <button type="submit">Schedule Message</button>
        </form>

        <hr style="margin:30px 0;border:none;border-top:1px solid #e5e7eb;" />

        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h3>Scheduled & Sent Messages History</h3>
          <button onclick="location.href='/'" style="width:auto;padding:6px 14px;background:#2563eb;">Refresh Status</button>
        </div>

        <div style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th>ID</th><th>Number</th><th>Message</th><th>Image</th>
                <th>Created (IST)</th><th>Send Time (IST)</th><th>Status</th><th>Details</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${rows || '<tr><td colspan="9" style="text-align:center;padding:20px;">Koi message queued nahi hai.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
      <script>
        const input = document.getElementById('image');
        const preview = document.getElementById('preview');
        input.addEventListener('change', () => {
          const f = input.files[0];
          if (f) { preview.src = URL.createObjectURL(f); preview.style.display = 'block'; }
          else preview.style.display = 'none';
        });
      </script>
    </body>
    </html>
  `);
});

// Multer errors (file too big etc.)
app.use((err, req, res, next) => {
  res.redirect('/?error=' + encodeURIComponent(err.message || 'Upload error'));
});

// Render keep-alive
app.get('/ping', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`Server live on port ${PORT}`);
});
