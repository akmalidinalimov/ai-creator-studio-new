# AI Creators — Certificate Template

The approved module-completion certificate (locked with the owner, 2026-08-18).

**Design:** graphite "Deco Frame" (matches the app's Graphite & Emerald palette), the real
**AI CREATORS ACADEMY** logo, a gold + emerald double frame with the brand's green-cube motif in
the top corners, and Onest / Unbounded / Playfair type. No seal. Everything sits inside the frame.

## File
- `certificate-template.html` — self-contained (fonts embedded as data-URIs). It renders as a clean,
  **edge-to-edge certificate** at a **1.414 landscape** ratio, so a screenshot at e.g. **1400×990**
  produces the final certificate PNG with no surrounding chrome.

## Variables
Replace these placeholders in the HTML, then render to PNG:

| Placeholder | Example | Notes |
|---|---|---|
| `{{STUDENT_NAME}}` | `Bekzod Karimov` | the graduate |
| `{{MODULE_NAME}}`  | `4-modul · Video montaj` | use the middle-dot `·` |
| `{{DATE}}`         | `18.08.2026` | completion date (DD.MM.YYYY) |
| `{{CERT_ID}}`      | `AC-2026-4M-1203` | unique id |

Everything else is fixed:
- Title: *Modul sertifikati* · *Ushbu sertifikat tasdiqlaydi*
- Body: **«AI CREATORS» kursining {{MODULE_NAME}} modulini muvaffaqiyatli tamomladi**
- Signatures: **Shahlo va Akmalidin** — *Oʻqituvchilar: Shvetsiyadan AI Expertlar*

## Generate
1. Read `certificate-template.html`, replace the four placeholders.
2. Save the filled HTML, screenshot it at a 1.414 viewport (e.g. 1400×990) → the certificate PNG.

Per the UI-redesign spec, certificates are **generated on-demand and delivered by DM** when a student
completes a module; the PNGs are **not stored permanently** (only the completion record is kept).
A course-completion variant uses the same template with the course (not a module) in the body.
