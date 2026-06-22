---
name: Scheduled jobs on autoscale deployments
description: How to run reliable time-based/cron jobs when the web app is deployed on autoscale.
---

# Scheduled jobs alongside an autoscale web app

For any recurring time-based job (daily digest emails, cleanup, reports), do NOT rely on an in-process timer (`setInterval`/`node-cron`) inside the main server.

**Why:** the web app is deployed on an **autoscale** deployment target, which scales to zero and sleeps when there is no traffic. An in-process scheduler will not fire reliably at a fixed wall-clock time (e.g. 23:00).

**How to apply:**
- Write the job as a standalone script with its own DB/SMTP setup that runs once and exits (e.g. `server/dailyDigest.js`, exposed as an npm script).
- The user creates a **Scheduled Deployment** via the Publishing UI (Publishing → Scheduled) pointing at that command, with a schedule + timezone. This project's digest runs at 23:00 ET (`America/New_York`, which auto-handles EST/EDT).
- A single repl **can** have both an Autoscale Deployment (the web app) and a Scheduled Deployment (the job) at the same time — confirmed via Replit docs. Do NOT switch the `.replit` `[deployment]` section to `scheduled`; that would replace the web app's deployment config. The Scheduled Deployment is configured separately in the Publishing UI.
- Creating the Scheduled Deployment requires the user's action in the UI; the agent cannot create the second deployment programmatically.
