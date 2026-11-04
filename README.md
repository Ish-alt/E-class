# Classroom

A full-stack classroom app for teacher and student accounts, class enrollment, assignments, submissions, and grades.

## Run locally

1. Install Node.js 22.13 or newer.
2. In this folder, run `npm install`.
3. Run `npm start`.
4. Open <http://localhost:3000>.

Create a teacher account, create a class, and share its 6-character class code. Students can create their own accounts and request to join a class with the code. The class owner must approve each request before the student can see classwork. Teachers can remove enrolled students or delete their classes; students can leave classes. Both roles can manage their name, email, and password in Settings. Teachers can post assignments, review submissions, and return grades and feedback; students see their own work and grades after signing in.

## Storage and deployment

The server stores accounts, sessions, classes, assignments, submissions, and grades in `data/classroom.sqlite`. Set `DATA_DIRECTORY` to a persistent, private directory to store the database elsewhere. Back up the SQLite database regularly. Keep `NODE_ENV=production` when deploying behind HTTPS so session cookies are marked secure. Run the server as a single instance when using its SQLite database and in-memory request limiter.

This is a working starting point, not a fully managed school service: it does not yet include email verification, password recovery, file uploads, or multi-factor authentication. Configure HTTPS, backups, monitoring, and an account-recovery process before inviting a real school community.
