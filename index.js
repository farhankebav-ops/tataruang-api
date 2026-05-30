const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const Cerebras = require('@cerebras/cerebras_cloud_sdk');
const cerebrasClient = new Cerebras({ apiKey: process.env.CEREBRAS_API_KEY });

const app = express();
const port = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Konfigurasi Multer untuk menyimpan file di memory sementara (RAM)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Buat folder untuk menyimpan foto profil jika belum ada (Bungkus try-catch agar aman dari Read-Only Vercel)
const profileDir = path.join(__dirname, 'uploads', 'profiles');
try {
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }
} catch (err) {
  console.log("Folder profile gagal dibuat / read-only environment, aman di-bypass.");
}

// Konfigurasi Multer khusus untuk foto profil (simpan di disk, bukan memory)
const profileStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, profileDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `profile-${req.user.id}-${Date.now()}${ext}`); // Penamaan unik
  }
});
const uploadProfile = multer({ storage: profileStorage });


// --- PERBAIKAN SAKTI: LAZY LOADING DATABASE ---
// Kita bungkus database ke dalam pool global, tapi handshake baru dilakukan pas endpoint SQL dipanggil aja.
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5, // Batasi koneksi biar gak nge-hang di serverless
  queueLimit: 0
});

// --- MIDDLEWARE AUTENTIKASI ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer <token>"

  if (!token) return res.status(401).json({ error: 'Akses ditolak. Token tidak ada.' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token tidak valid atau kedaluwarsa.' });
    req.user = user; // Simpan data user dari payload JWT ke request
    next();
  });
};

const systemPrompt = `
Kamu adalah AI Arsitek Ahli dan Penganalisa Spasial Lahan. Tugasmu adalah menganalisis foto lahan yang diberikan dan memberikan estimasi awal untuk pembangunan dengan konsep "Eco-friendly" dan arsitektur Nusantara.

PENTING: Kamu WAJIB merespon HANYA dengan format JSON yang valid. 
ATURAN WAJIB JSON:
1. Jangan ada teks basa-basi sebelum atau sesudah JSON.
2. JANGAN gunakan tanda kutip ganda (") di dalam isi teks value.
3. JANGAN gunakan enter (newline) di dalam teks. Jadikan teks dalam satu kalimat panjang saja.
4. Pastikan tanda koma (,) terpasang benar antar properti.

Struktur JSON harus persis seperti ini:
{
  "confidence": <angka_persentase_keyakinan_dari_0_sampai_100>,
  "karakteristik": {
    "tipe_tanah": "<isi, contoh: Tanah Merah / Berpasir>",
    "elevasi": "<isi, contoh: Landai / Miring 15° / Rata>",
    "luas_perkiraan": "<isi, berikan estimasi luas berdasarkan pandangan, contoh: ~500m²>",
    "drainase": "<isi, contoh: Baik / Perlu penanganan khusus>"
  },
  "struktur": {
    "pondasi": "<isi, saran pondasi, contoh: Cakar Ayam / Bore Pile>",
    "material": "<isi, saran material utama pelengkap pondasi>"
  },
  "desain": {
    "arah_matahari": "<isi, estimasi pencahayaan matahari>",
    "gaya_rekomendasi": "<isi, gaya bangunan yang cocok, contoh: Tropis Modern>",
    "unsur_lokal": "<isi, material kearifan lokal yang cocok, contoh: Bambu / Kayu Ulin>"
  },
  "budget": "<isi, estimasi biaya kasar per meter persegi, contoh: Rp 4.500.000 - Rp 6.000.000 / m²>"
}
`;

app.get('/', (req, res) => {
    res.json({ status: "online", message: "Server Produse AI Scan Ready!" });
});

// Endpoint POST untuk menerima gambar dan memproses analisis
app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Tidak ada gambar yang diunggah.' });
    }

    // Ubah buffer gambar dari Multer menjadi string Base64
    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    
    const dataURI = `data:${mimeType};base64,${base64Image}`;

    // Konfigurasi payload untuk Fireworks API
    const payload = {
      model: "accounts/fireworks/models/kimi-k2p6",
      max_tokens: 2000,
      temperature: 0.2, 
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Tolong analisis foto lahan ini dan berikan output dalam format JSON sesuai instruksi sistem."
            },
            {
              type: "image_url",
              image_url: {
                url: dataURI
              }
            }
          ]
        }
      ]
    };

    // Tembak API Fireworks dengan Header Connection close biar ga gampang ECONNRESET
    const response = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.FIREWORKS_API_KEY}`,
        "Connection": "close"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || 'Gagal menghubungi Fireworks API');
    }
    
    let aiMessage = data.choices[0].message.content;
    
    let jsonString = null;
    let startIndex = aiMessage.indexOf('{');
    
    if (startIndex !== -1) {
      let depth = 0;
      for (let i = startIndex; i < aiMessage.length; i++) {
        if (aiMessage[i] === '{') depth++;
        else if (aiMessage[i] === '}') depth--;
        
        if (depth === 0) {
          jsonString = aiMessage.substring(startIndex, i + 1);
          break; 
        }
      }
    }

    if (jsonString) {
      jsonString = jsonString.replace(/[\n\r\t]/g, ' ');
      jsonString = jsonString.replace(/,\s*([}\]])/g, '$1');
      
      const parsedData = JSON.parse(jsonString);

      res.json({
        success: true,
        data: parsedData
      });
    } else {
      throw new Error("AI tidak mengembalikan struktur data yang benar. Coba scan ulang.");
    }

  } catch (error) {
    console.error("Error saat analisis lahan:", error);
    res.status(500).json({ 
      success: false, 
      error: 'Terjadi kesalahan saat menganalisis gambar.',
      details: error.message 
    });
  }
});

// --- ENDPOINT RIWAYAT CHAT ---
app.get('/api/chat/sessions', authenticateToken, async (req, res) => {
  try {
    const [sessions] = await db.execute(
      'SELECT id, title, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC',
      [req.user.id]
    );
    res.json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil sesi chat atau database sibuk.' });
  }
});

app.get('/api/chat/sessions/:id', authenticateToken, async (req, res) => {
  try {
    const [messages] = await db.execute(
      'SELECT role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    
    const formattedMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content,
      timestamp: new Date(msg.created_at).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })
    }));

    res.json({ success: true, messages: formattedMessages });
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil pesan.' });
  }
});

// Endpoint POST untuk Smart AI Chat
app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message) return res.status(400).json({ error: 'Pesan kosong.' });

    let currentSessionId = sessionId;
    let chatHistory = [];
    let isNewSession = false; 

    if (!currentSessionId) {
      isNewSession = true;
      const [newSession] = await db.execute(
        'INSERT INTO chat_sessions (user_id, title) VALUES (?, ?)',
        [req.user.id, 'Sesi Konsultasi Baru'] 
      );
      currentSessionId = newSession.insertId;
    } else {
      const [history] = await db.execute(
        'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC',
        [currentSessionId]
      );
      chatHistory = history.map(h => ({ role: h.role, content: h.content }));
    }

    await db.execute(
      'INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)',
      [currentSessionId, 'user', message]
    );

    const chatSystemPrompt = {
      role: "system",
      content: "Kamu adalah Smart AI Chat, asisten arsitek lini pertama..." 
    };

    const payloadMessages = [chatSystemPrompt, ...chatHistory, { role: 'user', content: message }];

    const payload = {
      model: "accounts/fireworks/models/gpt-oss-120b",
      max_tokens: 2000,
      temperature: 0.6,
      messages: payloadMessages
    };

    const response = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.FIREWORKS_API_KEY}`,
        "Connection": "close"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message);

    const aiContent = data.choices[0].message.content;

    await db.execute(
      'INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)',
      [currentSessionId, 'assistant', aiContent]
    );

    if (isNewSession) {
      let fallbackTitle = message.split(' ').slice(0, 5).join(' ');
      if (fallbackTitle.length > 30) {
        fallbackTitle = fallbackTitle.substring(0, 30) + '...';
      }

      await db.execute('UPDATE chat_sessions SET title = ? WHERE id = ?', [fallbackTitle, currentSessionId]);

      try {
        const completion = await cerebrasClient.chat.completions.create({
          messages: [
            {
              role: "system",
              content: "Tugasmu merangkum pesan user menjadi judul topik obrolan yang singkat dalam Bahasa Indonesia. Langsung berikan judulnya, jangan pakai tanda kutip, dan jangan pakai titik di akhir kalimat."
            },
            {
              role: "user",
              content: `Rangkum ini jadi judul singkat: ${message}`
            }
          ],
          model: 'llama3.1-8b',
          max_tokens: 25,
          temperature: 0.5,
        });

        const aiText = completion.choices[0]?.message?.content;
        
        if (aiText && aiText.trim().length > 0) {
          let generatedTitle = aiText.trim();
          generatedTitle = generatedTitle.replace(/^"|"$/g, '').replace(/^'|'$/g, '').replace(/\.$/, '');
          await db.execute('UPDATE chat_sessions SET title = ? WHERE id = ?', [generatedTitle, currentSessionId]);
        }
      } catch (titleError) {
        console.error("Cerebras gagal, tetep pakai judul fallback:", titleError);
      }
    }
    
    res.json({
      success: true,
      sessionId: currentSessionId,
      data: {
        content: aiContent,
        timestamp: new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })
      }
    });

  } catch (error) {
    console.error("Error saat chat AI:", error);
    res.status(500).json({ success: false, error: 'Terjadi kesalahan sistem atau database sibuk.' });
  }
});

// --- ENDPOINT AUTENTIKASI ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { nama, username, email, password, lokasi } = req.body;
    if (!email || !password || !nama) return res.status(400).json({ error: 'Nama, Email, dan Password wajib diisi.' });

    const [existingUsers] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) return res.status(400).json({ error: 'Email sudah terdaftar.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.execute(
      'INSERT INTO users (nama, username, email, password, lokasi) VALUES (?, ?, ?, ?, ?)',
      [nama, username || null, email, hashedPassword, lokasi || null]
    );

    res.status(201).json({ success: true, message: 'Registrasi berhasil.' });
  } catch (error) {
    console.error("Error Register:", error);
    res.status(500).json({ error: 'Terjadi kesalahan pada server database.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
    
    if (users.length === 0) return res.status(401).json({ error: 'Email atau password salah.' });

    const user = users[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Email atau password salah.' });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, nama: user.nama, email: user.email } });
  } catch (error) {
    console.error("Error Login:", error);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    const payload = jwt.decode(idToken);

    if (!payload || !payload.email) {
      return res.status(401).json({ error: 'Token Google tidak valid.' });
    }

    const { email, name } = payload; 
    const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
    let user;

    if (users.length === 0) {
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const hashedPassword = await bcrypt.hash(randomPassword, 10);

      const [result] = await db.execute(
        'INSERT INTO users (nama, email, password) VALUES (?, ?, ?)',
        [name, email, hashedPassword]
      );
      
      const [newUsers] = await db.execute('SELECT * FROM users WHERE id = ?', [result.insertId]);
      user = newUsers[0];
    } else {
      user = users[0];
    }

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, nama: user.nama, email: user.email } });
  } catch (error) {
    console.error("Error Google Auth Offline:", error);
    res.status(500).json({ error: 'Gagal memproses token Google secara offline.' });
  }
});

app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  res.json({ success: true, message: 'Logout berhasil.' });
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const [users] = await db.execute('SELECT id, nama, email, lokasi, foto_profil FROM users WHERE id = ?', [req.user.id]);
    if (users.length === 0) return res.status(404).json({ error: 'User tidak ditemukan.' });
    res.json({ success: true, user: users[0] });
  } catch (error) {
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});

app.put('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const { sandiLama, sandiBaru } = req.body;
    if (!sandiLama || !sandiBaru) return res.status(400).json({ error: 'Kolom wajib diisi.' });

    const [users] = await db.execute('SELECT password FROM users WHERE id = ?', [req.user.id]);
    if (users.length === 0) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const match = await bcrypt.compare(sandiLama, users[0].password);
    if (!match) return res.status(401).json({ error: 'Sandi saat ini salah.' });

    const hashedNewPassword = await bcrypt.hash(sandiBaru, 10);
    await db.execute('UPDATE users SET password = ? WHERE id = ?', [hashedNewPassword, req.user.id]);

    res.json({ success: true, message: 'Kata sandi diperbarui.' });
  } catch (error) {
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});

app.put('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    const { nama, lokasi } = req.body;
    if (!nama) return res.status(400).json({ error: 'Nama wajib diisi.' });

    await db.execute('UPDATE users SET nama = ?, lokasi = ? WHERE id = ?', [nama, lokasi || null, req.user.id]);
    res.json({ success: true, message: 'Profil diperbarui.' });
  } catch (error) {
    res.status(500).json({ error: 'Gagal memperbarui profil.' });
  }
});

app.post('/api/auth/profile/photo', authenticateToken, uploadProfile.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada gambar.' });
    const photoUrl = `/uploads/profiles/${req.file.filename}`;

    const [users] = await db.execute('SELECT foto_profil FROM users WHERE id = ?', [req.user.id]);
    const oldPhoto = users[0].foto_profil;
    if (oldPhoto) {
      const oldPath = path.join(__dirname, oldPhoto);
      try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch(e){}
    }

    await db.execute('UPDATE users SET foto_profil = ? WHERE id = ?', [photoUrl, req.user.id]);
    res.json({ success: true, photoUrl });
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengunggah foto.' });
  }
});

app.delete('/api/auth/profile/photo', authenticateToken, async (req, res) => {
  try {
    const [users] = await db.execute('SELECT foto_profil FROM users WHERE id = ?', [req.user.id]);
    const oldPhoto = users[0].foto_profil;
    if (oldPhoto) {
      const oldPath = path.join(__dirname, oldPhoto);
      try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch(e){}
    }
    await db.execute('UPDATE users SET foto_profil = NULL WHERE id = ?', [req.user.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal menghapus foto.' });
  }
});

app.get('/api/experts', async (req, res) => {
  try {
    const [experts] = await db.execute('SELECT id, nama, bio, nomor_wa, foto_profil FROM experts ORDER BY created_at DESC');
    res.json({ success: true, data: experts });
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil data.' });
  }
});

// --- ENDPOINT PENDAFTARAN RELAWAN (BRIDGE KE BOT WA VIA IP VPS NAT) ---
app.post('/api/relawan/register', async (req, res) => {
  try {
    const { nama, whatsapp, instansi, keahlian, motivasi } = req.body;
    if (!nama || !whatsapp || !instansi || !keahlian || !motivasi) {
      return res.status(400).json({ error: 'Semua kolom wajib diisi.' });
    }

    const waMessage = `*🚨 PENDAFTARAN RELAWAN BARU TATARUANG.IN 🚨*\n\n` +
      `*Nama Lengkap:* ${nama}\n` +
      `*No WhatsApp:* ${whatsapp}\n` +
      `*Instansi/Sekolah:* ${instansi}\n` +
      `*Keahlian:* ${keahlian}\n` +
      `*Motivasi:*\n_${motivasi}_\n\n` +
      `Mohon segera ditindaklanjuti.`;

    // SAKTI: Tembak langsung ke Port NAT publik bot WA lo, bukan localhost!
    // Ganti 5000 dengan PORT FORWARD NAT publik bot WA lo di VPS jika berbeda.
    const waResponse = await fetch('http://202.155.143.190:5000/send-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify({
        target: '6281929787463',
        message: waMessage
      })
    });

    const waData = await waResponse.json();
    if (!waResponse.ok || !waData.success) throw new Error('Gagal ke Bot WA');

    res.json({ success: true, message: 'Data terkirim ke Admin.' });
  } catch (error) {
    console.error("Error Register Relawan:", error);
    res.status(500).json({ error: 'Gagal meneruskan data ke Bot WhatsApp Admin.' });
  }
});

// --- SAKTI: EXPORT UNTUK VERCEL SERVERLESS ENVIRONMENT ---
module.exports = app;
