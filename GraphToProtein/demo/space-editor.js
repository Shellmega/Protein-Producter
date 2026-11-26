import { dots, place, movePoint } from './ptg-graph.js';

const origin = [0, 0, 0];
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function spaceEditor(canvas, controls, { editable, changed, message, save }) {
  const ctx = canvas.getContext('2d');
  let view, yaw, pitch, selected, gesture, cursor, reference;

  function basis() {
    if (view === 'front') return [[1,0,0], [0,1,0]];
    if (view === 'side') return [[0,0,1], [0,1,0]];
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [[c,0,s], [-s*Math.sin(pitch),Math.cos(pitch),c*Math.sin(pitch)]];
  }

  function camera() {
    const {width, height} = canvas.getBoundingClientRect();
    const scale = Math.min(width / 10, height / 5);
    const [right, up] = basis();
    const project = p => [width / 2 + scale * dot(p, right), height / 2 - scale * dot(p, up)];
    // Inverse orthographic mapping on the plane through the selected point.
    function displace(anchor, dx, dy) {
      return anchor.map((v, i) => v + (dx * right[i] - dy * up[i]) / scale);
    }
    return {width, height, scale, project, displace};
  }

  function highlightView() {
    for (const btn of controls.querySelectorAll('button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.view === view));
    }
  }
  function setView(name) {
    view = name;
    yaw = name === 'front' ? 0 : name === 'side' ? Math.PI/2 : .72;
    pitch = name === 'orbit' ? .36 : 0;
    gesture = cursor = null;
    highlightView();
    paint();
  }

  function paint() {
    const {width, height, scale, project} = camera();
    if (!width || !height) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width*ratio) || canvas.height !== Math.round(height*ratio)) {
      canvas.width = Math.round(width*ratio); canvas.height = Math.round(height*ratio);
    }
    ctx.setTransform(ratio,0,0,ratio,0,0);
    ctx.clearRect(0,0,width,height);
    function line(a,b,color,weight,dash=[]) {
      ctx.setLineDash(dash); ctx.lineWidth=weight; ctx.strokeStyle=color;
      ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();
    }
    function circle(p,r,fill,edge) {
      ctx.setLineDash([]);ctx.lineWidth=1.5;ctx.fillStyle=fill;ctx.strokeStyle=edge;
      ctx.beginPath();ctx.arc(...p,r,0,Math.PI*2);ctx.fill();ctx.stroke();
    }
    if (reference && view === 'front') {
      const fit = Math.min(9.6/reference.width,4.25/reference.height)*scale;
      const w=reference.width*fit, h=reference.height*fit;
      ctx.globalAlpha=.8;ctx.drawImage(reference,(width-w)/2,(height-h)/2,w,h);ctx.globalAlpha=1;
    }
    const nodes = dots();
    const points = nodes.map(n => gesture?.node?.id === n.id && gesture.preview ? gesture.preview : n.position);
    const projected = points.map(project);
    if (!nodes.length && !reference && view === 'front') {
      const guide = [[-4,-.6,0],[-3,1,0],[-1.5,1.25,0],[0,-.35,0],[1.2,-1,0],[3.4,.85,0]].map(project);
      guide.slice(1).forEach((p,i)=>line(guide[i],p,'#829e96',1.5,[3,7]));
      guide.forEach(p=>circle(p,5,'#23423f','#a6b8a9'));
      circle(guide[0],13,'transparent','#c7e58e');
    }
    if (view === 'orbit') {
      for (let i=-4;i<=4;i++) {
        line(project([i,-1.8,-4]),project([i,-1.8,4]),'#72938d25',1);
        line(project([-4,-1.8,i]),project([4,-1.8,i]),'#72938d25',1);
      }
    }
    projected.slice(1).forEach((p,i)=>line(projected[i],p,'#b4ef9a',3.5));
    projected.forEach((p,i)=>{
      circle(p,6,i===0?'#dcff82':'#85eac3','#183d35');
      if (nodes[i].id === selected) circle(p,10,'transparent','#c5efb2');
      ctx.fillStyle='#e1efdf';ctx.font='12px system-ui';ctx.fillText(String(i+1),p[0]+10,p[1]-9);
    });
    if(cursor && document.activeElement===canvas) circle(cursor,3,'#fff','#314e43');
    const axisOrigin = [24,height-24];
    const center = project(origin);
    const axes = [[[1,0,0],'X','#ded884'],[[0,1,0],'Y','#97dfad'],[[0,0,1],'Z','#95cfe8']];
    for (const [dir,label,color] of axes) {
      const v=project(dir);
      const dx=(v[0]-center[0])/scale, dy=(v[1]-center[1])/scale;
      if (Math.hypot(dx,dy)<.12) continue;
      const end=[axisOrigin[0]+16*dx,axisOrigin[1]+16*dy];
      line(axisOrigin,end,color,1.5);
      ctx.fillStyle=color;ctx.font='10px monospace';ctx.fillText(label,end[0]+2,end[1]);
    }
  }

  function eventPoint(e) {
    const rect=canvas.getBoundingClientRect();
    return [e.clientX-rect.left,e.clientY-rect.top];
  }
  function addAt(pointer) {
    const {project,displace} = camera();
    const anchor = dots().at(-1)?.position || origin;
    const pos = project(anchor);
    selected = place(displace(anchor,pointer[0]-pos[0],pointer[1]-pos[1]));
    changed();
  }
  canvas.onpointerdown = e => {
    if (!editable() || !e.isPrimary || e.button !== 0) return;
    const p=eventPoint(e), {project}=camera();
    const hits = dots().map(n=>{
      const [x,y]=project(n.position);
      return {n,dist:Math.hypot(p[0]-x,p[1]-y)};
    }).filter(hit=>hit.dist<=14);
    hits.sort((a,b)=>a.dist-b.dist || Number(b.n.id===selected)-Number(a.n.id===selected));
    gesture={id:e.pointerId,start:p,yaw,pitch,node:hits[0]?.n,moved:false};
    if(gesture.node) selected=gesture.node.id;
    cursor=null;canvas.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);paint();
  };
  function drag(e) {
    if(!gesture || gesture.id!==e.pointerId)return;
    const p=eventPoint(e), dx=p[0]-gesture.start[0], dy=p[1]-gesture.start[1];
    if(!gesture.moved && Math.hypot(dx,dy)<4)return;
    gesture.moved=true;
    if(gesture.node) {
      gesture.preview=camera().displace(gesture.node.position,dx,dy);
    } else {
      view='orbit';yaw=gesture.yaw+dx*.008; pitch=clamp(gesture.pitch+dy*.008,-1.45,1.45);
      highlightView();
    }
    paint();
  }
  canvas.onpointermove=drag;
  canvas.onpointerup=e=>{
    if(!gesture || gesture.id!==e.pointerId)return;
    drag(e);
    const done=gesture;gesture=null;
    try {
      if(done.preview){movePoint(done.node.id,done.preview);changed()}
      else if(!done.node&&!done.moved)addAt(done.start);
    } catch(error){message(error.message)}
    paint();
  };
  canvas.onlostpointercapture=canvas.onpointercancel=()=>{gesture=null;paint()};
  canvas.onkeydown=e=>{
    if(!editable())return;
    const {width,height,scale,displace,project}=camera();
    cursor??=[width/2,height/2];
    try {
      if(e.key===' '){e.preventDefault();addAt(cursor)}
      else if(e.key==='Enter'){e.preventDefault();save()}
      else if(e.key==='[' || e.key===']'){
        e.preventDefault();const list=dots();
        if(list.length){const i=list.findIndex(n=>n.id===selected);selected=list[(i+(e.key===']'?1:-1)+list.length)%list.length].id}
      } else {
        const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
        if(!delta)return;
        e.preventDefault();
        const [dx,dy]=delta.map(n=>n*scale*.2);
        const node=dots().find(n=>n.id===selected);
        if(e.shiftKey && node){movePoint(node.id,displace(node.position,dx,dy));cursor=project(node.position);changed()}
        else cursor=[clamp(cursor[0]+dx,1,width-1),clamp(cursor[1]+dy,1,height-1)];
      }
    }catch(error){message(error.message)}
    paint();
  };
  controls.onclick=e=>{if(editable() && e.target.dataset.view)setView(e.target.dataset.view)};
  new ResizeObserver(paint).observe(canvas);
  setView('front');
  return {
    paint,
    reference(bitmap){reference?.close();reference=bitmap;setView('front')},
    reset(){reference?.close();reference=null;selected=null;setView('front')}
  };
}
