# Classroom

A full-stack classroom app for teacher and student accounts, class enrollment, assignments, submissions, and grades.

## Run locally

1. Install Node.js 22.13 or newer.
2. In this folder, run `npm install`.
3. Run `npm start`.
4. Open <http://localhost:3000>.

Create a teacher account, create a class, and share its 6-character class code. Students can create their own accounts and request to join a class with the code. The class owner must approve each request before the student can see classwork. Teachers can remove enrolled students or delete their classes; students can leave classes. Both roles can manage their name, email, and password in Settings. Teachers can post assignments, review submissions, and return grades and feedback; students see their own work and grades after signing in.

After registration, each user receives a unique Classroom ID in the format `AA-45-BC`. Save this ID to sign in with your password; it is also available in Profile & settings. Email remains the account's contact address and is not used to sign in.

Local development uses SQLite at `data/classroom.sqlite`. Production requires PostgreSQL; set `DATABASE_URL` to a PostgreSQL connection string before starting the server.

## Deploy with Render and Supabase

1. Create a Supabase project and copy its PostgreSQL connection string. For Render, use the Supabase session pooler connection string if the direct connection is not reachable from your service.
2. In Render, create a **Web Service** from this GitHub repository and the `main` branch. Set the build command to `npm ci` and the start command to `npm start`.
3. Add these Render environment variables:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = your Supabase PostgreSQL connection string (keep it secret)
4. Do not set `DATA_DIRECTORY` or attach a Render disk when using Supabase. The app creates its PostgreSQL tables at startup.
5. Before switching from your local app, back up `data/classroom.sqlite` and stop the local server. To import its accounts, classes, assignments, and submissions into a fresh Supabase database, set `DATABASE_URL` in your local terminal and run `npm run migrate:sqlite-to-postgres`. The import script refuses to run if any destination table already contains rows.
6. Deploy the service and open its Render URL. Check `/api/health` to verify it responds.

Supabase's free projects can pause after a period of inactivity. Check Supabase's current plan limits before using the free tier for an active class.

## Storage and deployment

In local development, the server stores accounts, sessions, classes, assignments, submissions, and grades in `data/classroom.sqlite`; back up this file regularly. In production, store this data in Supabase PostgreSQL via `DATABASE_URL`. Keep `NODE_ENV=production` when deploying behind HTTPS so session cookies are marked secure. The request limiter is in memory, so each instance maintains its own rate limits.

This is a working starting point, not a fully managed school service: it does not yet include email verification, password recovery, file uploads, or multi-factor authentication. Configure HTTPS, backups, monitoring, and an account-recovery process before inviting a real school community.
