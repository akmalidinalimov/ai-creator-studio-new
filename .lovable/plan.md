## Change

Remove the `(o'rtacha X/10)` / `(средняя X/10)` / `(avg X/10)` parenthesis from the `/Statistikam` homework line in the Telegram bot. Keep both the submission count and the points total.

## After

- UZ: `📝 Uy vazifalari: 2/5 topshirildi · 18/50 ball`
- RU: `📝 Домашка: 2/5 сдано · 18/50 баллов`
- EN: `📝 Homework: 2/5 submitted · 18/50 pts`

## File

`supabase/functions/telegram-bot-webhook/index.ts` — update `statsHomework` template strings on lines 103, 296, 479. Drop the now-unused `avg` parameter and the `avg` calculation at the call site (line 1148).

No DB or other changes.
