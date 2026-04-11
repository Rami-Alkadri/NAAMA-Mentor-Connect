import express from 'express';
import cors from 'cors';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import crypto from 'crypto';

const { Pool } = pg;
const app = express();
const PORT = process.env.NODE_ENV === 'production' ? (process.env.PORT || 5000) : 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = process.env.JWT_SECRET || 'naama-connect-secret-key-2025';

const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s/g, '');
console.log('[SMTP] SMTP_USER:', SMTP_USER || 'NOT SET');
console.log('[SMTP] SMTP_PASS:', SMTP_PASS ? `SET (${SMTP_PASS.length} chars)` : 'NOT SET');

const mailer = SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

console.log('[SMTP] Mailer initialized:', mailer ? 'YES' : 'NO — credentials missing');

async function sendEmail(to, subject, html) {
  if (!mailer) {
    console.error('[SMTP] Cannot send — mailer not initialized (missing credentials)');
    return;
  }
  try {
    const info = await mailer.sendMail({ from: `"NAAMA Mentor Connect" <${SMTP_USER}>`, to, subject, html });
    console.log('[SMTP] Email sent to', to, '— messageId:', info.messageId);
  } catch (e) {
    console.error('[SMTP] Send error:', e.message, e.code || '');
  }
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) { req.user = null; return next(); }
  const token = header.replace('Bearer ', '');
  try { req.user = jwt.verify(token, JWT_SECRET); } catch { req.user = null; }
  next();
}

// ── AUTH ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length > 0) return res.status(409).json({ error: 'An account with this email already exists' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, profile_id, created_at',
      [email.toLowerCase(), hash]
    );
    const user = rows[0];
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: { id: user.id, email: user.email, profile_id: user.profile_id } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'No account found with this email' });
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    let profile = null;
    if (user.profile_id) {
      const p = await pool.query('SELECT * FROM user_profiles WHERE id = $1', [user.profile_id]);
      profile = p.rows[0] || null;
    }
    res.json({ token, user: { id: user.id, email: user.email, profile_id: user.profile_id }, profile });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, profile_id, created_at FROM users WHERE id = $1', [req.user.userId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];
    let profile = null;
    if (user.profile_id) {
      const p = await pool.query('SELECT * FROM user_profiles WHERE id = $1', [user.profile_id]);
      profile = p.rows[0] || null;
    }
    res.json({ user, profile });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/auth/link-profile', authMiddleware, async (req, res) => {
  try {
    const { profile_id } = req.body;
    await pool.query('UPDATE users SET profile_id = $1 WHERE id = $2', [profile_id, req.user.userId]);

    // If mentor/both role, auto-create a mentors directory entry linked to this user
    const { rows: pRows } = await pool.query('SELECT * FROM user_profiles WHERE id = $1', [profile_id]);
    const p = pRows[0];
    if (p && (p.role === 'mentor' || p.role === 'both')) {
      const existing = await pool.query('SELECT id FROM mentors WHERE linked_user_id = $1', [req.user.userId]);
      if (!existing.rows.length) {
        await pool.query(
          `INSERT INTO mentors (name, initials, role, level, category, specialty, subfield, institution, state, bio, tags, is_img, avatar_grad, photo, linked_user_id, match_score, years_exp, mentees_count, sessions_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,85,$16,0,0)`,
          [p.name, p.initials, p.role, p.level, p.category, p.specialty, p.subfield || '', p.institution || '', p.state || '', p.bio || '', p.tags || [], p.is_img, p.avatar_grad || '', p.photo || '', req.user.userId, parseInt(p.year) || 0]
        );
      }
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/auth/delete-account', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT profile_id FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];
    const profileId = user?.profile_id;
    // Clear the FK link on users first so we can delete the profile
    await pool.query('UPDATE users SET profile_id = NULL WHERE id = $1', [req.user.userId]);
    if (profileId) {
      await pool.query('DELETE FROM connections WHERE user_profile_id = $1', [profileId]);
      await pool.query('DELETE FROM schedule_requests WHERE user_profile_id = $1', [profileId]);
      await pool.query('DELETE FROM user_profiles WHERE id = $1', [profileId]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    // Always return success to prevent email enumeration
    if (!rows.length) return res.json({ success: true });
    const userId = rows[0].id;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [userId, token, expiresAt]
    );
    const host = req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const resetUrl = `${proto}://${host}/?reset_token=${token}`;
    await sendEmail(
      email.toLowerCase(),
      'Reset your NAAMA Mentor Connect password',
      `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0d1b2a;color:#fff;border-radius:12px;">
        <h2 style="color:#c9a84c;margin-bottom:8px;">Password Reset</h2>
        <p style="color:#8a9ab0;">We received a request to reset your password. Click the button below to set a new one.</p>
        <a href="${resetUrl}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#c9a84c;color:#0d1b2a;border-radius:10px;font-weight:700;text-decoration:none;">Reset Password</a>
        <p style="color:#8a9ab0;font-size:12px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
        <p style="color:#4a9b8e;margin-top:20px;">— NAAMA Mentor Connect</p>
      </div>`
    );
    res.json({ success: true });
  } catch (e) {
    console.error('Forgot password error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const { rows } = await pool.query(
      'SELECT * FROM password_reset_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()',
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    const resetRow = rows[0];
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, resetRow.user_id]);
    await pool.query('UPDATE password_reset_tokens SET used = TRUE WHERE id = $1', [resetRow.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MENTORS ──────────────────────────────────────────────────────────────────

app.get('/api/mentors', async (req, res) => {
  try {
    const { category, level, state, img, q } = req.query;
    let query = 'SELECT * FROM mentors WHERE 1=1';
    const params = [];
    if (category) { params.push(category); query += ` AND category = $${params.length}`; }
    if (level)    { params.push(level);    query += ` AND level = $${params.length}`; }
    if (state)    { params.push(state);    query += ` AND state = $${params.length}`; }
    if (img === 'true') { query += ' AND is_img = true'; }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      const n = params.length;
      query += ` AND (LOWER(name) LIKE $${n} OR LOWER(specialty) LIKE $${n} OR LOWER(institution) LIKE $${n} OR LOWER(state) LIKE $${n} OR LOWER(subfield) LIKE $${n} OR LOWER(bio) LIKE $${n})`;
    }
    query += ' ORDER BY match_score DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows.map(formatMentor));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/mentors/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM mentors WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(formatMentor(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mentors', async (req, res) => {
  try {
    const m = req.body;
    const { rows } = await pool.query(
      `INSERT INTO mentors (name, initials, role, level, category, specialty, subfield, institution, state, bio, tags, match_score, years_exp, mentees_count, sessions_count, is_img, avatar_grad, photo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [m.name, m.initials, m.role, m.level, m.category, m.specialty, m.subfield, m.institution, m.state, m.bio, m.tags || [], m.match_score || 90, m.years_exp || 0, m.mentees_count || 0, m.sessions_count || 0, m.is_img || false, m.avatar_grad || '', m.photo || '']
    );
    res.status(201).json(formatMentor(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/mentors/:id', async (req, res) => {
  try {
    const m = req.body;
    const { rows } = await pool.query(
      `UPDATE mentors SET name=$1, initials=$2, role=$3, level=$4, category=$5, specialty=$6, subfield=$7, institution=$8, state=$9, bio=$10, tags=$11, match_score=$12, years_exp=$13, mentees_count=$14, sessions_count=$15, is_img=$16, avatar_grad=$17, photo=$18 WHERE id=$19 RETURNING *`,
      [m.name, m.initials, m.role, m.level, m.category, m.specialty, m.subfield, m.institution, m.state, m.bio, m.tags || [], m.match_score || 90, m.years_exp || 0, m.mentees_count || 0, m.sessions_count || 0, m.is_img || false, m.avatar_grad || '', m.photo || '', req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(formatMentor(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/mentors/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM mentors WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function formatMentor(r) {
  return {
    id: r.id,
    name: r.name,
    initials: r.initials,
    role: r.role,
    level: r.level,
    category: r.category,
    specialty: r.specialty,
    subfield: r.subfield,
    institution: r.institution,
    state: r.state,
    bio: r.bio,
    tags: r.tags || [],
    match: r.match_score,
    mentees: r.mentees_count,
    sessions: r.sessions_count,
    years: r.years_exp,
    isIMG: r.is_img,
    avatarGrad: r.avatar_grad,
    photo: r.photo || '',
  };
}

// ── USER PROFILES ─────────────────────────────────────────────────────────────

app.post('/api/profiles', async (req, res) => {
  try {
    const p = req.body;
    const { rows } = await pool.query(
      `INSERT INTO user_profiles (name, initials, role, category, specialty, subfield, level, year, tags, state, institution, is_img, avatar_grad, photo, bio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [p.name, p.initials, p.role, p.category, p.specialty, p.subfield, p.level, p.year, p.tags || [], p.state || '', p.institution || '', p.isIMG || false, p.avatarGrad || '', p.photo || '', p.bio || '']
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/profiles', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM user_profiles ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/profiles/:id', async (req, res) => {
  try {
    const p = req.body;
    const { rows } = await pool.query(
      `UPDATE user_profiles SET name=$1, initials=$2, role=$3, category=$4, specialty=$5, subfield=$6, level=$7, year=$8, tags=$9, state=$10, institution=$11, is_img=$12, avatar_grad=$13, photo=$14, bio=$15
       WHERE id=$16 RETURNING *`,
      [p.name, p.initials, p.role, p.category, p.specialty, p.subfield, p.level, p.year, p.tags || [], p.state || '', p.institution || '', p.isIMG || false, p.avatarGrad || '', p.photo || '', p.bio || '', req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // Sync years_exp on the linked mentor row if one exists
    await pool.query(
      `UPDATE mentors SET years_exp=$1 WHERE linked_user_id = (SELECT id FROM users WHERE profile_id = $2)`,
      [parseInt(p.year) || 0, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/profiles/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM user_profiles WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CONNECTIONS ───────────────────────────────────────────────────────────────

app.post('/api/connections', optionalAuth, async (req, res) => {
  try {
    const { user_profile_id, mentor_id } = req.body;
    const userId = req.user?.userId || null;
    const { rows } = await pool.query(
      `INSERT INTO connections (user_profile_id, mentor_id, user_id, status) VALUES ($1,$2,$3,'pending')
       ON CONFLICT DO NOTHING RETURNING *`,
      [user_profile_id, mentor_id, userId]
    );
    await pool.query('UPDATE mentors SET mentees_count = mentees_count + 1 WHERE id = $1', [mentor_id]);

    // Send email notification to the user who made the connection
    try {
      const [userRes, mentorRes] = await Promise.all([
        pool.query(`SELECT u.email, up.name as profile_name FROM users u JOIN user_profiles up ON u.profile_id = up.id WHERE up.id = $1`, [user_profile_id]),
        pool.query('SELECT name, specialty, institution FROM mentors WHERE id = $1', [mentor_id]),
      ]);
      const user = userRes.rows[0];
      const mentor = mentorRes.rows[0];
      if (user?.email && mentor) {
        await sendEmail(
          user.email,
          `Your connection request to ${mentor.name} was sent!`,
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0d1b2a;color:#fff;border-radius:12px;">
            <h2 style="color:#c9a84c;margin-bottom:8px;">Connection Request Sent</h2>
            <p style="color:#8a9ab0;">Hi ${user.profile_name},</p>
            <p style="color:#8a9ab0;">Your mentorship request to <strong style="color:#fff">${mentor.name}</strong> (${mentor.specialty} · ${mentor.institution}) has been sent successfully.</p>
            <p style="color:#8a9ab0;">You'll hear back once they review your request. In the meantime, you can schedule a session from your dashboard.</p>
            <p style="color:#4a9b8e;margin-top:20px;">— NAAMA Mentor Connect</p>
          </div>`
        );
      }
    } catch (emailErr) {
      console.error('Connection email error:', emailErr.message);
    }

    res.status(201).json(rows[0] || { status: 'already_exists' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/connections/mine', authMiddleware, async (req, res) => {
  try {
    const cols = `c.id, c.user_profile_id, c.mentor_id, c.user_id, c.status, c.created_at,
      m.name as mentor_name, m.specialty as mentor_specialty, m.institution as mentor_institution,
      m.avatar_grad as mentor_avatar_grad, m.photo as mentor_photo, m.initials as mentor_initials,
      m.linked_user_id as mentor_linked_user_id,
      up.name as mentee_name, up.initials as mentee_initials, up.photo as mentee_photo`;

    const [asMentee, asMentor] = await Promise.all([
      pool.query(
        `SELECT ${cols} FROM connections c
         JOIN mentors m ON c.mentor_id = m.id
         LEFT JOIN user_profiles up ON c.user_profile_id = up.id
         WHERE c.user_id = $1 ORDER BY c.created_at DESC`,
        [req.user.userId]
      ),
      pool.query(
        `SELECT ${cols} FROM connections c
         JOIN mentors m ON c.mentor_id = m.id
         LEFT JOIN user_profiles up ON c.user_profile_id = up.id
         WHERE m.linked_user_id = $1 ORDER BY c.created_at DESC`,
        [req.user.userId]
      ),
    ]);
    res.json({ asMentee: asMentee.rows, asMentor: asMentor.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/connections', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, up.name as user_name, m.name as mentor_name FROM connections c
       LEFT JOIN user_profiles up ON c.user_profile_id = up.id
       LEFT JOIN mentors m ON c.mentor_id = m.id
       ORDER BY c.created_at DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/connections/:id/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['accepted', 'declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { rows } = await pool.query(
      'UPDATE connections SET status=$1 WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MESSAGES ──────────────────────────────────────────────────────────────────

app.get('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { connection_id } = req.query;
    if (!connection_id) return res.status(400).json({ error: 'connection_id required' });
    const { rows } = await pool.query(
      'SELECT * FROM messages WHERE connection_id=$1 ORDER BY created_at ASC',
      [connection_id]
    );
    await pool.query(
      'UPDATE messages SET is_read=true WHERE connection_id=$1 AND sender_user_id!=$2',
      [connection_id, req.user.userId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { connection_id, content } = req.body;
    if (!connection_id || !content?.trim()) return res.status(400).json({ error: 'connection_id and content required' });
    const { rows } = await pool.query(
      'INSERT INTO messages (connection_id, sender_user_id, content) VALUES ($1,$2,$3) RETURNING *',
      [connection_id, req.user.userId, content.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SCHEDULE REQUESTS ─────────────────────────────────────────────────────────

app.post('/api/schedule-requests', async (req, res) => {
  try {
    const r = req.body;
    const { rows } = await pool.query(
      `INSERT INTO schedule_requests (mentee_name, mentee_initials, mentee_photo, user_profile_id, meeting_type, meeting_date, meeting_time, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [r.mentee, r.menteeInitials, r.menteePhoto || '', r.user_profile_id || null, r.type, r.date, r.time, r.note || '']
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/schedule-requests', async (req, res) => {
  try {
    const { user_profile_id } = req.query;
    let query = 'SELECT * FROM schedule_requests';
    const params = [];
    if (user_profile_id) {
      query += ' WHERE user_profile_id = $1';
      params.push(user_profile_id);
    }
    query += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows.map(r => ({
      id: r.id,
      mentee: r.mentee_name,
      menteeInitials: r.mentee_initials,
      menteePhoto: r.mentee_photo,
      type: r.meeting_type,
      date: r.meeting_date,
      time: r.meeting_time,
      note: r.note,
      status: r.status,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/schedule-requests/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const { rows } = await pool.query(
      'UPDATE schedule_requests SET status=$1 WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/schedule-requests/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM schedule_requests WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────

app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const [mentors, profiles, connections, requests] = await Promise.all([
      pool.query('SELECT * FROM mentors ORDER BY created_at DESC'),
      pool.query('SELECT * FROM user_profiles ORDER BY created_at DESC'),
      pool.query(`SELECT c.*, up.name as user_name, m.name as mentor_name
                  FROM connections c
                  LEFT JOIN user_profiles up ON c.user_profile_id = up.id
                  LEFT JOIN mentors m ON c.mentor_id = m.id
                  ORDER BY c.created_at DESC`),
      pool.query('SELECT * FROM schedule_requests ORDER BY created_at DESC'),
    ]);
    res.json({
      stats: {
        mentors: mentors.rowCount,
        profiles: profiles.rowCount,
        connections: connections.rowCount,
        requests: requests.rowCount,
        pending: requests.rows.filter(r => r.status === 'pending').length,
      },
      mentors: mentors.rows.map(formatMentor),
      profiles: profiles.rows,
      connections: connections.rows,
      requests: requests.rows.map(r => ({
        id: r.id,
        mentee: r.mentee_name,
        menteeInitials: r.mentee_initials,
        type: r.meeting_type,
        date: r.meeting_date,
        time: r.meeting_time,
        note: r.note,
        status: r.status,
        created_at: r.created_at,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STATIC (PRODUCTION) ───────────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '../dist');
  app.use(express.static(distPath));
  app.get('*', (_, res) => res.sendFile(path.join(distPath, 'index.html')));
}

app.listen(PORT, () => console.log(`API server running on port ${PORT}`));
