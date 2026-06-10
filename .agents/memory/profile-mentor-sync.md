---
name: profile↔mentor directory sync
description: The mentors directory row must be kept in sync with its linked user_profile on EDIT, not just at creation.
---

# Profile → mentor directory sync

The discover/search cards and the mentor detail modal ("About", name, photo, specialty, etc.) read from the `mentors` table, while a user's own profile page reads from `user_profiles`. A mentor row is created (with all display fields) when a mentor/both user links their profile. The two can drift apart on edit.

**Rule:** Any display field that appears on a mentor card or detail modal must be synced from `user_profiles` to the linked `mentors` row inside `PUT /api/profiles/:id`. Syncing only a subset (the handler historically synced only `years_exp`/`year_set_date`) makes profile edits silently fail to appear in discovery.

**Why:** A user edited/added their bio after onboarding; it saved to `user_profiles` (so their own profile page showed it) but never reached the `mentors` row, so "About" and the search cards stayed empty. Same class of bug applies to name, specialty, photo, etc.

**How to apply:**
- Field mapping in `PUT /api/profiles/:id`: the `p` object is the **request body = camelCase** (`p.isIMG`, `p.avatarGrad`). Contrast with `link-profile`, where `p` is a **DB row = snake_case** (`p.is_img`). Don't copy the snake_case form into the PUT handler.
- Preserve counters not owned by the profile: do NOT overwrite `match_score`, `mentees_count`, `sessions_count` in the sync.
- Frontend: after a successful profile save, call the shared `loadMentors()` so the discover view reflects the change without a reload.

**Known pre-existing gap (separate from the sync):** `PUT`/`POST`/`DELETE /api/profiles[/:id]` have no `authMiddleware` or ownership check. Since edits now propagate to the public mentors directory, an unauthenticated caller could rewrite a mentor's public entry by ID. Worth hardening as a follow-up (frontend already sends `Authorization: Bearer`).
