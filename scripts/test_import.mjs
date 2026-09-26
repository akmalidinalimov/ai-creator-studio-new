import fs from 'fs';
import Papa from 'papaparse';

const csv = fs.readFileSync('/tmp/users_import_1guruh.csv', 'utf8');
const parsed = Papa.parse(csv, { header: true, skipEmptyLines: 'greedy' });
const rows = parsed.data;

// Pre-filter just like GroupDetail.tsx does (only "new"/"moved" with name OR identifier)
const students = rows.map(r => ({
  name: (r.name || '').trim(),
  last_name: (r.last_name || '').trim() || undefined,
  email: (r.email || '').trim() || '',
  telegram_user_id: r.telegram_user_id ? Number(String(r.telegram_user_id).replace(/[^\d]/g, '')) : undefined,
  telegram_username: (r.telegram_username || '').trim().replace(/^@/, '') || undefined,
  role: 'student',
})).filter(s => s.name || s.email || s.telegram_user_id || s.telegram_username);

console.log('Total rows to send:', students.length);
console.log('First 3:', JSON.stringify(students.slice(0,3), null, 2));

// The target project must be named explicitly on every run. This used to hardcode the ORIGINAL
// project's URL while sending SUPABASE_SERVICE_ROLE_KEY — so running it with production's key in the
// shell sent a full-database credential to a project this codebase no longer controls. It is not
// defaulted to production either: this bulk-creates students, and aiming it at the live database
// should be a deliberate choice, not the fallback. See 20260926161000.
const SUPABASE_URL = process.env.SUPABASE_URL;
if (!SUPABASE_URL || !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(SUPABASE_URL)) {
  console.error('Refusing to run: set SUPABASE_URL=https://<project-ref>.supabase.co explicitly.');
  process.exit(1);
}
const r = await fetch(`${SUPABASE_URL}/functions/v1/admin-create-students`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  body: JSON.stringify({
    students,
    target_group_id: 'b5fac0b8-b670-4757-bf74-e007a86e17e5',
    csv_import: true,
  }),
});
const res = await r.json();
console.log('HTTP', r.status);
const counts = {};
for (const x of (res.results || [])) counts[x.status] = (counts[x.status]||0)+1;
console.log('Counts:', counts);
const errs = (res.results || []).filter(x => x.status === 'error' || x.status === 'invalid_email');
console.log('Errors (' + errs.length + '):');
for (const e of errs) console.log('  -', e.email, '|', e.error || e.status);
