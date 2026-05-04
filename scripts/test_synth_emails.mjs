import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

// Replicate the sanitizer from the edge function.
const sanitizeForEmailLocal = (raw) => (raw || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^\x00-\x7F]/g, '')
  .replace(/[^a-z0-9._-]/g, '')
  .replace(/^[._-]+|[._-]+$/g, '')
  .slice(0, 32);

const shortHash = async (s) => {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = Array.from(new Uint8Array(digest)).slice(0, 6);
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
};

// The 10 previously failing rows from the screenshot
const failingRows = [
  { name: 'Угилой', tg_id: 7882146989, tg_user: 'Ugiloy_S' },
  { name: 'Н.', last: 'К.М.', tg_id: 193056361, tg_user: 'NigoraKM' },
  { name: 'Мохичехра', last: 'Ахророва', tg_id: 738290859, tg_user: 'Mohichehra_ohbaby' },
  { name: 'Жамолиддин', last: 'Boboyev', tg_id: 786175275, tg_user: '' },
  { name: 'Н', tg_id: 5173813651, tg_user: 'babykidslux' },
  { name: 'Azimovna🌸🌼', tg_id: 6033790654, tg_user: '' },
  { name: 'Мухайё💥', tg_id: 5531331813, tg_user: 'M280683' },
  { name: 'Бегзод', last: 'Адилов', tg_id: 166413283, tg_user: 'abuabdulloh_77777' },
  { name: '@RANO_', last: 'BAHTIYAROVA', tg_id: 1794291402, tg_user: 'Rano_Bahtiyarova' },
  { name: 'Q^', tg_id: 99999999991, tg_user: '' }, // synthetic q^ test
];

let pass = 0, fail = 0;
for (const r of failingRows) {
  let email = '';
  if (r.tg_id) email = `tg-${r.tg_id}@telegram.local`;
  else {
    const safe = sanitizeForEmailLocal(r.tg_user);
    if (safe) email = `tg-${safe}@telegram.local`;
    else {
      const h = await shortHash(`${r.name}|${r.last||''}|${r.tg_user||''}|${r.tg_id||''}`);
      email = `tg-anon-${h}@telegram.local`;
    }
  }
  // Try createUser then immediately delete
  const { data, error } = await admin.auth.admin.createUser({
    email, password: 'TestPass123!xyz', email_confirm: true,
    user_metadata: { name: r.name, last_name: r.last || null },
  });
  if (error) {
    console.log('❌', email, '|', error.message);
    fail++;
  } else {
    console.log('✅', email);
    pass++;
    await admin.auth.admin.deleteUser(data.user.id);
  }
}
console.log(`\n${pass}/${failingRows.length} pass · ${fail} fail`);
