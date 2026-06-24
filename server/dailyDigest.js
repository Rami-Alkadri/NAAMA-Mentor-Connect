// Daily notification digest.
// Run by a Replit Scheduled Deployment (e.g. every day at 23:00 ET / America/New_York).
// Sends each active user an email summarizing THEIR own outstanding notifications:
//   - pending connection / collaboration requests they received
//   - pending session requests they received
//   - unread messages
// Users with no notifications are skipped (no empty emails).
//
// Usage:
//   node server/dailyDigest.js            -> sends emails
//   node server/dailyDigest.js --dry-run  -> prints what would be sent, sends nothing

import 'dotenv/config';
import pg from 'pg';
import nodemailer from 'nodemailer';

const { Pool } = pg;
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DIGEST_DRY_RUN === '1';

const SMTP_USER = (process.env.SMTP_USER || 'naamamentorconnect@gmail.com').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s/g, '');
const APP_URL = process.env.APP_URL || 'https://naamamentorconnect.replit.app';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const mailer = SMTP_PASS
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

async function sendEmail(to, subject, html) {
  if (!mailer) {
    console.warn('[digest] No SMTP configured — cannot send email to', to);
    return false;
  }
  try {
    await mailer.sendMail({ from: `"NAAMA Mentor Connect" <${SMTP_USER}>`, to, subject, html });
    return true;
  } catch (e) {
    console.error('[digest] Send error to', to, '-', e.message);
    return false;
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rowHtml(emoji, title, sub) {
  return `<tr><td style="padding:12px 16px;border-bottom:1px solid rgba(201,168,76,0.18);">
    <div style="font-size:14px;font-weight:600;color:#ffffff;">${emoji} ${title}</div>
    ${sub ? `<div style="font-size:13px;color:#8a9ab0;margin-top:3px;">${sub}</div>` : ''}
  </td></tr>`;
}

function buildDigestHtml(name, items) {
  const greeting = name ? `Hi ${esc(name.split(' ')[0])},` : 'Hello,';
  const rows = items.map(it => rowHtml(it.emoji, it.title, it.sub)).join('');
  return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#1e3a5f;color:#fff;border-radius:16px;">
    <h1 style="color:#c9a84c;margin:0 0 6px;font-size:22px;">Your daily summary</h1>
    <p style="color:#8a9ab0;margin:0 0 4px;font-size:14px;">NAAMA Mentor Connect</p>
    <p style="color:#e0e8f0;margin:18px 0 16px;font-size:15px;">${greeting} here's what's waiting for you:</p>
    <table style="width:100%;border-collapse:collapse;background:rgba(255,255,255,0.05);border-radius:12px;overflow:hidden;">
      ${rows}
    </table>
    <a href="${APP_URL}"
       style="display:inline-block;margin-top:24px;padding:12px 28px;background:#c9a84c;color:#1e3a5f;border-radius:10px;font-weight:700;text-decoration:none;font-size:15px;">
      Open Mentor Connect
    </a>
    <p style="color:#4a9b8e;margin:28px 0 0;font-size:13px;">— The NAAMA Mentor Connect Team</p>
    <p style="color:#5a6a80;margin:14px 0 0;font-size:11px;">You're receiving this daily summary because you have an active NAAMA Mentor Connect account.</p>
  </div>`;
}

async function run() {
  const startedAt = new Date();
  console.log(`[digest] Starting${DRY_RUN ? ' (DRY RUN)' : ''} at ${startedAt.toISOString()}`);

  // All users (with their display name from their linked profile)
  const { rows: users } = await pool.query(
    `SELECT u.id, u.email, COALESCE(u.is_active, true) AS is_active, up.name AS name
     FROM users u
     LEFT JOIN user_profiles up ON up.id = u.profile_id`
  );

  // Pending connection / collaboration requests, keyed by the mentor's user id
  const { rows: connReqs } = await pool.query(
    `SELECT m.linked_user_id AS uid, c.is_collab, COALESCE(up.name, 'A member') AS mentee_name
     FROM connections c
     JOIN mentors m ON c.mentor_id = m.id
     LEFT JOIN user_profiles up ON c.user_profile_id = up.id
     WHERE c.status = 'pending' AND m.linked_user_id IS NOT NULL`
  );

  // Pending session requests, keyed by the mentor's user id
  const { rows: schedReqs } = await pool.query(
    `SELECT mentor_user_id AS uid, mentee_name, meeting_type, meeting_date, meeting_time
     FROM schedule_requests
     WHERE status = 'pending' AND mentor_user_id IS NOT NULL`
  );

  // Unread messages, keyed by the recipient's user id (the participant who didn't send it)
  const { rows: unread } = await pool.query(
    `SELECT
       CASE WHEN msg.sender_user_id = c.user_id THEN m.linked_user_id ELSE c.user_id END AS uid,
       COALESCE(sup.name, 'A member') AS sender_name,
       COUNT(*)::int AS cnt
     FROM messages msg
     JOIN connections c ON msg.connection_id = c.id
     JOIN mentors m ON c.mentor_id = m.id
     LEFT JOIN users su ON su.id = msg.sender_user_id
     LEFT JOIN user_profiles sup ON sup.id = su.profile_id
     WHERE msg.is_read = false AND c.status = 'accepted'
     GROUP BY uid, sender_name`
  );

  // Index by user id
  const byUser = new Map();
  const bucket = (uid) => {
    if (uid == null) return null;
    if (!byUser.has(uid)) byUser.set(uid, { conn: [], sched: [], unread: [] });
    return byUser.get(uid);
  };
  connReqs.forEach(r => { const b = bucket(r.uid); if (b) b.conn.push(r); });
  schedReqs.forEach(r => { const b = bucket(r.uid); if (b) b.sched.push(r); });
  unread.forEach(r => { const b = bucket(r.uid); if (b) b.unread.push(r); });

  let sent = 0, skipped = 0, failed = 0;

  for (const user of users) {
    if (!user.email || user.is_active === false) { skipped++; continue; }
    const data = byUser.get(user.id);
    if (!data) { skipped++; continue; }

    const items = [];

    for (const c of data.conn) {
      const kind = c.is_collab ? 'collaboration' : 'mentorship';
      items.push({ emoji: '🤝', title: `New ${kind} request`, sub: `From ${esc(c.mentee_name)}` });
    }
    for (const s of data.sched) {
      const bits = [s.mentee_name, s.meeting_type, s.meeting_date].filter(Boolean).map(esc).join(' · ');
      items.push({ emoji: '📅', title: 'New session request', sub: bits });
    }
    const unreadTotal = data.unread.reduce((sum, u) => sum + u.cnt, 0);
    if (unreadTotal > 0) {
      const senders = data.unread.map(u => `${esc(u.sender_name)} (${u.cnt})`).join(', ');
      items.push({ emoji: '💬', title: `${plural(unreadTotal, 'unread message')}`, sub: `From ${senders}` });
    }

    if (items.length === 0) { skipped++; continue; }

    const html = buildDigestHtml(user.name, items);
    const count = items.length;
    const subject = `You have ${plural(count, 'new notification')} on NAAMA Mentor Connect`;

    if (DRY_RUN) {
      console.log(`[digest] WOULD SEND to ${user.email}: ${items.map(i => i.title).join(' | ')}`);
      sent++;
    } else {
      const ok = await sendEmail(user.email, subject, html);
      if (ok) sent++; else failed++;
    }
  }

  console.log(`[digest] Done. sent=${sent} skipped=${skipped} failed=${failed} (of ${users.length} users)`);
}

run()
  .catch(e => { console.error('[digest] Fatal:', e); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => {}); process.exit(process.exitCode || 0); });
