import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(process.cwd(), 'database.json');

// WhatsApp Gateway Settings
const GATEWAY_URL = 'https://rp-digital-tribes-wa-api.onrender.com/api/send';
const SESSION = 'rp-01';

// Database helper functions (Persists data across restarts)
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

// Indian Standard Time (IST) string generator
function getISTTimestamp(date = new Date()) {
  return new Date(date).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium'
  });
}

// Actual message dispatch function
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

    const response = await axios.get(GATEWAY_URL, {
      params,
      timeout: 30000
    });

    item.status = 'SENT';
    item.sentAt = getISTTimestamp();
    item.gatewayResponse = response.data;
  } catch (error) {
    item.status = 'FAILED';
    item.failedAt = getISTTimestamp();
    item.error = error.response ? JSON.stringify(error.response.data) : error.message;
  }
}

// Background Worker: Har 15 second me check karta hai scheduled messages ko
setInterval(async () => {
  const queue = readQueue();
  const now = Date.now();
  let updated = false;

  for (const item of queue) {
    if (item.status === 'PENDING' && now >= item.executeAt) {
      item.status = 'SENDING';
      saveQueue(queue); // Lock kar rahe hain duplicate calls rokne ke liye
      await dispatchMessage(item);
      updated = true;
    }
  }

  if (updated) {
    saveQueue(queue);
  }
}, 15000);

// API 1: Naya Message Schedule Karne Ke Liye
app.post('/api/schedule', (req, res) => {
  const { number, message, imageUrl, delayHours = 2 } = req.body;

  if (!number || !message) {
    return res.status(400).json({ error: 'number and message are required' });
  }

  const queue = readQueue();
  const executeAt = Date.now() + parseFloat(delayHours) * 60 * 60 * 1000;

  const newItem = {
    id: 'MSG_' + Date.now(),
    number: number.trim(),
    message: message.trim(),
    imageUrl: imageUrl ? imageUrl.trim() : '',
    delayHours: Number(delayHours),
    scheduledAt: getISTTimestamp(),
    executeAtTimeIST: getISTTimestamp(executeAt),
    executeAt: executeAt,
    status: 'PENDING',
    sentAt: null,
    error: null
  };

  queue.push(newItem);
  saveQueue(queue);

  return res.json({
    success: true,
    message: `Message scheduled for ${delayHours} hours later (${newItem.executeAtTimeIST})`,
    data: newItem
  });
});

// API 2: Status check karne ke liye (JSON format)
app.get('/api/status', (req, res) => {
  const queue = readQueue();
  res.json({
    total: queue.length,
    pending: queue.filter((i) => i.status === 'PENDING').length,
    sent: queue.filter((i) => i.status === 'SENT').length,
    failed: queue.filter((i) => i.status === 'FAILED').length,
    data: queue.reverse()
  });
});

// Visual Dashboard: Browser me khol kar live dekhne ke liye (/)
app.get('/', (req, res) => {
  const queue = readQueue().reverse();

  const rows = queue
    .map(
      (m) => `
    <tr style="border-bottom: 1px solid #e5e7eb;">
      <td style="padding: 10px;">${m.id}</td>
      <td style="padding: 10px; font-weight: bold;">${m.number}</td>
      <td style="padding: 10px; max-width: 250px;">${m.message}</td>
      <td style="padding: 10px;">${m.imageUrl ? `<a href="${m.imageUrl}" target="_blank">View Image</a>` : '-'}</td>
      <td style="padding: 10px;">${m.scheduledAt}</td>
      <td style="padding: 10px; color: #2563eb;">${m.executeAtTimeIST}</td>
      <td style="padding: 10px;">
        <span style="padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; 
          background-color: ${m.status === 'SENT' ? '#dcfce7; color: #166534;' : m.status === 'PENDING' ? '#fef9c3; color: #854d0e;' : '#fee2e2; color: #991b1b;'};">
          ${m.status}
        </span>
      </td>
      <td style="padding: 10px; font-size: 12px; color: #6b7280;">${m.sentAt || m.error || '-'}</td>
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
        body { font-family: system-ui, sans-serif; background: #f9fafb; padding: 20px; color: #1f2937; }
        .card { background: white; padding: 24px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); max-width: 1100px; margin: auto; }
        input, textarea, button { width: 100%; padding: 10px; margin-top: 6px; margin-bottom: 14px; border: 1px solid #d1d5db; border-radius: 6px; box-sizing: border-box; }
        button { background: #16a34a; color: white; font-weight: bold; border: none; cursor: pointer; }
        button:hover { background: #15803d; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; text-align: left; }
        th { background: #f3f4f6; padding: 10px; font-size: 13px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Schedule WhatsApp Message (IST)</h2>
        <form method="POST" action="/schedule-form">
          <label>Recipient Number (with country code):</label>
          <input type="text" name="number" placeholder="919876543210" required />

          <label>Message Text:</label>
          <textarea name="message" rows="3" placeholder="Apna message yahan likhein..." required></textarea>

          <label>Image URL (Optional):</label>
          <input type="text" name="imageUrl" placeholder="https://example.com/image.jpg" />

          <label>Delay in Hours (Kitne ghante baad bhejna hai):</label>
          <input type="number" step="0.01" name="delayHours" value="2" required />

          <button type="submit">Schedule Message</button>
        </form>

        <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;" />

        <div style="display: flex; justify-content: space-between; align-items: center;">
          <h3>Scheduled & Sent Messages History</h3>
          <button onclick="location.reload()" style="width: auto; padding: 6px 14px; background: #2563eb;">Refresh Status</button>
        </div>

        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Number</th>
                <th>Message</th>
                <th>Media</th>
                <th>Created (IST)</th>
                <th>Execution Time (IST)</th>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              ${rows || '<tr><td colspan="8" style="text-align: center; padding: 20px;">Koi message queued nahi hai.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </body>
    </html>
  `);
});

// HTML Form submit handle karne ke liye route
app.post('/schedule-form', (req, res) => {
  const { number, message, imageUrl, delayHours } = req.body;
  const queue = readQueue();
  const executeAt = Date.now() + parseFloat(delayHours) * 60 * 60 * 1000;

  queue.push({
    id: 'MSG_' + Date.now(),
    number: number.trim(),
    message: message.trim(),
    imageUrl: imageUrl ? imageUrl.trim() : '',
    delayHours: Number(delayHours),
    scheduledAt: getISTTimestamp(),
    executeAtTimeIST: getISTTimestamp(executeAt),
    executeAt: executeAt,
    status: 'PENDING',
    sentAt: null,
    error: null
  });

  saveQueue(queue);
  res.redirect('/');
});

// Health endpoint Render keep-alive ke liye
app.get('/ping', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`Server live on port ${PORT}`);
});
