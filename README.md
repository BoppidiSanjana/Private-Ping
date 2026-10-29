# Private Ping — Real-Time Chat Application

Private Ping is a portfolio-oriented real-time chat application built with **Node.js, Express.js, Socket.IO, HTML, CSS, and vanilla JavaScript**. It avoids Docker, React, TypeScript, Tailwind, and MongoDB to keep the setup focused and approachable.

## Features
- Account registration and sign-in using bcrypt password hashing and HTTP-only JWT cookies
- Private one-to-one chats and group conversations
- Persistent messages and users stored in a local JSON database file
- Real-time messaging with Socket.IO
- Online presence and typing indicators
- Read receipts, unread counts, and conversation previews
- Image, PDF, TXT, and DOCX sharing (configurable 5 MB limit)
- Authenticated attachment download routes
- User search, message search, group creation and admin-controlled member changes
- Profile/about updates, dark/light theme, responsive mobile layout
- Basic API rate limiting and `/api/health`

## Requirements
- Node.js 18 or newer
- npm

## Run locally
1. Extract the ZIP and open the project folder in VS Code.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env`, then change `JWT_SECRET` to a long random secret.
   - Windows PowerShell: `Copy-Item .env.example .env`
   - macOS/Linux: `cp .env.example .env`
4. Start:
   ```bash
   npm start
   ```
5. Open `http://localhost:3000`.
6. Register two accounts in separate browsers or one normal and one incognito window. Search by username to start a private chat, or create a group using registered usernames.

## Project structure
- `server.js` — REST API, authentication, persistence, and Socket.IO server
- `public/index.html` — app and sign-in UI
- `public/style.css` — responsive dark/light themes
- `public/app.js` — frontend behavior and real-time events
- `data/db.json` — generated local JSON storage
- `uploads/` — generated private attachment files

## Notes and honest limitations
- This is a learning/portfolio project, not a hardened production messenger.
- The JSON file database is suitable for a local demo but not high-concurrency production use; SQLite or MongoDB would be more appropriate at scale.
- No end-to-end encryption is implemented. Do not use this for confidential messages.
- Configure HTTPS and a strong `JWT_SECRET` before deployment.
- The reported “30% lower message delivery latency” should only be used on a resume if measured with a repeatable before/after benchmark. No latency improvement is claimed by this source code alone.
- A full automated test suite and production security audit have not been run.
