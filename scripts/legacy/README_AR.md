# تفويت داتا الآليات القديمة (شباط ← أيلول 2026): خطوات التشغيل والـ Rollback

## شو في بهالفولدر (`legacy`)
| الملف | شو هوّي |
|---|---|
| `legacy_import.js` | السكريبت. بيشغّل الـ backend تبعك جوّاتو وبيمرق كل شي عبر الـ API، يعني كل قوانين السيستم بتنطبق |
| `plan.js` | بيحضّر الخطة ويعمل كل الفحوصات قبل ما ينكتب أي شي |
| `legacy_data.json` | 2,226 يوم شغل مقروءين من ملفات الإكسل الـ 8 (النسخة النهائية تبع 21 تشرين) |
| `legacy_mapping.json` | كل القرارات يلي اتفقنا عليها: أسماء الـ vendors، الأنواع، الليرة ÷100، الهواري، الصهريج اليومي... |
| `out/` | بينعمل لحالو. فيه التقارير والـ logs وملف المطابقة Excel |

## شو انجرّب وشو لأ (لازم تعرف)
- **انجرّب:**
  - الخطة كلها على الـ dump الحقيقي (`equipment_asik_before1_test`)، وطلعت **0 مشاكل**.
  - الحسابات بمحرّك الحساب الحقيقي تبع السيستم.
  - التشغيل كامل على **محاكاة** للـ API والـ database: مشي من أولو لآخرو، وكل بند ساوى المحاسب بالسنت.
  - إعادة التشغيل بعد انقطاع بنص الحضور، وبنص الفواتير، وبين generate وfinalize: كمّل صح بلا تكرار.
  - حماية داتا تشرين وقّفت التشغيل لما تغيّرت.
- **ما انجرّب:** على MySQL حقيقي والـ backend الحقيقي، لأن الجلسة ما كان فيها نت تنزّل MySQL. لهيك **المرحلة 1 إلزامية**: تجربة على نسخة عندك قبل الـ production.

## يلي رح يصير بالسيستم
- 3 أنواع جديدة: Small Roller وSmall Loader وDumper.
- 13 vendor جديد، كل واحد إلو contract. الـ 7 vendors الموجودين بيتقدّم تاريخ بداية الـ contract تبعهن لأول يوم شغل.
- 28 آلية جديدة برقمها متل الإكسل (مثلاً BOBCAT2 بتصير "Bobcat #2"). الـ 16 آلية الموجودة بتنستعمل نفسها، وما بيتكرّر ولا شي.
- 86 rate card بسعر المحاسب لكل فترة.
- 66 deployment.
- 2,226 سطر حضور: submitted وapproved. كل سطر عليه "Legacy import" والسطر بالإكسل يلي جاي منو.
- 65 فاتورة، vendor × شهر، كلها issued، وبلا رفع أوراق موقّعة.
- آخر شي: الآليات والـ vendors الجداد كلهن بيصيروا **Inactive**. يلي شغّال هلق بيضل Active.

**ليش في Adjustment صغيرة؟** السيستم بيحفظ السعر بالساعة برقمين بعد الفاصلة بس، يعني 9.615 بيصير 9.62، وبيحسب الساعات بالدقيقة، يعني 9.33 ساعة بتصير 560 دقيقة. لهيك السكريبت بيزيد سطر Adjustment صغير، اسمو "accountant price rounding"، على الآليات يلي فيها فرق، لحتى يطلع توتال كل فاتورة **متل المحاسب بالظبط**. بالتجربة طلعوا 73 adjustment من أصل 148 بند، أكبرها حوالي 2$، وبالليرة السوري أكبرها 35 ليرة.

## يلي بيحميك
1. **`--dry-run`**: بيقرا بس وما بيكتب ولا حرف. بيعمل الخطة وبيعمل كل الفحوصات: الأرقام، تضارب الأوقات، الـ deployments، الـ rate cards، والترقيم. وبيحسب سلفاً كل فاتورة بنفس محرّك الحساب تبع السيستم.
2. **`--run` ما بيقبل يبلّش** إلا إذا:
   - عطيتو ملف backup عمرو أقل من 12 ساعة، وفيه جداول السيستم.
   - كتبت اسم الـ database بـ `--confirm-db`. هيك ما بيصير تشغّلو على database غلط.
   - الـ dry-run طلع بلا ولا مشكلة.
3. **حماية داتا تشرين:** قبل ما يبلّش، السكريبت بياخد بصمة لكل داتا من 1/10 وطالع: الحضور، الـ downtime، الـ rate cards، الـ deployments، الفواتير، الـ adjustments، المازوت، وجداول الدوام. بعد كل مرحلة بيرجع بيقارن. إذا تغيّر شي، **بيوقف فوراً**.
4. **مطابقة كل فاتورة قبل إصدارها:** كل بند لازم يساوي المحاسب بالسنت قبل ما يتعمل generate. إذا ما ساوى، بيوقف.
5. **إذا وقف بالنص** (انقطع نت أو صار خطأ): بتشغّلو مرة تانية بنفس الأمر، وبيكمّل من وين وقف بلا ما يكرّر شي.
6. **بالآخر** بيطلّع ملف المطابقة `reconciliation_*.xlsx`، وفيه:
   - **Machine x month:** سعر المحاسب، سعر السيستم، مبلغ المحاسب، مبلغ الفاتورة، الفرق، ورقم الفاتورة.
   - **Hours:** ساعات الإكسل مقابل ساعات السيستم، والفرق بالدقيقة من التدوير.
   - **Vendor x month:** توتال المحاسب مقابل توتال الفواتير.
   - **Excel rows:** كل سطر من الإكسل.
   - **Live data check:** داتا تشرين قبل وبعد. لازم تكون كلها "YES".

## الـ Rollback
السكريبت بيمرق عبر الـ API، فما في زر Undo. الرجعة هي **ترجيع الـ backup** يلي بتاخدو قبل التشغيل:
```
mysql -h <HOST> -P <PORT> -u <USER> -p <DB_NAME> < backup_before_legacy.sql
```
- **على Aiven** زيد `--ssl-mode=REQUIRED`.
- **على Windows** شغّل الأوامر يلي فيها `<` أو `>` بالـ **cmd**، مش بالـ PowerShell.
- الـ backup فيه `DROP TABLE IF EXISTS` لكل جدول، فبترجع الـ database **متل ما كانت بالظبط** وقت الـ backup.
- ⚠️ **انتبه:** أي شي انكتب على السيستم بعد الـ backup بينمحى. لهيك التشغيل على الـ production بيكون بوقت ما حدا عم يشتغل عالسيستم.

---

## المرحلة 1: تجربة على نسخة عندك (إلزامية قبل الـ production)

**شو بدك:** Node 20 أو أحدث، والـ backend تبعك مع `npm install`، وMySQL 8 على الكمبيوتر.

1. **حط الفولدر:** انسخ فولدر `legacy` كلّو جوّا `equipment_asik_backend\scripts\`، فبيصير `scripts\legacy\legacy_import.js`.
2. **رجّع الـ dump على database جديدة عندك:**
   ```
   mysql -u root -p -e "CREATE DATABASE equipment_asik_copy CHARACTER SET utf8mb4"
   mysql -u root -p equipment_asik_copy < equipment_asik_before1_test
   ```
   الأحسن تعمل dump جديد من الـ production هلق، وترجّعو بدل `equipment_asik_before1_test`.
3. **اعمل ملف `.env.copy`:** نسخة عن `.env`، وغيّر فيها بس `DB_HOST=127.0.0.1` و`DB_NAME=equipment_asik_copy` و`DB_USER/DB_PASSWORD` تبع الـ MySQL عندك، و`DB_SSL=false`.
4. **اعمل المستخدم يلي بيشغّل الـ import** (مرة وحدة):
   ```
   node --env-file=.env.copy scripts/createAdmin.js --username legacy_import --name "Legacy import"
   ```
5. **Dry run:**
   ```
   node --env-file=.env.copy scripts/legacy/legacy_import.js --dry-run
   ```
   افتح `scripts\legacy\out\dry_run_report_*.txt`، ولازم يكون مكتوب `PROBLEMS (0)`.
6. **Backup للنسخة، وبعدين التشغيل:**
   ```
   mysqldump -u root -p --single-transaction --routines --triggers equipment_asik_copy > backup_copy.sql
   node --env-file=.env.copy scripts/legacy/legacy_import.js --run --backup backup_copy.sql --confirm-db equipment_asik_copy
   ```
   لازم بالآخر يطلع: `items not equal to the accountant: 0`.
7. **افحص:**
   - افتح ملف المطابقة `out\reconciliation_*.xlsx`.
   - شغّل التطبيق على النسخة إذا بدك تشوف بعينك: ريبورتات آلية، فواتير، Billing history.
   - انتبه لكم دقيقة بتاخد كل مرحلة. السكريبت بيكتبها بالـ log.
8. **ابعتلي فولدر `out`** (الـ report والـ log وملف المطابقة) لراجعو معك قبل الـ production.

## المرحلة 2: الـ production (بس بعد ما تنجح المرحلة 1)

1. **اختار الوقت:** وقت ما حدا عم يشتغل عالتطبيق، وخبّر المشرفين ما يسجّلوا لحتى تخلص.
2. **خلّي الـ `.env` يأشّر عالـ production** (Aiven)، أو اعمل `.env.prod`.
3. **أنشئ المستخدم على الـ production:**
   ```
   node --env-file=.env.prod scripts/createAdmin.js --username legacy_import --name "Legacy import"
   ```
4. **Backup للـ production قبل أي شي:**
   ```
   mysqldump -h <AIVEN_HOST> -P <PORT> -u avnadmin -p --ssl-mode=REQUIRED --single-transaction --set-gtid-purged=OFF --routines --triggers --no-tablespaces equipment_asik > backup_before_legacy.sql
   ```
   بتقدر كمان تعمل Export من DBeaver متل ما عملت قبل. **احفظ هالملف بمحل آمن.**
5. **Dry run على الـ production:**
   ```
   node --env-file=.env.prod scripts/legacy/legacy_import.js --dry-run
   ```
   لازم يطلع `PROBLEMS (0)`.
6. **التشغيل:**
   ```
   node --env-file=.env.prod scripts/legacy/legacy_import.js --run --backup backup_before_legacy.sql --confirm-db equipment_asik
   ```
7. **الفحص:** افتح ملف المطابقة. لازم يكون `items not equal: 0`، وكل "Live data check" يكون YES.
8. **إذا شي مش مظبوط:** ترجّع `backup_before_legacy.sql` بالأمر تبع الـ Rollback فوق.

**عن الوقت:** على النسخة المحلية كلّو بياخد دقايق. على Aiven كل طلب بيروح عالإنترنت، فممكن ياخد أطول بكتير. السكريبت فيه حوالي 3,300 طلب، وكل طلب عدة استعلامات للـ database. إذا وقت المرحلة 1 عندك بيعطي فكرة إنو الـ production رح ياخد أكتر من ساعة، قلّي، ومنعمل الطريقة البديلة: منشغّلو على نسخة محلية جديدة، وبعدين منرفع النتيجة عالـ production بخطوة وحدة.

## إذا وقف السكريبت
- اقرا السطر تبع **STOPPED** أو **FAILED** بالشاشة أو بالـ log. كل رسالة بتقول شو المشكلة.
- إذا المشكلة مؤقتة، متل نت أو اتصال: بتشغّل نفس الأمر مرة تانية وبيكمّل.
- إذا المشكلة بالداتا، أو مش فاهم شو صار: **ما تكمّل**. ابعتلي الـ log، أو رجّع الـ backup.
