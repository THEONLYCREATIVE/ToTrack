/**
 * PHARMASCAN v1.0.0
 * Pharmacy Expiry Intelligence System
 * Features: GS1 Full Parse | EAN-13 + Expiry Prompt | Tesseract OCR | Master DB | Camera
 */

// ════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════
const CFG = {
  DB: 'PharmaScanDB',
  DB_VER: 1,
  SOON_DAYS: 90,
  VER: '1.0.0'
};

// ════════════════════════════════════════
// STATE
// ════════════════════════════════════════
const S = {
  db: null,
  masterIndex: new Map(),   // barcode → name
  masterRMS:   new Map(),   // barcode → rms
  filter: 'all',
  search: '',
  currentEntry: null,        // entry being built (scan → expiry prompt)
  camActive: false,
  camInstance: null,
  ocrWorker: null
};

// ════════════════════════════════════════
// DATABASE
// ════════════════════════════════════════
const DB = {
  async init() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(CFG.DB, CFG.DB_VER);
      req.onerror = () => rej(req.error);
      req.onsuccess = () => { S.db = req.result; res(); };
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('history')) {
          const h = db.createObjectStore('history', { keyPath:'id', autoIncrement:true });
          h.createIndex('gtin','gtin',{unique:false});
          h.createIndex('ts','ts',{unique:false});
        }
        if (!db.objectStoreNames.contains('master')) {
          db.createObjectStore('master', { keyPath:'barcode' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath:'key' });
        }
      };
    });
  },

  _tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const tx = S.db.transaction(store, mode);
      const s  = tx.objectStore(store);
      const r  = fn(s);
      if (r && r.onsuccess !== undefined) {
        r.onsuccess = () => res(r.result);
        r.onerror   = () => rej(r.error);
      } else {
        tx.oncomplete = () => res(r);
        tx.onerror    = () => rej(tx.error);
      }
    });
  },

  add:    (st, item) => DB._tx(st,'readwrite', s => s.add(item)),
  put:    (st, item) => DB._tx(st,'readwrite', s => s.put(item)),
  get:    (st, id)   => DB._tx(st,'readonly',  s => s.get(id)),
  getAll: (st)       => DB._tx(st,'readonly',  s => s.getAll()),
  del:    (st, id)   => DB._tx(st,'readwrite', s => s.delete(id)),
  clear:  (st)       => DB._tx(st,'readwrite', s => s.clear()),

  async bulkMaster(items) {
    return new Promise((res,rej) => {
      const tx = S.db.transaction('master','readwrite');
      const st = tx.objectStore('master');
      let n = 0;
      for (const it of items) { if(it.barcode){ st.put(it); n++; } }
      tx.oncomplete = () => res(n);
      tx.onerror    = () => rej(tx.error);
    });
  },

  async getSetting(key, def=null) {
    try { const r = await DB.get('settings',key); return r ? r.value : def; }
    catch { return def; }
  },
  setSetting: (key,val) => DB.put('settings',{key,value:val})
};

// ════════════════════════════════════════
// GS1 PARSER  (v2 — positional + parenthesised)
// ════════════════════════════════════════
const GS1 = {
  parse(raw) {
    const result = { raw:raw||'', gtin:'', expiry:'', expiryISO:'', expiryDisplay:'', batch:'', serial:'', qty:1, isGS1:false };
    if (!raw || typeof raw !== 'string') return result;

    let code = raw.trim().replace(/[\r\n\t]/g,'');
    const GS = '\x1D';
    const hasParens  = code.includes('(');
    const hasRawGS1  = /^01\d{14}/.test(code);

    if (!hasParens && !hasRawGS1) {
      // Plain EAN/UPC
      const d = code.replace(/\D/g,'');
      if (d.length >= 8 && d.length <= 14) result.gtin = d.padStart(14,'0');
      return result;
    }

    result.isGS1 = true;

    if (hasParens) {
      // ── Parenthesised: (01)XXXXXX(17)YYMMDD(10)BATCH ──
      const g = code.match(/\(01\)(\d{14})/);   if (g) result.gtin  = g[1];
      const e = code.match(/\(17\)(\d{6})/);    if (e) this._expiry(e[1], result);
      const b = code.match(/\(10\)([^(]+)/);    if (b) result.batch  = b[1].replace(/[^\x20-\x7E]/g,'').trim().substring(0,20);
      const s = code.match(/\(21\)([^(]+)/);    if (s) result.serial = s[1].replace(/[^\x20-\x7E]/g,'').trim().substring(0,20);
    } else {
      // ── Raw concatenated: 01GTIN17YYMMDD<GS>10BATCH ──
      let pos = 0;
      while (pos < code.length) {
        if (code[pos] === GS) { pos++; continue; }
        const ai = code.substring(pos,pos+2);
        if (ai==='01') { result.gtin = code.substring(pos+2,pos+16); pos+=16; }
        else if (ai==='17') { this._expiry(code.substring(pos+2,pos+8),result); pos+=8; }
        else if (ai==='10') { pos+=2; const e=this._varEnd(code,pos); result.batch=code.substring(pos,e).replace(/[^\x20-\x7E]/g,'').trim().substring(0,20); pos=e; }
        else if (ai==='21') { pos+=2; const e=this._varEnd(code,pos); result.serial=code.substring(pos,e).replace(/[^\x20-\x7E]/g,'').trim().substring(0,20); pos=e; }
        else { pos++; }
      }
    }
    return result;
  },

  _varEnd(code,start) {
    const GS='\x1D';
    for(let i=start;i<code.length;i++) if(code[i]===GS) return i;
    return code.length;
  },

  _expiry(yymmdd, r) {
    if (!yymmdd || yymmdd.length!==6) return;
    r.expiry = yymmdd;
    const yy=parseInt(yymmdd.slice(0,2)), mm=parseInt(yymmdd.slice(2,4));
    let dd=parseInt(yymmdd.slice(4,6));
    const yr=2000+yy;
    if(dd===0) dd=new Date(yr,mm,0).getDate();
    r.expiryISO     = `${yr}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    r.expiryDisplay = `${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${yr}`;
  },

  status(isoDate) {
    if (!isoDate) return 'unknown';
    const today = new Date(); today.setHours(0,0,0,0);
    const exp   = new Date(isoDate); exp.setHours(0,0,0,0);
    const diff  = Math.floor((exp-today)/86400000);
    if (diff < 0)             return 'expired';
    if (diff <= CFG.SOON_DAYS) return 'expiring';
    return 'ok';
  }
};

// ════════════════════════════════════════
// MASTER INDEX
// ════════════════════════════════════════
const Master = {
  build(data) {
    S.masterIndex.clear();
    S.masterRMS.clear();
    for (const it of data) {
      const bc   = String(it.barcode||'').replace(/\D/g,'');
      if (!bc || bc.length<8) continue;
      const g14  = bc.padStart(14,'0');
      [bc, g14, g14.startsWith('0')?g14.slice(1):'', bc.slice(-8)].filter(Boolean).forEach(k => {
        if (!S.masterIndex.has(k)) S.masterIndex.set(k, it.name||'');
        if (it.rms && !S.masterRMS.has(k)) S.masterRMS.set(k, it.rms);
      });
    }
  },

  find(gtin) {
    if (!gtin) return {name:'',rms:'',how:'NONE'};
    const candidates = [gtin, gtin.startsWith('0')?gtin.slice(1):'', gtin.slice(-8)].filter(Boolean);
    for (const c of candidates) {
      if (S.masterIndex.has(c)) return { name:S.masterIndex.get(c), rms:S.masterRMS.get(c)||'', how:c===gtin?'EXACT':'PARTIAL' };
    }
    return {name:'',rms:'',how:'NONE'};
  }
};

// ════════════════════════════════════════
// SCAN FLOW
// ════════════════════════════════════════
async function onBarcode(raw) {
  if (!raw || !raw.trim()) return;

  const parsed = GS1.parse(raw.trim());

  if (!parsed.gtin) {
    toast('Could not extract barcode — try again','error'); return;
  }

  const match  = Master.find(parsed.gtin);
  const isGS1  = parsed.isGS1 && !!parsed.expiryISO;

  // Build a draft entry
  S.currentEntry = {
    raw:         parsed.raw,
    gtin:        parsed.gtin,
    name:        match.name || 'Unknown Product',
    rms:         match.rms  || '',
    matchHow:    match.how,
    expiry:      parsed.expiry,
    expiryISO:   parsed.expiryISO,
    expiryDisplay: parsed.expiryDisplay,
    batch:       parsed.batch,
    serial:      parsed.serial,
    qty:         1,
    supplier:    '',
    returnable:  '',
    ts:          Date.now()
  };

  showProductPanel(isGS1);
}

function showProductPanel(hasExpiry) {
  const e   = S.currentEntry;
  const pp  = document.getElementById('productPanel');

  // Badge
  const badge = document.getElementById('ppMatchBadge');
  badge.textContent = e.matchHow === 'NONE' ? 'UNKNOWN' : e.matchHow === 'EXACT' ? 'MATCHED' : 'PARTIAL';
  badge.className   = 'pp-match-badge' + (e.matchHow==='NONE'?' unknown':'');

  document.getElementById('ppName').textContent = e.name;
  document.getElementById('ppGtin').textContent = `GTIN: ${e.gtin}`;

  // Pre-fill fields
  document.getElementById('ppExpiry').value   = e.expiryISO  || '';
  document.getElementById('ppBatch').value    = e.batch      || '';
  document.getElementById('ppQty').value      = 1;
  document.getElementById('ppSupplier').value = '';

  // OCR button — only for plain EAN (no GS1 expiry)
  const ocrBtn  = document.getElementById('btnOCR');
  const ocrZone = document.getElementById('ocrZone');
  if (!hasExpiry) {
    ocrBtn.classList.remove('hidden');
  } else {
    ocrBtn.classList.add('hidden');
    ocrZone.classList.add('hidden');
  }

  pp.classList.remove('hidden');

  // Auto-focus expiry if it's empty
  if (!e.expiryISO) {
    setTimeout(() => document.getElementById('ppExpiry').focus(), 80);
  }

  vibrate('medium');
}

async function saveCurrentEntry() {
  const e = S.currentEntry;
  if (!e) return;

  // Pull from form
  const expiryISO = document.getElementById('ppExpiry').value;
  let   expiryDisplay = '';
  if (expiryISO) {
    const d = new Date(expiryISO + 'T00:00:00');
    expiryDisplay = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }

  e.expiryISO     = expiryISO;
  e.expiryDisplay = expiryDisplay;
  e.batch         = document.getElementById('ppBatch').value.trim();
  e.qty           = parseInt(document.getElementById('ppQty').value)||1;
  e.supplier      = document.getElementById('ppSupplier').value.trim();

  const id = await DB.add('history', e);
  e.id = id;

  closeProductPanel();
  await refreshAll();
  toast(`Saved: ${e.name}`, 'ok');
  vibrate('success');

  // Re-focus barcode input for next scan
  document.getElementById('barcodeInput').focus();
}

function closeProductPanel() {
  document.getElementById('productPanel').classList.add('hidden');
  document.getElementById('ocrZone').classList.add('hidden');
  document.getElementById('ocrStatus').textContent = '';
  S.currentEntry = null;
}

// ════════════════════════════════════════
// OCR — Tesseract.js
// ════════════════════════════════════════
async function runOCR(file) {
  const statusEl = document.getElementById('ocrStatus');
  statusEl.textContent = '⏳ Loading OCR engine...';

  try {
    // Lazy-init worker
    if (!S.ocrWorker) {
      S.ocrWorker = await Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text') {
            statusEl.textContent = `⏳ Reading... ${Math.round(m.progress*100)}%`;
          }
        }
      });
    }

    statusEl.textContent = '⏳ Analysing image...';
    const { data: { text } } = await S.ocrWorker.recognize(file);

    const date = extractDateFromOCR(text);
    if (date) {
      document.getElementById('ppExpiry').value = date;
      statusEl.textContent = `✅ Found: ${date}`;
      toast('Expiry date extracted!', 'ok');
    } else {
      statusEl.textContent = '⚠ No date found — please enter manually';
      toast('Could not find date in image', 'warn');
    }
  } catch(err) {
    console.error('OCR error:', err);
    statusEl.textContent = '❌ OCR failed — enter date manually';
    toast('OCR error', 'error');
  }
}

/**
 * Extract expiry date from OCR text.
 * Handles: EXP 12/2026 | 12/26 | JUN 2026 | 2026-06-30 | 30.06.26 | BB 06/2026 etc.
 */
function extractDateFromOCR(text) {
  // Normalise
  const t = text.toUpperCase().replace(/[|Il]/g, '1').replace(/O/g,'0');

  const MONTHS = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };

  const patterns = [
    // ISO: 2026-06-30
    { re:/\b(20\d{2})[\/\-\.](0?[1-9]|1[0-2])[\/\-\.](0?[1-9]|[12]\d|3[01])\b/, fn:m=>`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` },
    // DD/MM/YYYY or DD-MM-YYYY
    { re:/\b(0?[1-9]|[12]\d|3[01])[\/\-\.](0?[1-9]|1[0-2])[\/\-\.](20\d{2})\b/, fn:m=>`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` },
    // MM/YYYY or MM-YYYY (no day → last day of month)
    { re:/\b(0?[1-9]|1[0-2])[\/\-](20\d{2})\b/, fn:m=>{ const yr=parseInt(m[2]),mo=parseInt(m[1]); const last=new Date(yr,mo,0).getDate(); return `${yr}-${String(mo).padStart(2,'0')}-${String(last).padStart(2,'0')}`; } },
    // MM/YY → assume 20YY
    { re:/\b(0?[1-9]|1[0-2])[\/\-](\d{2})\b/, fn:m=>{ const yr=2000+parseInt(m[2]),mo=parseInt(m[1]); const last=new Date(yr,mo,0).getDate(); return `${yr}-${String(mo).padStart(2,'0')}-${String(last).padStart(2,'0')}`; } },
    // MON YYYY  e.g. JUN 2026
    { re:/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*(20\d{2})\b/, fn:m=>{ const mo=MONTHS[m[1]],yr=parseInt(m[2]); const last=new Date(yr,mo,0).getDate(); return `${yr}-${String(mo).padStart(2,'0')}-${String(last).padStart(2,'0')}`; } },
    // DD MON YYYY e.g. 30 JUN 2026
    { re:/\b(\d{1,2})\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*(20\d{2})\b/, fn:m=>`${m[3]}-${String(MONTHS[m[2]]).padStart(2,'0')}-${m[1].padStart(2,'0')}` },
    // GS1 YYMMDD 6 digits (after EXP or BB)
    { re:/(?:EXP|BB|EXPIRY|BEST\s*BEFORE|USE\s*BY)[:\s]*(\d{6})/, fn:m=>{ const yy=m[1].slice(0,2),mm=m[1].slice(2,4); let dd=parseInt(m[1].slice(4,6)); const yr=2000+parseInt(yy),mo=parseInt(mm); if(dd===0)dd=new Date(yr,mo,0).getDate(); return `${yr}-${String(mo).padStart(2,'0')}-${String(dd).padStart(2,'0')}`; } }
  ];

  for (const { re, fn } of patterns) {
    const m = t.match(re);
    if (m) {
      try {
        const iso = fn(m);
        // Sanity check — must be a real future-ish date
        const d = new Date(iso);
        if (!isNaN(d) && d.getFullYear() >= 2020 && d.getFullYear() <= 2040) return iso;
      } catch {}
    }
  }
  return null;
}

// ════════════════════════════════════════
// MASTER DATA UPLOAD
// ════════════════════════════════════════
async function uploadMaster(file, append=false) {
  showLoading('Parsing file...');
  try {
    const text  = await file.text();
    const lines = text.trim().split(/[\r\n]+/);
    if (lines.length < 2) { toast('File too short','error'); hideLoading(); return; }

    const header = lines[0];
    const delim  = header.includes('\t') ? '\t' : ',';
    const cols   = header.toLowerCase().split(delim).map(c=>c.trim().replace(/['"]/g,''));

    const bi = cols.findIndex(c=>['barcode','gtin','ean','upc','code'].includes(c));
    const ni = cols.findIndex(c=>['name','description','product','productname'].includes(c));
    const ri = cols.findIndex(c=>['rms','rmscode','rms_code'].includes(c));

    if (bi===-1) { toast('No barcode column found','error'); hideLoading(); return; }

    if (!append) await DB.clear('master');

    const items=[];
    for (let i=1;i<lines.length;i++) {
      const row = lines[i].split(delim).map(c=>c.trim().replace(/['"]/g,''));
      const bc  = row[bi];
      if (bc && bc.replace(/\D/g,'').length>=8)
        items.push({ barcode:bc, name:ni>=0?row[ni]:'', rms:ri>=0?row[ri]:'' });
    }

    const n = await DB.bulkMaster(items);
    await refreshMasterCount();
    toast(`${append?'Appended':'Loaded'} ${n} products`,'ok');
  } catch(e) {
    toast('Upload failed: '+e.message,'error');
  }
  hideLoading();
}

async function resetMaster() {
  if (!confirm('Clear all master data?')) return;
  await DB.clear('master');
  await refreshMasterCount();
  toast('Master data cleared');
}

function downloadTemplate() {
  const t=`barcode,name,rms\n06291107439358,Zyrtec 75ml Bottle,220155756\n00840149658430,VIAGRA 100MG 4S,220153086\n06285074002448,Yasmin 21s Blister,220164755`;
  dlFile(t,'master-template.csv','text/csv');
  toast('Template downloaded');
}

// ════════════════════════════════════════
// EXPORT / BACKUP
// ════════════════════════════════════════
async function exportCSV() {
  const hist = await DB.getAll('history');
  if (!hist.length) { toast('No data','warn'); return; }
  const hdr = ['RMS','BARCODE','NAME','EXPIRY','BATCH','QTY','SUPPLIER','RETURNABLE'];
  const rows = hist.map(h=>[h.rms,h.gtin,h.name,h.expiryDisplay,h.batch,h.qty,h.supplier,h.returnable]);
  let csv = hdr.join(',')+'\n';
  for(const r of rows) csv += r.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(',')+'\n';
  dlFile(csv,`pharmascan-export-${fmtDate(new Date())}.csv`,'text/csv');
  toast('CSV exported','ok');
}

async function downloadBackup() {
  const [hist,mstr] = await Promise.all([DB.getAll('history'),DB.getAll('master')]);
  dlFile(JSON.stringify({version:CFG.VER,date:new Date().toISOString(),history:hist,master:mstr},null,2),
    `pharmascan-backup-${fmtDate(new Date())}.json`,'application/json');
  toast('Backup downloaded','ok');
}

async function restoreBackup(file) {
  showLoading('Restoring...');
  try {
    const bk = JSON.parse(await file.text());
    if (!bk.history && !bk.master) { toast('Invalid backup','error'); hideLoading(); return; }
    if (bk.history?.length) { await DB.clear('history'); for(const it of bk.history){delete it.id; await DB.add('history',it);} }
    if (bk.master?.length)  { await DB.clear('master');  await DB.bulkMaster(bk.master); }
    await refreshAll();
    toast(`Restored ${bk.history?.length||0} items`,'ok');
  } catch(e) { toast('Restore failed','error'); }
  hideLoading();
}

async function clearAllHistory() {
  if (!confirm('Delete all scanned items?')) return;
  await DB.clear('history');
  await refreshAll();
  toast('History cleared');
}

// ════════════════════════════════════════
// UI REFRESH
// ════════════════════════════════════════
async function refreshAll() {
  await Promise.all([refreshStats(), refreshRecent(), refreshHistory(), refreshMasterCount()]);
}

async function refreshStats() {
  const hist = await DB.getAll('history');
  let exp=0,soon=0,ok=0;
  for(const h of hist){ const s=GS1.status(h.expiryISO); if(s==='expired')exp++; else if(s==='expiring')soon++; else if(s==='ok')ok++; }
  document.getElementById('cntExpired').textContent  = exp;
  document.getElementById('cntExpiring').textContent = soon;
  document.getElementById('cntOk').textContent       = ok;
}

async function refreshRecent() {
  const hist = (await DB.getAll('history')).sort((a,b)=>b.ts-a.ts).slice(0,8);
  document.getElementById('recentList').innerHTML = hist.length ? hist.map(renderCard).join('') : emptyState('📦','No items yet','Scan a barcode to start');
}

async function refreshHistory() {
  let hist = (await DB.getAll('history')).sort((a,b)=>b.ts-a.ts);
  if (S.filter !== 'all') hist = hist.filter(h => {
    if (S.filter==='unknown') return !h.expiryISO;
    return GS1.status(h.expiryISO) === S.filter;
  });
  if (S.search) {
    const q=S.search.toLowerCase();
    hist=hist.filter(h=>(h.name||'').toLowerCase().includes(q)||(h.gtin||'').includes(q)||(h.batch||'').toLowerCase().includes(q)||(h.rms||'').includes(q));
  }
  document.getElementById('historyList').innerHTML = hist.length ? hist.map(h=>renderCard(h,true)).join('') : emptyState('🔍','No items found','Try a different filter');
}

async function refreshMasterCount() {
  const mstr = await DB.getAll('master');
  document.getElementById('masterCount').textContent = mstr.length;
  Master.build(mstr);
}

function renderCard(h, actions=false) {
  const st   = h.expiryISO ? GS1.status(h.expiryISO) : 'unknown';
  const badge = { expired:'EXPIRED', expiring:'EXPIRING SOON', ok: h.expiryDisplay||'OK', unknown:'NO EXPIRY' }[st] || '';
  return `<div class="item-card status-${st}">
    <div class="ic-top">
      <span class="ic-name">${esc(h.name)}</span>
      <span class="ic-badge">${badge}</span>
    </div>
    <div class="ic-meta">
      <div class="ic-meta-item"><span>GTIN</span><span>${h.gtin||'—'}</span></div>
      <div class="ic-meta-item"><span>BATCH</span><span>${h.batch||'—'}</span></div>
      <div class="ic-meta-item"><span>RMS</span><span>${h.rms||'—'}</span></div>
    </div>
    ${actions?`<div class="ic-actions">
      <button class="ic-btn edit" onclick="openEdit(${h.id})">✏ Edit</button>
      <button class="ic-btn delete" onclick="delItem(${h.id})">🗑 Delete</button>
    </div>`:''}
  </div>`;
}

function emptyState(icon,title,sub) {
  return `<div class="empty-state"><div class="e-icon">${icon}</div><div class="e-title">${title}</div><div class="e-sub">${sub}</div></div>`;
}

// ════════════════════════════════════════
// EDIT / DELETE
// ════════════════════════════════════════
async function openEdit(id) {
  const h = await DB.get('history',id);
  if (!h) return;
  document.getElementById('eId').value        = id;
  document.getElementById('eName').value       = h.name||'';
  document.getElementById('eGtin').value       = h.gtin||'';
  document.getElementById('eExpiry').value     = h.expiryISO||'';
  document.getElementById('eBatch').value      = h.batch||'';
  document.getElementById('eQty').value        = h.qty||1;
  document.getElementById('eRms').value        = h.rms||'';
  document.getElementById('eSupplier').value   = h.supplier||'';
  document.getElementById('eReturnable').value = h.returnable||'';
  document.getElementById('editModal').classList.remove('hidden');
}

async function saveEdit() {
  const id = parseInt(document.getElementById('eId').value);
  const h  = await DB.get('history',id);
  if (!h) return;
  const iso = document.getElementById('eExpiry').value;
  h.name       = document.getElementById('eName').value.trim();
  h.expiryISO  = iso;
  h.expiryDisplay = iso ? (() => { const d=new Date(iso+'T00:00:00'); return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`; })() : '';
  h.batch      = document.getElementById('eBatch').value.trim();
  h.qty        = parseInt(document.getElementById('eQty').value)||1;
  h.rms        = document.getElementById('eRms').value.trim();
  h.supplier   = document.getElementById('eSupplier').value.trim();
  h.returnable = document.getElementById('eReturnable').value;
  await DB.put('history',h);
  closeEditModal();
  await refreshAll();
  toast('Saved','ok');
}

function closeEditModal() { document.getElementById('editModal').classList.add('hidden'); }

async function delItem(id) {
  if (!confirm('Delete this item?')) return;
  await DB.del('history',id);
  await refreshAll();
  toast('Deleted');
}

// ════════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════════
function showPage(id) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  document.querySelectorAll('.bnav-btn').forEach(b=>b.classList.toggle('active', b.dataset.page===id));
  if (id!=='pg-scan' && S.camActive) stopCam();
}

// ════════════════════════════════════════
// CAMERA
// ════════════════════════════════════════
async function toggleCam() {
  S.camActive ? stopCam() : startCam();
}

async function startCam() {
  const readerEl = document.getElementById('reader');
  readerEl.classList.remove('hidden');
  try {
    S.camInstance = new Html5Qrcode('reader');
    const cams = await Html5Qrcode.getCameras();
    if (!cams.length) { toast('No camera found','error'); return; }
    const back = cams.find(c=>/(back|rear|environment)/i.test(c.label)) || cams[0];
    await S.camInstance.start(back.id,
      { fps:10, qrbox:{width:250,height:250}, formatsToSupport:[
        Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,    Html5QrcodeSupportedFormats.QR_CODE,
        Html5QrcodeSupportedFormats.DATA_MATRIX, Html5QrcodeSupportedFormats.UPC_A
      ]},
      async txt => { await stopCam(); document.getElementById('barcodeInput').value=txt; await onBarcode(txt); },
      ()=>{}
    );
    S.camActive=true;
    document.getElementById('btnCam').style.background='var(--danger)';
    document.getElementById('btnCam').style.color='#fff';
  } catch(e) { toast('Camera error: '+e.message,'error'); readerEl.classList.add('hidden'); }
}

async function stopCam() {
  if (S.camInstance) { try{ await S.camInstance.stop(); S.camInstance.clear(); }catch{} S.camInstance=null; }
  S.camActive=false;
  document.getElementById('reader').classList.add('hidden');
  document.getElementById('btnCam').style.background='';
  document.getElementById('btnCam').style.color='';
}

// ════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════
function toast(msg, type='info') {
  const el=document.createElement('div');
  el.className=`toast ${type}`;
  el.textContent=msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); },2800);
}
function showLoading(t='Loading...') { document.getElementById('loadingText').textContent=t; document.getElementById('loading').classList.remove('hidden'); }
function hideLoading() { document.getElementById('loading').classList.add('hidden'); }
function vibrate(t='light') { if(!navigator.vibrate)return; ({light:[10],medium:[30],success:[30,50,30],error:[100,50,100]})[t]&&navigator.vibrate(({light:[10],medium:[30],success:[30,50,30],error:[100,50,100]})[t]); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(d) { return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function dlFile(content,name,mime) { const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([content],{type:mime})),download:name}); document.body.appendChild(a); a.click(); document.body.removeChild(a); }

// ════════════════════════════════════════
// EVENTS
// ════════════════════════════════════════
function setupEvents() {
  // Barcode input — Enter or paste
  const bi = document.getElementById('barcodeInput');
  bi.addEventListener('keydown', async e => {
    if (e.key==='Enter') { e.preventDefault(); await onBarcode(bi.value); bi.value=''; }
  });
  bi.addEventListener('paste', () => setTimeout(async ()=>{ await onBarcode(bi.value); bi.value=''; },80));

  // Camera
  document.getElementById('btnCam').addEventListener('click', toggleCam);

  // Product panel
  document.getElementById('btnSave').addEventListener('click', saveCurrentEntry);
  document.getElementById('btnSkip').addEventListener('click', closeProductPanel);
  document.getElementById('ppClose').addEventListener('click', closeProductPanel);

  // OCR toggle
  document.getElementById('btnOCR').addEventListener('click', () => {
    document.getElementById('ocrZone').classList.toggle('hidden');
  });
  document.getElementById('ocrFile').addEventListener('change', e => {
    const f=e.target.files[0]; if(f) runOCR(f);
  });

  // ppExpiry — Enter key moves to next field
  document.getElementById('ppExpiry').addEventListener('keydown', e => {
    if (e.key==='Enter') { e.preventDefault(); document.getElementById('ppBatch').focus(); }
  });
  document.getElementById('ppBatch').addEventListener('keydown', e => {
    if (e.key==='Enter') { e.preventDefault(); document.getElementById('btnSave').click(); }
  });

  // Nav
  document.querySelectorAll('.bnav-btn').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.page)));

  // Filter pills
  document.querySelectorAll('.pill').forEach(p=>p.addEventListener('click',()=>{
    S.filter=p.dataset.f;
    document.querySelectorAll('.pill').forEach(x=>x.classList.remove('active'));
    p.classList.add('active');
    refreshHistory();
  }));

  // Search
  document.getElementById('searchInput').addEventListener('input', e=>{ S.search=e.target.value; refreshHistory(); });

  // Master file inputs
  document.getElementById('fileMaster').addEventListener('change', e=>{ if(e.target.files[0]){uploadMaster(e.target.files[0],false); e.target.value='';} });
  document.getElementById('fileAppend').addEventListener('change', e=>{ if(e.target.files[0]){uploadMaster(e.target.files[0],true); e.target.value='';} });
  document.getElementById('fileRestore').addEventListener('change', e=>{ if(e.target.files[0]){restoreBackup(e.target.files[0]); e.target.value='';} });

  // Modal backdrop
  document.getElementById('editModal').addEventListener('click', e=>{ if(e.target.id==='editModal')closeEditModal(); });

  // Keyboard shortcut: Escape closes panel / modal
  document.addEventListener('keydown', e => {
    if (e.key==='Escape') { closeProductPanel(); closeEditModal(); }
  });
}

// ════════════════════════════════════════
// INIT
// ════════════════════════════════════════
async function init() {
  console.log('🚀 PharmaScan', CFG.VER);
  try {
    await DB.init();
    await refreshMasterCount();
    await refreshAll();
    setupEvents();

    setTimeout(()=>{
      document.getElementById('splash').classList.add('out');
      document.getElementById('app').classList.remove('hidden');
      setTimeout(()=>document.getElementById('barcodeInput').focus(), 150);
    }, 2400);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(()=>{});
    }
  } catch(e) {
    console.error(e);
    document.getElementById('splash').classList.add('out');
    document.getElementById('app').classList.remove('hidden');
  }
}

document.readyState==='loading' ? document.addEventListener('DOMContentLoaded',init) : init();
