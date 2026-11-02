/* Family Board: small service worker. It shows alerts that arrive while the app is closed,
   and focuses the app when one is tapped. Licensed under the GNU General Public License v3.0, see LICENSE.txt. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));

self.addEventListener('push',e=>{
  let d={};
  try{d=e.data?e.data.json():{}}catch{d={body:e.data?e.data.text():''}}
  const title=typeof d.title==='string'&&d.title?d.title.slice(0,100):'Family Board';
  const opts={body:typeof d.body==='string'?d.body.slice(0,300):'',icon:'icon-192.png',badge:'icon-192.png',data:{}};
  if(typeof d.tag==='string'&&d.tag)opts.tag=d.tag.slice(0,100);
  e.waitUntil((async()=>{
    await self.registration.showNotification(title,opts);
    // if the app is open, tell it to refresh now so the bell and sound update at once
    const list=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    list.forEach(c=>c.postMessage({type:'family-board-push'}));
  })());
});

self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{
    for(const c of l){if('focus' in c)return c.focus()}
    return self.clients.openWindow('./');
  }));
});
