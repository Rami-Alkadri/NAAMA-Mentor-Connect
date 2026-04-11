# NAAMA Mentor Connect

A React + TypeScript + Vite web application with a Node.js/Express backend and PostgreSQL database for the National Arab American Medical Association's mentorship platform.

## Architecture

- **Frontend**: React + TypeScript + Vite (port 5000 in dev)
- **Backend**: Express.js API server (port 3001 in dev, port 5000 in production)
- **Database**: Replit PostgreSQL (connection via `DATABASE_URL`)

## Project Structure

```
├── src/
│   ├── App.tsx        — Main React app (all UI, state, API integration)
│   └── index.tsx      — React entry point
├── server/
│   └── index.js       — Express API server (REST API + serves static in prod)
├── index.html         — HTML shell
├── vite.config.ts     — Vite config (dev server port 5000, proxies /api to 3001)
├── tsconfig.json      — TypeScript config
└── package.json
```

## Running the App

```bash
npm run dev:all    # Run both frontend (Vite) and backend (Express) concurrently
npm run dev        # Frontend only
npm run dev:server # Backend only
npm run build      # Build for production
npm start          # Production server (serves static + API on port 5000)
```

## Database Tables

- **mentors** — Mentor profiles (seeded with Dr. Dana Al-Khaled)
- **user_profiles** — Users created during onboarding
- **connections** — Mentor connection requests from users
- **schedule_requests** — Meeting/session booking requests

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/mentors | List mentors (supports filters: category, level, state, img, q) |
| POST | /api/mentors | Create mentor |
| PUT | /api/mentors/:id | Update mentor |
| DELETE | /api/mentors/:id | Delete mentor |
| POST | /api/profiles | Create user profile (called on onboarding) |
| GET | /api/profiles | List all user profiles |
| DELETE | /api/profiles/:id | Delete profile |
| POST | /api/connections | Create connection request |
| GET | /api/connections | List all connections |
| POST | /api/schedule-requests | Create session request |
| GET | /api/schedule-requests | List all session requests |
| PUT | /api/schedule-requests/:id | Update request status |
| DELETE | /api/schedule-requests/:id | Delete request |
| GET | /api/admin/dashboard | Full admin data + stats |

## Admin Panel

Access the admin panel by adding `?admin=true` to the URL after logging in. This reveals an Admin tab in the navigation with:
- Platform stats overview
- Full mentor management (view/delete)
- User profile management
- Connection tracking
- Session request management

## Features

- Multi-step onboarding (role, profile, focus areas) — saved to DB
- Mentor discovery with search and filters — loaded from DB
- Mentor connection requests — saved to DB
- Session scheduling (calendar + time slots) — saved to DB
- Relationship management
- Profile page
- Dual-role (mentor + mentee) support
- Admin dashboard (via ?admin=true URL param)
