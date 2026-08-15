'use strict';
const $ = s => document.querySelector(s);
const state = { token: localStorage.getItem('uv_token'), mode:'login', user:null, socket:null };
const intro = $('#intro');
setTimeout(() => { intro.classList.add('hidden'); $('#app').classList.remove('hidden'); boot(); }, 2200);

function msg(t, bad=false){ $('#authMsg').textContent=t; $('#authMsg').style.color=bad?'#ff7d7d':'#9ee6b0'; }
async function api(url, options={}){
  const headers = {'Content-Type':'application/json', ...(options.headers||{})};
  if(state.token) headers.Authorization = `Bearer ${state.token}`;
  const r=await fetch(url,{...options,headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||'Erro');
  return data;
}
function showGame(){ $('#auth').classList.add('hidden'); $('#game').classList.remove('hidden'); $('#userInfo').textContent=`${state.user.username} · ${state.user.coins} 🪙`; if(state.user.role!=='player') $('#adminNav').classList.remove('hidden'); connect(); loadRooms(); }
async function boot(){
  if(state.token){ try{ const d=await api('/api/auth/me'); state.user=d.user; showGame(); return; }catch{ localStorage.removeItem('uv_token'); state.token=null; }}
  $('#auth').classList.remove('hidden');
}
async function submitAuth(e){
  e.preventDefault(); const username=$('#username').value.trim(); const password=$('#password').value;
  try{ const d=await api(state.mode==='login'?'/api/auth/login':'/api/auth/register',{method:'POST',body:JSON.stringify({username,password})}); state.token=d.token; state.user=d.user; localStorage.setItem('uv_token',state.token); msg('Acesso realizado.'); showGame(); }catch(err){msg(err.message,true)}
}
async function loadRooms(){ try{const d=await api('/api/rooms'); $('#rooms').innerHTML=d.rooms.length?d.rooms.map(r=>`<div class="room"><div><b>${r.code}</b><br><span class="muted">${r.players}/${r.max_players} jogadores · ${r.map_key}</span></div><button class="primary" data-join="${r.code}">Entrar</button></div>`).join(''):'<p class="muted">Nenhuma sala aberta.</p>';}catch(e){}}
async function createRoom(){ try{const d=await api('/api/rooms',{method:'POST',body:JSON.stringify({maxPlayers:4,mapKey:'taverna',rules:{specialCards:true}})}); alert(`Sala criada: ${d.room.code}`); loadRooms();}catch(e){alert(e.message)} }
function connect(){ if(state.socket) return; state.socket=io({auth:{token:state.token}}); state.socket.on('connect_error',()=>{}); }

document.addEventListener('click', async e=>{
  const tab=e.target.closest('[data-auth]'); if(tab){state.mode=tab.dataset.auth; document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));tab.classList.add('active');return}
  const nav=e.target.closest('[data-page]'); if(nav){document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active'));nav.classList.add('active');document.querySelectorAll('.page').forEach(x=>x.classList.add('hidden'));$('#'+nav.dataset.page).classList.remove('hidden');if(nav.dataset.page==='online')loadRooms();return}
  const action=e.target.closest('[data-action]'); if(action&&action.dataset.action==='online'){document.querySelector('[data-page="online"]').click();return}
  const join=e.target.closest('[data-join]'); if(join){try{await api(`/api/rooms/${join.dataset.join}/join`,{method:'POST'}); alert('Você entrou na sala.');}catch(err){alert(err.message)}return}
});
$('#authForm').addEventListener('submit',submitAuth); $('#createRoom').addEventListener('click',createRoom);
$('#logout').addEventListener('click',()=>{localStorage.removeItem('uv_token');location.reload()});
$('#saveCharacter').addEventListener('click',()=>alert('Base pronta para a personalização persistente.'));
$('#sendCommand').addEventListener('click',async()=>{try{const d=await api('/api/admin/command',{method:'POST',body:JSON.stringify({command:$('#adminCommand').value})});$('#adminOutput').textContent=JSON.stringify(d,null,2)}catch(e){$('#adminOutput').textContent=e.message}});
