-- 011: the business clock is Syria time (Asia/Damascus, UTC+3 all year), not Beirut (which changes in winter).
UPDATE settings SET setting_value = 'Asia/Damascus' WHERE setting_key = 'app_time_zone' AND setting_value = 'Asia/Beirut';
