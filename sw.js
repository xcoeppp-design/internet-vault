const CACHE_NAME = "internet-vault-shell-v1";
const APP_SHELL = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const req=event.request;
  if(req.method!=="GET") return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin) return;
  event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(response=>{
    if(response.ok && (req.destination==="style"||req.destination==="script"||req.destination==="document"||req.destination==="manifest")){
      const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(req,copy));
    }
    return response;
  }).catch(()=>caches.match("./index.html"))));
});
