// ============================================================================
// Dev database seeder — floods the LOCAL Postgres with realistic fake data so
// the app can be viewed under full usage (mentors directory, mentees,
// connections, schedule requests, chat messages).
//
// Usage:
//   node db/seed.js            # add seed data on top of whatever exists
//   node db/seed.js --reset    # remove previously-seeded data first, then seed
//
// Safety:
//   - Refuses to run against a Neon/production DATABASE_URL.
//   - All seeded accounts use the @naama.seed email domain and the password
//     "password123", so they're easy to identify, log in as, and clean up.
//   - --reset only removes seed-created rows (plus any unlinked directory
//     mentors, which in local dev are only ever created here).
// ============================================================================
import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;
const url = process.env.DATABASE_URL || '';
if (!url) {
  console.error('No DATABASE_URL set. Aborting.');
  process.exit(1);
}
if (/neon\.tech/.test(url) || process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed: DATABASE_URL looks like production (neon.tech / NODE_ENV=production).');
  process.exit(1);
}

const SEED_DOMAIN = 'naama.seed';
const PASSWORD = 'password123';
const RESET = process.argv.includes('--reset');

const pool = new Pool({ connectionString: url });

// ── Vocabulary (kept in sync with the constants in src/App.tsx) ──────────────
const FIRST_NAMES = [
  'Omar', 'Layla', 'Yusuf', 'Fatima', 'Karim', 'Noor', 'Sami', 'Rania', 'Hassan', 'Leila',
  'Tarek', 'Mariam', 'Khaled', 'Dana', 'Adam', 'Salma', 'Nabil', 'Hana', 'Ziad', 'Yasmin',
  'Faisal', 'Reem', 'Bashar', 'Lina', 'Amir', 'Sara', 'Jad', 'Maya', 'Rami', 'Aisha',
  'Walid', 'Nadia', 'Tariq', 'Huda', 'Sherif', 'Lara', 'Murad', 'Zeina', 'Anwar', 'Dalia',
];
const LAST_NAMES = [
  'Haddad', 'Khalil', 'Mansour', 'Saleh', 'Najjar', 'Sayegh', 'Aziz', 'Darwish', 'Khoury', 'Rahman',
  'Hamdan', 'Barakat', 'Shadid', 'Awad', 'Ghanem', 'Maalouf', 'Sabbagh', 'Tahan', 'Jaber', 'Nasser',
  'Halabi', 'Antoun', 'Bishara', 'Farah', 'Karam', 'Mikhail', 'Qasim', 'Suleiman', 'Tannous', 'Zogby',
];
const STATES = [
  'California', 'New York', 'Texas', 'Illinois', 'Michigan', 'Florida', 'Ohio', 'Massachusetts',
  'Pennsylvania', 'New Jersey', 'Virginia', 'Washington', 'Georgia', 'North Carolina', 'Maryland',
];
const INSTITUTIONS = [
  'Johns Hopkins Hospital', 'Mayo Clinic', 'Cleveland Clinic', 'Massachusetts General Hospital',
  'UCSF Medical Center', 'Stanford Health Care', 'NewYork-Presbyterian', 'University of Michigan Health',
  'Northwestern Memorial', 'UCLA Health', 'Mount Sinai', 'Houston Methodist', 'Duke University Hospital',
  'University of Chicago Medicine', 'Emory University Hospital', 'Cedars-Sinai',
];
const LEVELS = ['Professional/Graduate School Student', 'Resident', 'Fellow', 'Attending', 'Other'];

const CATEGORY_DATA = {
  medicine: {
    specialties: ['Family Medicine', 'Internal Medicine', 'Pediatrics', 'General Surgery', 'Cardiology',
      'Neurology', 'Psychiatry', 'Emergency Medicine', 'Anesthesiology', 'Radiology', 'Dermatology', 'Obstetrics & Gynecology'],
    subfields: ['Interventional', 'Pediatric', 'Critical Care', 'Outpatient', 'Academic', ''],
    tags: ['Residency Match Strategy', 'Fellowship Match Strategy', 'Application Review', 'Specialty Choice',
      'Research', 'Medical Education', 'Career Planning', 'Work-Life Balance', 'IMG Guidance', 'Women in NAAMA'],
  },
  dentistry: {
    specialties: ['General Dentistry', 'Orthodontics', 'Endodontics', 'Periodontics', 'Oral Surgery', 'Pediatric Dentistry'],
    subfields: ['Cosmetic', 'Surgical', 'Academic', ''],
    tags: ['Dental School Apps', 'Specialty Selection', 'Research', 'Practice Management', 'Board Exams', 'Academic Dentistry'],
  },
  pharmacy: {
    specialties: ['Clinical Pharmacy', 'Ambulatory Care', 'Oncology Pharmacy', 'Critical Care Pharmacy'],
    subfields: ['PGY1', 'PGY2', 'Industry', 'Academic', ''],
    tags: ['Residency (PGY1/PGY2)', 'Clinical Pharmacy', 'Research', 'Board Exams', 'Industry Careers', 'Academic Pharmacy'],
  },
  publichealth: {
    specialties: ['Epidemiology', 'Health Policy', 'Global Health', 'Biostatistics'],
    subfields: ['Infectious Disease', 'Maternal Health', 'Community', 'Academic', ''],
    tags: ['Epidemiology', 'Health Policy', 'Global Health', 'Research Methods', 'MPH Programs', 'Community Health'],
  },
  other: {
    specialties: ['Physical Therapy', 'Nursing', 'Physician Assistant', 'Optometry'],
    subfields: ['Clinical', 'Academic', 'Leadership', ''],
    tags: ['Career Guidance', 'Application Review', 'Research', 'Leadership', 'Education', 'Advocacy'],
  },
};
const CATEGORIES = Object.keys(CATEGORY_DATA);
const AVATAR_GRADS = [
  'linear-gradient(135deg,#c9a84c,#e8a83c)',
  'linear-gradient(135deg,#4a9b8e,#2a7a6e)',
  'linear-gradient(135deg,#8b5cf6,#6d3fc8)',
  'linear-gradient(135deg,#ec4899,#9c2c6e)',
  'linear-gradient(135deg,#f59e0b,#d97706)',
];
const MEETING_TYPES = ['intro', 'deep', 'review'];
const TIMES = ['9:00 AM', '9:30 AM', '10:00 AM', '11:00 AM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM'];

const MENTOR_MESSAGES = [
  'Great to connect! What stage of training are you in right now?',
  'Happy to help with your application. Do you have a personal statement draft yet?',
  'I matched into my specialty as an IMG, so I know the process well. Ask me anything.',
  'Let\'s set up a call to go over your CV in detail.',
  'Research experience really helped my application. Are you involved in any projects?',
  'Make sure to start your letters of recommendation early — programs notice.',
  'I\'d focus on programs that have a track record of supporting international graduates.',
  'How did the interview go? Happy to debrief whenever you\'re ready.',
];
const MENTEE_MESSAGES = [
  'Thank you so much for connecting! I\'m a third-year student exploring specialties.',
  'I have a rough draft of my personal statement — could I send it over?',
  'That\'s really encouraging to hear. How early did you start preparing?',
  'A call would be great. I\'m free most afternoons next week.',
  'I have one poster presentation so far and I\'m looking for more research.',
  'Thanks for the advice — I\'ll reach out to my professors this week.',
  'Which programs would you recommend I look into for my specialty?',
  'The interview went well, I think! I\'d love your feedback on follow-up notes.',
];

// ── Helpers ──────────────────────────────────────────────────────────────────
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const chance = (p) => Math.random() < p;
function sample(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}
const initialsOf = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
function futureDate(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

let nameCounter = 0;
function makeName() {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}

function makeProfileFields(role) {
  const category = pick(CATEGORIES);
  const cd = CATEGORY_DATA[category];
  const name = makeName();
  const level = role === 'mentee'
    ? pick(['Professional/Graduate School Student', 'Resident'])
    : pick(['Resident', 'Fellow', 'Attending', 'Attending']);
  const specialty = pick(cd.specialties);
  const isImg = chance(0.3);
  return {
    name,
    initials: initialsOf(name),
    role,
    category,
    specialty,
    subfield: pick(cd.subfields),
    level,
    year: String(randInt(1, 18)),
    tags: sample(cd.tags, randInt(2, 4)),
    specialties: chance(0.5) ? sample(cd.specialties, randInt(1, 3)) : [],
    state: pick(STATES),
    institution: pick(INSTITUTIONS),
    isImg,
    avatarGrad: pick(AVATAR_GRADS),
    bio: `${level} in ${specialty} at ${pick(INSTITUTIONS)}.${isImg ? ' International medical graduate.' : ''} Passionate about mentoring the next generation of Arab American healthcare professionals.`,
  };
}

// ── Reset ────────────────────────────────────────────────────────────────────
async function reset() {
  console.log('Resetting previously-seeded data…');
  // Seed user ids
  const { rows: seedUsers } = await pool.query(
    `SELECT id, profile_id FROM users WHERE email LIKE '%@${SEED_DOMAIN}'`
  );
  const userIds = seedUsers.map((u) => u.id);
  const profileIds = seedUsers.map((u) => u.profile_id).filter(Boolean);

  // Wipe relationship data tied to seed users, plus all unlinked directory
  // mentors (only ever created by this script in local dev).
  await pool.query('DELETE FROM messages WHERE sender_user_id = ANY($1::int[])', [userIds]);
  await pool.query('DELETE FROM connections WHERE user_id = ANY($1::int[])', [userIds]);
  await pool.query('DELETE FROM schedule_requests WHERE mentor_user_id = ANY($1::int[])', [userIds]);
  if (profileIds.length) {
    await pool.query('DELETE FROM schedule_requests WHERE user_profile_id = ANY($1::int[])', [profileIds]);
    await pool.query('DELETE FROM connections WHERE user_profile_id = ANY($1::int[])', [profileIds]);
  }
  await pool.query('DELETE FROM mentors WHERE linked_user_id = ANY($1::int[]) OR linked_user_id IS NULL', [userIds]);
  await pool.query('UPDATE users SET profile_id = NULL WHERE id = ANY($1::int[])', [userIds]);
  if (profileIds.length) await pool.query('DELETE FROM user_profiles WHERE id = ANY($1::int[])', [profileIds]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  console.log(`  removed ${userIds.length} seed users and their data.`);
}

// ── Insert helpers ───────────────────────────────────────────────────────────
async function insertProfile(p) {
  const { rows } = await pool.query(
    `INSERT INTO user_profiles (name, initials, role, category, specialty, subfield, level, year, tags, state, institution, is_img, avatar_grad, photo, bio, specialties)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [p.name, p.initials, p.role, p.category, p.specialty, p.subfield, p.level, p.year, p.tags, p.state, p.institution, p.isImg, p.avatarGrad, '', p.bio, p.specialties]
  );
  return rows[0].id;
}

async function insertUser(email, hash, profileId) {
  const { rows } = await pool.query(
    'INSERT INTO users (email, password_hash, profile_id, is_active) VALUES ($1,$2,$3,true) RETURNING id',
    [email, hash, profileId]
  );
  return rows[0].id;
}

async function insertMentor(p, linkedUserId) {
  const { rows } = await pool.query(
    `INSERT INTO mentors (name, initials, role, level, category, specialty, subfield, institution, state, bio, tags, is_img, avatar_grad, photo, linked_user_id, match_score, years_exp, mentees_count, sessions_count, specialties, is_active, year_set_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,true,CURRENT_DATE) RETURNING id`,
    [p.name, p.initials, p.role, p.level, p.category, p.specialty, p.subfield, p.institution, p.state, p.bio,
     p.tags, p.isImg, p.avatarGrad, '', linkedUserId, randInt(78, 99), randInt(2, 25), randInt(0, 12), randInt(0, 40), p.specialties]
  );
  return rows[0].id;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (RESET) await reset();

  const hash = await bcrypt.hash(PASSWORD, 10);
  const emailUsed = new Set();
  const emailFor = (name) => {
    const base = name.toLowerCase().replace(/[^a-z]+/g, '.');
    let email = `${base}@${SEED_DOMAIN}`;
    while (emailUsed.has(email)) email = `${base}.${++nameCounter}@${SEED_DOMAIN}`;
    emailUsed.add(email);
    return email;
  };

  // 1. Mentor accounts (role mentor or both) — each gets a profile + linked mentor row.
  const mentorAccounts = []; // { userId, profileId, mentorId, profile }
  const NUM_MENTOR_USERS = 35;
  for (let i = 0; i < NUM_MENTOR_USERS; i++) {
    const role = chance(0.25) ? 'both' : 'mentor';
    const p = makeProfileFields(role);
    const profileId = await insertProfile(p);
    const userId = await insertUser(emailFor(p.name), hash, profileId);
    const mentorId = await insertMentor(p, userId);
    mentorAccounts.push({ userId, profileId, mentorId, profile: p });
  }
  console.log(`Created ${mentorAccounts.length} mentor accounts (with linked directory rows).`);

  // 2. Standalone directory mentors (no user account) for a fuller Discover page.
  const directoryMentorIds = [];
  const NUM_DIRECTORY = 25;
  for (let i = 0; i < NUM_DIRECTORY; i++) {
    const p = makeProfileFields(chance(0.2) ? 'both' : 'mentor');
    directoryMentorIds.push(await insertMentor(p, null));
  }
  console.log(`Created ${directoryMentorIds.length} unlinked directory mentors.`);

  const allMentorIds = [...mentorAccounts.map((m) => m.mentorId), ...directoryMentorIds];

  // 3. Mentee accounts.
  const menteeAccounts = []; // { userId, profileId, profile }
  const NUM_MENTEES = 30;
  for (let i = 0; i < NUM_MENTEES; i++) {
    const p = makeProfileFields('mentee');
    const profileId = await insertProfile(p);
    const userId = await insertUser(emailFor(p.name), hash, profileId);
    menteeAccounts.push({ userId, profileId, profile: p });
  }
  console.log(`Created ${menteeAccounts.length} mentee accounts.`);

  // 4. Connections (mentorship). Mentees connect to random mentors.
  const acceptedConns = []; // { id, menteeUserId, mentorUserId }
  let connCount = 0;
  for (const mentee of menteeAccounts) {
    const targets = sample(allMentorIds, randInt(1, 5));
    for (const mentorId of targets) {
      const r = Math.random();
      const status = r < 0.45 ? 'accepted' : r < 0.8 ? 'pending' : 'declined';
      const { rows } = await pool.query(
        `INSERT INTO connections (user_profile_id, mentor_id, user_id, status, is_collab) VALUES ($1,$2,$3,$4,false) RETURNING id`,
        [mentee.profileId, mentorId, mentee.userId, status]
      );
      connCount++;
      const owner = mentorAccounts.find((m) => m.mentorId === mentorId);
      if (status === 'accepted') {
        acceptedConns.push({ id: rows[0].id, menteeUserId: mentee.userId, mentorUserId: owner?.userId || null });
      }
    }
  }

  // 5. Collaboration connections (mentor ↔ mentor).
  for (const m of mentorAccounts) {
    if (!chance(0.5)) continue;
    const others = mentorAccounts.filter((o) => o.mentorId !== m.mentorId);
    for (const target of sample(others, randInt(1, 3))) {
      const status = chance(0.5) ? 'accepted' : 'pending';
      const { rows } = await pool.query(
        `INSERT INTO connections (user_profile_id, mentor_id, user_id, status, is_collab) VALUES ($1,$2,$3,$4,true) RETURNING id`,
        [m.profileId, target.mentorId, m.userId, status]
      );
      connCount++;
      if (status === 'accepted') {
        acceptedConns.push({ id: rows[0].id, menteeUserId: m.userId, mentorUserId: target.userId });
      }
    }
  }
  console.log(`Created ${connCount} connections (${acceptedConns.length} accepted).`);

  // 6. Messages inside accepted connections.
  let msgCount = 0;
  for (const conn of acceptedConns) {
    if (conn.mentorUserId == null) continue; // need a real mentor account to converse
    const n = randInt(2, 10);
    for (let i = 0; i < n; i++) {
      const fromMentee = i % 2 === 0;
      const sender = fromMentee ? conn.menteeUserId : conn.mentorUserId;
      const content = fromMentee ? pick(MENTEE_MESSAGES) : pick(MENTOR_MESSAGES);
      const isRead = i < n - randInt(0, 2); // last couple may be unread
      await pool.query(
        'INSERT INTO messages (connection_id, sender_user_id, content, is_read) VALUES ($1,$2,$3,$4)',
        [conn.id, sender, content, isRead]
      );
      msgCount++;
    }
  }
  console.log(`Created ${msgCount} messages.`);

  // 7. Schedule requests from mentees to mentor accounts.
  let schedCount = 0;
  for (const mentee of menteeAccounts) {
    if (!chance(0.6)) continue;
    for (const mentor of sample(mentorAccounts, randInt(1, 2))) {
      const r = Math.random();
      const status = r < 0.4 ? 'confirmed' : r < 0.8 ? 'pending' : 'cancelled';
      await pool.query(
        `INSERT INTO schedule_requests (mentee_name, mentee_initials, mentee_photo, user_profile_id, meeting_type, meeting_date, meeting_time, note, mentor_user_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [mentee.profile.name, mentee.profile.initials, '', mentee.profileId, pick(MEETING_TYPES),
         futureDate(randInt(1, 30)), pick(TIMES), chance(0.6) ? 'Looking forward to discussing my application.' : '', mentor.userId, status]
      );
      schedCount++;
    }
  }
  console.log(`Created ${schedCount} schedule requests.`);

  console.log('\nDone. Seed accounts use password "password123".');
  console.log('Example logins:');
  for (const m of mentorAccounts.slice(0, 2)) {
    const { rows } = await pool.query('SELECT email FROM users WHERE id=$1', [m.userId]);
    console.log(`  mentor: ${rows[0].email}`);
  }
  for (const m of menteeAccounts.slice(0, 2)) {
    const { rows } = await pool.query('SELECT email FROM users WHERE id=$1', [m.userId]);
    console.log(`  mentee: ${rows[0].email}`);
  }
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error(e); pool.end(); process.exit(1); });
