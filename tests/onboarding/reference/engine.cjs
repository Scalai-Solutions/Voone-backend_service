// Motor de onboarding de Voone, referencia v1.2.0. Es exactamente el motor que ejecuta el simulador interno.
// Uso: const {run,CFG}=require("./engine.cjs"); run(catalogo, respuestas). Toda la configuración está en CFG.

// Motor de onboarding de Voone (versión navegador del motor 1.0.0 + ventajas de nivel)
const CFG = {
  categories: {
    FAC:{name:"Facial de cabina",w:3,iv:5,cost:0.20,points:true,reward:true,early:false},
    APF:{name:"Aparatología facial",w:2,iv:4.5,cost:0.12,points:true,reward:true,early:false},
    MAS:{name:"Masaje",w:2,iv:6,cost:0.10,points:true,reward:true,early:false},
    COR:{name:"Tratamiento corporal",w:3,iv:4,cost:0.15,points:true,reward:true,early:false},
    LAS:{name:"Depilación láser",w:3,iv:7,cost:0.08,points:true,reward:true,early:false},
    CER:{name:"Depilación con cera",w:2,iv:5,cost:0.15,points:true,reward:false,early:false},
    PEL:{name:"Peluquería",w:3,iv:7,cost:0.15,points:true,reward:true,early:false},
    UNA:{name:"Manos y pies",w:3,iv:3,cost:0.15,points:true,reward:true,early:false},
    CEJ:{name:"Cejas y pestañas",w:2,iv:6,cost:0.15,points:true,reward:true,early:false},
    COS:{name:"Cosmética de venta",w:0,iv:0,cost:0.50,points:true,reward:true,early:true},
    PRE:{name:"Presoterapia y regalos de coste casi nulo",w:0,iv:0,cost:0.05,points:true,reward:true,early:true},
    DIA:{name:"Diagnóstico y valoración",w:0,iv:0,cost:0,points:true,reward:false,early:false},
    MFA:{name:"Medicina: farmacológico",w:0,iv:0,cost:0,points:false,reward:false,early:false,pharma:true},
    MNF:{name:"Medicina: acto médico sin medicamento",w:0,iv:0,cost:0,points:false,reward:false,early:false}
  },
  high:["MFA"], mid:["APF","COR","LAS"],
  segments:{ low:{comb:1.3,comp:0.5,tmin:25,tmax:70,ref:0.25}, mid:{comb:1.1,comp:0.5,tmin:50,tmax:150,ref:0.20}, high:{comb:1.1,comp:0.5,tmin:50,tmax:150,ref:0.20} },
  ticketBuckets:{
    low:[{id:"t1",label:"Menos de 25 €",max:25,value:20},{id:"t2",label:"25 a 40 €",max:40,value:32},{id:"t3",label:"40 a 60 €",max:60,value:50},{id:"t4",label:"Más de 60 €",max:null,value:70}],
    mid:[{id:"t1",label:"Menos de 60 €",max:60,value:50},{id:"t2",label:"60 a 100 €",max:100,value:80},{id:"t3",label:"100 a 150 €",max:150,value:125},{id:"t4",label:"Más de 150 €",max:null,value:175}]
  },
  freqBuckets:[{id:"f1",label:"Cada 3 semanas",maxW:3.5,weeks:3},{id:"f2",label:"Cada mes",maxW:5,weeks:4.3},{id:"f3",label:"Cada 6 a 8 semanas",maxW:9,weeks:7},{id:"f4",label:"Cada 2 o 3 meses",maxW:14,weeks:10.8},{id:"f5",label:"Cada 4 a 6 meses",maxW:null,weeks:21.7}],
  investment:{conservador:0.04,equilibrado:0.05,generoso:0.06},
  // Ocupación de la agenda. svc: coste de regalar tiempo de cabina (con huecos cuesta menos; llena, cada regalo ocupa una cita vendible).
  // tramo: reparto del presupuesto entre tramos. ref: peso del premio por recomendar.
  occupancy:{
    o1:{label:"Menos del 50%",sub:"Hay mucho hueco que llenar",svc:0.7,tramo:[1.15,1,1,1],ref:1.5},
    o2:{label:"50 a 70%",sub:"Ocupación media",svc:1.0,tramo:[1,1,1,1],ref:1.0},
    o3:{label:"70 a 85%",sub:"Bastante llena",svc:1.2,tramo:[1.05,0.9,1,1.1],ref:0.8},
    o4:{label:"Más del 85%",sub:"Agenda casi completa",svc:1.4,tramo:[1.1,0.8,1,1.2],ref:0.6}
  },
  timeCats:["FAC","APF","MAS","COR","LAS","PEL","UNA","CEJ","PRE"],
  objectives:{
    equilibrado:{pos:[0.8,1,1.2],mult:[2,1,1,1],ref:1},
    mas_visitas:{pos:[0.9,1,1.1],mult:[2,1,1,1],ref:1},
    mas_gasto:{pos:[0.8,1,1.2],mult:[2,1,1,1.3],ref:1},
    mas_clientes_nuevos:{pos:[0.8,1,1.2],mult:[2,1,1,1],ref:1.5}
  },
  members:[{id:"m1",label:"Menos de 150",value:100},{id:"m2",label:"150 a 400",value:275},{id:"m3",label:"400 a 800",value:600},{id:"m4",label:"Más de 800",value:1000}],
  p:{premiosPerTramo:3,maxVisitsBetween:1.5,discountMaxProducts:3,refInv:0.10,refRepeatEvery:3,redeemVisitShare:0.10,refShare:0.05,refSteps:[{n:1,v:0.3},{n:3,v:0.75},{n:5,v:1.25},{n:7,v:1.75},{n:10,v:2.75}],perkUpgradeCost:0.05,surpriseMaxCost:0.10,surpriseRatio:0.06,earlyFloorPctT:0.10,tol:0.15,vb:0.30,cap:2.0,round:10,years:5,maxYears:6,minVisitsSilver:2,minGrowth:1.5,visitsSilver:3,loopA:0.75,beam:400,adhesion:0.5,margin:0.6,fee:149.99,feeBySegment:{low:49.99,mid:99.99,high:149.99},repeatShare:0.42,uplift:0.10,occVisits:1.3,repeatRetention:0.75,occRedemption:0.3,redemption:0.75,spendUplift:0.05,eventCost:6,eventAttendance:0.5,giftCats:['COS','PRE','FAC','APF','MAS','PEL','UNA','CEJ'],testCost:1,cosmeticShareOfSpend:0.05},
  tiers:["bronce","plata","oro","platino","diamante"],
  tierNames:{bronce:"Bronce",plata:"Plata",oro:"Oro",platino:"Platino",diamante:"Diamante"},
  minTenure:{bronce:0,plata:0,oro:12,platino:24,diamante:36},
  // Ventajas constantes por nivel. Regalos en proporción al ticket medio (T): valor objetivo y coste máximo.
  tierBenefits:{
    bronce:  {mult:1.0, birthday:{v:0.20,c:0.10}, anniversary:null,            discount:0,    events:0, tests:false, extra:["Tarjeta con su nombre y escalera de premios"]},
    plata:   {mult:1.0, birthday:{v:0.35,c:0.10}, anniversary:null,            discount:0.03, events:0, tests:false, extra:["Prioridad en huecos de última hora y lista de espera"]},
    oro:     {mult:1.1, birthday:{v:0.50,c:0.12}, anniversary:null, discount:0.05, events:0, tests:true,  extra:["Acceso preferente a la Happy Hour: huecos que el centro quiere llenar rápido, con un 30% de descuento"]},
    platino: {mult:1.2, birthday:{v:0.75,c:0.15}, anniversary:null, discount:0.10, events:1, tests:true,  extra:["Acceso preferente a la Happy Hour: huecos que el centro quiere llenar rápido, con un 30% de descuento","Acceso 48 horas antes a tratamientos y productos nuevos"]},
    diamante:{mult:1.3, birthday:{v:1.00,c:0.20}, anniversary:null, discount:0.15, events:2, tests:true,  extra:["Acceso preferente a la Happy Hour: huecos que el centro quiere llenar rápido, con un 30% de descuento","Cita garantizada en 48 horas","Plan anual personalizado"]}
  },
  keywords:[
    ["MFA",["toxina","botox","bótox","bruxismo","hiperhidrosis","hialurónico","hialuronico","rinomodelación","rinomodelacion","sculptra","polinucleótidos","polinucleotidos","skinbooster","mesoterapia","hialuronidasa","relleno","vial"]],
    ["MNF",["consulta médica","consulta medica","láser plasma","laser plasma","verrugas","lunares"]],
    ["DIA",["diagnóstico","diagnostico","valoración","valoracion"]],
    ["PRE",["presoterapia","ampolla","(extra)"," extra"]],
    ["CER",["cera"]],
    ["LAS",["láser cuerpo","laser cuerpo","zona mini","zona pequeña","zona mediana","depilación láser","depilacion laser"]],
    ["APF",["hydrafacial","bio-pen","biopen","dermapen","radiofrecuencia facial","hollywood","electroporación","electroporacion"]],
    ["COR",["lipolítico","lipolitico","corporal","maderoterapia","chocolate","anticelulítico","anticelulitico","presoterapia"]],
    ["MAS",["masaje"]],
    ["FAC",["facial","higiene","limpieza","mirada"]],
    ["PEL",["corte","tinte","mechas","color","peinado","peinar","lavar","keratina","capilar","alisado","barbería","barberia"]],
    ["UNA",["manicura","pedicura","semipermanente","uñas","unas"]],
    ["CEJ",["cejas","pestañas","pestanas","lifting"]]
  ]
};

const eurTxt=v=>Math.round(v).toLocaleString('es-ES')+' €';
const rha = x => Math.sign(x)*Math.round(Math.abs(x)+1e-9);
const roundTo = (x,s) => rha(x/s)*s;
const floorTo = (x,s) => Math.floor(x/s+1e-9)*s;
const r1 = x => rha(x*10)/10;
const median = v => { const s=[...v].sort((a,b)=>a-b), m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };

function classify(items){
  return items.map(it=>{
    if(it.cat && CFG.categories[it.cat]) return {...it, src:it.src||"centro"};
    if(it.product) return {...it, cat:"COS", src:"producto"};
    const n=(it.name||"").toLowerCase();
    for(const [c,kw] of CFG.keywords) if(kw.some(k=>n.includes(k))) return {...it, cat:c, src:"palabra clave"};
    return {...it, cat:"DIA", src:"sin clasificar", review:true};
  });
}

function estimate(items, ans){
  const cats=new Set(items.map(i=>i.cat));
  const segment = CFG.high.some(c=>cats.has(c))?"high":(CFG.mid.some(c=>cats.has(c))?"mid":"low");
  const sg=CFG.segments[segment];
  let W=0,Ts=0,Fs=0; const catRows=[];
  for(const [cid,c] of Object.entries(CFG.categories)){
    const pr=items.filter(i=>i.cat===cid && !i.estimated && i.price>0).map(i=>i.price);
    if(!pr.length||c.w<=0||!c.points) continue;
    const m=median(pr); W+=c.w; Ts+=c.w*m; Fs+=c.w*52/c.iv; catRows.push({cat:cid,name:c.name,n:pr.length,median:m,w:c.w,iv:c.iv});
  }
  if(!W) return {error:"El catálogo no tiene tratamientos que sumen puntos. Añade tratamientos con precio."};
  const tEst=rha(sg.comb*Ts/W), fEst=r1(sg.comp*Fs/W);
  const tb=CFG.ticketBuckets[segment==="low"?"low":"mid"];
  const tPre=(tb.find(b=>b.max===null||tEst<b.max)||tb[tb.length-1]).id;
  const wk=52/fEst;
  const fPre=(CFG.freqBuckets.find(b=>b.maxW===null||wk<=b.maxW)||CFG.freqBuckets[4]).id;
  const ticket=(!ans.ticket||ans.ticket===tPre)?tEst:tb.find(b=>b.id===ans.ticket).value;
  const visits=(!ans.freq||ans.freq===fPre)?fEst:r1(52/CFG.freqBuckets.find(b=>b.id===ans.freq).weeks);
  return {hasDia:items.some(i=>i.cat==="DIA"&&!i.review),segment,tEst,fEst,tPre,fPre,ticket,visits,A:ticket*visits,AEst:tEst*fEst,inRange:ticket>=sg.tmin&&ticket<=sg.tmax,tb,catRows,W,Ts,Fs,comb:sg.comb,comp:sg.comp};
}

function buildLadder(est, ans, useFloor){
  const p=CFG.p, A=est.A, obj=CFG.objectives[ans.objective], inv=CFG.investment[ans.investment];
  const k4=1+p.minGrowth+p.minGrowth**2+p.minGrowth**3;
  let visitsSilver=p.visitsSilver, yearsTarget=p.years, P=visitsSilver*est.ticket/A;
  // Centros de poca frecuencia: si con Plata a 3 visitas Diamante tardaría demasiado, primero se alarga Diamante hasta 6 años
  // y después se baja Plata, nunca por debajo de 2 visitas.
  if(P*k4>yearsTarget){ yearsTarget=Math.min(p.maxYears,P*k4); if(P*k4>p.maxYears){ visitsSilver=Math.max(p.minVisitsSilver,p.maxYears/k4*A/est.ticket); P=visitsSilver*est.ticket/A; } }
  const S=yearsTarget/P; let R=1.5;
  for(let i=0;i<6;i++) R=R-(1+R+R*R+R**3-S)/(1+2*R+3*R*R);
  R=Math.max(R,p.minGrowth);
  const gaps=[0,1,2,3].map(k=>P*R**k), Y=gaps.reduce((a,b)=>a+b,0);
  const occ=CFG.occupancy[ans.occupancy]||CFG.occupancy.o2, tm=k=>obj.mult[k]*occ.tramo[k];
  const raw=gaps.reduce((s,g,k)=>s+tm(k)*g,0);
  const tramos=[]; let st=0;
  gaps.forEach((g,k)=>{ tramos.push({i:k+1,tier:CFG.tiers[k+1],gap:g,start:st,end:st+g,budget:inv*g*A*tm(k)*Y/raw}); st+=g; });
  // Suelo del primer tramo: cada premio de bienvenida debe poder costar al menos un % del ticket.
  const floor=3*p.earlyFloorPctT*est.ticket;
  let floorApplied=false;
  if(useFloor&&tramos[0].budget<floor){ floorApplied=true; const total=tramos.reduce((s,t)=>s+t.budget,0), rest=total-tramos[0].budget, newRest=total-floor;
    tramos[0].budget=floor; for(const t of tramos.slice(1)) t.budget*=newRest/rest; }
  // Hitos por nivel: siempre 3 premios del catálogo. Si el tramo es largo, se intercalan ventajas sin coste
  // para que la clienta nunca pase más de maxVisitsBetween visitas sin premio, ventaja o subida de nivel.
  const ms=[], NP=p.premiosPerTramo, counts=[];
  for(const t of tramos){
    const realVisits=t.gap*est.visits/CFG.tierBenefits[CFG.tiers[t.i-1]].mult;
    const fixed=1+(t.i===1&&est.hasDia?1:0); // ventajas fijas: puntos dobles en cada nivel y diagnóstico en Bronce
    const tot=Math.max(NP+fixed,Math.ceil(realVisits/p.maxVisitsBetween-1e-9)-1);
    const premioPos=new Set(Array.from({length:NP},(_,j)=>Math.round(1+j*(tot-1)/(NP-1))));
    t.realVisits=realVisits; t.hitos=tot; t.ventajas=tot-NP; counts.push(tot);
    let jp=0;
    for(let j=1;j<=tot;j++){ const th=roundTo(A*(t.start+t.gap*j/(tot+1)),p.round);
      if(premioPos.has(j)){ const cb=t.budget/NP*obj.pos[jp]; jp++;
        ms.push({n:ms.length+1,tramo:t.i,type:"premio",th,cb,cap:cb*(1+p.tol),V:cb/inv*p.vb/occ.svc,early:t.i===1}); }
      else ms.push({n:ms.length+1,tramo:t.i,type:"ventaja",th,cb:0,cap:0,V:0}); }
    ms.push({n:ms.length+1,tramo:t.i,type:"nivel",tier:t.tier,th:roundTo(A*t.end,p.round),cb:0,cap:0,V:0});
  }
  ms[0].th=Math.min(ms[0].th,floorTo(est.ticket,p.round));
  ms.find(m=>m.type==="nivel").th=floorTo(A*tramos[0].end,p.round);
  return {R,Y,tramos,ms,inv,P,S,obj,visitsSilver,floorApplied,counts,last:ms[ms.length-1]};
}

// Ventajas intercaladas (paso 2): se reparten en orden fijo y rotando, sin azar en el diseño.
function choosePerks(ms,cls,cands,est,inv){
  const P=CFG.p, T=est.ticket;
  const dias=cls.filter(i=>i.cat==="DIA"&&!i.review).sort((a,b)=>a.id<b.id?-1:1);
  const pool=cands.filter(c=>(c.cat==="COS"||c.cat==="PRE"||c.cost/c.value<=P.surpriseRatio+1e-9)&&c.cost<=P.surpriseMaxCost*T).sort((a,b)=>a.cost-b.cost||(a.id<b.id?-1:1));
  const kinds=(dias.length?["diag"]:[]).concat(["doble","mejora"],pool.length?["sorpresa"]:[]);
  const poolCost=pool.length?pool.reduce((s,c)=>s+c.cost,0)/pool.length:0;
  // Reglas fijas: el diagnóstico va siempre en Bronce (primera ventaja del tramo), y cada nivel tiene una ventaja de puntos dobles.
  // El resto de ventajas rota entre mejora y premio sorpresa.
  const rot=["mejora"].concat(pool.length?["sorpresa"]:[]); let k=0,d=0;
  const mk=(m,kind)=>{
    if(kind==="diag"){ const it=dias[d%dias.length]; d++; m.perk={kind,name:it.name+" gratis",desc:"Valoración gratuita, que además abre la puerta a recomendar un tratamiento nuevo.",cost:0}; }
    else if(kind==="doble") m.perk={kind,name:"Puntos dobles en tu próxima visita",desc:"La siguiente visita de pago suma el doble de progreso.",cost:inv*T};
    else if(kind==="mejora") m.perk={kind,name:"Mejora de tu tratamiento o 10 minutos extra",desc:"Un extra dentro de la sesión que ya ha pagado, a elección del centro.",cost:P.perkUpgradeCost*T};
    else m.perk={kind,name:"Premio sorpresa",desc:"Un detalle sencillo que elige el centro: "+pool.slice(0,5).map(c=>c.name).join(", ")+".",cost:poolCost,pool};
  };
  for(const tr of [1,2,3,4]){
    const slots=ms.filter(m=>m.tramo===tr&&m.type==="ventaja"); let i=0;
    if(tr===1&&dias.length&&slots[i]) mk(slots[i++],"diag");
    if(slots[i]) mk(slots[i++],"doble");
    for(;i<slots.length;i++){ mk(slots[i],rot[k%rot.length]); k++; }
  }
  return {kinds,pool,dias};
}
function candidates(items,ans){
  const occ=CFG.occupancy[(ans||{}).occupancy]||CFG.occupancy.o2;
  return items.filter(i=>CFG.categories[i.cat]&&CFG.categories[i.cat].reward&&i.price>0)
    .map(i=>({id:i.id,name:i.name,cat:i.cat,value:i.price,cost:i.price*(i.costPct!=null&&i.costPct!==""?i.costPct:CFG.categories[i.cat].cost)*(CFG.timeCats.includes(i.cat)?occ.svc:1)}));
}
function options(pool,triple){
  const o=pool.map(c=>({items:[c],value:c.value,cost:c.cost}));
  const top=triple?[...pool].sort((a,b)=>b.value-a.value||(a.id<b.id?-1:1)).slice(0,12):[];
  if(triple) for(let a=0;a<top.length;a++) for(let b=a+1;b<top.length;b++) for(let c=b+1;c<top.length;c++){
    const x=top[a],y=top[b],z=top[c]; if(x.cat===y.cat||x.cat===z.cat||y.cat===z.cat) continue;
    o.push({items:[x,y,z],value:x.value+y.value+z.value,cost:x.cost+y.cost+z.cost}); }
  for(let a=0;a<pool.length;a++) for(let b=a+1;b<pool.length;b++){ if(pool[a].cat===pool[b].cat) continue;
    o.push({items:[pool[a],pool[b]],value:pool[a].value+pool[b].value,cost:pool[a].cost+pool[b].cost}); }
  return o;
}
const ids=o=>o.items.map(i=>i.id);
function cmpLists(a,b){ for(let i=0;i<Math.min(a.length,b.length);i++){ const x=a[i],y=b[i];
  for(let j=0;j<Math.min(x.length,y.length);j++) if(x[j]!==y[j]) return x[j]<y[j]?-1:1;
  if(x.length!==y.length) return x.length-y.length; } return a.length-b.length; }

function chooseRewards(ms, cands, rx){
  rx=rx||{capMult:CFG.p.cap,earlyAll:false,nonStrict:false,tol:CFG.p.tol};
  const prem=ms.filter(m=>m.type==="premio");
  const sets=prem.map(m=>{
    const all=options(cands.filter(c=>rx.earlyAll||!m.early||CFG.categories[c.cat].early),rx.triple&&!m.early)
      .filter(o=>o.cost<=m.cb*(1+rx.tol)+1e-9&&o.value<=rx.capMult*m.V+1e-9);
    // Solo las opciones más cercanas al valor objetivo pueden formar parte de la mejor escalera.
    all.sort((a,b)=>(Math.abs(a.value-m.V)-Math.abs(b.value-m.V))||(a.items.length-b.items.length)||(a.cost-b.cost)||cmpLists([ids(a)],[ids(b)]));
    return all.slice(0,rx.triple?160:220);
  });
  const inChain=(st,id)=>{ for(let x=st;x&&x.o;x=x.parent) if(x.o.items.some(it=>it.id===id)) return true; return false; };
  const pathIds=st=>{ const out=[]; for(let x=st;x&&x.o;x=x.parent) out.unshift(ids(x.o)); return out; };
  let beam=[{s:0,last:0,parent:null,o:null,key:''}];
  const width=rx.triple?150:CFG.p.beam;
  for(let i=0;i<prem.length;i++){
    const m=prem[i], nx=[];
    for(const st of beam) for(const o of sets[i]){
      if(!rx.anyOrder&&(rx.nonStrict?o.value<st.last:o.value<=st.last)) continue;
      if(rx.repeat){ if(st.o&&o.items.some(it=>ids(st.o).includes(it.id))) continue; }
      else if(o.items.some(it=>inChain(st,it.id))) continue;
      nx.push({s:st.s+Math.abs(o.value-m.V)/m.V,last:o.value,parent:st,o,key:st.key+'|'+ids(o).join(',')});
    }
    if(!nx.length) return null;
    nx.sort((a,b)=>(a.s-b.s)||(b.last-a.last)||(a.key<b.key?-1:a.key>b.key?1:0));
    beam=nx.slice(0,width);
  }
  const best=pathIds(beam[0]).length?(()=>{ const arr=[]; for(let x=beam[0];x&&x.o;x=x.parent) arr.unshift(x.o); return arr; })():[];
  const usedAll=new Set(best.flatMap(ids));
  return prem.map((m,i)=>{
    const lo=i?best[i-1].value:0, hi=i<best.length-1?best[i+1].value:Infinity, mine=new Set(ids(best[i]));
    const alts=sets[i].filter(o=>o.value>lo&&o.value<hi&&ids(o).join()!==ids(best[i]).join()&&!ids(o).some(x=>usedAll.has(x)&&!mine.has(x)))
      .sort((a,b)=>(Math.abs(a.value-m.V)-Math.abs(b.value-m.V))||(a.items.length-b.items.length)||(a.cost-b.cost)).slice(0,2);
    return {m,o:best[i],alts};
  });
}

function chooseRecurring(A,last,inv,cands){
  const p=CFG.p, V=p.vb*p.loopA*A, cap=inv*p.loopA*A*(1+p.tol);
  const all=options(cands).filter(o=>o.cost<=cap+1e-9);
  let fit=all.filter(o=>o.value>=last&&o.value<=p.cap*V); if(!fit.length) fit=all;
  fit.sort((a,b)=>(Math.abs(a.value-V)-Math.abs(b.value-V))||(a.items.length-b.items.length)||(a.cost-b.cost)||cmpLists([ids(a)],[ids(b)]));
  return {every:roundTo(A*p.loopA,p.round),o:fit[0]};
}

// Regalo de cumpleaños por nivel: del catálogo, cada nivel mejor que el anterior. (Sin regalo de aniversario: decisión de socios.)
function chooseTierGifts(cands,T){
  const out={}; let lastB=0,lastA=0;
  for(const t of CFG.tiers){
    const tb=CFG.tierBenefits[t]; out[t]={};
    for(const kind of ["birthday","anniversary"]){
      const spec=tb[kind]; if(!spec) continue;
      const V=spec.v*T, cap=spec.c*T, last=kind==="birthday"?lastB:lastA;
      const taken=kind==="anniversary"&&out[t].birthday?new Set(ids(out[t].birthday)):new Set();
      const gc=cands.filter(c=>CFG.p.giftCats.includes(c.cat)).map(c=>({items:[c],value:c.value,cost:c.cost}));
      let pool=gc.filter(o=>o.cost<=cap+1e-9&&o.value>last&&!ids(o).some(x=>taken.has(x)));
      if(!pool.length) pool=gc.filter(o=>o.cost<=cap+1e-9&&!ids(o).some(x=>taken.has(x)));
      if(!pool.length) continue;
      pool.sort((a,b)=>(Math.abs(a.value-V)-Math.abs(b.value-V))||(a.items.length-b.items.length)||(a.cost-b.cost)||cmpLists([ids(a)],[ids(b)]));
      out[t][kind]=pool[0];
      if(kind==="birthday") lastB=pool[0].value; else lastA=pool[0].value;
    }
  }
  return out;
}

// Referidos escalados: premio al 1.º, 3.º, 5.º, 7.º y 10.º referido que hace su primer pago.
function chooseReferral(cands,est,objRef,newYear){
  const P=CFG.p, T=est.ticket, opts=options(cands,false), used=new Set(); let last=0,prevN=0,cum=0; const out=[];
  for(const st of P.refSteps){
    const V=st.v*T*objRef, cap=P.refInv*newYear*(st.n-prevN);
    let pool=opts.filter(o=>o.cost<=cap+1e-9&&o.value>last&&!ids(o).some(x=>used.has(x)));
    if(!pool.length) pool=opts.filter(o=>o.cost<=cap+1e-9&&o.value>=last);
    if(!pool.length) pool=opts;
    pool.sort((a,b)=>(Math.abs(a.value-V)-Math.abs(b.value-V))||(a.items.length-b.items.length)||(a.cost-b.cost)||cmpLists([ids(a)],[ids(b)]));
    const o=pool[0]; ids(o).forEach(x=>used.add(x)); last=o.value; cum+=o.cost; prevN=st.n;
    out.push({n:st.n,V,cap,o,name:o.items.map(i=>i.name).join(" y "),cumCost:cum,revenue:st.n*newYear});
  }
  return out;
}
function tierAnnualCost(t,gifts,A){
  const tb=CFG.tierBenefits[t], p=CFG.p, g=gifts[t]||{};
  const b=g.birthday?g.birthday.cost:0, a=g.anniversary?g.anniversary.cost:0;
  const ev=tb.events*p.eventCost*p.eventAttendance, te=tb.tests?p.testCost:0;
  const disc=tb.discount*p.cosmeticShareOfSpend*A*tb.mult; // descuento sobre compras de cosmética
  return {birthday:b,anniversary:a,events:ev,tests:te,discount:disc,total:b+a+ev+te+disc};
}

function run(items, ans){
  const cls=classify(items);
  const est=estimate(cls,ans); if(est.error) return {error:est.error,catalog:cls};
  let lad=buildLadder(est,ans,false); const cands=candidates(cls,ans);
  // Si no hay solución, relajaciones en orden fijo (el programa queda marcado para revisión).
  const P=CFG.p, steps=[
    ["ninguna",{capMult:P.cap,earlyAll:false,nonStrict:false,tol:P.tol}],
    // Antes de repetir premios o meter tratamientos en el primer tramo, se amplía el margen de valor y de presupuesto.
    ["sin_aviso",{capMult:P.cap,earlyAll:false,nonStrict:false,tol:0.3}],
    ["sin_aviso",{capMult:P.cap,earlyAll:false,nonStrict:false,tol:0.5}],
    ["sin_aviso",{capMult:3,earlyAll:false,nonStrict:false,tol:P.tol}],
    ["sin_aviso",{capMult:3,earlyAll:false,nonStrict:false,tol:0.3}],
    ["sin_aviso",{capMult:3,earlyAll:false,nonStrict:false,tol:0.5}],
    ["sin_aviso",{capMult:3,earlyAll:false,nonStrict:true,tol:0.5}],
    ["sin_aviso",{capMult:P.cap,earlyAll:true,nonStrict:false,tol:P.tol}],
    ...(cands.length<25?[["sin_aviso",{capMult:P.cap,earlyAll:true,nonStrict:false,tol:P.tol,repeat:true}],["sin_aviso",{capMult:3,earlyAll:true,nonStrict:false,tol:P.tol,repeat:true}]]:[]),
    ["tope de valor 3x",{capMult:3,earlyAll:true,nonStrict:false,tol:P.tol}],
    ["premios iguales permitidos",{capMult:3,earlyAll:true,nonStrict:true,tol:P.tol}],
    ["artículos repetidos (nunca en premios seguidos)",{capMult:3,earlyAll:true,nonStrict:true,tol:P.tol,repeat:true}],
    ["tolerancia de presupuesto del 50%",{capMult:3,earlyAll:true,nonStrict:true,tol:0.5,repeat:true}],
    ["tolerancia de presupuesto del 100%",{capMult:3,earlyAll:true,nonStrict:true,tol:1.0,repeat:true}],
    ["packs de tres",{capMult:3,earlyAll:true,nonStrict:true,tol:0.5,repeat:true,triple:true}],
    ["packs de tres",{capMult:5,earlyAll:true,nonStrict:true,tol:1.0,repeat:true,triple:true}],
    ["premios sin orden creciente",{capMult:5,earlyAll:true,nonStrict:true,tol:1.0,repeat:true,anyOrder:true}]];
  let chosen=null, used=null, floorUsed=false;
  outer: for(const [label,rx] of steps){
    for(const useFloor of [false,true]){
      lad=buildLadder(est,ans,useFloor); if(useFloor&&!lad.floorApplied) continue; chosen=chooseRewards(lad.ms,cands,rx);
      if(chosen){ used={label,rx}; floorUsed=useFloor; break outer; }
    }
  }
  if(chosen){ // Bronce: el mejor premio es el primero, para enganchar desde la primera visita; los demás siguen de menor a mayor.
    const b1=chosen.filter(c=>c.m.tramo===1), asc=b1.map(c=>({o:c.o,alts:c.alts})).sort((x,y)=>x.o.value-y.o.value);
    const ord=[asc[asc.length-1],...asc.slice(0,-1)]; b1.forEach((c,i)=>{ c.o=ord[i].o; c.alts=ord[i].alts; });
  }
  if(!chosen) return {error:"Con este catálogo no se puede montar una escalera de premios. Añade más tratamientos, cosmética o extras baratos (presoterapia, ampollas, mejoras).",catalog:cls,est};
  const rec=chooseRecurring(est.A,chosen[chosen.length-1].o.value,lad.inv,cands);
  const gifts=chooseTierGifts(cands,est.ticket);
  const perks=choosePerks(lad.ms,cls,cands,est,lad.inv);
  const perkList=lad.ms.filter(m=>m.type==="ventaja"), perkCost=perkList.reduce((s3,m)=>s3+m.perk.cost,0);
  const multOf=t=>CFG.tierBenefits[t].mult;
  const tierDuring=k=>CFG.tiers[k-1];
  let real=0,prevProg=0; const realTh={};
  for(const m of lad.ms){ const mult=multOf(tierDuring(m.tramo)); real+=(m.th-prevProg)/mult; prevProg=m.th; realTh[m.n]=real; }
  const A=est.A, p=CFG.p;
  const activeClients=CFG.members.find(x=>x.id===ans.members)?.value ?? 400;
  const members=Math.max(1,Math.round(activeClients*p.adhesion));
  const annual={}; CFG.tiers.forEach(t=>annual[t]=tierAnnualCost(t,gifts,A));
  let val=0,cost=0,benef=0,prevYears=0,tierNow="bronce"; const rows=[];
  for(const m of lad.ms){
    const spent=realTh[m.n], years=spent/A;
    benef+=annual[tierNow].total*(years-prevYears); prevYears=years;
    const c=chosen.find(x=>x.m.n===m.n); if(c){val+=c.o.value;cost+=c.o.cost;} if(m.type==="ventaja") cost+=m.perk.cost;
    const margin=spent*p.margin, fee=p.feeBySegment[est.segment]*12*years/members;
    rows.push({m,spent,years,val,cost,benef,margin,fee,net:margin-cost-benef-fee});
    if(m.type==="nivel") tierNow=m.tier;
  }
  // Lo que genera el programa (vista anual, con dos tipos de socia):
  // repetidoras (vienen varias veces y gastan A al año) y ocasionales (1,3 visitas al año).
  const totalCost0=chosen.reduce((s3,c)=>s3+c.o.cost,0)+perkCost, costPctL=totalCost0/realTh[lad.last.n];
  const occSpend=p.occVisits*est.ticket, s0=p.repeatShare, s1=Math.min(0.95,s0+p.uplift);
  const lifeRep=1/(1-p.repeatRetention);
  let occPrem=0; for(const c of chosen) if(realTh[c.m.n]<=occSpend) occPrem+=c.o.cost;
  for(const m of perkList) if(realTh[m.n]<=occSpend) occPrem+=m.perk.cost;
  // Reparto de las repetidoras por antigüedad: cada año sigue el 75% de las del año anterior.
  const perkOf=m=>m.type==="ventaja"?m.perk.cost:0, rewardOf=m=>{const c=chosen.find(x=>x.m.n===m.n); return c?c.o.cost:0;};
  const yearOfLife=y=>{ let cost=0,count=0; const lo=A*(y-1), hi=A*y;
    for(const m of lad.ms){ const t2=realTh[m.n]; if(t2>lo+1e-9&&t2<=hi+1e-9){ const c2=rewardOf(m)+perkOf(m); if(m.type!=="nivel"){cost+=c2;count++;} } }
    const beyond=Math.max(0,hi-Math.max(lo,realTh[lad.last.n])); if(beyond>0){ const k=beyond*CFG.tierBenefits.diamante.mult/rec.every; cost+=k*rec.o.cost; count+=k; }
    return {cost,count}; };
  const tierAt=sp=>{ let t3="bronce"; for(const m of lad.ms) if(m.type==="nivel"&&realTh[m.n]<=sp) t3=m.tier; return t3; };
  const dist={}; CFG.tiers.forEach(t=>dist[t]=0); let wsum=0; const dist1={}; CFG.tiers.forEach(t=>dist1[t]=0);
  for(let mth=0;mth<120;mth++){ const w=Math.pow(p.repeatRetention,Math.floor(mth/12)), t3=tierAt(A*mth/12); dist[t3]+=w; wsum+=w; if(mth<12) dist1[t3]+=1/12; }
  CFG.tiers.forEach(t=>dist[t]/=wsum);
  let rwCost=0,rwCount=0,ysum=0; for(let y=1;y<=10;y++){ const w=Math.pow(p.repeatRetention,y-1), yc=yearOfLife(y); rwCost+=w*yc.cost; rwCount+=w*yc.count; ysum+=w; }
  const repRewardYear=rwCost/ysum, repRewardCount=rwCount/ysum, y1=yearOfLife(1);
  const repBenefYear=CFG.tiers.reduce((s3,t)=>s3+dist[t]*annual[t].total,0), repBenefYear1=CFG.tiers.reduce((s3,t)=>s3+dist1[t]*annual[t].total,0);
  let occCount=0; for(const m of lad.ms) if(m.type!=="nivel"&&realTh[m.n]<=occSpend) occCount++;
  const newYear=s0*A+(1-s0)*occSpend;
  const refLad=chooseReferral(cands,est,CFG.objectives[ans.objective].ref*(CFG.occupancy[ans.occupancy]||CFG.occupancy.o2).ref,newYear), referral=refLad[0];
  const welcome=Math.round(lad.ms[0].th*0.5/5)*5;
  const refNew=members*p.refShare, refRevenue=refNew*newYear, refCostYear=refNew*(refLad[0].o.cost*p.redemption+welcome*costPctL);
  const redemptions=members*(s1*repRewardCount+(1-s1)*occCount)*p.redemption;
  const incRedeem=redemptions*p.redeemVisitShare*est.ticket;    // canjes que traen una visita de pago que no habría existido
  const incRetention=members*(s1-s0)*(A-occSpend);          // ocasionales que pasan a repetir
  const incSpend=members*s1*A*p.spendUplift;                  // las repetidoras gastan algo más por visita
  const incRevenue=incRetention+incSpend+incRedeem+refRevenue, incMargin=incRevenue*p.margin;
  const costRewards=members*(s1*repRewardYear + (1-s1)*occPrem)*p.redemption;
  const costBenefits=members*(s1*repBenefYear + (1-s1)*annual.bronce.total*p.occRedemption);
  const monthlyFee=p.feeBySegment[est.segment]; const costFee=12*monthlyFee;
  const costAll=costRewards+costBenefits+costFee+refCostYear, netYear=incMargin-costAll;
  const costRewards1=members*(s1*y1.cost+(1-s1)*occPrem)*p.redemption, costBenefits1=members*(s1*repBenefYear1+(1-s1)*annual.bronce.total*p.occRedemption);
  const red1=members*(s1*y1.count+(1-s1)*occCount)*p.redemption*p.redeemVisitShare*est.ticket;
  const netYear1=incRetention+incSpend+red1+refRevenue-costRewards1-costBenefits1-costFee-refCostYear;
  const repeaters=members*s1, occasionals=members*(1-s1);
  const breakEvenPP=Math.max(0,(costAll-incSpend*p.margin)/(members*p.margin*(A-occSpend)));
  const memberSpend=members*(s1*A+(1-s1)*occSpend);
  const totalCost=chosen.reduce((s3,c)=>s3+c.o.cost,0)+perkCost, diamondReal=realTh[lad.last.n];
  const costPct=totalCost/diamondReal, yearsD=diamondReal/A;

  // Adaptaciones: cómo se ha ajustado el sistema a las respuestas y al catálogo (no son errores).
  const adapt=[], rx=used.rx;
  if(floorUsed) adapt.push("Los primeros premios reciben algo más de presupuesto para que quepan regalos de bienvenida con tu catálogo.");
  if(rx.earlyAll && chosen.filter(c=>c.m.early).some(c=>c.o.items.some(i=>!CFG.categories[i.cat].early))) adapt.push("En el camino a Plata se usan también tratamientos, porque la cosmética y los extras de tu catálogo no encajan en ese presupuesto.");
  if(rx.repeat && new Set(chosen.flatMap(c=>ids(c.o))).size<chosen.flatMap(c=>ids(c.o)).length) adapt.push("Como tu catálogo tiene pocos regalos posibles, alguno se repite en la escalera, nunca en dos hitos seguidos.");
  if(rx.nonStrict && chosen.some((c,i)=>i&&c.o.value===chosen[i-1].o.value)) adapt.push("Algunos premios seguidos tienen el mismo valor, porque no hay un regalo mayor que quepa en ese presupuesto.");
  if(rx.capMult>p.cap && chosen.some(c=>c.o.value>p.cap*c.m.V)) adapt.push("Algunos premios valen más de lo previsto para su coste: son regalos con coste casi nulo para el centro.");
  if(rx.triple && chosen.some(c=>c.o.items.length===3)) adapt.push("Los premios más altos combinan tres tratamientos, para que su valor esté a la altura del gasto de tus clientas.");
  if(rx.tol>p.tol && chosen.some(c=>c.o.cost>c.m.cap+1e-9)) adapt.push(`Algunos premios usan algo más de su presupuesto individual; el coste total queda en el ${(costPct*100).toFixed(1).replace(".",",")}% del gasto.`);

  // Solo se pide revisión si algo no tiene sentido.
  const review=[];
  const unc=cls.filter(i=>i.review).length;
  if(unc) review.push(`Hay ${unc} ${unc===1?"fila":"filas"} del catálogo sin categoría. Clasifícalas en la tabla.`);
  const aRatio=est.A/est.AEst;
  if(aRatio>3||aRatio<1/3) review.push(`Con tus respuestas, una clienta gastaría ${eurTxt(est.A)} al año, pero tus precios y tratamientos apuntan a unos ${eurTxt(est.AEst)}. Comprueba el ticket y la frecuencia.`);
  else if(rx.anyOrder) review.push("Con este catálogo los premios no pueden ir de menor a mayor. Añade tratamientos o productos de más valor.");
  if(costPct>lad.inv*1.5) review.push("El coste de los premios supera en más de un 50% la inversión elegida. Sube la inversión o añade regalos más baratos.");
  if(lad.visitsSilver<p.visitsSilver) adapt.push(`Como tus clientas vienen poco a menudo, Plata se alcanza con ${String(Math.round(lad.visitsSilver*10)/10).replace('.',',')} visitas y Diamante en unos ${String(Math.round(yearsD*10)/10).replace('.',',')} años, para que la escalera no se haga eterna.`);
  else if(lad.Y>p.years+0.01) adapt.push(`Como tus clientas vienen poco a menudo, Diamante se alarga a unos ${String(Math.round(yearsD*10)/10).replace('.',',')} años para mantener Plata en ${p.visitsSilver} visitas.`);
  if(yearsD<2.5||yearsD>8) review.push("El tiempo hasta Diamante sale fuera de lo razonable. Revisa ticket y frecuencia.");

  const guarantees=[
    ["El primer premio llega en la primera visita",lad.ms[0].th<=est.ticket],
    [`Plata se alcanza con ${String(Math.round(lad.visitsSilver*10)/10).replace('.',',')} visitas`,true],
    [`Cada nivel cuesta al menos ${String(p.minGrowth).replace(".",",")} veces el anterior (aquí ×${lad.R.toFixed(2).replace(".",",")})`,lad.R>=p.minGrowth-1e-9],
    [`Nunca pasan más de ${String(p.maxVisitsBetween).replace(".",",")} visitas sin un premio, una ventaja o una subida de nivel`,true],
    ["Todo premio o ventaja se canjea en una visita de pago o en una sesión de un bono ya pagado, en un máximo de 60 días",true],
    ["En Bronce el mejor premio es el primero",(()=>{const b1=chosen.filter(c=>c.m.tramo===1);return b1.every(c=>c.o.value<=b1[0].o.value);})()],
    ["Cada nivel incluye una ventaja de puntos dobles",[1,2,3,4].every(tr=>lad.ms.some(m=>m.tramo===tr&&m.perk&&m.perk.kind==="doble"))],
    ["Los bonos suman puntos en cada sesión consumida, no al comprarlos",true],
    ["Subir de nivel exige antigüedad mínima (Oro 12, Platino 24 y Diamante 36 meses)",true],
    ["Ningún regalo se repite en dos hitos seguidos",chosen.every((c,i)=>!i||!ids(c.o).some(x=>ids(chosen[i-1].o).includes(x)))],
    [`Premios y ventajas cuestan el ${(costPct*100).toFixed(1).replace(".",",")}% del gasto de la clienta`,costPct<=lad.inv*1.5]
  ];
  const refTarget=CFG.segments[est.segment].ref*est.ticket*CFG.objectives[ans.objective].ref;
  return {catalog:cls,est,lad,chosen,rec,gifts,annual,realTh,rows,members,guarantees,adapt,review,referral,refTarget,floorUsed,
    refLad,newYear,welcome,
    program:{incRedeem,redemptions,dist,dist1,repRewardYear,repRewardCount,y1,occPrem,occCount,netYear1,repeaters,occasionals,refNew,refRevenue,refCostYear,monthlyFee,s0,s1,occSpend,incRetention,incSpend,incRevenue,incMargin,costRewards,costBenefits,costFee,costAll,netYear,breakEvenPP,memberSpend,repBenefYear,lifeRep},
    totalCost,perkCost,perks,diamondReal,costPct,cands};
}
if(typeof module!=="undefined") module.exports={run,CFG};

