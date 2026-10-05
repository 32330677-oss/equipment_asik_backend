# Equipment Flow — backend (ASIK)

Standalone system for **rented construction machinery**. It covers:

- daily machine attendance (check-in / downtime / check-out);
- the signed monthly paper timesheet, with QR code, scans and row-by-row reconciliation;
- a live board of the machines on site;
- flexible vendor payroll (Hourly / Daily / Monthly), with PDF and Excel statements.

It is **not connected to Team Flow**: own database `equipment_asik`, own users, own port `5055`.

The full specification is in `docs/` (files 01–08).

- **Stack:** Node.js 20+, Express 5, MySQL 8 (MariaDB 10.6+ also works), JWT, pdfkit, exceljs.
- **Tests:** 58 automated tests, run green on MySQL 8.0 and MariaDB 10.11.

---

## 1. Run it locally (Windows, MySQL already installed, DBeaver)

> Your other project keeps working: this one uses **another database** (`equipment_asik`), **another MySQL user** (`equipment_asik_user`, with rights on that database only) and **another port** (`5055`).

1. Install **Node.js 20 LTS or newer** (https://nodejs.org), then check it in a terminal with `node -v`.
2. In this folder run:

   ```bash
   npm install
   copy .env.example .env      # on PowerShell: Copy-Item .env.example .env
   ```

3. Open `.env` and set:
   - `DB_PASSWORD`: choose a password for the new MySQL user `equipment_asik_user`.
   - `DB_ROOT_USER` and `DB_ROOT_PASSWORD`: your MySQL **root** login (the one DBeaver uses). It is needed once, to create the database and the user.
   - `JWT_SECRET`: generate it with

     ```bash
     node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     ```

4. Create the database, the tables and the settings:

   ```bash
   npm run db:init
   ```

   You should see `Done: 26 tables in equipment_asik`. The command is safe to run again.
5. Create your Admin account:

   ```bash
   npm run create-admin -- --username hamza --name "Hamza"
   ```

   Note the temporary password; you must change it at the first login.
6. Optional — demo data (2 sites, 3 machines, 2 weeks of attendance):

   ```bash
   npm run seed-demo
   ```

7. Start the API:

   ```bash
   npm run dev        # auto-reload while developing
   # or
   npm start
   ```

   Then open http://localhost:5055/api/health. It must show `{"status":"ok","db":"ok"}`.

After `db:init` you can clear `DB_ROOT_PASSWORD` from `.env`; the app itself only uses `equipment_asik_user`.

## 2. Connect DBeaver to this database

1. **Database → New Database Connection → MySQL** (choose MariaDB if your server is MariaDB / XAMPP).
2. Fill in the connection:
   - Host `localhost`, Port `3306`.
   - **Database** `equipment_asik`.
   - User `equipment_asik_user` and the `DB_PASSWORD` from `.env`. You can also use `root`.
3. If MySQL 8 shows *"Public Key Retrieval is not allowed"*: on **Driver properties** set `allowPublicKeyRetrieval = true` (and `useSSL = false` locally).
4. **Test Connection → Finish.**
5. In the connection settings → **General**, give it a clear name and a different colour (e.g. "Equipment Flow LOCAL"), so it is never confused with the other project's connection.

Useful tables:

| Area | Tables |
|---|---|
| Users and login | `users`, `login_history` |
| Sites and supervisors | `sites`, `site_supervisors` |
| Master data | `eq_vendors`, `eq_vendor_contracts`, `eq_equipment`, `eq_operators`, `eq_rate_cards`, `eq_site_assignments` |
| Daily attendance | `eq_attendance`, `eq_downtime_periods` |
| Paper | `eq_timesheets`, `eq_timesheet_scans`, `eq_paper_checks` |
| Money | `eq_fuel_issues`, `eq_adjustments`, `eq_payroll_batches`, `eq_payroll_items`, `eq_payroll_lines`, `eq_payroll_attendance_snapshot` |
| Audit | `audit_logs` (every change, old and new values) |

## 3. Tests

The tests use a **separate** database `equipment_asik_test`, which they drop and recreate. Never point them at real data: the name must end with `_test`. Create the test user once (DBeaver SQL editor, as root):

```sql
CREATE USER IF NOT EXISTS 'eqtest'@'localhost' IDENTIFIED BY 'eqtestpass';
GRANT ALL ON equipment_asik_test.* TO 'eqtest'@'localhost';
```

Then run:

```bash
npm test
```

To use another port or user, set `TEST_DB_PORT`, `TEST_DB_USER` and `TEST_DB_PASSWORD`.

## 4. Going online later

- **Database:** a managed MySQL 8. Run `npm run db:init` once against it (or run `database/schema.sql` then `database/seed.sql`).
- **Files:** set `FILE_STORAGE_DRIVER=s3` with a private bucket, e.g. Cloudflare R2. Most hosts (e.g. Render without a disk) erase local files on every deploy. The signed scans must not be lost.
- **Environment:**
  - `NODE_ENV=production`;
  - a new `JWT_SECRET`;
  - `CORS_ORIGINS=https://your-app-domain`.
- **Schema changes:** never edit `schema.sql` on a live database. Add `database/migrations/NNN_name.sql` and run `npm run migrate`.

## 5. API map (all under `/api`)

| Area | Main endpoints |
|---|---|
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password` |
| Users (Admin) | `GET/POST /users`, `PUT /users/:id`, `PATCH /users/:id/status`, `POST /users/:id/reset-password` |
| Sites | `GET/POST /sites`, `PUT /sites/:id`, `PATCH /sites/:id/status`, `POST /sites/:id/supervisors`, `POST /sites/:id/supervisors/replace`, `PATCH /site-supervisors/:id/end` |
| Settings / audit | `GET /settings`, `PUT /settings/:key`, `GET /audit` |
| Vendors | `/equipment/vendors`, `/equipment/vendors/:id/contracts`, `/equipment/contracts/:id/document` |
| Machines | `/equipment/types`, `/equipment/machines`, `/equipment/operators`, `/equipment/machines/:id/rate-cards`, `/equipment/rate-cards/preview` |
| Deployments | `/equipment/deployments` (+ `/end`, `/transfer`) |
| Supervisor day | `GET /equipment/my-sites`, `GET /equipment/attendance/site/:siteId?date=&shift=`, `POST /equipment/attendance/check-in`, `…/:id/downtime/start`, `…/:id/downtime/:dId/end`, `…/:id/check-out`, `POST /equipment/attendance/day-status`, `POST /equipment/attendance/submit` |
| Review | `GET /equipment/admin/attendance`, `POST …/approve`, `POST …/reject`, `POST …/:id/ack-anomaly`, `POST …/:id/correction` |
| Fuel / adjustments | `/equipment/fuel-issues`, `/equipment/adjustments` |
| Paper | `/equipment/timesheets`, `…/:id/print.pdf`, `…/:id/scans`, `…/:id/paper-checks`, `…/:id/close` |
| Payroll | `POST /equipment/payroll/preview`, `GET /equipment/payroll/blockers`, `POST /equipment/payroll/generate`, `…/batches/:id/finalize`, `/mark-paid`, `/void`, `/supersede`, `export.pdf?view=summary\|vendor\|machine`, `export.xlsx`, `GET /equipment/statements/vendor/:id.pdf?from=&to=` |
| Live / reports | `GET /equipment/live`, `GET /equipment/live/sites/:id`, `GET /equipment/reports/daily.pdf`, `GET /equipment/reports/utilization` |

Every request and answer is documented in `docs/03_Backend_API_Spec_EN.md`. Ready-made requests for the VS Code REST Client are in `test.http`.
