// File-mode entry. The graph editor, validator, renderer and exported PDB are shared with the local demo.
import { dots, place, undoEdit, clearGraph, snapshot } from './ptg-graph.js';
import { spaceEditor } from './space-editor.js';
import { MolstarScene } from '@viewer/scene.js';
import { BackbonePreview } from '@viewer/backbonePreview.js';
import { revealBackbone } from '@viewer/backboneReveal.js';
import { parsePdb, buildGuidePdb } from '@viewer/pdb.js';

const el = id => document.getElementById(id);
const canvas = el('drawing'), model = el('model'), button = el('reveal');
const storageKey = 'gtp.local.model-sketches.v1';
const served = ['http:','https:'].includes(location.protocol);
const examples = JSON.parse(el('generated-examples').textContent);
let pdbUrl = null, guideVisible = false;
let sketchSpan = 0;

let mode = 'draw', developer = false, records = [], storageWarning = '';
let active = null, scene = null, stopReveal = null;
const fallback = new BackbonePreview();
model.append(fallback.element);

function validGraph(graph) {
  return Array.isArray(graph?.nodes) && graph.nodes.length >= 3 &&
    graph.nodes.every(n => Array.isArray(n.position) && n.position.length === 3 && n.position.every(Number.isFinite));
}
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
  if (Array.isArray(saved)) records = saved.filter(r => validGraph(r?.graph) && typeof r.id === 'string').slice(0, 8);
} catch { storageWarning = '此浏览器暂时无法读取已保存的草图。'; }

function saveRecords() {
  try { localStorage.setItem(storageKey, JSON.stringify(records)); }
  catch { storageWarning = '浏览器未能保存记录。可在开发者模式下载草图。'; }
}

const hint = text => { el('hint').textContent = text; };
const editor = spaceEditor(canvas, el('views'), {
  editable: () => mode === 'draw',
  changed: () => { active = null; update(); },
  message: hint, save: () => button.focus()
});

function previous() {
  const list = el('reopen-list');
  list.replaceChildren();
  el('reopen').hidden = !records.length && !examples.length && !storageWarning;
  el('reopen-note').hidden = !storageWarning;
  el('reopen-note').textContent = storageWarning;
  for (const record of [...records, ...examples]) {
    const row = document.createElement('li');
    row.className = 'reopen-item';
    const text = document.createElement('strong');
    text.textContent = record.label || record.graph.nodes.length+' 个点 · '+new Date(record.savedAt).toLocaleString();
    const edit = document.createElement('button');
    edit.textContent = '打开草图';
    edit.onclick = () => restoreDrawing(record);
    const result = document.createElement('button');
    result.textContent = record.result ? '查看生成结果' : record.job ? '查看生成进度' : '尚无结果';
    result.disabled = !record.result && !record.job;
    result.onclick = () => openRecord(record);
    row.append(text, edit, result);
    list.append(row);
  }
}

function update() {
  const drawing = mode === 'draw', loading = mode === 'loading', count = dots().length;
  document.body.dataset.mode = mode;
  document.body.dataset.interface = developer ? 'developer' : 'simple';
  el('developer-mode').setAttribute('aria-pressed', String(developer));
  el('developer-mode').disabled = loading;
  const source = active?.id.startsWith('example-') ? '预置示例' : '草图';
  el('headline').textContent = drawing ? '画一条空间折线。' : loading ? '正在生成骨架。' : active.graph.nodes.length+' 点'+source+'的候选骨架';
  el('instruction').textContent = drawing ? '点出至少三个点，切到侧面可调整深度。模型会按这条折线生成一份候选骨架。' : '拖动旋转，比较原草图和模型输出的彩色骨架。';
  canvas.hidden = !drawing;
  model.hidden = drawing;
  el('edit-tools').hidden = el('views').hidden = !drawing;
  el('count').textContent = drawing ? count+' 个点' : active?.result ? active.result.residues+' 个残基 · '+active.result.atoms+' 个原子' : '';
  el('stage-label').textContent = drawing ? '三维折线' : 'RFdiffusion · 本地模型';
  el('undo').disabled = !count;
  el('busy').hidden = !loading;
  el('back').hidden = el('download').hidden = mode !== 'result';
  el('guide-toggle').hidden = mode !== 'result';
  el('guide-toggle').setAttribute('aria-pressed', String(guideVisible));
  el('guide-toggle').textContent = guideVisible ? '隐藏草图' : '显示草图';
  el('sample-sketch').hidden = !drawing || count > 0;
  button.hidden = !drawing;
  button.disabled = count < 3 || !drawing;
  button.textContent = developer && (!active || active.result || active.pdb) ? '保存草图' : '一键生产蛋白质';
  el('graph-info').hidden = !developer || !active;
  el('graph-data').textContent = developer && active ? JSON.stringify(active.graph, null, 2) : '';
  el('busy-text').textContent = '正在准备本地模型…';
  if (drawing) hint(count < 3 ? '再点 '+(3-count)+' 个点即可继续' : '草图已就绪');
  else if (mode === 'result') hint(active.result.mean_distance > sketchSpan ? '骨架偏离草图：平均偏差超过了整张草图的跨度。' : '草图和候选骨架已按同一坐标系显示。');
  else hint('这张草图有 '+active.graph.nodes.length+' 个点');
  el('note').textContent = drawing ? (served ? '每次生成用当前草图的三维坐标约束模型。' : '要生成自己的骨架，请双击同目录的“启动GTP.cmd”。') :
    mode === 'result' ? '对应点平均偏差 '+active.result.mean_distance.toFixed(2)+' Å · 草图最远两点相距 '+sketchSpan.toFixed(2)+' Å' : '请保持启动窗口打开。';
  if (mode === 'result' && active.result.candidate_count) {
    const baseline = active.result.candidate_scores.find(candidate => candidate.seed === 0);
    const selection = active.result.seed === 0 ? '保留第一份' : '选中第 '+(active.result.seed+1)+' 份';
    el('note').textContent += ' · 本次比较 '+active.result.candidate_count+' 份候选，'+selection;
    if (active.result.seed !== 0 && Number.isFinite(baseline?.mean_distance)) {
      el('note').textContent += '（第一份偏差 '+baseline.mean_distance.toFixed(2)+' Å）';
    }
  }
  previous();
  if (drawing) editor.paint();
}

function leaveResult() {
  stopReveal?.(); stopReveal = null;
  if (pdbUrl) URL.revokeObjectURL(pdbUrl);
  pdbUrl = null; guideVisible = false;
  el('download').removeAttribute('href');
  fallback.clear();
  if (scene) { scene.dispose(); scene = null; }
  const old = model.firstElementChild;
  const fresh = old.cloneNode(false);
  fresh.hidden = false;
  old.replaceWith(fresh);
}

function drawAgain(record = null) {
  if (mode === 'loading') return;
  leaveResult();
  clearGraph(); editor.reset(); mode = 'draw';
  if (record) for (const node of record.graph.nodes) place(node.position);
  active = record;
  update();
  canvas.focus({preventScroll:true});
}
function restoreDrawing(record) {
  if (mode === 'loading') return;
  try { drawAgain(record); }
  catch (error) { active = null; update(); hint(error.message); }
}

async function request(path, init) {
  const response = await fetch(path, {...init,cache:'no-store'});
  const value = await response.json();
  if (!response.ok || value.error) throw Error(value.message || '读取本地模型服务失败');
  return value;
}

async function readModel(record) {
  if (record.pdb && record.result) return Uint8Array.from(atob(record.pdb), c=>c.charCodeAt(0));
  let status;
  if (!record.job) {
    record.job = record.id;
    saveRecords();
  }
  if (!record.result) {
    // The request id is reused after a transport failure or a page reload.
    status = await request('/api/sketch-jobs',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:record.job,graph:record.graph})});
    const start = Date.now();
    while (status.state === 'queued' || status.state === 'running') {
      el('busy-text').textContent = (status.state==='queued' ? '等待本机模型' : '正在生成和比较候选骨架')+' · '+Math.floor((Date.now()-start)/1000)+' 秒';
      await new Promise(r=>setTimeout(r,800));
      status = await request('/api/sketch-jobs/'+record.job);
    }
    if (status.state !== 'done') {
      record.job = null;
      record.id = crypto.randomUUID();
      saveRecords();
      throw Error(status.message || '本次生成未完成，请重试。');
    }
    record.result = status.result;
    saveRecords();
  }
  const response = await fetch('/api/sketch-jobs/'+record.job+'/backbone.pdb',{cache:'no-store'});
  if (!response.ok) throw Error('读取本次生成的 PDB 失败，请重新打开结果。');
  return new Uint8Array(await response.arrayBuffer());
}

async function show(record) {
  const bytes = await readModel(record);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), n=>n.toString(16).padStart(2,'0')).join('');
  if (!record.result.is_real_model_output || hash !== record.result.pdb_sha256) throw Error('PDB 与本次模型输出的摘要不符。');
  const pdb = new TextDecoder().decode(bytes);
  const parsed = parsePdb(pdb,'生成的骨架');
  if (!parsed.ok) throw Error(parsed.error.message);
  const guide = record.result.anchors.map(a => a.target);
  sketchSpan = 0;
  for (let i=0; i<guide.length; i++) {
    for (let j=0; j<i; j++) {
      sketchSpan = Math.max(sketchSpan, Math.hypot(...guide[i].map((x,k)=>x-guide[j][k])));
    }
  }
  const guideText = buildGuidePdb(guide.map((position,i)=>({position,id:'n'+i})), 'sketch');
  const mainCanvas = model.firstElementChild;
  try {
    scene = await MolstarScene.create(mainCanvas, model);
    await scene.load({structureText:pdb, structureLabel:'生成的骨架', guideText, guideLabel:'guide-sketch'});
    guideVisible = scene.setGuideVisible(true);
    stopReveal = revealBackbone(scene, model, parsed.structure.atoms);
  } catch {
    if (scene) { scene.dispose(); scene = null; }
    mainCanvas.hidden = true;
    fallback.show(parsed.structure.atoms, guide, pdb);
    if (guide.length) fallback.toggleGuide();
    guideVisible = fallback.guideVisible;
  }
  pdbUrl = URL.createObjectURL(new Blob([bytes], {type:'chemical/x-pdb'}));
  el('download').href = pdbUrl;
  el('download').download = 'gtp-'+hash.slice(0,12)+'.pdb';
  mode = 'result';
  update();
  el('download').focus({preventScroll:true});
}

async function openRecord(record) {
  if (mode==='loading') return;
  if (!served && !record.pdb) { hint('请双击“启动GTP.cmd”，在本机模型页打开这张草图。'); return; }
  leaveResult();
  active = record; mode = 'loading'; update();
  try { await show(record); }
  catch (error) { mode='draw'; restoreDrawing(record); hint(error.message); }
}

el('guide-toggle').onclick = () => {
  if (mode!=='result') return;
  if (scene) {
    if (scene.setGuideVisible(!guideVisible)) guideVisible = !guideVisible;
  } else {
    fallback.toggleGuide();
    guideVisible = fallback.guideVisible;
  }
  el('guide-toggle').setAttribute('aria-pressed', String(guideVisible));
  el('guide-toggle').textContent = guideVisible ? '隐藏草图' : '显示草图';
};
button.onclick = async () => {
  if (mode !== 'draw' || button.disabled) return;
  try {
    if (!served && !developer) { hint('生成需使用本机模型。请双击“启动GTP.cmd”打开绘图页。'); return; }
    if (!active || active.result || active.pdb) {
      const graph = snapshot();
      active = {id: crypto.randomUUID(), savedAt:new Date().toISOString(), graph};
      records = [active, ...records].slice(0, 8);
      if (developer) { saveRecords(); update(); hint('已保存，可查看坐标或继续打开结构。'); return; }
    }
    saveRecords();
    await openRecord(active);
  } catch (error) { if (mode === 'loading') mode = 'draw'; update(); hint(error.message); }
};
el('back').onclick = () => drawAgain();
el('undo').onclick = () => { undoEdit(); active = null; update(); };
el('developer-mode').onclick = () => { developer = !developer; update(); };
el('sample-sketch').onclick = () => {
  if (mode !== 'draw' || dots().length) return;
  for (const p of [[-3,0,0],[-1,1,0.6],[1,-0.6,-0.3],[3,0.7,1.5]]) place(p);
  active = null; update(); button.focus();
};
el('graph-export').onclick = () => {
  if (!active) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(active.graph,null,2)], {type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'sketch-'+active.id+'.json';
  link.click(); setTimeout(() => URL.revokeObjectURL(url),30000);
};
el('photo').onclick = () => el('file').click();
el('file').onchange = async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  try {
    const image = await createImageBitmap(file);
    if (mode === 'draw') editor.reference(image); else image.close();
  } catch { hint('图片无法打开，请选择 PNG 或 JPEG。'); }
};
update();
if (document.body.dataset.openResult && examples.length) {
  openRecord(examples[0]);
  el('back').textContent = '返回绘图窗口';
  el('back').onclick = () => { window.close(); hint('请切回 GraphToProtein 绘图窗口，继续画下一张。'); };
}
