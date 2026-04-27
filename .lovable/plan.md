## Add `vercel.json` for SPA routing

Create a single file at the repo root so Vercel rewrites all paths to `index.html`, allowing React Router to handle deep links on `aicreator.academy` (fixes the current `404 NOT_FOUND` on refresh / direct navigation).

### File to create

**`vercel.json`** (repo root):

```json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

### Notes

- No other code changes.
- Lovable's GitHub integration auto-syncs the commit, which will trigger Vercel's auto-deploy.
- This only affects the Vercel-hosted `aicreator.academy` domain. Lovable's own hosting (`*.lovable.app`) already handles SPA fallback automatically and ignores `vercel.json`, so nothing changes there.
