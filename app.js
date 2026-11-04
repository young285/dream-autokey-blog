'use strict';
/* 드림 자동차키 블로그 관리. 원고·사진은 이 브라우저 IndexedDB에만 둔다.
   저장소에 고객 원고를 심어 두지 않는다. */
const $=id=>document.getElementById(id);
const DB_NAME='dream_blog_main_v1';
const STORE='posts';
const SETTINGS_KEY='dream_blog_main_settings_v1';
const BACKUP_AT_KEY='dream_blog_last_backup_at';
const SNOOZE_KEY='dream_blog_backup_snooze_until';
const MIGRATED_KEY='dream_blog_main_migrated_v1';
const CLOUD_FLAG='dream_blog_cloud_on';
const SUPABASE_URL='https://hsoolcglsnmvglmmtzvx.supabase.co';
const SUPABASE_KEY='sb_publishable_Gjy-SW4ZSb1SNGggP2Prlw_6t_mDP8n';
const DEFAULT_SETTINGS={
  business:'드림 자동차키',
  phone:'010-3004-0452',
  quoteText:'자동차키 무료견적 문의\n차량명 / 연식 / 현재 보유한 키 개수 / 지역을 알려주시면 작업 가능 여부와 견적을 안내해드립니다.',
  autoBackup:true,
  backupDays:3
};

let db, posts=[], settings={...DEFAULT_SETTINGS};
let editingId=null, photos=[], photoHashes=[], marked=[];
let templateCursor=0, bodyGenerated=false, currentFilter='all';
let cloud=null, cloudUser=null;
let calendarMonth='';

const STATUS_LABEL={draft:'초안',completed:'완성본',posted:'게시 완료',archived:'보관함'};

function esc(v){return String(v??'');}
function uid(){return 'p_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);}
function todayISO(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function quoteUrl(){return new URL('quote.html', location.href).href;}
function telHref(phone){const n=String(phone||'').replace(/[^0-9+]/g,'');return n?`tel:${n}`:'';}
function loadSettings(){
  try{settings={...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')};}
  catch{settings={...DEFAULT_SETTINGS};}
}
function saveSettings(){localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));}

function openDB(){
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB_NAME,1);
    r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE,{keyPath:'id'});};
    r.onsuccess=()=>{db=r.result;resolve(db);};
    r.onerror=()=>reject(r.error);
  });
}
function localAll(){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readonly');
    const q=tx.objectStore(STORE).getAll();
    q.onsuccess=()=>resolve(q.result||[]);
    q.onerror=()=>reject(q.error);
  });
}
function localPut(p){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite');
    const q=tx.objectStore(STORE).put(p);
    q.onsuccess=()=>resolve();
    q.onerror=()=>reject(q.error);
  });
}
function localDelete(id){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite');
    const q=tx.objectStore(STORE).delete(id);
    q.onsuccess=()=>resolve();
    q.onerror=()=>reject(q.error);
  });
}
async function refreshPosts(){
  posts=(await localAll()).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
}

const LEGACY_DB_NAMES=['dream_blog_v2','dream_blog_rescue_v4','dream_blog_rescue','dream_blog','dream_blog_main_v1'];

function looksLikePost(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  if(value.id==null||String(value.id).trim()==='')return false;
  return ['title','body','car'].some(key=>typeof value[key]==='string'&&value[key].trim());
}
function photoList(value){
  if(!Array.isArray(value))return [];
  return value.map(item=>{
    if(typeof item==='string')return item;
    if(item&&typeof item==='object')return item.dataUrl||item.src||item.url||'';
    return '';
  }).filter(Boolean);
}
function normalizeIncomingPost(value){
  if(!looksLikePost(value))return null;
  return {
    ...value,
    id:value.id,
    title:value.title||'',
    body:value.body||'',
    car:value.car||'',
    photos:photoList(value.photos),
    markedPhotos:photoList(value.markedPhotos),
    photoHashes:Array.isArray(value.photoHashes)?value.photoHashes.map(hash=>String(hash||'')):[],
    quoteCta:typeof value.quoteCta==='string'?value.quoteCta:''
  };
}
function postStamp(post){return String(post?.updatedAt||post?.createdAt||'');}
function parseJsonLoose(raw){
  if(typeof raw!=='string')return raw;
  try{
    const once=JSON.parse(raw);
    if(typeof once==='string'){try{return JSON.parse(once);}catch{return once;}}
    return once;
  }catch{return null;}
}
function collectPosts(value, into, source, depth=0){
  if(value==null||depth>4)return;
  if(Array.isArray(value)){
    if(value.some(looksLikePost)){
      value.forEach(item=>{
        const post=normalizeIncomingPost(item);
        if(post)into.push({post, source});
      });
      return;
    }
    value.forEach(item=>collectPosts(item, into, source, depth+1));
    return;
  }
  if(typeof value!=='object')return;
  const post=normalizeIncomingPost(value);
  if(post){into.push({post, source});return;}
  ['posts','data','items','rows'].forEach(key=>{
    if(value[key]!=null)collectPosts(value[key], into, source, depth+1);
  });
}
function dedupeHits(hits){
  const map=new Map();
  hits.forEach(hit=>{
    const id=String(hit.post.id);
    const prev=map.get(id);
    if(!prev){map.set(id,{post:hit.post, sources:[hit.source]});return;}
    if(!prev.sources.includes(hit.source))prev.sources.push(hit.source);
    const prevStamp=postStamp(prev.post);
    const nextStamp=postStamp(hit.post);
    const richer=photoList(hit.post.photos).length>photoList(prev.post.photos).length;
    if(nextStamp>prevStamp||(nextStamp===prevStamp&&richer))prev.post=hit.post;
  });
  return [...map.values()];
}
function isCurrentDbSource(source){return source.startsWith(`IndexedDB ${DB_NAME}/`);}
function getAllStore(database, store){
  return new Promise(resolve=>{
    try{
      if(!database.objectStoreNames.contains(store)){resolve([]);return;}
      const tx=database.transaction(store,'readonly');
      const request=tx.objectStore(store).getAll();
      let rows=[];
      request.onsuccess=()=>{rows=request.result||[];};
      tx.oncomplete=()=>resolve(rows);
      tx.onerror=()=>resolve(rows);
      tx.onabort=()=>resolve(rows);
    }catch{resolve([]);}
  });
}
function openIfExists(name){
  return new Promise(resolve=>{
    let settled=false;
    const done=value=>{if(!settled){settled=true;resolve(value);}};
    let created=false;
    let request;
    try{request=indexedDB.open(name);}catch{done(null);return;}
    request.onupgradeneeded=()=>{
      created=true;
      try{request.transaction.abort();}catch{/* already aborting */}
    };
    request.onsuccess=()=>{
      const database=request.result;
      if(created){
        try{database.close();}catch{/* ignore */}
        try{indexedDB.deleteDatabase(name);}catch{/* ignore */}
        done(null);
        return;
      }
      done(database);
    };
    request.onerror=()=>{
      if(created){try{indexedDB.deleteDatabase(name);}catch{/* ignore */}}
      done(null);
    };
    request.onblocked=()=>done(null);
  });
}
async function databaseNamesToScan(){
  try{
    if(typeof indexedDB.databases==='function'){
      const listed=await indexedDB.databases();
      return {listed:true, names:[...new Set((listed||[]).map(info=>info&&info.name).filter(Boolean))]};
    }
  }catch{/* use the known names below */}
  return {listed:false, names:[...LEGACY_DB_NAMES]};
}
async function scanLegacySources(){
  const hits=[];
  const {names}=await databaseNamesToScan();
  for(const name of names){
    let database=null;
    let openedSeparately=false;
    try{
      if(name===DB_NAME&&db)database=db;
      else database=await openIfExists(name);
      if(!database)continue;
      openedSeparately=database!==db;
      const stores=[...database.objectStoreNames];
      for(const store of stores){
        const rows=await getAllStore(database, store);
        const source=`IndexedDB ${name}/${store}`;
        rows.forEach(row=>collectPosts(row, hits, source));
      }
    }catch{/* one unreadable database must not stop the rest */}
    finally{
      if(openedSeparately&&database){try{database.close();}catch{/* ignore */}}
    }
  }
  try{
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);
      if(!key)continue;
      if(key!=='dream_blog_rescue_manager_v1'&&!key.includes('dream_blog'))continue;
      try{collectPosts(parseJsonLoose(localStorage.getItem(key)), hits, `localStorage ${key}`);}
      catch{/* skip this key */}
    }
  }catch{/* localStorage unavailable */}
  return {records:dedupeHits(hits)};
}
async function applyRecovered(records){
  const existing=await localAll();
  const byId=new Map(existing.map(post=>[String(post.id), post]));
  let added=0, replaced=0, skipped=0;
  for(const record of records){
    const post=record.post;
    const old=byId.get(String(post.id));
    if(!old){await localPut(post);byId.set(String(post.id), post);added++;}
    else if(postStamp(post)>postStamp(old)){await localPut({...old, ...post, createdAt:old.createdAt||post.createdAt});replaced++;}
    else skipped++;
  }
  return {added, replaced, skipped};
}
function externalRecords(records){
  return records.filter(record=>record.sources.some(source=>!isCurrentDbSource(source))).map(record=>({
    post:record.post,
    sources:record.sources.filter(source=>!isCurrentDbSource(source))
  }));
}
async function migrateOld(){
  if(localStorage.getItem(MIGRATED_KEY)==='1')return {copied:0, locked:true};
  try{
    const {records}=await scanLegacySources();
    const applied=await applyRecovered(externalRecords(records));
    const copied=applied.added+applied.replaced;
    if(copied>0)localStorage.setItem(MIGRATED_KEY,'1');
    return {copied, ...applied};
  }catch{
    return {copied:0, failed:true};
  }
}
function recoverySummary(records){
  const photos=records.reduce((sum, record)=>sum+(record.post.photos||[]).length, 0);
  const sources=[...new Set(records.flatMap(record=>record.sources))];
  return {photos, sources};
}
async function findOldPosts(){
  const box=$('recoveryResult');
  box.textContent='이 브라우저 안을 살펴보는 중입니다…';
  let records=[];
  try{
    const scanned=await scanLegacySources();
    records=externalRecords(scanned.records);
  }catch{
    box.textContent='찾기에 실패했습니다. 잠시 후 다시 눌러 주세요. 이번 실패로 다음 찾기가 막히지는 않습니다.';
    return;
  }
  const scope='이 휴대폰의 이 브라우저 안만 살펴봤습니다.';
  if(!records.length){
    box.textContent=`이전 원고를 찾지 못했습니다. ${scope} 예전에 받은 JSON 파일은 아래 불러오기로 넣을 수 있습니다.`;
    return;
  }
  const {photos, sources}=recoverySummary(records);
  const found=`원고 ${records.length}건 · 사진 ${photos}장 · ${sources.join(', ')}. ${scope}`;
  box.textContent=found;
  if(!confirm(`이전 원고를 찾았습니다.\n${found}\n앱에 넣을까요?`)){
    box.textContent=`넣지 않았습니다. ${found}`;
    return;
  }
  try{
    const applied=await applyRecovered(records);
    if(applied.added+applied.replaced>0)localStorage.setItem(MIGRATED_KEY,'1');
    await refreshPosts();
    renderList();
    updateBanner();
    box.textContent=`추가 ${applied.added}건 · 교체 ${applied.replaced}건 · 건너뜀 ${applied.skipped}건. ${found}`;
    if(applied.added+applied.replaced>0){
      $('migrationNote').textContent=`이 휴대폰에 남아 있던 이전 원고 ${applied.added+applied.replaced}건을 불러왔습니다.`;
      $('migrationNote').classList.remove('hidden');
    }
  }catch(error){
    box.textContent='넣기에 실패했습니다. '+(error.message||'')+' 다시 찾아도 됩니다.';
  }
}

function cityToken(sido, sigungu){
  const s=String(sido||'');
  const g=String(sigungu||'');
  if(s.startsWith('인천'))return '인천';
  if(s.startsWith('서울'))return '서울';
  if(s.startsWith('부산'))return '부산';
  if(s.startsWith('대구'))return '대구';
  if(s.startsWith('대전'))return '대전';
  if(s.startsWith('광주'))return '광주';
  if(s.startsWith('울산'))return '울산';
  if(s.startsWith('세종'))return '세종';
  if(s.startsWith('제주'))return g.startsWith('서귀포')?'서귀포':'제주';
  if(s.startsWith('경기')){
    const name=g.split(/\s+/)[0].replace(/(시|군|구)$/,'');
    return name||'경기';
  }
  return g.replace(/(시|군|구)$/,'').split(/\s+/)[0]||s.replace(/(특별시|광역시|특별자치시|특별자치도|도)$/,'');
}
function formContext(){
  const sido=$('sido').value, sigungu=$('sigungu').value, dong=$('dong').value, detail=$('region').value.trim();
  const city=cityToken(sido, sigungu);
  const area=dong||sigungu||city;
  const parts=[sido,sigungu,dong,detail].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i);
  return {
    car:$('car').value.trim(),
    year:$('year').value.trim(),
    work:$('work').value.trim(),
    reason:$('reason').value.trim(),
    equipment:$('equipment').value.trim(),
    result:$('result').value.trim(),
    sido, sigungu, dong, detail, city, area,
    place:parts.join(' ')
  };
}
function searchKeyword(city){
  if(city==='인천')return '인천 스마트키 복사';
  if(city)return `${city} 스마트키 복사`;
  return '스마트키 복사';
}
function makeTitles(ctx){
  const kw=searchKeyword(ctx.city);
  const car=ctx.car||'차량';
  const loc=(ctx.dong||ctx.area||ctx.city||'출장').replace(/\s+/g,' ').trim();
  const yr=ctx.year?`${ctx.year}년식 `:'';
  const job=ctx.work||'스마트키 작업';
  const pattern=`${loc} ${car} 스마트키 복사`.replace(/\s+/g,' ').trim();
  const raw=[
    `${kw} | ${loc} ${yr}${car} ${job}`,
    `${pattern} | ${job}`,
    `${ctx.city||loc} ${car} 스마트키 복사 | ${yr}${loc} 출장`.trim(),
    `${kw} | ${car} 예비키 ${loc}`,
    `${loc} ${yr}${car} 차키 복사 | ${kw}`,
    `${pattern} | ${ctx.city||'출장'} 현장`,
    `${kw} | ${loc} ${car} 추가 등록`,
    `${yr}${car} ${job} | ${kw}`,
    `${loc} 자동차키 ${car} | ${kw}`,
    `${ctx.city||loc} ${job} ${car} | 스마트키 복사`
  ];
  const out=[];
  for(const t of raw){
    const s=t.replace(/\s+/g,' ').replace(/\s+\|/g,' |').trim();
    if(s&&!out.includes(s))out.push(s);
  }
  let n=2;
  while(out.length<10)out.push(`${kw} | ${loc} ${car} 작업 후기 ${n++}`);
  return out.slice(0,10);
}
function titleSimilarity(a,b){
  const n=x=>String(x||'').toLowerCase().replace(/[^가-힣a-z0-9]/g,'');
  a=n(a);b=n(b);
  if(!a||!b)return 0;
  if(a===b)return 100;
  const A=new Set(a.match(/.{1,2}/g)||[]), B=new Set(b.match(/.{1,2}/g)||[]);
  let i=0;A.forEach(x=>{if(B.has(x))i++;});
  return Math.round(i/Math.max(1,Math.min(A.size,B.size))*100);
}
function bestTitleDup(t){
  let best=0;
  for(const p of posts){
    if(p.id===editingId)continue;
    best=Math.max(best, titleSimilarity(t, p.title));
  }
  return best;
}
function renderTitleSuggestions(opts){
  const box=$('titleSuggestions');
  box.replaceChildren();
  opts.forEach(t=>{
    const row=document.createElement('div');
    row.className='title-option';
    const b=document.createElement('button');
    b.type='button';
    b.className='title-pick';
    b.textContent=t;
    b.addEventListener('click',()=>{$('title').value=t;});
    const d=bestTitleDup(t);
    const sig=document.createElement('span');
    sig.className='signal '+(d>=80?'bad':d>=55?'warn':'ok');
    sig.textContent=d>=80?'중복 높음':d>=55?'비슷함':'추천';
    row.append(b,sig);
    box.append(row);
  });
}

function reasonLine(ctx, styles){
  if(ctx.reason)return styles.reason(ctx.reason);
  return styles.fallback;
}
const BODY_TEMPLATES=[
  ctx=>{
    const yr=ctx.year?`${ctx.year}년식 `:'';
    const place=ctx.place||ctx.city||'인천';
    const car=ctx.car||'차량';
    const job=ctx.work||'스마트키 작업';
    return [
      `안녕하세요. ${place}에서 자동차키·스마트키 작업을 하는 ${settings.business}입니다. 오늘은 ${yr}${car} ${job} 과정을 정리했습니다.`,
      reasonLine(ctx,{reason:r=>`요청 내용은 ${r}입니다. 차종과 연식, 지금 가진 키 상태를 먼저 맞춘 뒤 작업 범위를 정했습니다.`,fallback:'키 외형이 같아도 등록 방식은 연식마다 달라서, 차량 정보를 확인한 다음 진행했습니다.'}),
      ctx.equipment?`진행 내용은 ${ctx.equipment}입니다. 기존 키가 있으면 그 인식 상태도 함께 봤습니다.`:'등록 순서는 차량 통신 상태를 보면서 맞췄고, 기존 키가 있으면 그 기능이 유지되는지도 같이 확인했습니다.',
      ctx.result?`마무리 점검은 ${ctx.result}입니다.`:'작업 뒤에는 문 잠금과 열림, 스마트키 인식, 시동을 차에서 직접 확인했습니다.',
      `${place}처럼 출장으로 진행하면 차량을 따로 옮기지 않고 그 자리에서 기능 확인까지 할 수 있습니다. 같은 차종도 키 사양에 따라 가능 여부가 달라집니다.`,
      `예비키는 분실 전에 만들어 두는 편이 시간과 비용을 줄입니다.\n${settings.quoteText}\n☎ ${settings.phone}\n무료견적: ${quoteUrl()}`
    ];
  },
  ctx=>{
    const yr=ctx.year?`${ctx.year} `:'';
    const place=ctx.place||ctx.city||'인천';
    const car=ctx.car||'차량';
    const job=ctx.work||'스마트키 작업';
    return [
      `${place} 출장 기록입니다. 차량은 ${yr}${car}이고, 작업은 ${job}입니다. ${settings.business}가 현장에서 확인한 내용만 적습니다.`,
      ctx.reason?`고객 사정은 ${ctx.reason}이었습니다. 이야기만으로 방식을 정하지 않고 차량에서 키 상태를 다시 봤습니다.`:'방문 전에는 차종·연식·지역만 받아 두고, 현장에서는 실제 키 개수와 작동을 다시 확인했습니다.',
      ctx.equipment?`사용한 절차는 ${ctx.equipment}입니다.`:'차종에 맞는 등록 절차로 진행했고, 중간에 기존 키가 있으면 잠금과 시동이 살아 있는지도 봤습니다.',
      ctx.result?`확인 결과는 ${ctx.result}입니다. 화면 완료만 보지 않고 차 옆에서 한 번 더 작동시켰습니다.`:'도어 잠금, 열림, 트렁크, 시동 순서로 차량 옆에서 다시 점검했습니다.',
      `스마트키 한 개만 쓰면 분실 때 차가 바로 멈추는 경우가 있습니다. 키가 있을 때 예비키를 마련해 두면 대응이 수월합니다.`,
      `견적이 필요하면 차종, 연식, 키 개수, 지역을 알려 주세요.\n☎ ${settings.phone}\n${quoteUrl()}`
    ];
  },
  ctx=>{
    const yr=ctx.year?`${ctx.year}년식 `:'';
    const place=ctx.place||ctx.city||'인천';
    const car=ctx.car||'차량';
    const job=ctx.work||'스마트키 작업';
    return [
      `${yr}${car} ${job} 문의가 ${place}에서 들어왔습니다. 같은 이름이라도 연식에 따라 키가 달라 현장 확인이 먼저입니다.`,
      ctx.reason?`이번 요청은 ${ctx.reason}입니다.`:'보유 키 수와 작동 여부를 듣고, 차에서 한 번 더 대조했습니다.',
      `작업 중에는 배터리 상태와 기존 키 기능을 같이 봅니다. ${ctx.equipment?`이번 과정은 ${ctx.equipment}입니다.`:'등록 방식은 그 차량 사양에 맞췄습니다.'}`,
      ctx.result?`끝난 뒤 ${ctx.result}을 확인했습니다.`:'등록이 끝났다고 화면만 믿지 않고, 차에서 떨어진 상태와 가까운 상태를 나눠 잠금·시동을 점검했습니다.',
      `가족이 함께 타는 차라면 예비키가 있을 때 일정이 덜 꼬입니다. ${place} 기준으로 출장 가능 여부는 지역과 차종을 같이 봐야 합니다.`,
      `${settings.business} 무료견적\n${settings.quoteText}\n전화 ${settings.phone}\n${quoteUrl()}`
    ];
  },
  ctx=>{
    const yr=ctx.year?`${ctx.year}년식 `:'';
    const place=ctx.place||ctx.city||'인천';
    const car=ctx.car||'차량';
    const job=ctx.work||'스마트키 작업';
    return [
      `차 키는 한 개만 두고 타다가 분실하면 일정 전체가 멈춥니다. ${place}에서 ${yr}${car} 차량, 작업은 ${job}입니다.`,
      ctx.reason?`연락 주신 이유는 ${ctx.reason}입니다. 그 내용을 기준으로 가능 범위를 먼저 설명드렸습니다.`:'가능 여부는 차종과 연식, 지금 키가 몇 개인지에 따라 달라져서 그 세 가지를 먼저 맞춥니다.',
      ctx.equipment?`현장 진행은 ${ctx.equipment}로 정리됩니다.`:'전용 절차로 등록하고, 작업 도중 기존 키가 있으면 그 키가 그대로 쓰이는지 확인했습니다.',
      ctx.result?`차량 확인은 ${ctx.result}까지 봤습니다.`:'문 잠금과 해제, 스마트키 감지, 시동을 하나씩 눌러 보고 전달했습니다.',
      `다음에 대비하려면 사용 중인 키가 있을 때 예비키를 만드는 편이 낫습니다. ${car}도 연식과 옵션에 따라 준비 과정이 달라질 수 있습니다.`,
      `지역·차종·연식·키 상태를 남기시면 가능 여부와 견적을 안내합니다.\n☎ ${settings.phone}\n무료견적 페이지 ${quoteUrl()}`
    ];
  }
];
function withPhotos(paragraphs, count){
  const out=[];
  paragraphs.forEach((p,i)=>{
    if(i<count)out.push(`[사진 ${i+1}]\n${p}`);
    else out.push(p);
  });
  for(let i=paragraphs.length;i<count;i++)out.push(`[사진 ${i+1}]`);
  return out.join('\n\n');
}
function buildTags(ctx){
  const compact=v=>String(v||'').replace(/\s+/g,'').replace(/[^가-힣a-zA-Z0-9]/g,'');
  const kw=compact(searchKeyword(ctx.city));
  const arr=[kw, compact((ctx.place||'')+'스마트키'), compact((ctx.car||'')+'스마트키'), compact((ctx.car||'')+(ctx.work||'')), compact(ctx.work), compact((ctx.city||'')+'자동차키'), '스마트키복사','스마트키추가','자동차키','차키복사','예비키','출장스마트키','드림자동차키'];
  return [...new Set(arr.filter(x=>x&&x.length>1))].slice(0,20).map(x=>'#'+x).join(' ');
}
function applyDraft(force){
  const ctx=formContext();
  if(!ctx.car||!ctx.work){alert('차량명과 작업 종류를 먼저 입력해 주세요.');return false;}
  if(!force && !bodyGenerated && ['title','body','tags'].some(id=>$(id).value.trim())){
    if(!confirm('제목·본문·태그를 새 초안으로 바꿀까요? 저장 전까지는 보관함에 반영되지 않습니다.'))return false;
  }
  const titles=makeTitles(ctx);
  $('title').value=titles[0];
  renderTitleSuggestions(titles);
  const paragraphs=BODY_TEMPLATES[templateCursor%BODY_TEMPLATES.length](ctx);
  $('body').value=withPhotos(paragraphs, photos.length);
  $('tags').value=buildTags(ctx);
  bodyGenerated=true;
  $('writeStatus').textContent=`초안을 만들었습니다. 문장 유형 ${templateCursor%BODY_TEMPLATES.length+1}/${BODY_TEMPLATES.length}. 사실과 다른 문장은 저장 전에 고쳐 주세요.`;
  return true;
}

function fillSido(){
  const sel=$('sido');
  const current=sel.value;
  sel.replaceChildren(new Option('시·도 선택',''));
  Object.keys(REGIONS).forEach(name=>sel.add(new Option(name,name)));
  if(current)sel.value=current;
}
function fillSigungu(){
  const sel=$('sigungu');
  const current=sel.value;
  sel.replaceChildren(new Option('시·군·구 선택',''));
  Object.keys(REGIONS[$('sido').value]||{}).forEach(name=>sel.add(new Option(name,name)));
  if([...sel.options].some(o=>o.value===current))sel.value=current;
  fillDong();
}
function fillDong(){
  const sel=$('dong');
  const current=sel.value;
  sel.replaceChildren(new Option('읍·면·동 선택',''));
  const list=(REGIONS[$('sido').value]||{})[$('sigungu').value]||[];
  list.forEach(name=>sel.add(new Option(name,name)));
  if([...sel.options].some(o=>o.value===current))sel.value=current;
}

function loadImg(src){
  return new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=()=>no(new Error('image'));i.src=src;});
}
function compressFile(file, maxEdge=1280, quality=0.8){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{
      let w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
      const edge=Math.max(w,h);
      if(edge>maxEdge){const k=maxEdge/edge;w=Math.max(1,Math.round(w*k));h=Math.max(1,Math.round(h*k));}
      const c=document.createElement('canvas');
      c.width=w;c.height=h;
      const x=c.getContext('2d');
      x.fillStyle='#ffffff';
      x.fillRect(0,0,w,h);
      x.drawImage(img,0,0,w,h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('사진을 읽지 못했습니다.'));};
    img.src=url;
  });
}
async function hashImage(src){
  const i=await loadImg(src);
  const c=document.createElement('canvas');
  c.width=9;c.height=8;
  const x=c.getContext('2d',{willReadFrequently:true});
  x.drawImage(i,0,0,9,8);
  const d=x.getImageData(0,0,9,8).data;
  let bits='';
  for(let y=0;y<8;y++){
    for(let xx=0;xx<8;xx++){
      const a=(d[(y*9+xx)*4]+d[(y*9+xx)*4+1]+d[(y*9+xx)*4+2])/3;
      const b=(d[(y*9+xx+1)*4]+d[(y*9+xx+1)*4+1]+d[(y*9+xx+1)*4+2])/3;
      bits+=a>b?'1':'0';
    }
  }
  return bits.match(/.{1,4}/g).map(s=>parseInt(s,2).toString(16)).join('');
}
function hammingHex(a,b){
  if(!a||!b||a.length!==b.length)return 99;
  let n=0;
  for(let i=0;i<a.length;i++){
    const v=parseInt(a[i],16)^parseInt(b[i],16);
    n+=(v&1)+((v>>1)&1)+((v>>2)&1)+((v>>3)&1);
  }
  return n;
}
function photoDupHits(){
  const hits=[];
  photoHashes.forEach((h,i)=>{
    if(!h)return;
    for(let j=0;j<i;j++){
      const dist=hammingHex(h, photoHashes[j]);
      if(dist<=10)hits.push({i, dist, where:`이 글 ${j+1}번 사진`});
    }
    for(const p of posts){
      if(p.id===editingId)continue;
      (p.photoHashes||[]).forEach((old,j)=>{
        const dist=hammingHex(h, old);
        if(dist<=10){
          const when=p.publishDate||String(p.createdAt||'').slice(0,10)||'이전 글';
          const label=[when,p.region,p.car,p.work].filter(Boolean).join(' · ');
          hits.push({i, dist, where:label||`보관 원고 ${j+1}번`});
        }
      });
    }
  });
  return hits;
}
function renderPhotoDup(){
  const box=$('photoDup');
  const hits=photoDupHits();
  box.className='dupbox';
  if(!photoHashes.length){box.textContent='';box.classList.add('hidden');return;}
  box.classList.remove('hidden');
  if(!hits.length){
    box.classList.add('ok');
    box.textContent='사진 중복 없음. 저장해 둔 사진과 겹치지 않습니다.';
    return;
  }
  box.classList.add('bad');
  const lines=hits.slice(0,8).map(h=>`${h.i+1}번 ${h.dist<=8?'같은 사진':'유사 사진'} → ${h.where}`);
  box.textContent='이전에 쓴 사진과 겹칩니다. '+lines.join(' / ');
}
async function markOne(src){
  const i=await loadImg(src);
  const c=document.createElement('canvas');
  c.width=i.naturalWidth;c.height=i.naturalHeight;
  const x=c.getContext('2d');
  x.drawImage(i,0,0,c.width,c.height);
  const phone=$('phone').value.trim()||settings.phone;
  const scale=Number($('phoneSize').value)||0.062;
  const z=Math.max(24, Math.round(Math.min(c.width,c.height)*scale));
  const p=Math.max(18, Math.round(z*0.45));
  x.font=`900 ${z}px sans-serif`;
  x.textAlign='right';
  x.textBaseline='bottom';
  x.lineWidth=Math.max(4, Math.round(z*0.12));
  x.strokeStyle='rgba(0,0,0,.85)';
  x.strokeText(phone, c.width-p, c.height-p);
  x.fillStyle='#ffd400';
  x.fillText(phone, c.width-p, c.height-p);
  return c.toDataURL('image/jpeg', 0.9);
}
function renderPhotos(){
  const el=$('editorPhotos');
  el.replaceChildren();
  const shown=marked.length===photos.length&&marked.length?marked:photos;
  shown.forEach((src,i)=>{
    const fig=document.createElement('figure');
    const img=document.createElement('img');
    img.src=src;
    img.alt=`사진 ${i+1}`;
    const setEdge=()=>{img.dataset.edge=String(Math.max(img.naturalWidth,img.naturalHeight));};
    img.addEventListener('load', setEdge);
    if(img.complete)setEdge();
    const cap=document.createElement('figcaption');
    const hit=photoDupHits().find(h=>h.i===i);
    cap.textContent=`${i+1}번${marked.length===photos.length&&marked.length?' · 번호 적용':''}${hit?(hit.dist<=8?' · 같은 사진':' · 유사 사진'):' · 처음 사용'}`;
    const tools=document.createElement('div');
    tools.className='photo-tools';
    const left=document.createElement('button');
    left.type='button';left.className='secondary';left.textContent='←';
    left.addEventListener('click',()=>movePhoto(i,-1));
    const right=document.createElement('button');
    right.type='button';right.className='secondary';right.textContent='→';
    right.addEventListener('click',()=>movePhoto(i,1));
    const del=document.createElement('button');
    del.type='button';del.className='danger';del.textContent='사진 삭제';
    del.addEventListener('click',()=>removePhoto(i));
    tools.append(left,right,del);
    fig.append(img,cap,tools);
    el.append(fig);
  });
  renderPhotoDup();
}
function movePhoto(i,d){
  const j=i+d;
  if(j<0||j>=photos.length)return;
  [photos[i],photos[j]]=[photos[j],photos[i]];
  [photoHashes[i],photoHashes[j]]=[photoHashes[j],photoHashes[i]];
  if(marked.length===photos.length)[marked[i],marked[j]]=[marked[j],marked[i]];
  renderPhotos();
}
function removePhoto(i){
  photos.splice(i,1);
  photoHashes.splice(i,1);
  if(marked.length)marked.splice(i,1);
  if(marked.length!==photos.length)marked=[];
  renderPhotos();
}
async function addPhotoFiles(fileList){
  const files=[...fileList].filter(f=>f.type.startsWith('image/'));
  if(!files.length){alert('이미지 파일을 선택해 주세요.');return;}
  $('writeStatus').textContent='사진을 줄이는 중입니다…';
  for(const file of files){
    try{
      const dataUrl=await compressFile(file,1280,0.8);
      const hash=await hashImage(dataUrl);
      photos.push(dataUrl);
      photoHashes.push(hash);
    }catch(e){
      alert((file.name||'사진')+' 을 처리하지 못했습니다. '+(e.message||''));
    }
  }
  marked=[];
  renderPhotos();
  $('writeStatus').textContent=`사진 ${photos.length}장. 긴 변은 1280px 이하, JPEG로 저장합니다.`;
}

async function copyTextRobust(t){
  try{
    if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(t);return true;}
  }catch{/* fallback */}
  try{
    const ta=document.createElement('textarea');
    ta.value=t;ta.setAttribute('readonly','');
    ta.style.position='fixed';ta.style.left='-9999px';
    document.body.appendChild(ta);ta.focus();ta.select();
    const ok=document.execCommand('copy');
    ta.remove();
    return !!ok;
  }catch{return false;}
}
async function copyText(text, label){
  const ok=await copyTextRobust(text);
  const status=$('copyStatus');
  status.dataset.copied=text;
  status.textContent=ok?(label||'복사했습니다.'):'복사하지 못했습니다. 길게 눌러 선택해 주세요.';
  return ok;
}

function collectPost(){
  const ctx=formContext();
  const previous=posts.find(p=>p.id===editingId);
  return {
    ...(previous||{}),
    id:editingId||uid(),
    car:ctx.car, year:ctx.year, work:ctx.work,
    reason:ctx.reason, equipment:ctx.equipment, result:ctx.result,
    sido:ctx.sido, sigungu:ctx.sigungu, dong:ctx.dong,
    detail:ctx.detail,
    region:ctx.place||previous?.region||'',
    title:$('title').value.trim(),
    body:$('body').value.trim(),
    tags:$('tags').value.trim(),
    publishDate:$('publishDate').value,
    status:$('status').value||'draft',
    naverUrl:$('naverUrl').value.trim(),
    photos:[...photos],
    markedPhotos:marked.length===photos.length?[...marked]:[],
    photoHashes:[...photoHashes],
    templateCursor,
    createdAt:previous?.createdAt||new Date().toISOString(),
    updatedAt:new Date().toISOString()
  };
}
async function persistPost(p){
  await localPut(p);
  if(cloudUser){
    try{await cloudPut(p);}catch(e){$('writeStatus').textContent='이 브라우저에는 저장했습니다. 클라우드 반영 실패: '+(e.message||e);}
  }
  await refreshPosts();
}
async function savePost(statusOverride){
  if(statusOverride)$('status').value=statusOverride;
  const p=collectPost();
  if(!p.title){alert('제목을 입력하거나 초안 작성을 눌러 주세요.');return;}
  $('writeStatus').textContent='저장 중…';
  try{
    await persistPost(p);
    editingId=p.id;
    $('deleteBtn').classList.remove('hidden');
    $('writeStatus').textContent=cloudUser?'이 브라우저와 클라우드에 저장했습니다.':'이 브라우저에 저장했습니다. 다른 휴대폰으로 옮기려면 백업 파일을 받으세요.';
    updateBanner();
    currentFilter='all';
    show('posts');
  }catch(e){
    alert('저장 실패: '+(e.message||e));
  }
}
async function deletePostById(id){
  if(!id)return;
  const p=posts.find(x=>x.id===id);
  const name=p?.title||p?.car||'이 원고';
  if(!confirm(`「${name}」을 삭제할까요?\n삭제한 글과 사진은 이 브라우저에서 지워집니다.`))return;
  await localDelete(id);
  if(cloudUser){
    try{await cloud.from('blog_posts').delete().eq('owner_id', cloudUser.id).eq('id', id);}catch{/* local delete already done */}
  }
  if(editingId===id)resetEditor();
  await refreshPosts();
  renderList();
  renderCalendar();
  updateBanner();
  show('posts');
}

function resetEditor(){
  editingId=null;
  photos=[];photoHashes=[];marked=[];
  bodyGenerated=false;
  templateCursor=(posts.length+new Date().getDate())%BODY_TEMPLATES.length;
  ['title','car','year','region','work','reason','equipment','result','body','tags','naverUrl','publishDate'].forEach(id=>$(id).value='');
  $('status').value='draft';
  $('sido').value='인천광역시';
  fillSigungu();
  $('phone').value=settings.phone;
  $('titleSuggestions').replaceChildren();
  $('editorTitle').textContent='새 글 작성';
  $('deleteBtn').classList.add('hidden');
  $('writeStatus').textContent='';
  $('copyStatus').textContent='';
  $('copyStatus').dataset.copied='';
  $('photoFiles').value='';
  renderPhotos();
  $('naverQuoteUrl').textContent=quoteUrl();
  $('naverQuoteUrl').href=quoteUrl();
}
function openEditor(id){
  const p=id?posts.find(x=>x.id===id):null;
  if(id&&!p){alert('원고를 찾지 못했습니다.');return;}
  show('editor');
  if(!p){resetEditor();return;}
  editingId=p.id;
  photos=[...(p.photos||[])];
  photoHashes=[...(p.photoHashes||[])];
  marked=(p.markedPhotos||[]).length===photos.length?[...p.markedPhotos]:[];
  templateCursor=Number.isInteger(p.templateCursor)?p.templateCursor:(posts.length%BODY_TEMPLATES.length);
  bodyGenerated=false;
  $('editorTitle').textContent='원고 수정';
  $('title').value=p.title||'';
  $('car').value=p.car||'';
  $('year').value=p.year||'';
  $('work').value=p.work||'';
  $('reason').value=p.reason||'';
  $('equipment').value=p.equipment||'';
  $('result').value=p.result||'';
  $('body').value=p.body||'';
  $('tags').value=p.tags||'';
  $('publishDate').value=p.publishDate||'';
  $('status').value=p.status||'draft';
  $('naverUrl').value=p.naverUrl||'';
  $('region').value=p.detail||'';
  $('sido').value=p.sido||'';
  fillSigungu();
  $('sigungu').value=p.sigungu||'';
  fillDong();
  $('dong').value=p.dong||'';
  if(!p.sido&&p.region){
    const sido=Object.keys(REGIONS).find(name=>String(p.region).startsWith(name));
    if(sido){$('sido').value=sido;fillSigungu();}
    else if(!p.detail)$('region').value=p.region;
  }
  $('phone').value=settings.phone;
  $('deleteBtn').classList.remove('hidden');
  $('photoFiles').value='';
  $('writeStatus').textContent='';
  renderPhotos();
  if(photoHashes.length!==photos.length||photoHashes.some(h=>!h))rebuildHashesForEditor();
  $('naverQuoteUrl').textContent=quoteUrl();
  $('naverQuoteUrl').href=quoteUrl();
  window.scrollTo(0,0);
}
async function rebuildHashesForEditor(){
  const hs=[];
  for(const src of photos){
    try{hs.push(await hashImage(src));}catch{hs.push('');}
  }
  photoHashes=hs;
  renderPhotos();
}

function matchesFilter(p){
  if(currentFilter==='archive')return p.status==='archived'||p.status==='draft';
  if(currentFilter==='completed')return p.status==='completed'||p.status==='posted';
  return true;
}
function renderList(){
  const q=$('search').value.trim().toLocaleLowerCase();
  const filtered=posts.filter(p=>matchesFilter(p)&&[p.title,p.car,p.region,p.body,p.tags,p.work].some(x=>String(x||'').toLocaleLowerCase().includes(q)));
  $('count').textContent=`표시 ${filtered.length}건 / 전체 ${posts.length}건`;
  const el=$('postList');
  el.replaceChildren();
  if(!filtered.length){
    const empty=document.createElement('p');
    empty.className='muted';
    empty.textContent=posts.length?'조건에 맞는 원고가 없습니다.':'저장된 원고가 없습니다. 새 글 작성에서 시작하면 이 브라우저에만 보관됩니다.';
    el.append(empty);
    return;
  }
  for(const p of filtered){
    const card=document.createElement('article');
    card.className='card';
    card.dataset.id=p.id;
    const h=document.createElement('h2');
    h.className='post-title';
    h.textContent=p.title||'(제목 없음)';
    const info=document.createElement('p');
    info.className='muted';
    info.textContent=[p.car,p.year,p.region,STATUS_LABEL[p.status]||p.status,p.publishDate].filter(Boolean).join(' · ');
    const count=document.createElement('p');
    count.textContent=`사진 ${(p.photos||[]).length}장`;
    const acts=document.createElement('div');
    acts.className='actions';
    const view=document.createElement('button');
    view.type='button';view.textContent='원고 보기';
    const edit=document.createElement('button');
    edit.type='button';edit.className='secondary';edit.textContent='수정';
    edit.addEventListener('click',()=>openEditor(p.id));
    const del=document.createElement('button');
    del.type='button';del.className='danger';del.textContent='삭제';
    del.addEventListener('click',()=>deletePostById(p.id));
    acts.append(view,edit,del);
    const detail=document.createElement('div');
    detail.className='hidden detail';
    const body=document.createElement('div');
    body.className='bodytext';
    body.textContent=p.body||'';
    const tags=document.createElement('p');
    tags.className='muted';
    tags.textContent=p.tags||'';
    const gallery=document.createElement('div');
    gallery.className='photos';
    (p.photos||[]).forEach((src,i)=>{
      const img=document.createElement('img');
      img.src=src;img.alt=`사진 ${i+1}`;img.loading='lazy';
      gallery.append(img);
    });
    if(p.naverUrl){
      const a=document.createElement('a');
      a.href=p.naverUrl;a.target='_blank';a.rel='noopener noreferrer';
      a.textContent='네이버 글 열기';
      detail.append(a);
    }
    detail.append(gallery,body,tags);
    view.addEventListener('click',()=>detail.classList.toggle('hidden'));
    card.append(h,info,count,acts,detail);
    el.append(card);
  }
}

function renderCalendar(){
  if(!calendarMonth)calendarMonth=todayISO().slice(0,7);
  $('calendarMonth').value=calendarMonth;
  const [y,m]=calendarMonth.split('-').map(Number);
  $('monthTitle').textContent=`${y}년 ${m}월`;
  const grid=$('calendarGrid');
  grid.replaceChildren();
  ['일','월','화','수','목','금','토'].forEach(name=>{
    const el=document.createElement('div');
    el.className='cal-dayname';
    el.textContent=name;
    grid.append(el);
  });
  const first=new Date(y,m-1,1).getDay();
  const days=new Date(y,m,0).getDate();
  const today=todayISO();
  const monthly=posts.filter(p=>String(p.publishDate||'').startsWith(calendarMonth));
  const cells=Math.ceil((first+days)/7)*7;
  for(let i=0;i<cells;i++){
    const day=i-first+1;
    const cell=document.createElement('div');
    cell.className='cal-cell';
    if(day<1||day>days){cell.classList.add('empty');grid.append(cell);continue;}
    const date=`${calendarMonth}-${String(day).padStart(2,'0')}`;
    if(date===today)cell.classList.add('today');
    const num=document.createElement('div');
    num.className='cal-num';
    num.textContent=String(day);
    cell.append(num);
    const items=monthly.filter(p=>p.publishDate===date);
    items.slice(0,3).forEach(p=>{
      const tag=document.createElement('span');
      tag.className='cal-item '+(p.status||'');
      tag.textContent=p.title||p.car||'원고';
      cell.append(tag);
    });
    if(items.length>3){
      const more=document.createElement('span');
      more.className='cal-item';
      more.textContent=`+${items.length-3}`;
      cell.append(more);
    }
    cell.addEventListener('click',()=>selectCalendarDay(date, items));
    grid.append(cell);
  }
  $('calSummary').textContent=`게시 완료 ${monthly.filter(p=>p.status==='posted').length}건 · 그 외 ${monthly.filter(p=>p.status!=='posted').length}건`;
}
function selectCalendarDay(date, items){
  const box=$('calSelected');
  box.replaceChildren();
  const h=document.createElement('h2');
  h.textContent=`${date} · ${items.length}건`;
  box.append(h);
  if(!items.length){
    const p=document.createElement('p');
    p.className='muted';
    p.textContent='이 날짜에 등록된 원고가 없습니다.';
    box.append(p);
    return;
  }
  items.forEach(p=>{
    const b=document.createElement('button');
    b.type='button';b.className='secondary';
    b.textContent=`${p.title||'제목 없음'} · 수정`;
    b.addEventListener('click',()=>openEditor(p.id));
    box.append(b);
  });
}

function backupDue(){
  if(!posts.length)return false;
  const snooze=Number(localStorage.getItem(SNOOZE_KEY)||0);
  if(Date.now()<snooze)return false;
  const last=Number(localStorage.getItem(BACKUP_AT_KEY)||0);
  const days=Number(settings.backupDays)||3;
  if(!last)return true;
  return Date.now()-last>days*86400000;
}
function updateBanner(){
  const banner=$('backupBanner');
  const last=Number(localStorage.getItem(BACKUP_AT_KEY)||0);
  if(last)$('lastBackup').textContent=`마지막 백업: ${new Date(last).toLocaleString('ko-KR')}`;
  else $('lastBackup').textContent='아직 받은 백업이 없습니다.';
  if(!backupDue()){banner.classList.add('hidden');return;}
  banner.classList.remove('hidden');
  const days=Number(settings.backupDays)||3;
  if(sessionStorage.getItem('dream_autobackup_offered')==='1'){
    $('backupBannerText').textContent='백업 파일을 이 탭에서 내려받았습니다. 파일 앱에 있는지 확인한 뒤, 다시 받거나 알림을 미루세요. 공개 저장소에는 올리지 마세요.';
    return;
  }
  $('backupBannerText').textContent=last
    ?`마지막 JSON 백업 이후 ${days}일이 지났습니다. 원고는 이 브라우저에만 있습니다. 백업 파일을 받아 두세요.`
    :'아직 백업 파일이 없습니다. 원고와 사진은 이 브라우저에만 저장됩니다. JSON 백업을 받아 주세요.';
}
function downloadBackup(opts={}){
  if(!posts.length){
    if(!opts.auto)alert('저장할 원고가 없습니다.');
    return;
  }
  const payload={version:'dream-blog-main-1', exportedAt:new Date().toISOString(), settings, posts};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  const url=URL.createObjectURL(blob);
  a.href=url;
  a.download=`드림블로그_백업_${todayISO()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
  if(opts.auto)sessionStorage.setItem('dream_autobackup_offered','1');
  else{
    localStorage.setItem(BACKUP_AT_KEY, String(Date.now()));
    localStorage.removeItem(SNOOZE_KEY);
    sessionStorage.removeItem('dream_autobackup_offered');
  }
  $('importResult').textContent=`백업 파일을 내려받았습니다. 원고 ${posts.length}건. 이 파일은 공개 저장소에 올리지 마세요.`;
  updateBanner();
}
async function importBackupFile(file){
  const data=JSON.parse(await file.text());
  const incoming=Array.isArray(data)?data:(data.posts||null);
  if(!Array.isArray(incoming))throw new Error('원고 목록이 없습니다.');
  if(data.settings&&typeof data.settings==='object'){
    settings={...settings, ...data.settings};
    saveSettings();
    applySettingsToUi();
  }
  let added=0, replaced=0, skipped=0;
  for(const raw of incoming){
    const post=normalizeIncomingPost(raw);
    if(!post){skipped++;continue;}
    const old=posts.find(item=>String(item.id)===String(post.id));
    if(!old){await localPut(post);added++;}
    else if(postStamp(post)>postStamp(old)){await localPut({...old, ...post, createdAt:old.createdAt||post.createdAt});replaced++;}
    else skipped++;
  }
  await refreshPosts();
  renderList();
  renderCalendar();
  updateBanner();
  $('importResult').textContent=`추가 ${added}건 · 교체 ${replaced}건 · 건너뜀 ${skipped}건`;
}

async function ensureSavedPhotoHashes(){
  let changed=0;
  for(const p of posts){
    const imgs=p.photos||[];
    if(!imgs.length)continue;
    if(!Array.isArray(p.photoHashes)||p.photoHashes.length!==imgs.length||p.photoHashes.some(x=>!x)){
      const hs=[];
      for(const img of imgs){try{hs.push(await hashImage(img));}catch{hs.push('');}}
      p.photoHashes=hs;
      await localPut(p);
      changed++;
    }
  }
  if(changed)await refreshPosts();
  return changed;
}

function applySettingsToUi(){
  $('settingBusiness').value=settings.business||'';
  $('settingPhone').value=settings.phone||'';
  $('settingQuote').value=settings.quoteText||'';
  $('autoBackup').checked=settings.autoBackup!==false;
  $('backupDays').value=String(settings.backupDays||3);
  $('phone').value=settings.phone||'';
  const tel=telHref(settings.phone);
  $('callBtn').href=tel||'#';
  $('callBtn2').href=tel||'#';
  $('phoneLabel').textContent=settings.phone||'';
}
function readSettingsFromUi(){
  settings.business=$('settingBusiness').value.trim()||DEFAULT_SETTINGS.business;
  settings.phone=$('settingPhone').value.trim()||DEFAULT_SETTINGS.phone;
  settings.quoteText=$('settingQuote').value.trim()||DEFAULT_SETTINGS.quoteText;
  settings.autoBackup=$('autoBackup').checked;
  settings.backupDays=Number($('backupDays').value)||3;
  saveSettings();
  applySettingsToUi();
}

function show(which){
  for(const id of ['posts','editor','calendar','backup'])$(id).classList.toggle('hidden', id!==which);
  const map={posts:currentFilter==='completed'?'tabCompleted':currentFilter==='archive'?'tabArchive':'tabAll', editor:'tabNew', calendar:'tabCalendar', backup:'tabBackup'};
  for(const id of ['tabAll','tabCompleted','tabArchive','tabCalendar','tabNew','tabBackup'])$(id).classList.toggle('active', id===map[which]);
  if(which==='posts')renderList();
  if(which==='calendar')renderCalendar();
  if(which==='backup')updateBanner();
  window.scrollTo(0,0);
}

async function loadSupabase(){
  if(window.supabase?.createClient)return;
  await new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    s.onload=resolve;
    s.onerror=()=>reject(new Error('클라우드 라이브러리를 불러오지 못했습니다. 인터넷 없이도 이 앱은 사용할 수 있습니다.'));
    document.head.append(s);
  });
}
async function ensureCloud(){
  if(cloud)return cloud;
  await loadSupabase();
  cloud=window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  return cloud;
}
async function cloudPut(p){
  if(!cloudUser)return;
  const row={owner_id:cloudUser.id,id:p.id,data:p,created_at:p.createdAt||new Date().toISOString(),updated_at:p.updatedAt||new Date().toISOString()};
  const {error}=await cloud.from('blog_posts').upsert(row,{onConflict:'owner_id,id'});
  if(error)throw error;
}
function setCloudStatus(text){$('cloudStatus').textContent=text||'';}
async function enterCloud(user){
  cloudUser=user;
  localStorage.setItem(CLOUD_FLAG,'1');
  $('cloudLogout').classList.remove('hidden');
  setCloudStatus(`연결됨 ${user.email||''}. 클라우드가 없어도 이 브라우저 저장은 유지됩니다.`);
}
async function tryQuietCloud(){
  if(localStorage.getItem(CLOUD_FLAG)!=='1')return;
  try{
    await ensureCloud();
    const {data,error}=await cloud.auth.getSession();
    if(error||!data?.session?.user){setCloudStatus('클라우드 세션이 없습니다. 로그인은 선택 사항입니다.');return;}
    await enterCloud(data.session.user);
  }catch{
    setCloudStatus('클라우드에 연결하지 못했습니다. 원고는 이 브라우저에 그대로 있습니다.');
  }
}

function bind(){
  $('tabAll').onclick=()=>{currentFilter='all';show('posts');};
  $('tabCompleted').onclick=()=>{currentFilter='completed';show('posts');};
  $('tabArchive').onclick=()=>{currentFilter='archive';show('posts');};
  $('tabCalendar').onclick=()=>show('calendar');
  $('tabNew').onclick=()=>openEditor(null);
  $('tabBackup').onclick=()=>show('backup');
  $('search').addEventListener('input', renderList);
  $('sido').addEventListener('change', fillSigungu);
  $('sigungu').addEventListener('change', fillDong);
  $('generateDraft').onclick=()=>applyDraft(false);
  $('cycleTemplate').onclick=()=>{
    if(!bodyGenerated && $('body').value.trim() && !confirm('본문을 다른 문장 유형으로 바꿀까요?'))return;
    templateCursor=(templateCursor+1)%BODY_TEMPLATES.length;
    applyDraft(true);
  };
  $('recommendTitles').onclick=()=>{
    const ctx=formContext();
    if(!ctx.car&&!ctx.work){alert('차량명 또는 작업 종류를 입력하면 제목을 더 구체적으로 만듭니다.');}
    renderTitleSuggestions(makeTitles(ctx));
  };
  $('body').addEventListener('input', ()=>{bodyGenerated=false;});
  $('photoFiles').addEventListener('change', async e=>{
    await addPhotoFiles(e.target.files||[]);
    e.target.value='';
  });
  $('watermark').onclick=async()=>{
    if(!photos.length){alert('사진을 먼저 선택해 주세요.');return;}
    const next=[];
    for(const src of photos)next.push(await markOne(src));
    marked=next;
    renderPhotos();
    $('writeStatus').textContent='사진에 전화번호를 넣었습니다. 번호 사진 저장으로 받을 수 있습니다.';
  };
  $('downloadMarked').onclick=()=>{
    const list=marked.length===photos.length&&marked.length?marked:[];
    if(!list.length){alert('먼저 전화번호 넣기를 실행해 주세요.');return;}
    list.forEach((src,i)=>setTimeout(()=>{
      const a=document.createElement('a');
      a.href=src;a.download=`드림블로그_${String(i+1).padStart(2,'0')}.jpg`;a.click();
    }, i*250));
  };
  $('clearPhotos').onclick=()=>{
    if(photos.length&&!confirm('이 글에 올린 사진을 모두 뺄까요? 저장 전까지는 보관함의 사진은 그대로입니다.'))return;
    photos=[];photoHashes=[];marked=[];renderPhotos();
  };
  $('rebuildPhotoDB').onclick=async()=>{
    $('rebuildPhotoDB').disabled=true;
    const n=await ensureSavedPhotoHashes();
    if(photos.length)await rebuildHashesForEditor();
    else renderPhotoDup();
    $('rebuildPhotoDB').disabled=false;
    alert(n?`${n}개 원고의 사진 지문을 다시 만들었습니다.`:'사진 지문을 확인했습니다.');
  };
  $('save').onclick=()=>savePost();
  $('saveArchive').onclick=()=>savePost('archived');
  $('deleteBtn').onclick=()=>deletePostById(editingId);
  $('cancel').onclick=()=>{currentFilter='all';show('posts');};
  $('copyTitle').onclick=()=>copyText($('title').value.trim(),'제목을 복사했습니다.');
  $('copyBody').onclick=()=>copyText($('body').value.trim(),'본문을 복사했습니다. 견적 주소가 본문에 있습니다.');
  $('copyTags').onclick=()=>copyText($('tags').value.trim(),'태그를 복사했습니다.');
  $('copyQuoteLink').onclick=()=>copyText(quoteUrl(),'견적 링크를 복사했습니다.');
  $('copyTelLink').onclick=()=>copyText(telHref(settings.phone), '전화 링크를 복사했습니다.');
  $('openNaver').onclick=()=>window.open('https://blog.naver.com','_blank','noopener');
  $('saveNaverUrl').onclick=async()=>{
    if(!editingId){alert('먼저 원고를 저장한 뒤 게시글 주소를 남겨 주세요.');return;}
    $('status').value='posted';
    if(!$('publishDate').value)$('publishDate').value=todayISO();
    await savePost();
    $('writeStatus').textContent='게시 완료로 저장하고 네이버 주소를 남겼습니다.';
  };
  $('export').onclick=()=>downloadBackup();
  $('backupNow').onclick=()=>downloadBackup();
  $('backupLater').onclick=()=>{
    localStorage.setItem(SNOOZE_KEY, String(Date.now()+86400000));
    updateBanner();
  };
  $('findOldPosts').onclick=()=>findOldPosts();
  $('import').onclick=()=>$('importFile').click();
  $('importFile').addEventListener('change', async e=>{
    const file=e.target.files&&e.target.files[0];
    e.target.value='';
    if(!file)return;
    try{await importBackupFile(file);}
    catch(err){alert('백업 파일을 읽지 못했습니다. '+(err.message||''));}
  });
  $('saveSettings').onclick=()=>{
    readSettingsFromUi();
    $('settingsStatus').textContent='설정을 이 브라우저에 저장했습니다.';
  };
  $('autoBackup').addEventListener('change', readSettingsFromUi);
  $('backupDays').addEventListener('change', readSettingsFromUi);
  $('prevMonth').onclick=()=>shiftMonth(-1);
  $('nextMonth').onclick=()=>shiftMonth(1);
  $('calendarMonth').addEventListener('change', ()=>{calendarMonth=$('calendarMonth').value||todayISO().slice(0,7);renderCalendar();});
  $('cloudLogin').onclick=async()=>{
    const email=$('cloudEmail').value.trim();
    const password=$('cloudPassword').value;
    if(!email||!password){setCloudStatus('이메일과 비밀번호를 입력하세요. 로그인하지 않아도 앱은 동작합니다.');return;}
    $('cloudLogin').disabled=true;
    try{
      await ensureCloud();
      const {data,error}=await cloud.auth.signInWithPassword({email,password});
      if(error)throw error;
      await enterCloud(data.user);
    }catch(e){setCloudStatus('로그인 실패: '+(e.message||'이메일과 비밀번호를 확인해 주세요.')+' 로컬 저장은 그대로입니다.');}
    finally{$('cloudLogin').disabled=false;}
  };
  $('cloudLogout').onclick=async()=>{
    try{if(cloud)await cloud.auth.signOut();}catch{/* ignore */}
    cloudUser=null;
    localStorage.removeItem(CLOUD_FLAG);
    $('cloudLogout').classList.add('hidden');
    setCloudStatus('로그아웃했습니다. 이 브라우저의 원고는 삭제되지 않습니다.');
  };
  $('cloudPull').onclick=async()=>{
    if(!cloudUser){setCloudStatus('로그인한 뒤에 가져올 수 있습니다.');return;}
    try{
      const {data,error}=await cloud.from('blog_posts').select('data').eq('owner_id', cloudUser.id);
      if(error)throw error;
      let added=0, updated=0;
      for(const row of data||[]){
        const p=row.data;
        if(!p||!p.id)continue;
        const old=posts.find(x=>x.id===p.id);
        if(!old){await localPut(p);added++;}
        else if(String(p.updatedAt||'')>String(old.updatedAt||'')){await localPut(p);updated++;}
      }
      await refreshPosts();
      renderList();
      setCloudStatus(`클라우드에서 추가 ${added}건, 갱신 ${updated}건. 이 브라우저에 없는 글만 더했습니다.`);
    }catch(e){setCloudStatus('가져오기 실패: '+(e.message||e));}
  };
  $('cloudPush').onclick=async()=>{
    if(!cloudUser){setCloudStatus('로그인한 뒤에 올릴 수 있습니다.');return;}
    if(!confirm(`이 브라우저의 원고 ${posts.length}건을 클라우드에 올릴까요? 같은 글은 덮어씁니다.`))return;
    try{
      for(const p of posts)await cloudPut(p);
      setCloudStatus(`클라우드에 ${posts.length}건을 올렸습니다.`);
    }catch(e){setCloudStatus('올리기 실패: '+(e.message||e)+' 이 브라우저 원본은 그대로입니다.');}
  };
}
function shiftMonth(n){
  const [y,m]=calendarMonth.split('-').map(Number);
  const d=new Date(y, m-1+n, 1);
  calendarMonth=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  renderCalendar();
}

async function init(){
  loadSettings();
  bind();
  fillSido();
  applySettingsToUi();
  calendarMonth=todayISO().slice(0,7);
  try{
    await openDB();
    const migrated=await migrateOld();
    await refreshPosts();
    if(migrated.copied>0){
      $('migrationNote').textContent=`이 휴대폰에 남아 있던 이전 원고 ${migrated.copied}건을 불러왔습니다.`;
      $('migrationNote').classList.remove('hidden');
    }
  }catch(e){
    alert('이 브라우저에서 저장소를 열지 못했습니다. '+ (e.message||''));
  }
  resetEditor();
  currentFilter='all';
  show('posts');
  updateBanner();
  if(settings.autoBackup && backupDue()){
    if(!sessionStorage.getItem('dream_autobackup_ran')){
      sessionStorage.setItem('dream_autobackup_ran','1');
      setTimeout(()=>downloadBackup({auto:true}), 700);
    }
  }
  tryQuietCloud();
  if('serviceWorker' in navigator)navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
}
init();
