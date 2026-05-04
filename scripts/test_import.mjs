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

const r = await fetch('https://wpdztrijasgmxgliwddr.supabase.co/functions/v1/admin-create-students', {
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
