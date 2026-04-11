import express from 'express';
import cors from 'cors';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const app = express();
const PORT = process.env.NODE_ENV === 'production' ? (process.env.PORT || 5000) : 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
      `INSERT INTO user_profiles (name, initials, role, category, specialty, subfield, level, year, tags, state, is_img, avatar_grad, photo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [p.name, p.initials, p.role, p.category, p.specialty, p.subfield, p.level, p.year, p.tags || [], p.state || '', p.isIMG || false, p.avatarGrad || '', p.photo || '']
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

app.delete('/api/profiles/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM user_profiles WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CONNECTIONS ───────────────────────────────────────────────────────────────

app.post('/api/connections', async (req, res) => {
  try {
    const { user_profile_id, mentor_id } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO connections (user_profile_id, mentor_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING RETURNING *`,
      [user_profile_id, mentor_id]
    );
    // bump mentor mentees count
    await pool.query('UPDATE mentors SET mentees_count = mentees_count + 1 WHERE id = $1', [mentor_id]);
    res.status(201).json(rows[0] || { status: 'already_exists' });
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
    const { rows } = await pool.query('SELECT * FROM schedule_requests ORDER BY created_at DESC');
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
