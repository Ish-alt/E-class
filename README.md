# Classroom

A full-stack classroom app for teacher and student accounts, class enrollment, assignments, quizzes, private class materials, group work, submissions, and grades.

## Run locally

1. Install Node.js 22.13 or newer.
2. In this folder, run `npm install`.
3. Run `npm start`.
4. Open <http://localhost:3000>.

Create a teacher account, create a class, and share its 6-character class code. Students can create their own accounts and request to join a class with the code. The class owner must approve each request before the student can see assessments. Open a class to manage its roster, assessments, quizzes, materials, and groups. Students see enrolled classmates and only their own group. Teachers set a minimum and maximum group size from 4 to 12, then choose a valid exact group count and either random grouping or student-led proposals. Student-led mode requires one teacher-assigned leader per group; leaders propose members and the teacher approves or rejects each proposal. Pending members are reserved until the teacher responds. Clear the current group setup before switching modes. Multiple-choice and true/false quiz questions are auto-graded; teachers grade short answers. Teachers can set whether an assessment accepts text, files, or either.

After registration, each user receives a unique Classroom ID in the format `TC-00-AB` or `ST-00-AB`. Sign in with your username and password. Users can change their username in Profile & settings; email remains the account's contact address.

Local development uses SQLite at `data/classroom.sqlite` and stores uploaded files privately under `data/classroom-files`. Production requires PostgreSQL; set `DATABASE_URL` to a PostgreSQL connection string before starting the server.

## Deploy with Render and Supabase

1. Create a Supabase project and copy its PostgreSQL connection string. For Render, use the Supabase session pooler connection string if the direct connection is not reachable from your service.
2. In Render, create a **Web Service** from this GitHub repository and the `main` branch. Set the build command to `npm ci` and the start command to `npm start`.
3. Add these Render environment variables:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = your Supabase PostgreSQL connection string (keep it secret)
   - `SUPABASE_URL` = the HTTPS Project URL from Supabase **Project Settings → API**
   - `SUPABASE_SERVICE_ROLE_KEY` = the server-side service role key from Supabase **Project Settings → API Keys** (never expose it in browser code or share it)
   - `SUPABASE_STORAGE_BUCKET` = `classroom-files` (optional; this is the default bucket name)
4. In Supabase **Storage**, create a bucket named `classroom-files`. Keep it **private** and set its file size limit to 20 MB or higher. Do not create public read policies; the application authorizes downloads through the signed-in class membership and proxies the file privately.
5. Do not set `DATA_DIRECTORY` or attach a Render disk when using Supabase. The app creates its PostgreSQL tables at startup.
6. Local SQLite development uses private on-disk file storage automatically. When using PostgreSQL, configure the Supabase Storage variables in step 3.
7. Before switching from your local app, back up `data/classroom.sqlite` and stop the local server. To import its accounts, classes, assignments, and submissions into a fresh Supabase database, set `DATABASE_URL` in your local terminal and run `npm run migrate:sqlite-to-postgres`. The import script refuses to run if any destination table already contains rows.
8. Deploy the service and open its Render URL. Check `/api/health` to verify it responds.

Supabase's free projects can pause after a period of inactivity. Check Supabase's current plan limits before using the free tier for an active class.

## Storage and deployment

In local development, the server stores accounts, sessions, classes, assignments, submissions, and grades in `data/classroom.sqlite`; uploaded files are stored under `data/classroom-files`. Back up both locations regularly. In production, store relational data in Supabase PostgreSQL via `DATABASE_URL` and files in the private Supabase Storage bucket. Keep `NODE_ENV=production` when deploying behind HTTPS so session cookies are marked secure. The request limiter is in memory, so each instance maintains its own rate limits.

This is a working starting point, not a fully managed school service: it does not yet include email verification, password recovery, malware scanning for uploads, or multi-factor authentication. Accepted upload formats are PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX, TXT, CSV, PNG, JPG/JPEG, and WEBP, up to 20 MB per file. Configure HTTPS, database and storage backups, monitoring, and an account-recovery process before inviting a real school community.
