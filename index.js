const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

const MAX_PASTE_SIZE = 2 * 1024 * 1024; // 2MB in bytes
const PASTE_DIR = path.join(__dirname, 'pastes');
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 8;
const ALLOWED_FORMATS = ['txt', 'html', 'md', 'json'];

// Helpers
const isValidId = (id) => /^[0-9A-Za-z]{8}$/.test(id);

const escapeHtml = (str = '') =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const safePath = (filename) => {
  const fullPath = path.resolve(PASTE_DIR, filename);
  if (!fullPath.startsWith(path.resolve(PASTE_DIR))) {
    throw new Error('Invalid path resolution');
  }
  return fullPath;
};

const generateId = () => {
  const bytes = crypto.randomBytes(ID_LENGTH);
  let id = '';
  for (let i = 0; i < ID_LENGTH; i += 1) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return id;
};

const ensurePasteDir = async () => {
  await fs.mkdir(PASTE_DIR, { recursive: true });
};

// Middleware
app.use(cors());
app.use(express.json({ limit: `${MAX_PASTE_SIZE}b` }));
app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));

// Prepare storage
ensurePasteDir().catch((error) => {
  console.error('Failed to initialize paste storage', error);
  process.exit(1);
});

// Routes
app.post('/api/paste', async (req, res) => {
  try {
    const { content, language, cipher, iv, encrypted, size } = req.body || {};

    const hasPlain = typeof content === 'string' && content.trim().length > 0;
    const hasCipher = typeof cipher === 'string' && typeof iv === 'string';

    if (!hasPlain && !hasCipher) {
      return res
        .status(400)
        .json({ error: 'Content cannot be empty' });
    }

    const contentSize = hasPlain
      ? Buffer.byteLength(content, 'utf8')
      : typeof size === 'number'
        ? size
        : Buffer.byteLength(cipher, 'utf8');

    if (contentSize > MAX_PASTE_SIZE) {
      return res
        .status(413)
        .json({ error: 'Paste too large; max 2MB allowed' });
    }

    const safeLanguage =
      typeof language === 'string'
        ? language.trim().slice(0, 50) || null
        : null;

    const id = generateId();
    const created_at = new Date().toISOString();
    const pasteData = {
      id,
      created_at,
      language: safeLanguage,
      encrypted: Boolean(encrypted) || hasCipher,
    };

    if (hasPlain) pasteData.content = content;
    if (hasCipher) {
      pasteData.cipher = cipher;
      pasteData.iv = iv;
    }

    const filePath = safePath(`${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(pasteData, null, 2), 'utf8');

    const url = `${req.protocol}://${req.get('host')}/${id}`;
    return res.status(201).json({ id, url, created_at });
  } catch (error) {
    console.error('Error creating paste:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/paste/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const filePath = safePath(`${id}.json`);
    const raw = await fs.readFile(filePath, 'utf8');
    const paste = JSON.parse(raw);
    return res.json({
      id: paste.id,
      content: paste.content,
      cipher: paste.cipher,
      iv: paste.iv,
      encrypted: Boolean(paste.encrypted),
      language: paste.language || null,
      created_at: paste.created_at,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Paste not found' });
    }
    console.error('Error reading paste:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/paste/:id/download', async (req, res) => {
  try {
    const { id } = req.params;
    const format = (req.query.format || 'txt').toLowerCase();

    if (!isValidId(id)) {
      return res.status(400).send('Invalid ID format');
    }
    if (!ALLOWED_FORMATS.includes(format)) {
      return res.status(400).send('Invalid format');
    }

    const filePath = safePath(`${id}.json`);
    const raw = await fs.readFile(filePath, 'utf8');
    const paste = JSON.parse(raw);

    if (paste.encrypted) {
      return res
        .status(400)
        .send('Downloads are unavailable for encrypted pastes.');
    }

    let body = paste.content;
    let contentType = 'text/plain';
    let extension = 'txt';

    if (format === 'html') {
      extension = 'html';
      contentType = 'text/html';
      const langClass = paste.language ? `language-${paste.language}` : '';
      body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Paste ${id}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css">
</head>
<body>
  <pre><code class="${langClass}">${escapeHtml(paste.content)}</code></pre>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/autoloader/prism-autoloader.min.js"></script>
</body>
</html>`;
    } else if (format === 'md') {
      extension = 'md';
      contentType = 'text/markdown';
      body = `# Paste ${id}\n\n**Created at:** ${paste.created_at}${
        paste.language ? `\n\n**Language:** ${paste.language}` : ''
      }\n\n${paste.content}\n`;
    } else if (format === 'json') {
      extension = 'json';
      contentType = 'application/json';
      body = JSON.stringify(paste, null, 2);
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="paste-${id}.${extension}"`
    );
    return res.send(body);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).send('Paste not found');
    }
    console.error('Error downloading paste:', error);
    return res.status(500).send('Internal Server Error');
  }
});

// Serve frontend for paste view routes
app.get('/:id', (req, res, next) => {
  if (req.params.id === 'api') return next();
  if (!req.params.id || req.params.id.includes('.')) return next();
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`PasteBox listening at http://localhost:${port}`);
});
