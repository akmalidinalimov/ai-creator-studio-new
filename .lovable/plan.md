## Root cause

The platform has **two separate places** where Telegram topics are stored, and the student submission flow only reads from one of them:

1. **`groups.homework_topic_url` / `homework_topic_id`** — single shared topic per group, edited from the **Admin → Groups** page (`AdminGroups.tsx`).
2. **`group_module_topics.telegram_topic_url`** — one topic per (group, module), edited from the **GroupTopicsSection** collapsible on each group.

**Group 8 was configured using only #1** (the shared homework topic on the group itself). The DB confirms this:

```
8-GURUH   homework_topic_id=3  homework_topic_url=https://t.me/c/3912373335/3
          group_module_topics rows: 0
```

But the student-facing flow in `telegram-bot-webhook/index.ts` only queries `group_module_topics`:

- `startHomeworkIntent` (line ~3022) — when student taps "📤 Topshirish" in /vazifalar, queries `group_module_topics` for that module; if empty → sends `hwIntentNoTopic` ("Topic not configured for this module").
- Pending-list digest (line ~1274 and ~2192) — same single-source lookup; shows `⚠️ Topik sozlanmagan` next to every task.
- `resolveGroupFromChatId` (line ~3064) — pattern 1 matches by `group_module_topics.telegram_topic_url`. For group 8 this also returns nothing, so we fall through to patterns 2/3 (which happen to work for group 8 because `telegram_group_url` exists — but if it didn't, posts in the shared topic couldn't be attributed to a group).

The auto-detect handler at line ~3425 *does* know about `groups.homework_topic_id` ("shared_topic" path), so a student who manually navigates to the topic and posts there is actually accepted. But the student never gets there because the bot tells them the topic is not configured first.

## Fix

Make `groups.homework_topic_url` a **first-class fallback** everywhere the bot resolves a module's submission topic. No schema changes, no UI changes — purely backend behavior so existing group 8 (and any future group configured the same way) just works.

### Edits (all in `supabase/functions/telegram-bot-webhook/index.ts`)

1. **Add a helper** `resolveModuleTopicUrl(admin, groupId, moduleId)`:
   - Look up `group_module_topics(group_id, module_id).telegram_topic_url` first.
   - If missing, fall back to `groups.homework_topic_url` for that `group_id`.
   - Return `{ url, source: "per_module" | "shared" | null }`.

2. **`startHomeworkIntent`** (~line 3022): replace the direct `group_module_topics` query with `resolveModuleTopicUrl`. Keep `parseTopicUrl` + intent upsert as-is — the shared topic URL has the same `https://t.me/c/{chatId}/{threadId}` shape.

3. **Pending-homework digest** (~line 1274 and ~line 2192): when `topicMap.get(m.mid)` is empty, fall back to the group's `homework_topic_url`. Fetch `groups.homework_topic_url` alongside the existing query (1 extra column on an already-loaded row, or 1 extra small select).

4. **`resolveGroupFromChatId`** (~line 3064): insert a new pattern between current Pattern 1 and Pattern 2 that matches `groups.homework_topic_url ILIKE '%/c/{stripped}/%'`. This guarantees group attribution for groups configured the shared-topic way, even if `telegram_group_url` is an invite link.

5. **`weekly-admin-topic-check`** (separate file): treat a module as "configured" when either `group_module_topics` has a row OR `groups.homework_topic_url` is set — otherwise admins will get noisy false-positive weekly warnings about group 8.

### Verification

- Re-run the pending list for a group-8 student and confirm each task now shows the topic button using the shared URL.
- Simulate `/vazifalar` → "📤 Topshirish" callback for a group-8 user and confirm `hwIntentReady` (not `hwIntentNoTopic`) is sent.
- Deploy `telegram-bot-webhook` + `weekly-admin-topic-check` and check edge logs for `resolveModuleTopicUrl` source distribution.

### Out of scope

- No DB migration. The two storage locations stay; we just unify reads.
- No UI changes. The Admin → Groups shared-topic input is now genuinely sufficient on its own; the per-module GroupTopicsSection remains as an optional override.

### Summary message for the user

The reason group 8 students saw "topic not set up" is that the bot was only reading per-module topic rows (the collapsible "📲 Telegram guruh va topiklar" section), not the shared topic URL you set on the group itself. Once this fix ships, the single homework topic you configure on a new group will automatically apply to every module, and the per-module section becomes optional.
