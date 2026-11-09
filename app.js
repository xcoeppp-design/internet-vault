const DB_NAME = "internet-vault-db";
const DB_VERSION = 1;
const STORE = "items";
const TARGET_BYTES = 5 * 1024 ** 3;
const AUTO_KEY = "internet-vault-auto-urls";
let db;
let currentFilter = "all";
let deferredInstall = null;
let toastTimer;

const $ = (id) => document.getElementById(id);
const fmt = (bytes=0) => {
  if (!bytes) return "0 B";
  const units = ["B","KB","MB","GB","TB"];
  const i = Math.min(Math.floor(Math.log(bytes)/Math.log(1024)), units.length-1);
  return `${(bytes/1024**i).toFixed(i ? 2 : 0)} ${units[i]}`;
};
const escapeHtml = (s="") => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(message) {
  const el=$("toast"); el.textContent=message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove("show"),3300);
}
function openDB() {
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{const d=req.result;if(!d.objectStoreNames.contains(STORE)){const s=d.createObjectStore(STORE,{keyPath:"id",autoIncrement:true});s.createIndex("createdAt","createdAt");}};
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
function allItems() {
  return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,"readonly");const r=tx.objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}
function putItem(item) {
  return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,"readwrite");const r=tx.objectStore(STORE).add(item);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}
function deleteItem(id) {
  return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,"readwrite");const r=tx.objectStore(STORE).delete(Number(id));r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);});
}
function clearItems() {
  return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,"readwrite");const r=tx.objectStore(STORE).clear();r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);});
}
async function getStoredBytes(items) { return items.reduce((sum,x)=>sum+(x.blob?.size||new Blob([x.content||""]).size),0); }
async function refresh() {
  const items=await allItems(); const used=await getStoredBytes(items);
  $("usedValue").textContent=fmt(used);
  $("usageBar").style.width=Math.min(100,used/TARGET_BYTES*100)+"%";
  $("usagePercent").textContent=(used/TARGET_BYTES*100).toFixed(2)+"% dari target";
  $("itemCount").textContent=items.length;
  $("pageCount").textContent=items.filter(x=>x.kind==="page").length;
  $("fileCount").textContent=items.filter(x=>x.kind==="file").length;
  if(navigator.storage?.estimate){
    try{const e=await navigator.storage.estimate();$("quotaText").textContent=`Browser: ${fmt(e.usage||0)} / ${fmt(e.quota||0)}`;}catch{$("quotaText").textContent="Kapasitas browser terbatas";}
  } else $("quotaText").textContent="Kapasitas browser terbatas";
  renderList(items);
}
function iconFor(item){if(item.kind==="page")return "◎";const t=item.type||"";if(t.startsWith("image/"))return "▧";if(t.startsWith("video/"))return "▷";if(t==="application/pdf")return "▤";return "◇";}
function renderList(items) {
  const q=$("searchInput").value.trim().toLowerCase();
  const shown=items.filter(x=>(currentFilter==="all"||x.kind===currentFilter)&&(`${x.name} ${x.url||""}`).toLowerCase().includes(q)).sort((a,b)=>b.createdAt-a.createdAt);
  if(!shown.length){$("vaultList").innerHTML=`<div class="empty-state"><span>◈</span><strong>${items.length?"Tidak ada hasil":"Vault masih kosong"}</strong><p>${items.length?"Coba kata pencarian atau filter lain.":"Simpan halaman atau unggah file untuk memulai koleksimu."}</p></div>`;return;}
  $("vaultList").innerHTML=shown.map(x=>`<article class="vault-item"><div class="item-icon">${iconFor(x)}</div><div class="item-info"><strong title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</strong><small>${x.kind==="page"?"Website":escapeHtml(x.type||"File")} · ${fmt(x.blob?.size||new Blob([x.content||""]).size)} · ${new Date(x.createdAt).toLocaleDateString("id-ID")}</small></div><div class="item-actions"><button data-open="${x.id}">Buka</button><button class="delete" data-delete="${x.id}">×</button></div></article>`).join("");
}
async function ensureCapacity(addBytes) {
  const used=await getStoredBytes(await allItems());
  if(used+addBytes>TARGET_BYTES)throw new Error("Batas target 5 GB aplikasi akan terlampaui.");
  if(navigator.storage?.estimate){
    const e=await navigator.storage.estimate();
    if(e.quota && (e.usage||0)+addBytes>e.quota*.95)throw new Error("Ruang yang diberikan browser hampir habis. Hapus file atau ekspor cadangan.");
  }
}
async function saveUrl(rawUrl, silent=false) {
  let url;
  try{url=new URL(rawUrl);if(!["http:","https:"].includes(url.protocol))throw 0;}catch{throw new Error("Masukkan URL HTTP atau HTTPS yang valid.");}
  if(!navigator.onLine)throw new Error("Kamu sedang offline. URL baru tidak dapat diunduh.");
  let response;
  try{response=await fetch(url.href,{mode:"cors",credentials:"omit",redirect:"follow",cache:"no-store"});}
  catch{throw new Error("Website menolak akses browser (CORS), atau tidak dapat dijangkau. Coba unggah file atau simpan konten lain.");}
  if(!response.ok)throw new Error(`Server memberi status ${response.status}.`);
  const type=(response.headers.get("content-type")||"application/octet-stream").split(";")[0].toLowerCase();
  if(type.includes("text/html")||type.includes("application/xhtml")){
    const text=await response.text();const blob=new Blob([text],{type:"text/html;charset=utf-8"});
    await ensureCapacity(blob.size);
    const title=text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g,"").trim()||url.hostname;
    await putItem({kind:"page",name:title.slice(0,120),url:url.href,content:text,type:"text/html",createdAt:Date.now()});
  }else{
    const blob=await response.blob();await ensureCapacity(blob.size);
    await putItem({kind:"file",name:decodeURIComponent(url.pathname.split("/").pop()||url.hostname),url:url.href,blob,type:blob.type||type,createdAt:Date.now()});
  }
  if(!silent)toast("Konten berhasil disimpan ke perangkat.");
  await refresh();
}
async function saveFiles(fileList) {
  for(const file of fileList){
    await ensureCapacity(file.size);
    await putItem({kind:"file",name:file.name,blob:file,type:file.type||"application/octet-stream",createdAt:Date.now()});
  }
  await refresh();toast(`${fileList.length} file berhasil disimpan.`);
}
async function openItem(id) {
  const item=(await allItems()).find(x=>x.id===Number(id));if(!item)return;
  $("viewerTitle").textContent=item.name;const body=$("viewerBody");body.replaceChildren();
  if(item.kind==="page"){
    const frame=document.createElement("iframe");frame.setAttribute("sandbox","allow-forms allow-scripts allow-same-origin");frame.srcdoc=item.content;body.append(frame);
  }else{
    const url=URL.createObjectURL(item.blob);const type=item.type||"";
    let el;
    if(type.startsWith("image/")){el=document.createElement("img");el.alt=item.name;el.src=url;}
    else if(type.startsWith("video/")){el=document.createElement("video");el.controls=true;el.src=url;}
    else if(type.startsWith("audio/")){el=document.createElement("audio");el.controls=true;el.src=url;}
    else if(type==="application/pdf"){el=document.createElement("iframe");el.src=url;}
    else {el=document.createElement("p");el.textContent="Pratinjau tidak tersedia untuk jenis file ini. Gunakan tombol unduh.";const a=document.createElement("a");a.href=url;a.download=item.name;a.textContent="Unduh file";a.className="btn btn-primary";body.append(el,a);$("viewerDialog").showModal();return;}
    body.append(el);
    const a=document.createElement("a");a.href=url;a.download=item.name;a.textContent="Unduh salinan";a.className="btn btn-ghost";a.style.display="inline-block";a.style.marginTop="12px";body.append(a);
  }
  $("viewerDialog").showModal();
}
function updateConnection(){
  const b=$("connectionBadge");b.classList.toggle("offline",!navigator.onLine);
  b.innerHTML=`<i></i> ${navigator.onLine?"Online":"Offline"}`;
  $("offlineModeBtn").textContent=navigator.onLine?"◉ Emergency Offline":"◉ Offline aktif";
}
function getAutoUrls(){try{return JSON.parse(localStorage.getItem(AUTO_KEY)||"[]");}catch{return [];}}
function setAutoUrls(list){localStorage.setItem(AUTO_KEY,JSON.stringify(list));renderAutoUrls();}
function renderAutoUrls(){
  const list=getAutoUrls();$("autoList").innerHTML=list.length?list.map((u,i)=>`<div class="auto-row"><span>${escapeHtml(u)}</span><button data-auto-remove="${i}" aria-label="Hapus URL">×</button></div>`).join(""):'<p class="hint">Belum ada URL otomatis.</p>';
}
let autoTimer=null;
async function runAutoCollector(){
  if(!$("autoToggle").checked||!navigator.onLine)return;
  if(!localStorage.getItem("internet-vault-wifi-confirmed")){toast("Baca pengingat jaringan terlebih dahulu di Pengaturan.");$("autoToggle").checked=false;return;}
  const urls=getAutoUrls();
  for(const url of urls){
    if(!$("autoToggle").checked||!navigator.onLine)break;
    try{await saveUrl(url,true);}catch(e){console.warn("Auto collector:",e.message);}
  }
}
function setAutoEnabled(enabled){
  clearInterval(autoTimer);autoTimer=null;
  if(enabled){
    if(!getAutoUrls().length){$("autoToggle").checked=false;toast("Tambahkan minimal satu URL terlebih dahulu.");return;}
    if(!localStorage.getItem("internet-vault-wifi-confirmed")){$("autoToggle").checked=false;toast("Buka Pengaturan dan aktifkan konfirmasi WiFi.");return;}
    if(!navigator.onLine){toast("Auto Collector menunggu koneksi online.");}
    runAutoCollector();autoTimer=setInterval(runAutoCollector,5*60*1000);
    toast("Auto Collector aktif selama halaman tetap terbuka.");
  }else toast("Auto Collector dijeda.");
}
function exportList(){
  allItems().then(items=>{
    const data=items.map(({id,kind,name,url,type,createdAt,blob,content})=>({id,kind,name,url,type,createdAt,size:blob?.size||new Blob([content||""]).size}));
    const a=document.createElement("a");const u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));a.href=u;a.download="internet-vault-index.json";a.click();URL.revokeObjectURL(u);
    toast("Daftar konten diekspor. File konten tetap tersimpan di browser.");
  });
}
function setup(){
  document.querySelectorAll("[data-tab]").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));document.querySelectorAll(".tab-content").forEach(x=>x.classList.remove("active"));b.classList.add("active");$(b.dataset.tab).classList.add("active");}));
  document.querySelectorAll("[data-filter]").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".filter").forEach(x=>x.classList.remove("active"));b.classList.add("active");currentFilter=b.dataset.filter;refresh();}));
  document.querySelectorAll("[data-scroll]").forEach(b=>b.addEventListener("click",()=>$(b.dataset.scroll).scrollIntoView({behavior:"smooth"})));
  $("saveUrlBtn").addEventListener("click",async()=>{try{await saveUrl($("urlInput").value);$("urlInput").value="";}catch(e){toast(e.message);}});
  $("urlInput").addEventListener("keydown",e=>{if(e.key==="Enter")$("saveUrlBtn").click();});
  $("fileInput").addEventListener("change",async e=>{try{await saveFiles([...e.target.files]);}catch(err){toast(err.message);}e.target.value="";});
  $("searchInput").addEventListener("input",refresh);
  $("vaultList").addEventListener("click",async e=>{const open=e.target.closest("[data-open]"),del=e.target.closest("[data-delete]");if(open)openItem(open.dataset.open);if(del){await deleteItem(del.dataset.delete);toast("Konten dihapus.");refresh();}});
  $("autoList").addEventListener("click",e=>{const b=e.target.closest("[data-auto-remove]");if(b){const a=getAutoUrls();a.splice(Number(b.dataset.autoRemove),1);setAutoUrls(a);}});
  $("addAutoUrlBtn").addEventListener("click",()=>{const v=$("autoUrlInput").value.trim();try{const u=new URL(v);if(!["http:","https:"].includes(u.protocol))throw 0;const a=getAutoUrls();if(!a.includes(u.href))a.push(u.href);setAutoUrls(a);$("autoUrlInput").value="";toast("URL ditambahkan.");}catch{toast("Masukkan URL HTTP/HTTPS yang valid.");}});
  $("autoToggle").addEventListener("change",e=>setAutoEnabled(e.target.checked));
  $("settingsBtn").addEventListener("click",()=>$("settingsDialog").showModal());
  $("wifiConfirm").checked=!!localStorage.getItem("internet-vault-wifi-confirmed");
  $("wifiConfirm").addEventListener("change",e=>{if(e.target.checked)localStorage.setItem("internet-vault-wifi-confirmed","yes");else localStorage.removeItem("internet-vault-wifi-confirmed");});
  $("clearAllBtn").addEventListener("click",async()=>{if(confirm("Hapus semua konten dari Internet Vault di perangkat ini? Tindakan ini tidak dapat dibatalkan.")){await clearItems();$("settingsDialog").close();refresh();toast("Semua konten dihapus.");}});
  $("offlineModeBtn").addEventListener("click",()=>{toast(navigator.onLine?"Mode offline menampilkan konten yang sudah disimpan. Matikan WiFi/data untuk menguji.":"Kamu offline. Buka konten tersimpan dari daftar Vault.");document.querySelector(".vault-list").scrollIntoView({behavior:"smooth"});});
  $("viewerClose").addEventListener("click",()=>$("viewerDialog").close());
  $("exportBtn").addEventListener("click",exportList);
  window.addEventListener("online",updateConnection);window.addEventListener("offline",updateConnection);
  renderAutoUrls();updateConnection();
  if("serviceWorker" in navigator && location.protocol!=="file:"){navigator.serviceWorker.register("./sw.js").catch(e=>console.warn("Service Worker tidak aktif:",e));}
  window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredInstall=e;$("installBtn").classList.remove("hidden");});
  $("installBtn").addEventListener("click",async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;$("installBtn").classList.add("hidden");});
}
(async()=>{try{db=await openDB();setup();await refresh();if(navigator.storage?.persist){navigator.storage.persist().then(granted=>{if(granted)toast("Penyimpanan persisten diizinkan browser.");});}}catch(e){console.error(e);toast("Penyimpanan lokal tidak dapat dibuka. Coba browser lain.");}})();
