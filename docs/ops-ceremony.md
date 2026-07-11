# Ops approve-flow ceremony

First production test of the Telegram approve loop: this PR was merged by the owner
tapping ✅ Tasdiqlash on their phone — no laptop involved.

- Date: 2026-07-12
- Chain: ops-notify DM → admin-guarded ops: callback → verifyOpsPr → checksAllGreen
  (CI merge gate) → two-tap confirm → squash-merge → deploy pipeline
