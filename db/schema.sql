Ok -- ============================================================================
-- NAAMA Mentor Connect — Reconstructed PostgreSQL schema
-- ----------------------------------------------------------------------------
-- This schema was reverse-engineered from every SQL query in:
--   server/index.js
--   server/dailyDigest.js
-- The original tables were created externally (on Replit); there was no
-- canonical SQL file in the repo. Column types were inferred from how each
-- column is used in INSERT/SELECT/UPDATE/WHERE/JOIN clauses, plus the
-- ALTER TABLE statements in runMigrations().
--
-- Columns added by runMigrations() ALTER statements are folded into the base
-- CREATE TABLE here so a fresh database matches a fully-migrated one:
--   users.is_active            (boolean default true)
--   mentors.is_active          (boolean default true)
--   user_profiles.year_set_date(DATE default CURRENT_DATE)
--   mentors.year_set_date      (DATE default CURRENT_DATE)
--   schedule_requests.mentor_user_id (INTEGER)
--   schedule_requests.cancelled_by   (VARCHAR(20))
--   connections.is_collab      (BOOLEAN default false)
--   user_profiles.specialties  (TEXT[] default '{}')
--   mentors.specialties        (TEXT[] default '{}')
--
-- push_subscriptions is intentionally OMITTED — it is created at runtime by
-- runMigrations() and is not part of this reconstruction.
--
-- Tables are ordered so foreign-key dependencies resolve cleanly.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- users
-- ----------------------------------------------------------------------------
-- Referenced by: auth signup/login/me, link-profile, toggle-active,
-- delete-account, forgot/reset-password, and many JOINs.
-- profile_id is a nullable FK to user_profiles (set to NULL before a profile
-- is deleted), so the FK is added AFTER user_profiles is created (see ALTER
-- at the bottom) to avoid a circular CREATE-TABLE dependency.
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,          -- compared with LOWER(); stored lowercased
  password_hash TEXT NOT NULL,                 -- bcrypt hash
  profile_id    INTEGER,                       -- FK -> user_profiles(id), added below
  is_active     BOOLEAN DEFAULT TRUE,          -- from ALTER in runMigrations()
  created_at    TIMESTAMPTZ DEFAULT NOW()
);


-- ----------------------------------------------------------------------------
-- user_profiles
-- ----------------------------------------------------------------------------
-- The member's profile (mentee and/or mentor persona). role is 'mentor',
-- 'mentee', or 'both'. Inserted via POST /api/profiles, updated via PUT.
CREATE TABLE IF NOT EXISTS user_profiles (
  id            SERIAL PRIMARY KEY,
  name          TEXT,
  initials      TEXT,
  role          TEXT,                          -- 'mentor' | 'mentee' | 'both'
  category      TEXT,
  specialty     TEXT,
  subfield      TEXT,
  level         TEXT,                          -- GUESS: free-text level label (TEXT)
  year          TEXT,                          -- stored as-is, also parsed via parseInt() -> kept TEXT
  tags          TEXT[] DEFAULT '{}',
  state         TEXT,
  institution   TEXT,
  is_img        BOOLEAN DEFAULT FALSE,
  avatar_grad   TEXT,
  photo         TEXT,                          -- data URL / image string
  bio           TEXT,
  specialties   TEXT[] DEFAULT '{}',           -- from ALTER in runMigrations()
  year_set_date DATE DEFAULT CURRENT_DATE,     -- from ALTER in runMigrations()
  created_at    TIMESTAMPTZ DEFAULT NOW()      -- used in ORDER BY created_at DESC
);


-- ----------------------------------------------------------------------------
-- mentors
-- ----------------------------------------------------------------------------
-- The public mentor directory. A mentor row may be linked to a user account
-- via linked_user_id (auto-created when a user links a mentor/both profile).
CREATE TABLE IF NOT EXISTS mentors (
  id             SERIAL PRIMARY KEY,
  name           TEXT,
  initials       TEXT,
  role           TEXT,
  level          TEXT,                         -- GUESS: free-text level label (TEXT)
  category       TEXT,
  specialty      TEXT,
  subfield       TEXT,
  institution    TEXT,
  state          TEXT,
  bio            TEXT,
  tags           TEXT[] DEFAULT '{}',
  is_img         BOOLEAN DEFAULT FALSE,
  avatar_grad    TEXT,
  photo          TEXT,
  linked_user_id INTEGER REFERENCES users(id), -- FK -> users(id); NULL for seeded directory mentors
  match_score    INTEGER DEFAULT 90,           -- 0-100 score; ORDER BY match_score DESC
  years_exp      INTEGER DEFAULT 0,
  mentees_count  INTEGER DEFAULT 0,            -- incremented on new connection
  sessions_count INTEGER DEFAULT 0,
  specialties    TEXT[] DEFAULT '{}',          -- from ALTER in runMigrations()
  is_active      BOOLEAN DEFAULT TRUE,         -- from ALTER in runMigrations()
  year_set_date  DATE DEFAULT CURRENT_DATE,    -- from ALTER in runMigrations()
  created_at     TIMESTAMPTZ DEFAULT NOW()     -- used in ORDER BY created_at DESC
);


-- ----------------------------------------------------------------------------
-- connections
-- ----------------------------------------------------------------------------
-- A mentorship or collaboration request between a mentee (user_profile_id /
-- user_id) and a mentor row (mentor_id). status: 'pending' | 'accepted' |
-- 'declined'. is_collab distinguishes collaboration from mentorship requests.
-- ON DELETE CASCADE chosen because delete-account / migration cleanup
-- explicitly remove connections when the referenced mentor or user is gone.
CREATE TABLE IF NOT EXISTS connections (
  id              SERIAL PRIMARY KEY,
  user_profile_id INTEGER REFERENCES user_profiles(id) ON DELETE CASCADE,
  mentor_id       INTEGER REFERENCES mentors(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE, -- the mentee's user account (nullable: optionalAuth)
  status          TEXT DEFAULT 'pending',      -- 'pending' | 'accepted' | 'declined'
  is_collab       BOOLEAN DEFAULT FALSE,       -- from ALTER in runMigrations()
  created_at      TIMESTAMPTZ DEFAULT NOW()    -- used in ORDER BY created_at DESC
);


-- ----------------------------------------------------------------------------
-- schedule_requests
-- ----------------------------------------------------------------------------
-- A session/meeting request from a mentee to a mentor. Note: mentee identity
-- is stored denormalized (mentee_name/initials/photo) plus a nullable
-- user_profile_id; the mentor side is referenced by mentor_user_id (a users.id,
-- NOT a mentors.id — joins are m.linked_user_id = sr.mentor_user_id).
CREATE TABLE IF NOT EXISTS schedule_requests (
  id              SERIAL PRIMARY KEY,
  mentee_name     TEXT,
  mentee_initials TEXT,
  mentee_photo    TEXT,
  user_profile_id INTEGER REFERENCES user_profiles(id) ON DELETE CASCADE, -- nullable
  mentor_user_id  INTEGER REFERENCES users(id),  -- from ALTER; a users.id, nullable
  meeting_type    TEXT,                           -- e.g. 'video' | 'phone' | 'in-person' (free text)
  meeting_date    DATE,                           -- GUESS: DATE (also accepts NULL on reschedule COALESCE)
  meeting_time    TEXT,                           -- stored as text time label (e.g. '3:00 PM')
  note            TEXT,
  status          TEXT DEFAULT 'pending',         -- 'pending' | 'confirmed' | 'cancelled' | 'declined'
  cancelled_by    VARCHAR(20),                    -- from ALTER in runMigrations(); 'mentor' | 'mentee'
  created_at      TIMESTAMPTZ DEFAULT NOW()       -- used in ORDER BY created_at DESC
);


-- ----------------------------------------------------------------------------
-- messages
-- ----------------------------------------------------------------------------
-- Chat messages within an accepted connection.
CREATE TABLE IF NOT EXISTS messages (
  id             SERIAL PRIMARY KEY,
  connection_id  INTEGER REFERENCES connections(id) ON DELETE CASCADE,
  sender_user_id INTEGER REFERENCES users(id),    -- the sender's users.id
  content        TEXT NOT NULL,
  is_read        BOOLEAN DEFAULT FALSE,           -- marked true when recipient opens thread
  created_at     TIMESTAMPTZ DEFAULT NOW()        -- used in ORDER BY created_at ASC/DESC
);


-- ----------------------------------------------------------------------------
-- password_reset_tokens
-- ----------------------------------------------------------------------------
-- One-time password reset tokens (crypto.randomBytes(32).toString('hex')).
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,                       -- 64-char hex string; queried by token
  used       BOOLEAN DEFAULT FALSE,               -- checked: used = FALSE
  expires_at TIMESTAMPTZ NOT NULL,                -- checked: expires_at > NOW()
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ----------------------------------------------------------------------------
-- Deferred FK: users.profile_id -> user_profiles(id)
-- ----------------------------------------------------------------------------
-- Added after user_profiles exists to break the users <-> user_profiles cycle.
-- ON DELETE SET NULL matches the app logic, which NULLs profile_id before
-- deleting a profile.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'users_profile_id_fkey'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_profile_id_fkey
      FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;
