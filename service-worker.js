const CACHE='dream-autokey-blog-v2.2';
const CORE=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE))) });
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const u=new URL(e.request.url);const page=e.request.mode==='navigate'||u.pathname.endsWith('/')||u.pathname.endsWith('/index.html');if(page){e.respondWith(fetch(e.request,{cache:'no-store'}).catch(()=>caches.match('./index.html')));return}e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{if(res&&res.ok){const x=res.clone();caches.open(CACHE).then(c=>c.put(e.request,x))}return res}))) });
