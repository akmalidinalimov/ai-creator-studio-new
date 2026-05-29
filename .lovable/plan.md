## Goal

Make homework submissions work only through the Telegram bot private chat:

- Direct image/video uploads in Telegram group topics stay ignored.
- When a student opens the homework submission flow in the bot and sends an image/video to the bot, it is recorded as homework.
- The student receives a confirmation message.
- The teacher receives/queues the existing “waiting for review” notification.

## What I found

- The direct group-topic ignore rule is working: recent logs show `hw:group:ignored-not-bot-flow`, and no new submission was created for those topic uploads.
- The bot-DM upload did not reach the private homework upload handler: recent logs show the bot flow callbacks and group-topic uploads, but no `hw:dm:*` log entries for a private photo upload.
- The current code only handles `update.message` for private uploads. Telegram can send media albums/forwarded or certain bot messages in shapes that are not being processed by this new DM submission path, and there is not enough diagnostic logging when a private message has an active intent but is skipped.

## Implementation plan

1. Strengthen the private bot submission intake
   - Handle private homework uploads before normal button/menu routing for all supported Telegram inbound message shapes that contain a private message.
   - Keep accepting only photo, video, video note, and image/video documents.
   - If the student has an active intent and sends unsupported content, send the existing “only photo/video” reminder instead of silently falling through.

2. Make the bot-DM happy path reliable
   - Use the active intent to copy the media into the configured group topic with `copyMessage`.
   - Record the submission with `source: "telegram_bot_dm"` and the copied group-topic message ID/URL.
   - Delete the consumed intent only after a successful submission record.
   - Send the existing student confirmation message.
   - Queue/send the existing teacher notification.

3. Preserve direct group-topic safety
   - Leave `handleGroupTopicMessage` as a silent ignore path for all group/supergroup/channel topic messages.
   - Do not reintroduce any topic-based homework matching or auto-detection.

4. Add targeted diagnostics for verification
   - Add concise logs for: active intent found, non-media rejected, copy success/failure, submission upsert success/failure, student confirmation sent, teacher notification queued/sent.
   - These logs will make end-to-end testing clear without changing user-facing behavior.

5. Test after deployment
   - Run edge-function tests if available for this webhook.
   - Deploy `telegram-bot-webhook`.
   - Verify with logs and database reads:
     - Direct group-topic image/video: ignored, no submission row, no DMs.
     - Bot flow + image sent to bot DM: `telegram_bot_dm` submission row created, intent deleted, student confirmation sent, teacher notification queued/sent.
     - Bot flow + text/non-media in bot DM: reminder sent, no submission, intent remains.

## Best approach

The best approach remains: students submit media to the bot private chat, and the bot mirrors it to the topic. Telegram does not provide a reliable signal that differentiates “uploaded after clicking a bot topic link” from “uploaded directly in the group topic,” so accepting group-topic uploads would keep causing false homework submissions.