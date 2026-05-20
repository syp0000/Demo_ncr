# NCR Assistant Demo

Mobile-first demo app for manufacturing NCR and work-completion reporting.

NCR Assistant turns a short shop-floor form into a consistent report entry, supports AI polishing/translation for issue and action text, stores shared records, and exports formatted Excel reports.

This public version is sanitized for portfolio and GitHub use. It uses generic sample language and keeps secrets, deployment IDs, and private data out of the repository.

## Highlights

- Mobile-first Progressive Web App that can be installed from the browser home screen
- Work-completion and defect-report workflows
- Live formatted report preview before copy or save
- AI polish/translate buttons for Korean and English report wording
- PostgreSQL-backed shared records with local browser fallback
- Role-aware access model with shared access code, optional user login, signup requests, and admin approval
- Record ownership controls, shared edit option, soft delete/restore, and edit history
- Validation for duplicate process entries and overlapping work times
- Evidence photo attachment with client-side image compression
- Excel export with grouped process rows, standard-time comparison, embedded photos, and export audit logging

## Tech Stack

- HTML, CSS, and vanilla JavaScript
- Vercel Serverless Functions
- PostgreSQL, tested with AWS RDS/Postgres
- `pg` for database access
- `jose` for JWT-based user sessions
- `exceljs` for `.xlsx` export generation
- Anthropic API for text polishing and translation
- PWA manifest and service worker

## Demo Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the example environment file:

```bash
cp .env.example .env.local
```

3. For a lightweight local demo, set only:

```env
APP_PASSWORD=demo123
APP_EXPORT_CODE=export123
APP_USER_AUTH=0
```

Without `DATABASE_URL`, record loading and saving falls back to browser local storage. This is useful for a public demo because visitors can try the form without a shared database.

For a public Vercel demo, create a separate Vercel project instead of reusing the real production project. Link this branch/folder to the demo project and set only demo-safe environment variables:

```env
APP_PASSWORD=demo123
APP_EXPORT_CODE=export123
APP_USER_AUTH=0
APP_AUTH_SECRET=replace_with_a_long_random_secret
APP_UNLOCK_CODE=unlock123
```

Leave `DATABASE_URL` empty unless you intentionally want a shared demo database. Leave `ANTHROPIC_API_KEY` empty for the lightweight demo; the polish buttons will return a clearly marked local demo suggestion. Excel export requires database-backed records for true `.xlsx` output, but the public demo falls back to a browser-downloaded `.csv` when records are local-only.

4. For AI polish/translation, add:

```env
ANTHROPIC_API_KEY=your_api_key_here
```

5. For shared records, add a PostgreSQL connection string:

```env
DATABASE_URL=postgres://user:password@host:5432/database
```

Then run the SQL in [db/schema.sql](db/schema.sql).

## Optional User Login

By default, the demo can run with only a shared access code. To enable per-user login:

```env
APP_USER_AUTH=1
APP_AUTH_SECRET=replace_with_a_long_random_secret
```

You can seed users through `APP_USERS_JSON`:

```json
[
  { "id": "operator1", "username": "operator1", "password": "demo1234", "name": "Operator 1", "role": "user" },
  { "id": "admin1", "username": "admin1", "password": "admin1234", "name": "Admin", "role": "admin" }
]
```

Roles:

- `user`: can read records and edit records they own or records marked as shared-edit
- `admin`: can manage all records and review account requests

## Environment Variables

- `APP_PASSWORD`: shared app access code
- `APP_EXPORT_CODE`: separate code for export authorization
- `APP_USERS_JSON`: optional environment-defined users
- `APP_USER_AUTH`: set to `1` to enable signup/admin approval flow
- `APP_AUTH_SECRET`: JWT signing secret
- `APP_UNLOCK_CODE`: optional code for editing completed/locked records
- `DATABASE_URL`: PostgreSQL connection string
- `ANTHROPIC_API_KEY`: enables AI polish/translation

## Public Demo Notes

- `.env.local` and `.vercel/` are ignored and should never be committed.
- The public branch does not include private guide decks or real operational data.
- Use fake records and screenshots when presenting the project publicly.
- The Korean translation/polish path is intentionally preserved so the language buttons remain functional.

## Resume Summary

Built a mobile-first manufacturing NCR reporting PWA with AI text polishing/translation, PostgreSQL-backed record management, role-based access, validation rules, evidence photos, edit history, and Excel export automation.
