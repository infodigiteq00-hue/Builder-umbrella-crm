// Receives leads from project websites and appends them to the "Leads" tab of
// the spreadsheet this script is attached to. Each site sends its own project
// name; SHEET_BY_PROJECT decides which tab it lands on.
// Deploy: Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.

const DEFAULT_SHEET = 'Leads';
// Projects whose name starts with the key go to that tab; everything else goes to DEFAULT_SHEET.
const SHEET_BY_PROJECT = { 'The Industrial Land': 'Sheet1' };
const HEADERS = ['Date & time', 'Project', 'Form', 'Name', 'Mobile', 'Email', 'Configuration', 'Message', 'Location', 'Budget', 'Timeline', 'Site visit', 'Page'];
// Every new lead is also emailed here. Several addresses: 'a@x.com, b@y.com'
const MOBILE_COL = 5; // column E
const NOTIFY_TO = 'builderumbrella@gmail.com';

// Real Estate CRM: every new (non-duplicate) lead is also sent to its public enquiry endpoint.
// Set CRM_ENABLED = false to pause sending without touching anything else.
const CRM_ENABLED = true;
const CRM_URL = 'https://crm.builderumbrella.com/api/public/enquiries';
const CRM_CAMPAIGN = { 'Lodha Wakad': 'lodha-wakad-living-forest', 'The Industrial Land': 'panoli-industrial-land' };
// Budget label -> rupees [min, max] (null = open ended), matching the options on the forms
const CR = 10000000, LAKH = 100000;
const BUDGET_RANGE = {
  'Below ₹2 Cr': [null, 2 * CR], '₹2 Cr – ₹2.5 Cr': [2 * CR, 2.5 * CR], '₹2.5 Cr – ₹3 Cr': [2.5 * CR, 3 * CR],
  '₹3 Cr – ₹4 Cr': [3 * CR, 4 * CR], 'Above ₹4 Cr': [4 * CR, null],
  'Below ₹50 lakh': [null, 50 * LAKH], '₹50 lakh – ₹1 crore': [50 * LAKH, CR], '₹1 crore – ₹3 crore': [CR, 3 * CR],
  '₹3 crore – ₹5 crore': [3 * CR, 5 * CR], 'Above ₹5 crore': [5 * CR, null]
};

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = sheetFor_(ss, d.project);
    // One entry per mobile number per tab: a repeat submission is ignored
    const phone = digits_(d.phone);
    if (phone && sh.getLastRow() > 1 &&
        sh.getRange(2, MOBILE_COL, sh.getLastRow() - 1, 1).getValues().some(r => digits_(r[0]) === phone)) {
      return ContentService.createTextOutput('duplicate');
    }
    // Cap length and stop values starting with = + - @ being read as formulas
    const clean = v => String(v == null ? '' : v).slice(0, 500).replace(/^[=+\-@]/, "'$&");
    const row = [
      new Date(),
      clean(d.project),
      clean(d.form),
      clean(d.name),
      d.phone ? "'+91 " + clean(d.phone) : '',
      clean(d.email),
      clean(d.config),
      clean(d.message),
      clean(d.location),
      clean(d.budget),
      clean(d.timeline),
      clean(d.visit),
      clean(d.page)
    ];
    sh.appendRow(row);
    // The lead is already saved, so a mail failure (e.g. daily quota) must not fail the request
    try {
      emailLead_(row, ss.getUrl());
    } catch (err) {
      console.error('Lead email failed: ' + err);
    }
    try {
      if (CRM_ENABLED) sendToCrm_(d);
    } catch (err) {
      console.error('CRM send failed: ' + err);
    }
    return ContentService.createTextOutput('ok');
  } finally {
    lock.releaseLock();
  }
}

function emailLead_(row, sheetUrl) {
  const esc = v => String(v).replace(/^'/, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const time = Utilities.formatDate(row[0], 'Asia/Kolkata', 'dd MMM yyyy, h:mm a');
  const phone = esc(row[4]);
  const cells = HEADERS.map((h, i) => {
    if (!row[i]) return '';
    let v = i === 0 ? time : esc(row[i]);
    if (i === 4) v = '<a href="tel:' + phone.replace(/\s/g, '') + '">' + phone + '</a>';
    return '<tr><td style="padding:6px 12px 6px 0;color:#666">' + h + '</td><td style="padding:6px 0"><b>' + v + '</b></td></tr>';
  }).join('');
  const name = String(row[3]).replace(/^'/, '') || 'No name';
  const project = String(row[1]).replace(/^'/, '');
  const options = {
    name: 'Website Leads',
    htmlBody: '<table style="font:14px Arial,sans-serif;border-collapse:collapse">' + cells + '</table>' +
      '<p style="font:13px Arial,sans-serif"><a href="' + sheetUrl + '">Open the leads sheet</a></p>'
  };
  if (row[5]) options.replyTo = String(row[5]).replace(/^'/, '');
  MailApp.sendEmail(NOTIFY_TO, 'New lead: ' + name + (project ? ' – ' + project : ''),
    HEADERS.map((h, i) => row[i] ? h + ': ' + (i === 0 ? time : String(row[i]).replace(/^'/, '')) : '').filter(String).join('\n'),
    options);
}

// Run once from the editor (select it, click Run) to grant the "send email"
// permission before deploying the new version, and to see a sample email.
function testLeadEmail() {
  emailLead_([new Date(), 'Test project', 'Enquire', 'Test Lead', "'+91 9999999999", '', '2 BHK', 'This is a test', ''],
    SpreadsheetApp.getActiveSpreadsheet().getUrl());
}

function tabFor_(project) {
  const p = String(project || '');
  const key = Object.keys(SHEET_BY_PROJECT).find(k => p.indexOf(k) === 0);
  return key ? SHEET_BY_PROJECT[key] : DEFAULT_SHEET;
}

function sheetFor_(ss, project) {
  const name = tabFor_(project);
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  // Only write headings into an empty tab, never over existing data
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// Last 10 digits, so "+91 98765 43210" and "9876543210" count as the same number
function digits_(v) {
  return String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
}

// One-off clean-up: run from the editor. Moves each project's rows to its own tab,
// then deletes repeat entries (same mobile number in the same tab), keeping the oldest.
function tidyLeads() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let moved = 0, removed = 0;
  ss.getSheets().forEach(sh => {
    const rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS.length).getValues() : [];
    const out = {};
    for (let i = rows.length - 1; i >= 0; i--) {
      const target = tabFor_(rows[i][1]);
      if (rows[i][1] && target !== sh.getName()) {
        (out[rows[i][1]] = out[rows[i][1]] || []).unshift(rows[i]); // keep oldest first
        sh.deleteRow(i + 2);
        moved++;
      }
    }
    Object.keys(out).forEach(project => {
      const dest = sheetFor_(ss, project);
      const at = dest.getLastRow() + 1;
      dest.getRange(at, MOBILE_COL, out[project].length, 1).setNumberFormat('@');
      dest.getRange(at, 1, out[project].length, HEADERS.length).setValues(out[project]);
    });
  });
  [DEFAULT_SHEET].concat(Object.keys(SHEET_BY_PROJECT).map(k => SHEET_BY_PROJECT[k])).forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    const phones = sh.getRange(2, MOBILE_COL, sh.getLastRow() - 1, 1).getValues().map(r => digits_(r[0]));
    const seen = {};
    const drop = [];
    phones.forEach((ph, i) => { if (ph && seen[ph]) drop.push(i + 2); else if (ph) seen[ph] = true; });
    drop.reverse().forEach(r => { sh.deleteRow(r); removed++; });
  });
  console.log('Moved ' + moved + ' rows, removed ' + removed + ' duplicates');
}

// One-off: run ONCE from the editor, BEFORE deploying the version that puts Page last.
// Moves the Page column (I) to the end in every tab and rewrites the headings to match.
function movePageColumnLast() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.getSheets().forEach(sh => {
    if (sh.getLastRow() < 1) return;
    if (String(sh.getRange(1, 9).getValue()) !== 'Page') return; // already moved
    sh.moveColumns(sh.getRange(1, 9), HEADERS.length + 1);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    console.log('Moved Page to the end in ' + sh.getName());
  });
}

// Sends one lead to the CRM. Never throws into doPost: the sheet row and email come first.
// Retries once after a short pause if the CRM is unreachable or answers with a server error.
function sendToCrm_(d) {
  const range = BUDGET_RANGE[d.budget] || [null, null];
  const key = Object.keys(CRM_CAMPAIGN).find(k => String(d.project || '').indexOf(k) === 0);
  const payload = {
    name: d.name, phone: digits_(d.phone), email: d.email,
    project: d.project, project_name: d.project, location: d.location, message: d.message,
    budget_min: range[0], budget_max: range[1], budget_text: d.budget,
    requirement: d.config, timeline: d.timeline, site_visit: d.visit,
    form: d.form, page: d.page,
    received_at: d.received_at, import_id: d.import_id, // only set by importOldLeadsToCrm
    campaign: key ? CRM_CAMPAIGN[key] : 'website-form'
  };
  const options = { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true };
  let code = 0, text = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = UrlFetchApp.fetch(CRM_URL, options);
      code = res.getResponseCode();
      text = res.getContentText();
    } catch (err) {
      code = 0;
      text = String(err);
    }
    if (code > 0 && code < 500) break; // delivered (2xx) or rejected for a reason a retry cannot fix (4xx)
    if (attempt === 1) Utilities.sleep(1500);
  }
  if (code >= 300 || code === 0) console.error('CRM answered ' + code + ': ' + text.slice(0, 200));
  return { code: code, body: text };
}

// Run once from the editor so Google asks you to allow the script to contact the CRM.
function authorizeCrm() {
  console.log('CRM reachable: HTTP ' + UrlFetchApp.fetch('https://crm.builderumbrella.com/', { muteHttpExceptions: true }).getResponseCode());
}

// Optional end-to-end test: sends ONE clearly fake lead straight to the CRM (not to the sheet or email).
// Check the log for "HTTP 200", then delete the "ZZ Test" lead in the CRM.
function testCrmLead() {
  const r = sendToCrm_({
    name: 'ZZ Test (delete me)', phone: '9000000003', email: '', project: 'Lodha Wakad - The Living Forest Estate',
    form: 'Apps Script test', config: '3 BHK', message: 'Test from Apps Script', budget: '₹3 Cr – ₹4 Cr',
    timeline: '', visit: '', page: 'apps-script-test'
  });
  console.log('CRM test: HTTP ' + r.code + ' ' + r.body);
}

// One-off: copies every lead already in the sheet into the CRM, keeping its original date (shown as "Originally
// received" on the lead). Run from the editor ONCE; it is safe to run again, because each sheet row is sent under its
// own id and the CRM never adds the same id twice. Works through all tabs and stops before Google's 6-minute limit;
// if it says "Not finished", just run it again and it carries on. Check the log for the totals.
// Tip: run it before the CRM has teams/staff, otherwise every old lead is auto-assigned like a fresh one.
function importOldLeadsToCrm() {
  const started = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  const tabs = [DEFAULT_SHEET].concat(Object.keys(SHEET_BY_PROJECT).map(k => SHEET_BY_PROJECT[k]))
    .filter((n, i, a) => a.indexOf(n) === i);
  let created = 0, already = 0, failed = 0, finished = true;
  for (const tab of tabs) {
    const sh = ss.getSheetByName(tab);
    if (!sh || sh.getLastRow() < 2) continue;
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS.length).getValues();
    const doneKey = 'crmImported_' + tab;
    for (let i = Number(props.getProperty(doneKey) || 0); i < rows.length; i++) {
      if (Date.now() - started > 4.5 * 60 * 1000) { finished = false; break; }
      const r = rows[i];
      const when = r[0] instanceof Date ? Utilities.formatDate(r[0], 'Asia/Kolkata', 'yyyy-MM-dd HH:mm') : String(r[0] || '');
      const res = sendToCrm_({
        project: r[1], form: r[2], name: r[3], phone: r[4], email: r[5], config: r[6], message: r[7],
        location: r[8], budget: r[9], timeline: r[10], visit: r[11], page: r[12],
        received_at: when, import_id: tab + '-' + (i + 2) // tab + sheet row number
      });
      if (res.code >= 200 && res.code < 300) {
        let dup = false;
        try { dup = JSON.parse(res.body).duplicate === true; } catch (e) {}
        if (dup) already++; else created++;
        props.setProperty(doneKey, String(i + 1));
      } else if (res.code >= 400 && res.code < 500) {
        failed++; // e.g. a row with no phone or email: skipped, not retried
        console.error(tab + ' row ' + (i + 2) + ' skipped: ' + res.body.slice(0, 150));
        props.setProperty(doneKey, String(i + 1));
      } else {
        finished = false; // CRM unreachable: stop here, a re-run resumes at this row
        console.error(tab + ' row ' + (i + 2) + ': CRM answered ' + res.code);
        break;
      }
    }
    if (!finished) break;
  }
  console.log((finished ? 'Done. ' : 'Not finished - run again. ') + 'Added ' + created + ', already in CRM ' + already + ', skipped ' + failed + '.');
}
