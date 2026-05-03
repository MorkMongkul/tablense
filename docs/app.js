// ─── State ───────────────────────────────────────────────
let currentItems  = [];
let currentFmt    = 'table';
let currentModel  = 'gemini-3-flash-preview';
let currentProvider = 'gemini';
let currentVision = true;
let lastRaw       = '';
let lastRows      = null;

const MAX_IMAGES = 30;
const MAX_PDF_MB = 10;
const API_BASE_URL = 'https://tablense.vercel.app';

let pdfjsLoadPromise = null;
const PDFJS_LIB_SRC = './vendor/pdfjs/pdf.min.mjs';
const PDFJS_WORKER_SRC = './vendor/pdfjs/pdf.worker.min.mjs';
if(window.pdfjsLib){
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
}

const MODELS = [
  { id: 'gemini-3-flash-preview', provider: 'gemini' },
  { id: 'gemini-3.1-flash-lite-preview', provider: 'gemini' },
  { id: 'gemini-3.1-pro-preview', provider: 'gemini' },
  { id: 'gemini-2.5-flash', provider: 'gemini' },
  { id: 'gemini-2.5-flash-lite', provider: 'gemini' },
  { id: 'gemini-2.5-pro', provider: 'gemini' },
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct', provider: 'groq' },
  { id: 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1', provider: 'nvidia' },
  { id: 'google-vision-ocr', provider: 'gcv' }
];

// ─── Init ─────────────────────────────────────────────────
(function init(){
  const savedModel = ls('tl_model');
  const savedProvider = ls('tl_provider');
  const savedVision = ls('tl_vision');
  if(savedModel && savedProvider){
    const has = MODELS.find(m=>m.id===savedModel && m.provider===savedProvider);
    if(has) applyModel(savedModel, savedProvider, savedVision !== '0');
  }
})();

// ─── LocalStorage helpers ─────────────────────────────────
function ls(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lss(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
function lsd(k){ try{ localStorage.removeItem(k); }catch(e){} }

// ─── About modal ─────────────────────────────────────────
function openAbout(){
  document.getElementById('about-modal').classList.add('open');
}
function closeAbout(){ document.getElementById('about-modal').classList.remove('open'); }
document.getElementById('about-modal').addEventListener('click', function(e){
  if(e.target === this) closeAbout();
});

// ─── Model selector ───────────────────────────────────────
function toggleModelMenu(){
  const dd = document.getElementById('model-dropdown');
  dd.classList.toggle('open');
}
document.addEventListener('click', function(e){
  if(!document.getElementById('model-pill').contains(e.target))
    document.getElementById('model-dropdown').classList.remove('open');
});
function selectModel(el){
  el.closest('.model-dropdown').classList.remove('open');
  const model = el.dataset.model;
  const provider = el.dataset.provider || 'gemini';
  const vision = el.dataset.vision !== 'false';
  applyModel(model, provider, vision);
  lss('tl_model', model);
  lss('tl_provider', provider);
  lss('tl_vision', vision ? '1' : '0');
  event.stopPropagation();
}
function applyModel(model, provider, vision){
  currentModel = model;
  currentProvider = provider || 'gemini';
  currentVision = vision !== false;
  document.getElementById('model-pill-label').textContent = model;
  document.querySelectorAll('.model-option').forEach(o=>{
    const isThis = o.dataset.model === model;
    o.classList.toggle('selected', isThis);
    const chk = document.getElementById('check-'+o.dataset.model);
    if(chk) chk.style.display = isThis ? 'inline':'none';
  });
}

// ─── File upload ──────────────────────────────────────────
const uploadZone = document.getElementById('upload-zone');
const fileInput  = document.getElementById('file-input');

fileInput.addEventListener('change', e => e.target.files.length && loadFiles(e.target.files));

uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.classList.add('over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('over');
  if(e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);

function isAllowedImageFile(file){
  if(ALLOWED_IMAGE_MIMES.has(file.type)) return true;
  const name = (file.name || '').toLowerCase();
  return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png');
}

async function loadFiles(fileList){
  const files = Array.from(fileList || []);
  currentItems = [];

  let imageCount = files.filter(f=>f.type !== 'application/pdf').length;
  if(imageCount > MAX_IMAGES){
    alert(`Max ${MAX_IMAGES} images allowed per batch.`);
  }

  for(const file of files){
    if(currentItems.length >= MAX_IMAGES) break;

    if(file.type === 'application/pdf'){
      if(file.size > MAX_PDF_MB * 1024 * 1024){
        alert(`PDF size limit is ${MAX_PDF_MB}MB. Skipping ${file.name}.`);
        continue;
      }
      const pdfItems = await pdfToItems(file, MAX_IMAGES - currentItems.length);
      currentItems = currentItems.concat(pdfItems);
      continue;
    }

    if(!isAllowedImageFile(file)) continue;
    const item = await fileToItem(file);
    if(item) currentItems.push(item);
  }

  if(!currentItems.length){
    alert('No supported files found.');
    clearImage();
    return;
  }

  const first = currentItems[0];
  document.getElementById('preview-img').src = first.dataUrl;
  const extraCount = currentItems.length - 1;
  document.getElementById('preview-name').textContent = extraCount > 0
    ? `${first.name} +${extraCount} more`
    : first.name;
  document.getElementById('preview-card').style.display = 'block';
  uploadZone.style.display = 'none';
}
function clearImage(){
  currentItems = [];
  fileInput.value = '';
  document.getElementById('preview-card').style.display = 'none';
  uploadZone.style.display = 'block';
}

// ─── Format ───────────────────────────────────────────────
function setFmt(btn){
  document.querySelectorAll('.fmt-tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  currentFmt = btn.dataset.fmt;
}

// ─── Lightbox ─────────────────────────────────────────────
function openLightbox(src){
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox(){ document.getElementById('lightbox').classList.remove('open'); }

// ─── Status ───────────────────────────────────────────────
function setStatus(msg, state='idle'){
  document.getElementById('status-text').textContent = msg;
  document.getElementById('status-led').className = 'status-led ' + state;
}

// ─── Extract ──────────────────────────────────────────────
async function doExtract(){
  if(!currentItems.length){ alert('Please upload an image or PDF first.'); return; }
  if(!currentVision){
    alert('This model is text-only and does not support images. Please select a vision-capable model.');
    return;
  }

  const btn = document.getElementById('extract-btn');
  const spinner = document.getElementById('btn-spinner');
  const label = document.getElementById('btn-label');
  btn.disabled = true;
  spinner.style.display = 'block';
  label.textContent = 'Extracting…';
  setStatus('Sending to ' + currentModel + '…', 'busy');

  // Hide previous result
  document.getElementById('output-content').style.display = 'none';
  document.getElementById('empty-state').style.display = 'flex';
  document.getElementById('copy-btn').classList.remove('visible');
  document.getElementById('dl-btn').classList.remove('visible');
  document.getElementById('count-badge').style.display = 'none';

  try {
    const extra  = document.getElementById('extra-prompt').value.trim();
    const allRows = [];
    const errors = [];

    for(let i=0;i<currentItems.length;i++){
      const item = currentItems[i];
      setStatus(`Processing ${i+1}/${currentItems.length}…`, 'busy');

      if(currentProvider === 'gcv'){
        const raw = await requestModel({
          imageBase64: item.base64,
          mimeType: item.mime,
          model: currentModel,
          provider: currentProvider
        });

        if(!raw){
          errors.push(item.name + ': Empty OCR response');
          continue;
        }

        const header = currentItems.length > 1 ? `--- ${item.name} ---\n` : '';
        allRows.push({ __ocr: header + raw.trim() });
        continue;
      }

      const raw = await requestModel({
        imageBase64: item.base64,
        mimeType: item.mime,
        model: currentModel,
        provider: currentProvider,
        vision: currentVision,
        outputFormat: currentFmt,
        extraPrompt: extra
      });

      if(!raw){
        errors.push(item.name + ': Empty response');
        continue;
      }

      let combinedRaw = raw.trim();
      let rows = extractJsonRows(combinedRaw) || [];
      const initialArray = extractJsonArray(combinedRaw);
      if(!initialArray && rows.length){
        const maxPasses = 4;
        for(let p=0;p<maxPasses;p++){
          setStatus(`Continuing ${i+1}/${currentItems.length}…`, 'busy');
          const lastRow = rows[rows.length - 1];
          const contPrompt = buildContinuationPrompt(lastRow, extra);
          const contRaw = await requestModel({
            imageBase64: item.base64,
            mimeType: item.mime,
            model: currentModel,
            provider: currentProvider,
            vision: currentVision,
            promptOverride: contPrompt
          });
          if(!contRaw) break;
          const contRows = extractJsonRows(contRaw) || [];
          if(!contRows.length) break;
          rows = rows.concat(contRows);
          combinedRaw = JSON.stringify(rows, null, 2);
          if(extractJsonArray(contRaw)) break;
        }
      } else if(initialArray){
        combinedRaw = JSON.stringify(initialArray, null, 2);
        rows = initialArray;
      }

      rows = extractJsonRows(combinedRaw) || [];
      if(!rows.length){
        errors.push(item.name + ': No rows');
        continue;
      }
      allRows.push(...rows);
    }

    if(currentProvider === 'gcv'){
      lastRaw = allRows.map(r => r.__ocr).join('\n\n');
      renderResult(lastRaw);
    } else {
      lastRaw = JSON.stringify(allRows, null, 2);
      renderResult(lastRaw);
    }
    

    if(errors.length){
      setStatus('Done with warnings — ' + currentModel, 'ok');
    } else {
      setStatus('Done — ' + currentModel, 'ok');
    }

  } catch(err){
    renderError(err.message);
    setStatus('Error: ' + err.message.slice(0,80), 'error');
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    label.textContent = 'Extract Table';
  }
}

async function requestModel(payload){
  const res = await fetch(`${API_BASE_URL}/api/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if(!res.ok){
    const msg = data?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data?.raw || '';
}

function buildContinuationPrompt(lastRow, extra){
  const base = `Continue extracting the same table image. Return ONLY a JSON array of remaining rows, using the same columns and order. Start AFTER this last row:\n${JSON.stringify(lastRow)}\nIf there are no more rows, return [] only.`;
  return base + (extra ? '\n\nAdditional: ' + extra : '');
}

function fileToItem(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=>{
      const dataUrl = r.result;
      resolve({
        name: file.name,
        mime: file.type || 'image/jpeg',
        base64: String(dataUrl).split(',')[1],
        dataUrl: dataUrl
      });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function pdfToItems(file, maxItems){
  if(!window.pdfjsLib){
    await loadPdfJs();
  }
  if(!window.pdfjsLib){
    alert('PDF support is not available. Please check the local pdf.js files and try again.');
    return [];
  }
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  const maxPages = Math.min(pdf.numPages, maxItems);
  const items = [];

  for(let p=1;p<=maxPages;p++){
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.25 });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    items.push({
      name: `${file.name}#p${p}`,
      mime: 'image/jpeg',
      base64: dataUrl.split(',')[1],
      dataUrl: dataUrl
    });
    if(items.length >= maxItems) break;
  }

  return items;
}

function loadPdfJs(){
  if(pdfjsLoadPromise) return pdfjsLoadPromise;
  pdfjsLoadPromise = new Promise((resolve)=>{
    import(PDFJS_LIB_SRC).then((mod)=>{
      window.pdfjsLib = mod;
      if(window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions){
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
      }
      resolve();
    }).catch(()=>resolve());
  });
  return pdfjsLoadPromise;
}

// ─── Render ───────────────────────────────────────────────
function stripCodeFences(raw){
  return raw.replace(/^```[a-z]*\n?/i,'').replace(/```$/,'').trim();
}

function extractJsonArray(raw){
  const cleaned = stripCodeFences(raw).trim();
  try {
    const direct = JSON.parse(cleaned);
    if(Array.isArray(direct)) return direct;
  } catch(e){}

  // Try to locate the first top-level JSON array in mixed text.
  const s = cleaned;
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;

  for(let i=0;i<s.length;i++){
    const ch = s[i];
    if(inStr){
      if(esc){ esc = false; continue; }
      if(ch === '\\'){ esc = true; continue; }
      if(ch === '"') inStr = false;
      continue;
    }
    if(ch === '"'){ inStr = true; continue; }
    if(ch === '['){ if(depth === 0) start = i; depth++; continue; }
    if(ch === ']'){
      if(depth > 0) depth--;
      if(depth === 0 && start !== -1){
        const slice = s.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice);
          if(Array.isArray(parsed)) return parsed;
        } catch(e){}
        start = -1;
      }
    }
  }
  return null;
}

function extractJsonRows(raw){
  const arr = extractJsonArray(raw);
  if(arr) return arr;

  // Best-effort recovery: extract complete JSON objects.
  const s = stripCodeFences(raw).trim();
  const rows = [];
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;

  for(let i=0;i<s.length;i++){
    const ch = s[i];
    if(inStr){
      if(esc){ esc = false; continue; }
      if(ch === '\\'){ esc = true; continue; }
      if(ch === '"') inStr = false;
      continue;
    }
    if(ch === '"'){ inStr = true; continue; }
    if(ch === '{'){ if(depth === 0) start = i; depth++; continue; }
    if(ch === '}'){
      if(depth > 0) depth--;
      if(depth === 0 && start !== -1){
        const objText = s.slice(start, i + 1);
        try {
          const obj = JSON.parse(objText);
          if(obj && typeof obj === 'object' && !Array.isArray(obj)) rows.push(obj);
        } catch(e){}
        start = -1;
      }
    }
  }

  return rows.length ? rows : null;
}

function renderResult(raw){
  const content = document.getElementById('output-content');
  const empty   = document.getElementById('empty-state');
  empty.style.display = 'none';
  content.style.display = 'block';
  content.innerHTML = '';

  document.getElementById('copy-btn').classList.add('visible');
  document.getElementById('dl-btn').classList.add('visible');

  // Try to parse JSON
  const rows = extractJsonRows(raw);
  if(currentFmt === 'csv'){
    if(rows && rows.length){
      renderTable(rows, content);
      lastRows = rows;
      lastRaw = rowsToCsv(rows);
      showBadge(rows.length + ' rows');
      return;
    }

    const pre = document.createElement('pre');
    pre.className = 'code-out';
    pre.textContent = raw;
    content.appendChild(pre);
    lastRows = null;
    const lines = raw.trim().split('\n').length - 1;
    showBadge(lines + ' rows');
    return;
  }
  if(!rows){
    const pre = document.createElement('pre');
    pre.className = 'code-out';
    pre.textContent = raw;
    content.appendChild(pre);
    lastRows = null;
    return;
  }

  if(currentFmt === 'json'){
    const pre = document.createElement('pre');
    pre.className = 'code-out';
    pre.textContent = JSON.stringify(rows, null, 2);
    content.appendChild(pre);
    lastRaw = JSON.stringify(rows, null, 2);
    lastRows = rows;
    showBadge(rows.length + ' rows');
    return;
  }

  // Table view
  if(!rows.length){ content.textContent = 'No rows found.'; return; }
  renderTable(rows, content);
  lastRaw = JSON.stringify(rows, null, 2);
  lastRows = rows;
  showBadge(rows.length + ' rows');
}

function renderTable(rows, content){
  const keys = Object.keys(rows[0] || {});
  const wrap  = document.createElement('div'); wrap.className='tbl-wrap';
  const tbl   = document.createElement('table'); tbl.className='result-tbl';
  const thead = document.createElement('thead');
  const hrow  = document.createElement('tr');
  keys.forEach(k=>{ const th=document.createElement('th'); th.textContent=k; hrow.appendChild(th); });
  thead.appendChild(hrow); tbl.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach(row=>{
    const tr=document.createElement('tr');
    keys.forEach(k=>{
      const td=document.createElement('td');
      td.textContent = row[k] ?? '';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody); wrap.appendChild(tbl); content.appendChild(wrap);
}

function renderError(msg){
  const content = document.getElementById('output-content');
  document.getElementById('empty-state').style.display = 'none';
  content.style.display = 'block';
  content.innerHTML = `<div class="error-state">
    <strong>Extraction failed</strong>
    ${escHtml(msg)}
    <ul class="err-tips">
      <li>Make sure the image is clear and has a table</li>
      <li>Try a different model (e.g. gemini-2.5-pro)</li>
      <li>Check your backend logs</li>
    </ul>
  </div>`;
}

function showBadge(txt){
  const b = document.getElementById('count-badge');
  b.textContent = txt;
  b.style.display = 'inline';
}

function escHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function rowsToCsv(rows){
  if(!rows || !rows.length) return '';
  const keySet = new Set();
  rows.forEach(r=>Object.keys(r || {}).forEach(k=>keySet.add(k)));
  const keys = Array.from(keySet);
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return '"' + s.replace(/"/g,'""') + '"';
  };
  const header = keys.map(esc).join(',');
  const body = rows.map(r=>keys.map(k=>esc(r ? r[k] : '')).join(','));
  return [header, ...body].join('\n');
}

// ─── Copy & Download ──────────────────────────────────────
function doCopy(){
  navigator.clipboard.writeText(lastRaw).then(()=>{
    const btn = document.getElementById('copy-btn');
    btn.classList.add('ok');
    btn.textContent = '✓ Copied';
    setTimeout(()=>{ btn.classList.remove('ok'); btn.textContent='⎘ Copy'; }, 2000);
  });
}
function doDownload(){
  if(currentProvider === 'gcv'){
    const blob = new Blob([lastRaw],{type:'text/plain;charset=utf-8'});
    const a    = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vision-ocr.txt';
    a.click();
    return;
  }
  const isTable = currentFmt === 'table';
  const ext  = (currentFmt === 'csv' || isTable) ? 'csv' : 'json';
  const mime = ext === 'csv' ? 'text/csv' : 'application/json';
  const payload = (ext === 'csv')
    ? (currentFmt === 'csv' ? lastRaw : rowsToCsv(lastRows))
    : lastRaw;
  const blob = new Blob([payload],{type:mime+';charset=utf-8'});
  const a    = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `table-extract.${ext}`;
  a.click();
}
