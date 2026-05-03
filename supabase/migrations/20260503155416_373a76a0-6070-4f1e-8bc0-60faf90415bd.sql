ALTER TABLE public.telegram_magic_links DROP CONSTRAINT IF EXISTS telegram_magic_links_purpose_check;
ALTER TABLE public.telegram_magic_links
  ADD CONSTRAINT telegram_magic_links_purpose_check
  CHECK (purpose IN (
    'login',
    'deeplink_lesson',
    'deeplink_course',
    'reengagement',
    're_engagement',
    'nudge',
    'nudge_inactive_3d',
    'nudge_inactive_7d',
    'nudge_stuck_lesson',
    'nudge_module_complete',
    'cert_celebration',
    'reset_password',
    'email_confirm'
  ));