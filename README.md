# Apricart OneFlowe system

*Automatically synced with your [v0.app](https://v0.app) deployments*

[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?style=for-the-badge&logo=vercel)](https://vercel.com/tahas-projects-df7a2678/v0-apricart-one-flowe-system)
[![Built with v0](https://img.shields.io/badge/Built%20with-v0.app-black?style=for-the-badge)](https://v0.app/chat/projects/LsHE4sxac76)

## Overview

Apricart OneFlowe is a **multi-role retail operations platform** with:
- A **Super Admin dashboard** for global configuration (roles, permissions, global inventory, settings)
- An **Organization / Branch portal** for everyday operations (inventory, orders, budgets, reports)
- A separate **Order Portal** for branch employees to place e‑commerce style orders under budget control

If you just want a **big-picture mental model** of how everything connects, see:
- `SYSTEM_OVERVIEW.md` – architecture, roles, flows
- `INVENTORY_SYSTEM.md` – global → organization → branch inventory model
- `ORDER_PORTAL_IMPLEMENTATION.md` – separate employee Order Portal
- `ADMIN_GUIDE.md` – Super Admin dashboard usage
- `QUICK_START_ORDER_PORTAL.md` – how to enable and use the Order Portal

This repository will stay in sync with your deployed chats on [v0.app](https://v0.app).
Any changes you make to your deployed app will be automatically pushed to this repository from [v0.app](https://v0.app).

## Deployment

Your project is live at:

**[https://vercel.com/tahas-projects-df7a2678/v0-apricart-one-flowe-system](https://vercel.com/tahas-projects-df7a2678/v0-apricart-one-flowe-system)**

## Build your app

Continue building your app on:

**[https://v0.app/chat/projects/LsHE4sxac76](https://v0.app/chat/projects/LsHE4sxac76)**

## Local Development

- Start the dev server with Turbopack for faster compile times:

  ```bash
  npm run dev
  ```

- If you hit an unsupported edge case, fall back to the classic webpack dev server:

  ```bash
  npm run dev:legacy
  ```

## How It Works

1. Create and modify your project using [v0.app](https://v0.app)
2. Deploy your chats from the v0 interface
3. Changes are automatically pushed to this repository
4. Vercel deploys the latest version from this repository

## Database Setup and Seeding

### Environment Configuration

Copy `.env.example` to `.env.local` and obtain every secret from the approved
secret manager. Runtime and migration database credentials are deliberately
separate: the application uses `DATABASE_URL`, while Drizzle and schema-sync
commands use only `MIGRATION_DATABASE_URL`.

Do not add AWS access keys to environment files. Deployed environments should
use an IAM workload identity; local development should use AWS SSO or a profile.
See `docs/security/environment-security.md` for deployment requirements.

### Running Migrations

After setting up your database, run the migrations:

\`\`\`bash
npm run db:migrate
\`\`\`

### Seeding and Administrator Bootstrap

To seed roles, permissions, and organization settings, run:

\`\`\`bash
npm run db:seed
\`\`\`

The general seed never creates an administrator. For a controlled one-time
bootstrap, set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`, then run:

\`\`\`bash
npm run db:bootstrap-admin -- --confirm=CREATE_SUPER_ADMIN
\`\`\`

The bootstrap refuses to run if a super administrator already exists, records
an audit event, never prints the password, and requires the new administrator to
change it at first login. Remove both bootstrap variables immediately afterward.

Make sure your PostgreSQL server is running and the database exists before running the seed script.
