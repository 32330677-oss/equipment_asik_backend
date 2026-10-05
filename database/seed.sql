-- database/seed.sql (idempotent). The first Admin user is created by scripts/createAdmin.js (bcrypt), not here.
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  ('eq_payroll_requires_paper_match', 'false'),  -- true = payroll only takes rows whose paper_status = Matched
  ('eq_paper_tolerance_minutes',      '10'),     -- paper vs electronic time difference still "Matched"
  ('eq_meter_tolerance_pct',          '15'),     -- meter delta vs working hours: above -> anomaly
  ('eq_long_session_review_hours',    '16'),     -- open/long session -> anomaly (warning only)
  ('eq_default_currency',             'USD'),
  ('eq_timesheet_blank_rows',         '6'),      -- empty rows printed under the recorded rows
  ('eq_live_refresh_seconds',         '60'),
  ('week_start_day',                  '6'),      -- 0=Sun..6=Sat; week used by the submit gate
  ('week_gate_enabled',               'true'),   -- a day cannot be submitted while last week has Drafts
  ('company_name',                    'ASIK ENGINEERING CONSTRUCTION'),
  ('app_time_zone',                   'Asia/Beirut');

INSERT IGNORE INTO eq_types (type_name, type_name_ar, meter_unit) VALUES
  ('Excavator', 'حفارة', 'Hours'), ('Wheel Loader', 'تركس', 'Hours'), ('Bulldozer', 'بلدوزر', 'Hours'),
  ('Mobile Crane', 'رافعة متحركة', 'Hours'), ('Tower Crane', 'رافعة برجية', 'Hours'),
  ('Dump Truck', 'قلاب', 'Km'), ('Roller', 'مدحلة', 'Hours'), ('Grader', 'جريدر', 'Hours'),
  ('Backhoe Loader', 'باكر', 'Hours'), ('Concrete Pump', 'مضخة باطون', 'Hours'),
  ('Generator', 'مولدة', 'Hours'), ('Forklift', 'رافعة شوكية', 'Hours'), ('Water Tanker', 'صهريج مياه', 'Km');
