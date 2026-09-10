# Leap Lead Alerts – מסמך מערכת (עדכני ל-04/09/2026)

## רכיבים
| רכיב | איפה | תפקיד |
|---|---|---|
| תוסף WordPress `leap-lead-alerts` (v1.2, Network Active) | האתרים snaploans.cash | תופס את תשובת Leap בדפדפן של הגולש ושולח פינג ללא פרטים אישיים ל-`lead-alert` (שניות) |
| Edge Function `lead-alert` | Supabase / leap-lead-alerts | שומר בטבלה + התראת טלגרם. אם הליד כבר הוכרז כ"ממתין" מהסנכרון – שולח "עדכון: הליד אושר" |
| Edge Function `leap-sync` (כל דקה) | Supabase | מתחבר ל-Leap (LEAP_USER/LEAP_PASS), קורא את דוח הלידים של היום (שעון קליפורניה), משלים חסרים: "ליד נוצר – ממתין" ואז "עדכון: אושר" עם הסכום. Leap = מקור האמת לסכומים |
| Edge Function `daily-summary` | Supabase | סיכום יומי 10:00 שעון ישראל (אחרי סנכרון), פקודות בוט: /summary /today /week /month /top /domain /state /day /help |
| טבלה `leap_leads` | Supabase | לוג כל הלידים (ללא פרטים אישיים): מזהה, דומיין, state, סטטוס, payout, סכום מבוקש, מקור (xhr/hook/leap-sync) |
| `app_secrets` | Supabase | cron_key, עוגיית session של Leap, מצב הסנכרון |

## Secrets (Edge Functions → Secrets)
TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LEAP_USER, LEAP_PASS. (אופציונלי: SUMMARY_TZ, SUMMARY_HOUR, ALERT_KEY)

## תזמונים (pg_cron, UTC)
- `leap_sync_1min` – כל דקה
- `daily_summary_0700utc` + `daily_summary_0800utc` – הפונקציה שולחת רק כשהשעה בישראל היא 10:00

## תחזוקה
- שינוי סיסמה ב-Leap → לעדכן LEAP_PASS. הבוט יתריע פעם ב-6 שעות אם ההתחברות נכשלת.
- אם Leap משנים את מבנה הדוח → לעדכן את `parseLeads` ב-leap-sync (יש מצב אבחון: `{"debug":true,"days":["YYYY-MM-DD"]}`).
- השלמת היסטוריה בשקט: `{"days":["YYYY-MM-DD"],"alert":false}`.
- הפריסה של `leap-sync` נעשית ידנית דרך עורך הפונקציות ב-Supabase (הדבקת הקוד + Verify JWT כבוי).
