/**
 * AI Creators — Sales intake → platform auto-import.
 * Paste this in your intake Google Sheet: Extensions → Apps Script.
 * Setup steps are in README.md. Columns (row 1) MUST be, in this order:
 *   A First name | B Last name | C Telegram username | D Course | E Tier |
 *   F Group | G Phone | H Email | I Status | J Imported at | K Notes
 * Sales fill A–H (A,C,D,E,F are required). The script fills I,J,K.
 */

/*** CONFIG ***/
// Production (project cdyidatkegxwhtuoqxly). Until 2026-09 this file pointed at the OLD pre-2026-07-05
// project, so a sheet set up from it kept importing students into a database the platform no longer
// reads. To aim at another backend (e.g. a staging project) set the Script Property
// SHEET_SYNC_ENDPOINT instead of editing this line.
const DEFAULT_ENDPOINT = 'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/sheet-sync';
const SHEET_NAME = 'Intake';   // the tab sales fill
const BATCH_SIZE = 50;

// 1-indexed columns (match the header row above).
const COL = { FIRST: 1, LAST: 2, TG: 3, COURSE: 4, TIER: 5, GROUP: 6, PHONE: 7, EMAIL: 8, STATUS: 9, AT: 10, NOTES: 11 };

// Optional override: Project Settings → Script properties → SHEET_SYNC_ENDPOINT = <full sheet-sync URL>.
// Leave it unset to use production.
function getEndpoint_() {
  const e = String(PropertiesService.getScriptProperties().getProperty('SHEET_SYNC_ENDPOINT') || '').trim();
  return e || DEFAULT_ENDPOINT;
}

// Secret lives ONLY in Script Properties (never hard-code it here):
// Project Settings → Script properties → add  SHEET_SYNC_SECRET = <same value set in Supabase>
function getSecret_() {
  const s = PropertiesService.getScriptProperties().getProperty('SHEET_SYNC_SECRET');
  if (!s) throw new Error('Set SHEET_SYNC_SECRET in Project Settings → Script properties');
  return s;
}

/** Runs on the time trigger: sends every row that has no Status yet. */
function processRows() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;           // skip if a previous run is still going
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    if (!sh) throw new Error('Sheet tab "' + SHEET_NAME + '" not found');
    const last = sh.getLastRow();
    if (last < 2) return;
    const data = sh.getRange(2, 1, last - 1, COL.NOTES).getValues();

    const pending = [];
    for (let i = 0; i < data.length; i++) {
      const rowNum = i + 2;
      const status = String(data[i][COL.STATUS - 1] || '').trim();
      const tg = String(data[i][COL.TG - 1] || '').trim();
      if (status) continue;                  // already processed
      if (!tg) continue;                     // empty row — nothing to import yet
      pending.push({
        row: rowNum,
        name: String(data[i][COL.FIRST - 1] || '').trim(),
        last_name: String(data[i][COL.LAST - 1] || '').trim(),
        telegram_username: tg,
        course: String(data[i][COL.COURSE - 1] || '').trim(),
        tier: String(data[i][COL.TIER - 1] || '').trim(),
        group_name: String(data[i][COL.GROUP - 1] || '').trim(),
        phone: String(data[i][COL.PHONE - 1] || '').trim(),
        email: String(data[i][COL.EMAIL - 1] || '').trim(),
      });
    }
    if (!pending.length) return;

    const endpoint = getEndpoint_();
    for (let b = 0; b < pending.length; b += BATCH_SIZE) {
      const batch = pending.slice(b, b + BATCH_SIZE);
      const resp = UrlFetchApp.fetch(endpoint, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-sheet-secret': getSecret_() },
        payload: JSON.stringify({ rows: batch }),
        muteHttpExceptions: true,
      });
      const code = resp.getResponseCode();
      let results = [];
      try { results = JSON.parse(resp.getContentText()).results || []; } catch (e) {}
      const byRow = {};
      results.forEach(function (r) { byRow[r.row] = r; });

      const now = new Date();
      batch.forEach(function (item) {
        const r = byRow[item.row];
        let status, note;
        if (code === 403) { status = '❌ Error'; note = 'Server HTTP 403: the SHEET_SYNC_SECRET Script property does not match SHEET_SYNC_SECRET in Supabase (or it is not set there)'; }
        else if (code !== 200) { status = '❌ Error'; note = 'Server HTTP ' + code; }
        else if (!r) { status = '❌ Error'; note = 'No result returned'; }
        else if (r.status === 'created') { status = '✅ Imported'; note = ''; }
        // admin-create-students reports a student already in that group as 'already_in_group'.
        else if (r.status === 'updated' || r.status === 'matched' || r.status === 'already_in_group' || r.status === 'skipped_already_in_group') {
          status = '✔️ Already on platform'; note = r.message || '';
        } else { status = '⚠️ ' + r.status; note = r.message || ''; }
        sh.getRange(item.row, COL.STATUS).setValue(status);
        sh.getRange(item.row, COL.AT).setValue(now);
        sh.getRange(item.row, COL.NOTES).setValue(note);
      });
      SpreadsheetApp.flush();
    }
  } finally {
    lock.releaseLock();
  }
}

/** Run ONCE from the editor (▶) to create the 15-minute trigger. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processRows') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processRows').timeBased().everyMinutes(15).create();
}
