import express from 'express';
import cors from 'cors';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import webpush from 'web-push';
import nodemailer from 'nodemailer';

const { Pool } = pg;
const app = express();
const PORT = process.env.NODE_ENV === 'production' ? (process.env.PORT || 5000) : 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = process.env.JWT_SECRET || 'naama-connect-secret-key-2025';


const SMTP_USER = (process.env.SMTP_USER || 'naamamentorconnect@gmail.com').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s/g, '');
const mailer = SMTP_PASS
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

async function sendEmail(to, subject, html) {
  if (!mailer) return;
  try {
    await mailer.sendMail({ from: `"NAAMA Mentor Connect" <${SMTP_USER}>`, to, subject, html });
  } catch (e) {
    console.error('[SMTP] Send error:', e.message);
  }
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });


// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:naamamentorconnect@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log('[PUSH] VAPID configured');
} else {
  console.log('[PUSH] VAPID keys not set — push disabled');
}

async function sendPushNotification(userId, title, body, url = '/') {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  try {
    const { rows } = await pool.query('SELECT subscription FROM push_subscriptions WHERE user_id = $1', [userId]);
    if (!rows.length) return;
    await webpush.sendNotification(rows[0].subscription, JSON.stringify({ title, body, url }));
    console.log('[PUSH] Sent to user', userId, ':', title);
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]).catch(() => {});
    } else {
      console.error('[PUSH] Error sending to user', userId, ':', e.message);
    }
  }
}

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

    // Welcome email (fire-and-forget)
    sendEmail(
      user.email,
      'Welcome to NAAMA Mentor Connect!',
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#1e3a5f;color:#fff;border-radius:16px;">
        <h1 style="color:#c9a84c;margin:0 0 8px;">Welcome to NAAMA Mentor Connect</h1>
        <p style="color:#8a9ab0;margin:0 0 20px;">Your account has been created successfully.</p>
        <p style="color:#e0e8f0;margin:0 0 16px;">
          You now have access to a network of Arab American medical professionals ready to guide, collaborate, and grow with you.
        </p>
        <p style="color:#e0e8f0;margin:0 0 24px;">
          Complete your profile, explore mentors in your specialty, and send your first connection request to get started.
        </p>
        <a href="https://naamamentorconnect.replit.app"
           style="display:inline-block;padding:12px 28px;background:#c9a84c;color:#1e3a5f;border-radius:10px;font-weight:700;text-decoration:none;font-size:15px;">
          Go to My Dashboard
        </a>
        <p style="color:#4a9b8e;margin:28px 0 0;font-size:13px;">— The NAAMA Mentor Connect Team</p>
      </div>`
    ).catch(() => {});
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
    res.json({ token, user: { id: user.id, email: user.email, profile_id: user.profile_id, is_active: user.is_active !== false }, profile });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, profile_id, is_active, created_at FROM users WHERE id = $1', [req.user.userId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];
    user.is_active = user.is_active !== false;
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

app.put('/api/auth/toggle-active', authMiddleware, async (req, res) => {
  try {
    const { is_active } = req.body;
    await pool.query('UPDATE users SET is_active=$1 WHERE id=$2', [is_active, req.user.userId]);
    // Also toggle the linked mentor row visibility
    await pool.query('UPDATE mentors SET is_active=$1 WHERE linked_user_id=$2', [is_active, req.user.userId]);
    res.json({ success: true, is_active });
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
          `INSERT INTO mentors (name, initials, role, level, category, specialty, subfield, institution, state, bio, tags, is_img, avatar_grad, photo, linked_user_id, match_score, years_exp, year_set_date, mentees_count, sessions_count, specialties)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,85,$16,CURRENT_DATE,0,0,$17)`,
          [p.name, p.initials, p.role, p.level, p.category, p.specialty, p.subfield || '', p.institution || '', p.state || '', p.bio || '', p.tags || [], p.is_img, p.avatar_grad || '', p.photo || '', req.user.userId, parseInt(p.year) || 0, p.specialties || []]
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

    // Look up the mentor row (if this user is a mentor) to get mentor.id for FK cleanup
    const { rows: mentorRows } = await pool.query('SELECT id FROM mentors WHERE linked_user_id = $1', [req.user.userId]);
    const mentorId = mentorRows[0]?.id;

    // Step 1: Delete connections referencing this mentor row BEFORE deleting the mentor
    // (connections_mentor_id_fkey: connections.mentor_id → mentors.id)
    if (mentorId) {
      await pool.query('DELETE FROM connections WHERE mentor_id = $1', [mentorId]);
    }

    // Step 2: Delete schedule_requests that reference this mentor user
    await pool.query('DELETE FROM schedule_requests WHERE mentor_user_id = $1', [req.user.userId]);

    // Step 3: Now safe to delete the mentor row
    await pool.query('DELETE FROM mentors WHERE linked_user_id = $1', [req.user.userId]);

    // Step 4: Delete connections where this user is the mentee
    await pool.query('DELETE FROM connections WHERE user_id = $1', [req.user.userId]);

    // Step 5: Clear the FK link on users so we can delete the profile
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
    console.log('[PASSWORD RESET] Reset URL for', email.toLowerCase(), ':', resetUrl);
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
    let query = 'SELECT * FROM mentors WHERE is_active = true';
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
      `INSERT INTO mentors (name, initials, role, level, category, specialty, subfield, institution, state, bio, tags, match_score, years_exp, mentees_count, sessions_count, is_img, avatar_grad, photo, specialties)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [m.name, m.initials, m.role, m.level, m.category, m.specialty, m.subfield, m.institution, m.state, m.bio, m.tags || [], m.match_score || 90, m.years_exp || 0, m.mentees_count || 0, m.sessions_count || 0, m.is_img || false, m.avatar_grad || '', m.photo || '', m.specialties || []]
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
      `UPDATE mentors SET name=$1, initials=$2, role=$3, level=$4, category=$5, specialty=$6, subfield=$7, institution=$8, state=$9, bio=$10, tags=$11, match_score=$12, years_exp=$13, mentees_count=$14, sessions_count=$15, is_img=$16, avatar_grad=$17, photo=$18, specialties=$19 WHERE id=$20 RETURNING *`,
      [m.name, m.initials, m.role, m.level, m.category, m.specialty, m.subfield, m.institution, m.state, m.bio, m.tags || [], m.match_score || 90, m.years_exp || 0, m.mentees_count || 0, m.sessions_count || 0, m.is_img || false, m.avatar_grad || '', m.photo || '', m.specialties || [], req.params.id]
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
    specialties: r.specialties || [],
    institution: r.institution,
    state: r.state,
    bio: r.bio,
    tags: r.tags || [],
    match: r.match_score,
    mentees: r.mentees_count,
    sessions: r.sessions_count,
    years: r.years_exp,
    yearSetDate: r.year_set_date || null,
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
      `INSERT INTO user_profiles (name, initials, role, category, specialty, subfield, level, year, tags, state, institution, is_img, avatar_grad, photo, bio, specialties)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [p.name, p.initials, p.role, p.category, p.specialty, p.subfield, p.level, p.year, p.tags || [], p.state || '', p.institution || '', p.isIMG || false, p.avatarGrad || '', p.photo || '', p.bio || '', p.specialties || []]
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
      `UPDATE user_profiles SET name=$1, initials=$2, role=$3, category=$4, specialty=$5, subfield=$6, level=$7, year=$8, tags=$9, state=$10, institution=$11, is_img=$12, avatar_grad=$13, photo=$14, bio=$15, year_set_date=CURRENT_DATE, specialties=$16
       WHERE id=$17 RETURNING *`,
      [p.name, p.initials, p.role, p.category, p.specialty, p.subfield, p.level, p.year, p.tags || [], p.state || '', p.institution || '', p.isIMG || false, p.avatarGrad || '', p.photo || '', p.bio || '', p.specialties || [], req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // Keep the linked mentor directory row in sync with the edited profile
    await pool.query(
      `UPDATE mentors SET name=$1, initials=$2, role=$3, level=$4, category=$5, specialty=$6, subfield=$7,
         institution=$8, state=$9, bio=$10, tags=$11, is_img=$12, avatar_grad=$13, photo=$14,
         specialties=$15, years_exp=$16, year_set_date=CURRENT_DATE
       WHERE linked_user_id = (SELECT id FROM users WHERE profile_id = $17)`,
      [p.name, p.initials, p.role, p.level, p.category, p.specialty, p.subfield,
       p.institution || '', p.state || '', p.bio || '', p.tags || [], p.isIMG || false,
       p.avatarGrad || '', p.photo || '', p.specialties || [], parseInt(p.year) || 0, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/profiles/:id', async (req, res) => {
  try {
    const id = req.params.id;
    // Cascade: remove dependent rows before deleting the profile
    await pool.query('DELETE FROM schedule_requests WHERE user_profile_id = $1', [id]);
    await pool.query('DELETE FROM connections WHERE user_profile_id = $1', [id]);
    await pool.query('UPDATE users SET profile_id = NULL WHERE profile_id = $1', [id]);
    await pool.query('DELETE FROM user_profiles WHERE id = $1', [id]);
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
    const { is_collab } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO connections (user_profile_id, mentor_id, user_id, status, is_collab) VALUES ($1,$2,$3,'pending',$4)
       ON CONFLICT DO NOTHING RETURNING *`,
      [user_profile_id, mentor_id, userId, is_collab ? true : false]
    );
    await pool.query('UPDATE mentors SET mentees_count = mentees_count + 1 WHERE id = $1', [mentor_id]);

    const connectionId = rows[0]?.id;

    // Immediate push notification to the mentor
    if (connectionId) {
      const { is_collab: ic } = req.body;
      pool.query(
        `SELECT m.linked_user_id as mentor_user_id, up.name as mentee_name
         FROM mentors m, user_profiles up
         WHERE m.id = $1 AND up.id = $2`,
        [mentor_id, user_profile_id]
      ).then(({ rows: pr }) => {
        if (pr[0]?.mentor_user_id) {
          const label = ic ? 'Collaboration' : 'Mentorship';
          sendPushNotification(
            pr[0].mentor_user_id,
            `New ${label} Request`,
            `${pr[0].mentee_name} has sent you a ${label.toLowerCase()} request.`
          ).catch(() => {});
        }
      }).catch(() => {});
    }

    res.status(201).json(rows[0] || { status: 'already_exists' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/connections/mine', authMiddleware, async (req, res) => {
  try {
    const cols = `c.id, c.user_profile_id, c.mentor_id, c.user_id, c.status, c.created_at, c.is_collab,
      m.name as mentor_name, m.specialty as mentor_specialty, m.institution as mentor_institution,
      m.avatar_grad as mentor_avatar_grad, m.photo as mentor_photo, m.initials as mentor_initials,
      m.linked_user_id as mentor_linked_user_id,
      COALESCE(m.is_active, true) as mentor_is_active,
      up.name as mentee_name, up.initials as mentee_initials, up.photo as mentee_photo,
      COALESCE(u_mentee.is_active, true) as mentee_is_active,
      mc.name as collab_mentor_name, mc.specialty as collab_mentor_specialty,
      mc.photo as collab_mentor_photo, mc.initials as collab_mentor_initials,
      mc.avatar_grad as collab_mentor_avatar_grad`;

    const [asMentee, asMentor] = await Promise.all([
      pool.query(
        `SELECT ${cols} FROM connections c
         JOIN mentors m ON c.mentor_id = m.id
         LEFT JOIN user_profiles up ON c.user_profile_id = up.id
         LEFT JOIN users u_mentee ON u_mentee.id = c.user_id
         LEFT JOIN mentors mc ON mc.linked_user_id = c.user_id
         WHERE c.user_id = $1 ORDER BY c.created_at DESC`,
        [req.user.userId]
      ),
      pool.query(
        `SELECT ${cols} FROM connections c
         JOIN mentors m ON c.mentor_id = m.id
         LEFT JOIN user_profiles up ON c.user_profile_id = up.id
         LEFT JOIN users u_mentee ON u_mentee.id = c.user_id
         LEFT JOIN mentors mc ON mc.linked_user_id = c.user_id
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

    // Notify the mentee that their connection request was accepted or declined
    pool.query(
      `SELECT c.user_id as mentee_user_id, up.name as mentee_name,
              m.name as mentor_name, m.specialty as mentor_specialty
       FROM connections c
       JOIN mentors m ON c.mentor_id = m.id
       LEFT JOIN user_profiles up ON up.id = c.user_profile_id
       WHERE c.id = $1`,
      [req.params.id]
    ).then(({ rows: p }) => {
      const party = p[0];
      if (!party) return;
      const isAccepted = status === 'accepted';
      if (party.mentee_user_id) {
        sendPushNotification(
          party.mentee_user_id,
          isAccepted ? 'Connection Accepted!' : 'Connection Update',
          isAccepted
            ? `${party.mentor_name} has accepted your mentorship request.`
            : `${party.mentor_name} was unable to accept your request at this time.`
        ).catch(() => {});
      }
    }).catch(err => console.error('Connection status email error:', err.message));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/connections/:id', authMiddleware, async (req, res) => {
  try {
    // Allow deletion only if the requesting user is the mentee or the mentor in this connection
    const { rows } = await pool.query(
      `SELECT c.id FROM connections c
       JOIN mentors m ON c.mentor_id = m.id
       WHERE c.id = $1 AND (c.user_id = $2 OR m.linked_user_id = $2)`,
      [req.params.id, req.user.userId]
    );
    if (!rows.length) return res.status(403).json({ error: 'Not authorized or not found' });

    const connId = Number(req.params.id);
    await pool.query('DELETE FROM connections WHERE id = $1', [connId]);
    res.json({ success: true });
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

    // Push notification to the recipient
    pool.query(
      `SELECT c.user_id as mentee_user_id, m.linked_user_id as mentor_user_id,
              m.name as mentor_name, up.name as mentee_name
       FROM connections c
       JOIN mentors m ON c.mentor_id = m.id
       LEFT JOIN user_profiles up ON c.user_profile_id = up.id
       WHERE c.id = $1`,
      [connection_id]
    ).then(({ rows: connRows }) => {
      if (!connRows.length) return;
      const conn = connRows[0];
      const isSenderMentee = conn.mentee_user_id === req.user.userId;
      const senderName = isSenderMentee ? conn.mentee_name : conn.mentor_name;
      const recipientUserId = isSenderMentee ? conn.mentor_user_id : conn.mentee_user_id;
      const pushPreview = content.trim().length > 80 ? content.trim().slice(0, 80) + '…' : content.trim();
      if (recipientUserId) sendPushNotification(recipientUserId, `New message from ${senderName}`, pushPreview).catch(() => {});
    }).catch(() => {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/messages/conversations', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { rows } = await pool.query(
      `SELECT
         c.id, c.user_id, c.is_collab,
         m.name as mentor_name, m.specialty as mentor_specialty,
         m.photo as mentor_photo, m.initials as mentor_initials,
         m.avatar_grad as mentor_avatar_grad, m.linked_user_id as mentor_linked_user_id,
         up.name as mentee_name, up.initials as mentee_initials, up.photo as mentee_photo,
         last_msg.content as last_message,
         last_msg.created_at as last_message_at,
         last_msg.sender_user_id as last_sender_id,
         (SELECT COUNT(*)::int FROM messages
          WHERE connection_id = c.id AND sender_user_id != $1 AND is_read = false) as unread_count
       FROM connections c
       JOIN mentors m ON c.mentor_id = m.id
       LEFT JOIN user_profiles up ON c.user_profile_id = up.id
       LEFT JOIN LATERAL (
         SELECT content, created_at, sender_user_id FROM messages
         WHERE connection_id = c.id
         ORDER BY created_at DESC LIMIT 1
       ) last_msg ON true
       WHERE (c.user_id = $1 OR m.linked_user_id = $1) AND c.status = 'accepted'
       ORDER BY last_message_at DESC NULLS LAST`,
      [userId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SCHEDULE REQUESTS ─────────────────────────────────────────────────────────

app.post('/api/schedule-requests', async (req, res) => {
  try {
    const r = req.body;
    const { rows } = await pool.query(
      `INSERT INTO schedule_requests (mentee_name, mentee_initials, mentee_photo, user_profile_id, meeting_type, meeting_date, meeting_time, note, mentor_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [r.mentee, r.menteeInitials, r.menteePhoto || '', r.user_profile_id || null, r.type, r.date, r.time, r.note || '', r.mentor_user_id || null]
    );
    res.status(201).json(rows[0]);

    if (r.mentor_user_id) {
      sendPushNotification(r.mentor_user_id, 'New Session Request', `${r.mentee} has requested a session with you.`).catch(() => {});
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/schedule-requests', async (req, res) => {
  try {
    const { user_profile_id, mentor_user_id } = req.query;
    let query = `SELECT sr.*, m.name as mentor_name, m.photo as mentor_photo, m.initials as mentor_initials, m.avatar_grad as mentor_avatar_grad
                 FROM schedule_requests sr
                 LEFT JOIN mentors m ON m.linked_user_id = sr.mentor_user_id`;
    const params = [];
    if (user_profile_id) {
      query += ' WHERE sr.user_profile_id = $1';
      params.push(user_profile_id);
    } else if (mentor_user_id) {
      query += ' WHERE sr.mentor_user_id = $1';
      params.push(mentor_user_id);
    }
    query += ' ORDER BY sr.created_at DESC';
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
      mentor_user_id: r.mentor_user_id,
      mentorName: r.mentor_name || null,
      mentorPhoto: r.mentor_photo || '',
      mentorInitials: r.mentor_initials || '?',
      mentorAvatarGrad: r.mentor_avatar_grad || 'linear-gradient(135deg,#c9a84c,#4a9b8e)',
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper: look up both parties for a schedule request
async function getScheduleParties(requestId) {
  const { rows } = await pool.query(
    `SELECT sr.mentee_name, sr.meeting_type, sr.meeting_date, sr.meeting_time, sr.mentor_user_id,
            u_mentee.email as mentee_email, u_mentee.id as mentee_user_id,
            u_mentor.email as mentor_email,
            m.name as mentor_name
     FROM schedule_requests sr
     LEFT JOIN user_profiles up ON up.id = sr.user_profile_id
     LEFT JOIN users u_mentee ON u_mentee.profile_id = up.id
     LEFT JOIN users u_mentor ON u_mentor.id = sr.mentor_user_id
     LEFT JOIN mentors m ON m.linked_user_id = sr.mentor_user_id
     WHERE sr.id = $1`,
    [requestId]
  );
  return rows[0] || null;
}

app.put('/api/schedule-requests/:id', async (req, res) => {
  try {
    const { status, date, time, type, note, action } = req.body;
    let rows;

    if (action === 'reschedule' || date || time || type) {
      // Reschedule: update fields and reset to pending
      const result = await pool.query(
        `UPDATE schedule_requests
         SET meeting_date = COALESCE($1, meeting_date),
             meeting_time = COALESCE($2, meeting_time),
             meeting_type = COALESCE($3, meeting_type),
             note         = COALESCE($4, note),
             status       = 'pending'
         WHERE id = $5 RETURNING *`,
        [date || null, time || null, type || null, note !== undefined ? note : null, req.params.id]
      );
      rows = result.rows;
      // Notify both parties
      const p = await getScheduleParties(req.params.id);
      if (p) {
        const by = req.body.rescheduled_by === 'mentor' ? p.mentor_name : p.mentee_name;
        const newDate = date || p.meeting_date;
        const newTime = time || p.meeting_time;
        if (req.body.rescheduled_by === 'mentor') {
          if (p.mentee_user_id) sendPushNotification(p.mentee_user_id, 'Session Rescheduled', `${p.mentor_name || 'Your mentor'} proposed a new time: ${newDate} at ${newTime}.`).catch(() => {});
        }
        if (req.body.rescheduled_by === 'mentee') {
          if (p.mentor_user_id) sendPushNotification(p.mentor_user_id, 'Session Rescheduled', `${p.mentee_name} proposed a new time: ${newDate} at ${newTime}.`).catch(() => {});
        }
      }
    } else {
      // Status-only update (confirm / decline / cancel)
      const result = await pool.query(
        'UPDATE schedule_requests SET status=$1 WHERE id=$2 RETURNING *',
        [status, req.params.id]
      );
      rows = result.rows;
      // Send confirmation notification to mentee
      if (status === 'confirmed') {
        getScheduleParties(req.params.id).then(p => {
          if (!p) return;
          if (p.mentee_user_id) sendPushNotification(p.mentee_user_id, 'Session Confirmed!', `${p.mentor_name || 'Your mentor'} confirmed your session on ${p.meeting_date} at ${p.meeting_time}.`).catch(() => {});
        }).catch(() => {});
      }
      // Send cancellation notifications
      if (status === 'cancelled') {
        const p = await getScheduleParties(req.params.id);
        if (p) {
          if (req.body.cancelled_by === 'mentor') {
            if (p.mentee_user_id) sendPushNotification(p.mentee_user_id, 'Session Cancelled', `${p.mentor_name || 'Your mentor'} cancelled your session on ${p.meeting_date}.`).catch(() => {});
          }
          if (req.body.cancelled_by === 'mentee') {
            if (p.mentor_user_id) sendPushNotification(p.mentor_user_id, 'Session Cancelled', `${p.mentee_name} cancelled the session on ${p.meeting_date}.`).catch(() => {});
          }
        }
      }
    }

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

// ── STARTUP MIGRATIONS ────────────────────────────────────────────────────────
// ── PUSH SUBSCRIPTION ENDPOINTS ───────────────────────────────────────────────
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Subscription required' });
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, subscription) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET subscription = $2`,
      [req.user.userId, JSON.stringify(subscription)]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/push/subscribe', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1', [req.user.userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function runMigrations() {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true`);
    await pool.query(`ALTER TABLE mentors ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true`);
    await pool.query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS year_set_date DATE DEFAULT CURRENT_DATE`);
    await pool.query(`ALTER TABLE mentors ADD COLUMN IF NOT EXISTS year_set_date DATE DEFAULT CURRENT_DATE`);
    await pool.query(`ALTER TABLE schedule_requests ADD COLUMN IF NOT EXISTS mentor_user_id INTEGER`);
    await pool.query(`ALTER TABLE schedule_requests ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(20)`);
    await pool.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS is_collab BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS specialties TEXT[] DEFAULT '{}'`);
    await pool.query(`ALTER TABLE mentors ADD COLUMN IF NOT EXISTS specialties TEXT[] DEFAULT '{}'`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id)
      )
    `);

    // Step 1: Delete connections for mentors whose linked user account is gone
    // (must happen BEFORE deleting the mentor rows to satisfy the FK constraint)
    await pool.query(`
      DELETE FROM connections
      WHERE mentor_id IN (
        SELECT id FROM mentors
        WHERE linked_user_id IS NOT NULL
          AND linked_user_id NOT IN (SELECT id FROM users)
      )
    `);

    // Step 2: Now safe to delete orphaned mentor rows
    await pool.query(`
      DELETE FROM mentors
      WHERE linked_user_id IS NOT NULL
        AND linked_user_id NOT IN (SELECT id FROM users)
    `);

    // Step 3: Delete any remaining connections pointing to mentor rows that no longer exist
    await pool.query(`
      DELETE FROM connections
      WHERE mentor_id NOT IN (SELECT id FROM mentors)
    `);

    // Step 4: Delete connections where the mentee's user account has been deleted
    await pool.query(`
      DELETE FROM connections
      WHERE user_id IS NOT NULL
        AND user_id NOT IN (SELECT id FROM users)
    `);

    // Step 5: Clean up schedule_requests where the mentee's profile has been deleted
    await pool.query(`
      DELETE FROM schedule_requests
      WHERE user_profile_id IS NOT NULL
        AND user_profile_id NOT IN (SELECT id FROM user_profiles)
    `);

    console.log('[DB] Migrations applied');
  } catch (e) {
    console.error('[DB] Migration error:', e.message);
  }
}

runMigrations().then(() => {
  app.listen(PORT, () => console.log(`API server running on port ${PORT}`));
});
