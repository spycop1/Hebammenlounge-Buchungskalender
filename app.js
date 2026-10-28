/* Hebammen Lounge – static GitHub Pages client. No dependencies / CDN / service secrets.
   Server is authoritative for roles, tariffs, conflict handling and booking times. */
(() => {
'use strict';
const cfg = window.LOUNGE_CONFIG || {};
const url = String(cfg.supabaseUrl || '').replace(/\/$/, '');
const key = String(cfg.supabaseKey || '');
const ready = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) && key.length > 20 && !key.includes('HIER_');
const pageAdmin = document.body.dataset.mode === 'admin';
const $ = (selector) => document.querySelector(selector);
const app = $('#app');
const t = (value) => String(value ?? '');
const esc = (value) => t(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = (cents) => new Intl.NumberFormat('de-DE', {style:'currency', currency:'EUR'}).format((Number(cents) || 0) / 100);
const kindNames = {hourly:'Stundenweise', day:'Ganztägig', weekend:'Wochenende', block:'Gesperrt'};
const pad = (n) => String(n).padStart(2, '0');
function partsBerlin(d = new Date()) {
  const values = new Intl.DateTimeFormat('de-DE', {timeZone:'Europe/Berlin', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(d);
  const p = Object.fromEntries(values.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const today = () => partsBerlin();
const addDays = (iso, count) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + count); return d.toISOString().slice(0,10); };
const firstMonth = (iso) => iso.slice(0,7) + '-01';
const addMonths = (iso, count) => { const d = new Date(`${firstMonth(iso)}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth()+count); return d.toISOString().slice(0,7) + '-01'; };
const monthLabel = (iso) => new Intl.DateTimeFormat('de-DE', {month:'long', year:'numeric', timeZone:'UTC'}).format(new Date(`${firstMonth(iso)}T12:00:00Z`));
const dayLabel = (iso) => new Intl.DateTimeFormat('de-DE', {weekday:'long', day:'2-digit', month:'long', timeZone:'UTC'}).format(new Date(`${iso}T12:00:00Z`));
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
const formatDate = (timestamp) => new Intl.DateTimeFormat('de-DE', {day:'2-digit', month:'2-digit', year:'numeric', timeZone:'Europe/Berlin'}).format(new Date(timestamp));
const formatTime = (timestamp) => new Intl.DateTimeFormat('de-DE', {hour:'2-digit', minute:'2-digit', timeZone:'Europe/Berlin'}).format(new Date(timestamp));
const localDay = (timestamp) => partsBerlin(new Date(timestamp));
const sumCents = (rows) => rows.reduce((acc, r) => acc + Number(r.gross_cents || 0), 0);
const byStart = (a,b) => a.starts_at.localeCompare(b.starts_at);
const inDay = (r, day) => localDay(r.starts_at) <= day && localDay(new Date(new Date(r.ends_at).getTime() - 1)) >= day;
const isUpcoming = (r) => new Date(r.starts_at).getTime() > Date.now();
const nameOf = (id) => state.people.find(p => p.id === id)?.display_name || 'Kollegin';
const title = (kind) => kindNames[kind] || kind;
const hoursLabel = (r) => r.kind === 'weekend' ? 'Sa 08:00 – So 22:00' : `${formatTime(r.starts_at)} – ${formatTime(r.ends_at)}`;
const STORAGE = 'hebammen_lounge_auth_v1';
let state = {
  session:null, profile:null, people:[], reservations:[], busy:[], rates:[], monthly:[], invoices:[], closedMonths:[],
  section:'overview', month:firstMonth(today()), selected:today(),
  otpEmail:'', otpSent:false, loading:false, overlay:false, error:'', message:''
};
try { state.session = JSON.parse(sessionStorage.getItem(STORAGE) || 'null'); } catch { state.session=null; }
let refreshPromise=null;
function saveSession(value) { state.session=value; if(value) sessionStorage.setItem(STORAGE,JSON.stringify(value)); else sessionStorage.removeItem(STORAGE); }
function problem(error, fallback='Die Anfrage ist fehlgeschlagen.') {
  const info = t(error?.message || error?.msg || error?.error_description || error?.error || fallback);
  if (error?.code === '23P01') return 'Der Zeitraum ist bereits belegt. Bitte neu auswählen.';
  if (error?.status === 429) return 'Zu viele Anfragen. Bitte später erneut versuchen.';
  return info;
}
async function postAuth(path, body, accessToken=null) {
  const response = await fetch(`${url}/auth/v1/${path}`, {
    method:'POST', headers:{'apikey':key,'Content-Type':'application/json', ...(accessToken ? {'Authorization':`Bearer ${accessToken}`} : {})},
    body:JSON.stringify(body)
  });
  let data = {}; try {data=await response.json();} catch {}
  if (!response.ok) throw Object.assign(new Error(problem(data)), {status:response.status, code:data.code});
  return data;
}
async function refreshSession() {
  if(refreshPromise) return refreshPromise;
  refreshPromise=(async()=>{
    if(!state.session?.refresh_token) { saveSession(null); throw new Error('Bitte erneut anmelden.'); }
    try {
      const result=await postAuth('token?grant_type=refresh_token',{refresh_token:state.session.refresh_token});
      saveSession({...result, expires_at:Math.floor(Date.now()/1000)+result.expires_in});
    } catch (e) { saveSession(null); throw e; }
  })();
  try {await refreshPromise;} finally {refreshPromise=null;}
}
async function api(path, method='GET', data=undefined, retry=true) {
  if (!state.session) throw new Error('Bitte anmelden.');
  if ((state.session.expires_at || 0) < Date.now()/1000 + 75) await refreshSession();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method, headers: {'apikey':key, 'Authorization':`Bearer ${state.session.access_token}`, 'Content-Type':'application/json'},
    ...(data === undefined ? {} : {body:JSON.stringify(data)})
  });
  if(response.status===401 && retry) { await refreshSession(); return api(path,method,data,false); }
  let result; try {result=await response.json();} catch {result=null;}
  if(!response.ok) throw Object.assign(new Error(problem(result)), {code:result?.code,status:response.status});
  return result;
}
const rpc = (fn,args) => api(`rpc/${fn}`,'POST',args);
async function fetchProfile() {
  const id=state.session?.user?.id;
  if (!id) {saveSession(null);return;}
  const rows=await api(`profiles?id=eq.${encodeURIComponent(id)}&select=id,display_name,email,role,active,billing_name,billing_street,billing_postal_code,billing_city`);
  state.profile=rows?.[0] || null;
}
async function fetchData() {
  const month=state.month;
  const first=new Date(`${month}T12:00:00Z`).getUTCDay();
  const calBegin=addDays(month,-((first+6)%7));
  const calEnd=addDays(calBegin,42);
  const rangeBegin = encodeURIComponent(`${calBegin}T00:00:00Z`);
  const rangeEnd = encodeURIComponent(`${addDays(calEnd,1)}T00:00:00Z`);
  const jobs=[
    api(`tariffs?select=kind,gross_cents`),
    rpc('busy_slots',{p_from:calBegin,p_to:calEnd}),
    api(`reservations?select=id,profile_id,kind,starts_at,ends_at,gross_cents,status,note&status=eq.confirmed&ends_at=gt.${rangeBegin}&starts_at=lt.${rangeEnd}&order=starts_at.asc`)
  ];
  if(pageAdmin) {
    jobs.push(api('profiles?select=id,display_name,email,role,active,billing_name,billing_street,billing_postal_code,billing_city&order=display_name.asc'));
    jobs.push(rpc('admin_monthly_bookings',{p_month:month}));
    jobs.push(rpc('admin_month_invoices',{p_month:month}));
    jobs.push(api(`invoice_months?select=month&month=eq.${month}`));
  }
  const results=await Promise.all(jobs);
  [state.rates,state.busy,state.reservations]=results.slice(0,3);
  if(pageAdmin){state.people=results[3] || [];state.monthly=results[4] || [];state.invoices=results[5] || [];state.closedMonths=results[6] || [];}
}
// Supabase Magic Links return session credentials in the URL fragment (implicit flow).
// Remove them from the address bar BEFORE network access or rendering.
async function consumeMagicLink() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const search = new URLSearchParams(window.location.search);
  const callback = hash.has('access_token') || hash.has('error') || search.has('error');
  if (!callback) return;
  const accessToken = hash.get('access_token');
  const refreshToken = hash.get('refresh_token');
  const expiresIn = Number(hash.get('expires_in'));
  const authFailed = hash.has('error') || search.has('error');
  window.history.replaceState(null, '', window.location.pathname);
  if (authFailed) throw new Error('Der Anmeldelink ist ungültig oder abgelaufen. Bitte einen neuen Link anfordern.');
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0)
    throw new Error('Der Anmeldelink war unvollständig. Bitte einen neuen Link anfordern.');
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {'apikey':key, 'Authorization':`Bearer ${accessToken}`}, cache:'no-store'
  });
  if (!response.ok) throw new Error('Der Anmeldelink konnte nicht bestätigt werden. Bitte einen neuen Link anfordern.');
  const user = await response.json();
  if (!user || !user.id) throw new Error('Die E-Mail-Anmeldung konnte nicht bestätigt werden.');
  saveSession({access_token:accessToken,refresh_token:refreshToken,expires_in:expiresIn,
    expires_at:Math.floor(Date.now()/1000)+expiresIn,user});
  state.otpSent=false;
  state.message='Anmeldung über E-Mail-Link erfolgreich.';
  state.error='';
}
async function start() {
  if(!ready) { app.innerHTML=`<div class="auth-wrap"><div class="auth-card"><div class="brand"><span class="brand-icon">H</span><span class="brand-text">Hebammen Lounge</span></div><h1>Einrichtung erforderlich</h1><p>Die öffentliche Supabase-Projekt-URL und der Publishable-/Anon-Key fehlen noch in <code>config.js</code>. Bitte zunächst die Anleitung lesen.</p><div class="notice warn">Keinen Secret-, Service-Role- oder MIYA-Schlüssel in GitHub ablegen.</div></div></div>`;return; }
  try { await consumeMagicLink(); } catch(e) { state.error=problem(e); }
  if(state.session) {
    try { await fetchProfile(); if(state.profile?.active && (!pageAdmin || state.profile.role==='admin')) await fetchData(); }
    catch(e) {state.error=problem(e);if(!state.session)state.profile=null;}
  }
  render();
}
function brand() { return `<a class="brand" href="./index.html"><span class="brand-icon">H</span><span class="brand-text">Hebammen Lounge<small>Praxis buchen & verwalten</small></span></a>`; }
function notice() {return state.error ? `<div class="notice error" role="alert">${esc(state.error)}</div>` : state.message ? `<div class="notice ok" role="status">${esc(state.message)}</div>` : '';}
function loginView() {
  const email=esc(state.otpEmail);
  return `<div class="auth-wrap"><div class="auth-card">${brand()}
    <div class="eyebrow">${pageAdmin?'Vickys Verwaltung':'Für unsere Kolleginnen'}</div><h1>Willkommen.</h1><p>Melde dich über einen sicheren Link per E-Mail an. Neue Kolleginnen müssen zuerst freigegeben werden.</p>
    ${notice()}
    ${!state.otpSent ? `<form id="send-otp"><div class="field"><label for="email">E-Mail-Adresse</label><input id="email" name="email" type="email" autocomplete="email" maxlength="250" placeholder="du@beispiel.de" value="${email}" required></div><button class="btn wide" type="submit" ${state.loading?'disabled':''}>Anmeldelink anfordern</button></form>` :
    `<form id="verify-otp"><p class="small">E-Mail gesendet an <strong>${email}</strong>. Öffne den Anmeldelink im Browser. Falls du stattdessen einen Zahlencode erhältst, kannst du ihn hier eingeben.</p><div class="field"><label for="token">6-stelligen E-Mail-Code eingeben</label><input id="token" name="token" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="123456" required></div><button class="btn wide" type="submit" ${state.loading?'disabled':''}>Anmelden</button></form><button class="link back" data-action="change-email">Andere E-Mail verwenden</button>`}
    <div class="footer">Nur für berechtigte Nutzerinnen · Keine Patientinnendaten eingeben.</div>
  </div></div>`;
}
function restrictedView() {
  const p=state.profile;
  if(!p) return `<div class="auth-wrap"><div class="auth-card">${brand()}<h1>Profil wird eingerichtet.</h1>${notice()}<p>Bitte Seite erneut laden. Falls das Problem bleibt, die Verwaltung kontaktieren.</p><button class="btn" data-action="reload">Neu laden</button></div></div>`;
  if(!p.display_name || p.display_name.trim().length<2) return `<div class="auth-wrap"><div class="auth-card">${brand()}<h1>Wie heißt du?</h1><p>Bitte deinen Namen für die Buchung und Monatsübersicht hinterlegen.</p>${notice()}<form id="save-name"><div class="field"><label for="name">Vor- und Nachname</label><input type="text" id="name" name="name" minlength="2" maxlength="120" required autocomplete="name"></div><button class="btn wide" type="submit">Namen speichern</button></form><button class="link back" data-action="logout">Abmelden</button></div></div>`;
  if(!p.active) return `<div class="auth-wrap"><div class="auth-card">${brand()}<h1>Freigabe ausstehend.</h1><p>Hallo ${esc(p.display_name)}! Vicky muss deinen Zugang erst freigeben. Bis dahin sind keine Buchungen möglich.</p>${notice()}<button class="btn" data-action="reload">Status aktualisieren</button> <button class="btn outline" data-action="logout">Abmelden</button></div></div>`;
  if(!pageAdmin && p.active && (!p.billing_name || !p.billing_street || !p.billing_postal_code || !p.billing_city))
    return `<div class="auth-wrap"><div class="auth-card">${brand()}<h1>Deine Rechnungsanschrift.</h1><p>Vor der ersten Reservierung benötigen wir deine Rechnungsadresse. Rechnungen werden nach dem Monatsabschluss an die bestätigte Anmelde-E-Mail ${esc(p.email)} gesendet.</p>${notice()}${billingForm()}<button class="link back" data-action="logout">Abmelden</button></div></div>`;
  if(pageAdmin && p.role!=='admin') return `<div class="auth-wrap"><div class="auth-card">${brand()}<h1>Kein Admin-Zugang.</h1><p>Dieser Bereich ist ausschließlich für Vicky freigegeben. Die Berechtigung wird serverseitig geprüft.</p><a class="btn" href="./index.html">Zum Buchungskalender</a> <button class="btn outline" data-action="logout">Abmelden</button></div></div>`;
  return null;
}
function rate(kind) {return Number(state.rates.find(r=>r.kind===kind)?.gross_cents || {hourly:1600,day:12000,weekend:30000}[kind]);}
function stat(label,value,detail) {return `<article class="stat"><label>${esc(label)}</label><b>${esc(value)}</b><span>${esc(detail)}</span></article>`;}
function priceCards() {return `<div class="prices"><div class="price"><small>Stundenweise · 08–22 Uhr</small><b>${money(rate('hourly'))}</b><small>Pro voller Stunde</small></div><div class="price"><small>Ganztägig · 08–22 Uhr</small><b>${money(rate('day'))}</b><small>Festpreis für 14 Stunden</small></div><div class="price"><small>Wochenende · Sa 08 – So 22 Uhr</small><b>${money(rate('weekend'))}</b><small>Feste Wochenendpauschale</small></div></div>`;}
function nav() {
  const items=pageAdmin ? [['overview','Übersicht'],['calendar','Kalender'],['bookings','Buchungen'],['people','Kolleginnen'],['billing','Monatsauswertung'],['address','Meine Rechnungsadresse']] :
    [['overview','Übersicht'],['calendar','Kalender'],['bookings','Meine Buchungen'],['prices','Preise & Regeln'],['address','Rechnungsadresse']];
  return `<nav class="menu" aria-label="Hauptmenü">${items.map(([id,label])=>`<button type="button" data-action="section" data-value="${id}" ${state.section===id?'aria-current="page"':''}>${label}</button>`).join('')}</nav>`;
}
function shell() {
  const p=state.profile;
  const initials=p.display_name.split(/\s+/).slice(0,2).map(s=>s[0]||'').join('').toUpperCase();
  return `<div class="shell"><aside class="sidebar">${brand()}${nav()}<div class="side-foot"><strong>Hebammen Lounge</strong><p>Die gesamte Praxis ist eine buchbare Einheit. Zeiten: täglich 08–22 Uhr.</p><span class="pill">${pageAdmin?'Administration':'Kolleginnen-Zugang'}</span></div></aside>
  <div class="content"><header class="top"><span class="small muted">${pageAdmin?'Verwaltung · Vicky':'Praxisbuchung · Kolleginnen'}</span><div class="who">${!pageAdmin && p.role==='admin' ? '<a class="btn tiny outline" href="./admin.html">Admin-Dashboard</a>' : ''}<span class="avatar">${esc(initials)}</span><div><strong>${esc(p.display_name)}</strong><br><small class="muted">${esc(p.email)}</small></div><button class="btn tiny outline" data-action="logout">Abmelden</button></div></header>
  <main class="page">${notice()}${view()}<footer class="footer">Hebammen Lounge · Buchungen nur nach Anmeldung · Zeitangaben Europe/Berlin · Beträge brutto · Monatsrechnungen per E-Mail nach Vickys Abschluss · MIYA-Daten als CSV</footer></main></div></div>${state.overlay?bookingModal():''}`;
}
function view(){ switch(state.section){case 'calendar':return calendarPage();case 'bookings':return bookingsPage();case 'prices':return pricesPage();case 'address':return billingAddressPage();case 'people':return peoplePage();case 'billing':return billingPage();default:return overviewPage();} }
function primaryAction() {return `<button class="btn" data-action="open-book">+ Praxis buchen</button>`;}
function overviewPage() {
  const monthRows=pageAdmin?state.monthly:state.reservations.filter(r=>localDay(r.starts_at).startsWith(state.month.slice(0,7)));
  const upcoming=state.reservations.filter(isUpcoming).sort(byStart).slice(0,5);
  const first=pageAdmin ? [stat('Monatsumsatz brutto',money(sumCents(monthRows)),'Bestätigte Buchungen'),stat('Buchungen',monthRows.length,monthLabel(state.month)),stat('Kolleginnen',state.people.filter(p=>p.active && p.role==='colleague').length,'Freigeschaltet'),stat('Praxis-Einheiten','1','Gesamte Praxis')]
  : [stat('Meine Buchungen',monthRows.length,monthLabel(state.month)),stat('Meine Kosten',money(sumCents(monthRows)),'Im gewählten Monat'),stat('Nächste Termine',upcoming.length,'Im Kalenderzeitraum'),stat('Praxis-Einheiten','1','Gesamte Praxis')];
  return `<div class="hero"><div><div class="eyebrow">${pageAdmin?'Verwaltung & Auswertung':'Herzlich willkommen'}</div><h1>${pageAdmin?'Alles im Blick, Vicky.':'Dein Platz in der Lounge.'}</h1><p class="muted">${pageAdmin?'Alle Reservierungen, Zugänge und Monatsbeträge zentral verwalten.':'Finde freie Zeiten und reserviere die ganze Praxis für deine Arbeit.'}</p><div class="toolbar" class="margin-top-16">${primaryAction()}</div></div><span class="callout-icon" aria-hidden="true">✳</span></div>
    <div class="stats">${first.join('')}</div><div class="cols"><section class="panel"><div class="panel-title"><div><h2>Anstehende Buchungen</h2><p class="small muted">${pageAdmin?'Alle Termine im ausgewählten Kalender':'Deine persönlichen Reservierungen'}</p></div><button class="btn tiny outline" data-action="section" data-value="bookings">Alle ansehen</button></div>
    ${upcoming.length?upcoming.map(r=>agenda(r)).join(''):`<div class="empty">Keine anstehenden Buchungen in der Übersicht.</div>`}</section>
    <section class="panel"><div class="panel-title"><h2>Unsere Konditionen</h2></div>${priceCards()}<div class="notice">Es wird ausschließlich die gesamte Praxis reserviert – keine Einzelräume.</div></section></div>`;
}
function agenda(r) {return `<div class="agenda-row"><div><strong>${pageAdmin ? esc(r.kind==='block'?'Praxis gesperrt':nameOf(r.profile_id)) : 'Gesamte Praxis'} · ${esc(title(r.kind))}</strong><small>${esc(formatDate(r.starts_at))} · ${esc(hoursLabel(r))}</small></div><strong>${r.kind==='block'?'–':money(r.gross_cents)}</strong></div>`;}
function calendarRange(){
  const first=new Date(`${state.month}T12:00:00Z`).getUTCDay();
  return addDays(state.month,-((first+6)%7));
}
function calendarPage(){
  const start=calendarRange();
  const days=['Mo','Di','Mi','Do','Fr','Sa','So'].map(s=>`<div class="weekday">${s}</div>`).join('');
  const grid=Array.from({length:42},(_,i)=>{
    const d=addDays(start,i);
    const occupied=state.busy.filter(r=>inDay(r,d));
    const mine=state.reservations.filter(r=>inDay(r,d));
    const tag=mine.length ? (pageAdmin?`${mine.length} Reservierung(en)`:'Meine Buchung') : occupied.length ? 'Belegt / teilweise' : 'Frei';
    const cl=mine.length ? 'mine' : occupied.length ? 'busy' : '';
    return `<button class="calday ${!d.startsWith(state.month.slice(0,7))?'out':''} ${d===state.selected?'selected':''}" data-action="day" data-value="${d}" aria-pressed="${d===state.selected}"><span class="date-number">${Number(d.slice(-2))}</span><span class="flag ${cl}">${esc(tag)}</span></button>`;
  }).join('');
  const dailyBusy=state.busy.filter(r=>inDay(r,state.selected));
  const dailyRows=state.reservations.filter(r=>inDay(r,state.selected));
  return `<div class="page-head"><div><div class="eyebrow">Praxisplanung</div><h1>Belegungskalender.</h1><p class="muted">Alle Zeiten gelten für die gesamte Praxis.</p></div>${primaryAction()}</div>
    <div class="panel"><div class="panel-title"><div><h2>${esc(monthLabel(state.month))}</h2><p class="muted small">Freie und belegte Zeiträume</p></div><div class="toolbar"><button class="btn tiny outline" data-action="month-prev" aria-label="Vorheriger Monat">‹</button><button class="btn tiny outline" data-action="month-now">Heute</button><button class="btn tiny outline" data-action="month-next" aria-label="Nächster Monat">›</button></div></div>
    <div class="split"><div class="calendar" aria-label="Monatskalender">${days}${grid}</div><aside><div class="eyebrow">Tagesübersicht</div><h3>${esc(dayLabel(state.selected))}</h3><p class="muted small">Alle Belegungen (ohne fremde Personendaten)</p><div class="stack" class="margin-top-13">${!dailyBusy.length?'<div class="notice ok">Noch keine Reservierungen.</div>':dailyBusy.map(slot=>{
       const own=dailyRows.find(row=>row.starts_at===slot.starts_at && row.ends_at===slot.ends_at);
       return `<div class="booking-slot"><strong>${own?(pageAdmin?esc(own.kind==='block'?'Gesperrt':nameOf(own.profile_id)):'Deine Buchung'):'Belegt'}</strong><small>${esc(formatTime(slot.starts_at))} – ${esc(formatTime(slot.ends_at))}</small></div>`;
     }).join('')}</div><div class="toolbar" class="margin-top-16"><button class="btn" data-action="open-book">Datum buchen</button>${pageAdmin?`<button class="btn outline" data-action="block-day">Tag sperren</button>`:''}</div></aside></div></div><div class="notice">Tagesbuchung 08–22 Uhr · Wochenende Samstag 08 Uhr bis Sonntag 22 Uhr · Stundenbuchungen in vollen Stunden. Teilüberschneidungen sind nicht möglich.</div>`;
}
function bookingsPage(){
  const rows=[...state.reservations].sort(byStart).reverse();
  return `<div class="page-head"><div><div class="eyebrow">Reservierungen</div><h1>${pageAdmin?'Alle Buchungen.':'Meine Buchungen.'}</h1><p class="muted">Bestätigte Buchungen im angezeigten Kalenderzeitraum (${esc(monthLabel(state.month))}).</p></div>${primaryAction()}</div>
  <div class="panel"><div class="panel-title"><h2>Terminübersicht</h2><div class="toolbar"><button class="btn tiny outline" data-action="month-prev">‹</button><span class="small">${esc(monthLabel(state.month))}</span><button class="btn tiny outline" data-action="month-next">›</button></div></div><div class="table-wrap"><table><thead><tr><th>Datum</th>${pageAdmin?'<th>Kollegin</th>':''}<th>Tarif</th><th>Uhrzeit</th><th>Brutto</th><th>Aktion</th></tr></thead><tbody>${rows.length?rows.map(r=>`<tr><td><strong>${esc(formatDate(r.starts_at))}</strong></td>${pageAdmin?`<td>${r.kind==='block'?'Sperrung':esc(nameOf(r.profile_id))}</td>`:''}<td>${esc(title(r.kind))}</td><td>${esc(hoursLabel(r))}</td><td>${r.kind==='block'?'–':money(r.gross_cents)}</td><td>${isUpcoming(r)?`<button class="btn tiny danger" data-action="cancel" data-value="${r.id}">Stornieren</button>`:'–'}</td></tr>`).join(''):`<tr><td colspan="${pageAdmin?6:5}" class="empty">Keine Buchungen für diesen Zeitraum.</td></tr>`}</tbody></table></div></div>`;
}
function pricesPage(){return `<div class="page-head"><div><div class="eyebrow">Preise & Nutzung</div><h1>Einfach und transparent.</h1><p class="muted">Eine Buchung umfasst immer die gesamte Praxis.</p></div></div><div class="panel">${priceCards()}</div><div class="panel"><h2>Wichtige Hinweise</h2><div class="notice">Buchungen sind verbindliche Reservierungen. Eine konkrete Stornierungsfrist und eventuell anfallende Gebühren sind noch rechtlich und organisatorisch festzulegen. Bis dahin lässt die Software Stornierungen nur vor Buchungsbeginn zu.</div><p class="muted">Nach Vickys Monatsabschluss erstellt das Portal eine Rechnung und sendet sie an die bestätigte Anmelde-E-Mail. Der MIYA-Export bleibt separat; keine automatische MIYA-Schnittstelle.</p></div>`;}
function billingForm(){const p=state.profile || {};return `<form id="save-billing"><div class="field"><label for="billingName">Rechnungsempfängerin / Praxisname</label><input id="billingName" name="name" autocomplete="organization" maxlength="160" minlength="3" value="${esc(p.billing_name||p.display_name||'')}" required></div><div class="field"><label for="billingStreet">Straße und Hausnummer</label><input id="billingStreet" name="street" autocomplete="street-address" minlength="4" maxlength="180" value="${esc(p.billing_street)}" required></div><div class="fieldgrid"><div class="field"><label for="billingPostal">PLZ</label><input id="billingPostal" name="postal" autocomplete="postal-code" minlength="3" maxlength="16" value="${esc(p.billing_postal_code)}" required></div><div class="field"><label for="billingCity">Ort</label><input id="billingCity" name="city" autocomplete="address-level2" minlength="2" maxlength="100" value="${esc(p.billing_city)}" required></div></div><button type="submit" class="btn" ${state.loading?'disabled':''}>Rechnungsanschrift speichern</button></form>`;}
function billingAddressPage(){return `<div class="page-head"><div><div class="eyebrow">Rechnungsdaten</div><h1>Deine Rechnungsanschrift.</h1><p class="muted">Für deine monatliche Praxisrechnung. Versand ausschließlich an deine bestätigte Anmelde-E-Mail ${esc(state.profile.email)}.</p></div></div><section class="panel">${billingForm()}</section>`;}
function peoplePage(){
  if(!pageAdmin)return '';
  return `<div class="page-head"><div><div class="eyebrow">Zugänge</div><h1>Kolleginnen verwalten.</h1><p class="muted">Neue Anmeldungen zuerst prüfen und dann freigeben.</p></div></div><div class="panel"><div class="notice warn">Die E-Mail-Anmeldung erzeugt noch kein Buchungsrecht. Erst deine Freigabe aktiviert einen Zugang. Prüfe Identität und Berechtigung vorher.</div><div class="table-wrap"><table><thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Adresse</th><th>Status</th><th>Aktion</th></tr></thead><tbody>${state.people.map(p=>`<tr><td><strong>${esc(p.display_name||'(Name fehlt)')}</strong></td><td>${esc(p.email)}</td><td>${p.role==='admin'?'Admin':'Kollegin'}</td><td>${p.billing_name && p.billing_street && p.billing_postal_code && p.billing_city?'Vollständig':'Fehlt'}</td><td><span class="pill ${p.active?'':'wait'}">${p.active?'Freigeschaltet':'Wartet'}</span></td><td>${p.role==='admin'?'Geschützt':`<button class="btn tiny ${p.active?'danger':'outline'}" data-action="set-active" data-value="${p.id}" data-active="${p.active?'false':'true'}">${p.active?'Sperren':'Freigeben'}</button>`}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">Keine Profile.</td></tr>'}</tbody></table></div></div>`;
}
function billingPage(){
  if(!pageAdmin)return '';
  const map=new Map();
  for(const r of state.monthly){
    const x=map.get(r.profile_id)||{name:r.display_name,email:r.email,count:0,cents:0,hours:0};
    x.count++;x.cents+=Number(r.gross_cents);x.hours+=durationOf(r);map.set(r.profile_id,x);
  }
  const rows=[...map.values()].sort((a,b)=>a.name.localeCompare(b.name,'de'));
  const alreadyClosed=state.closedMonths.length>0;
  const canClose=state.month<firstMonth(today()) && !alreadyClosed;
  const pending=state.invoices.filter(i=>i.status==='pending').length;
  const dispatched=state.invoices.filter(i=>i.status==='sent').length;
  const reviews=state.invoices.filter(i=>i.status==='review'||i.status==='sending').length;
  const statusText={pending:'Ausstehend',sending:'In Bearbeitung – prüfen',sent:'An WEB.DE übergeben',failed:'Fehlgeschlagen',review:'Versand unklar – manuell prüfen'};
  return `<div class="page-head"><div><div class="eyebrow">Monatsabschluss & Rechnungen</div><h1>Monatsauswertung.</h1><p class="muted">Bruttobeträge für bestätigte Buchungen, gruppiert nach Kollegin.</p></div><div class="toolbar"><button class="btn tiny outline" data-action="month-prev">‹</button><strong>${esc(monthLabel(state.month))}</strong><button class="btn tiny outline" data-action="month-next">›</button></div></div>
  <div class="stats">${stat('Monatsbetrag',money(sumCents(state.monthly)),'Brutto')}${stat('Buchungen',state.monthly.length,'Ohne Stornierungen')}${stat('Kolleginnen',rows.length,'Mit Buchungen')}${stat('Rechnungsversand',alreadyClosed?`${dispatched}/${state.invoices.length} gesendet`:'Noch offen',alreadyClosed?'Abgeschlossener Monat':'Noch kein Abschluss')}</div>
  <section class="panel"><div class="panel-title"><div><h2>Abrechnung je Kollegin</h2><p class="muted small">Buchungen zählen zum Monat ihres Beginns (Zeitzone Berlin).</p></div><div class="toolbar"><button class="btn outline tiny" data-action="export-summary">Summen-CSV</button><button class="btn tiny" data-action="export-detail">Einzelbuchungen-CSV</button></div></div>
  <div class="table-wrap"><table><thead><tr><th>Kollegin</th><th>E-Mail</th><th>Buchungen</th><th>Nutzungsstunden</th><th>Bruttobetrag</th></tr></thead><tbody>${rows.length?rows.map(r=>`<tr><td><strong>${esc(r.name)}</strong></td><td>${esc(r.email)}</td><td>${r.count}</td><td>${r.hours.toLocaleString('de-DE')} h</td><td><strong>${money(r.cents)}</strong></td></tr>`).join(''):'<tr><td colspan="5" class="empty">Keine bestätigten Buchungen in diesem Monat.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><div class="panel-title"><div><h2>Monat abschließen & Rechnungen verschicken</h2><p class="muted small">Rechnungen mit PDF-Anhang werden an die bestätigten Anmelde-E-Mail-Adressen versendet. Geschlossene Monate sind endgültig; bei Versandfehlern bleibt der Status sichtbar.</p></div></div>
  ${alreadyClosed?`<div class="notice ok">Dieser Monat wurde abgeschlossen. ${dispatched} Rechnung(en) an WEB.DE übergeben.${reviews?' Achtung: '+reviews+' Versandvorgang/Vorgänge müssen geprüft werden.':''}</div>`:
    `<div class="notice warn">Vor dem ersten Abschluss: Absenderdaten und Umsatzsteuer beim Steuerberater klären, PDF-Rechnungsformat/E-Rechnungspflicht prüfen und den WEB.DE-SMTP-Zugang in Supabase sicher einrichten.</div>`}
  <div class="toolbar">${canClose?`<button class="btn" data-action="close-month" ${state.loading?'disabled':''}>Monat abschließen & Rechnungen senden</button>`:''}
  ${alreadyClosed && pending?`<button class="btn" data-action="continue-invoices" ${state.loading?'disabled':''}>Weitere ${pending} Rechnung(en) senden</button>`:''}
  ${!alreadyClosed && !canClose?'<p class="muted small">Abschluss erst ab dem Folgemonat möglich.</p>':''}</div>
  ${alreadyClosed?`<div class="table-wrap"><table><thead><tr><th>Rechnung</th><th>Empfängerin</th><th>Brutto</th><th>Versand</th><th>Aktion</th></tr></thead><tbody>${state.invoices.map(i=>`<tr><td>${esc(i.invoice_number)}</td><td>${esc(i.recipient_name)}<br><small class="muted">${esc(i.recipient_email)}</small></td><td>${money(i.gross_cents)}</td><td>${esc(statusText[i.status]||i.status)}${i.last_error?`<div class="small muted">${esc(i.last_error)}</div>`:''}</td><td><div class="toolbar">${i.pdf_path?`<button class="btn tiny outline" data-action="download-invoice" data-value="${i.id}">PDF</button>`:''}${i.status==='failed'?`<button class="btn tiny outline" data-action="retry-invoice" data-value="${i.id}">Erneut senden</button>`:''}</div></td></tr>`).join('')||'<tr><td colspan="5">Keine Rechnungen für diesen Monat.</td></tr>'}</tbody></table></div>`:''}</section>
  <div class="notice warn"><strong>MIYA-Hinweis:</strong> Diese Rechnungen werden vom Portal erstellt und nicht automatisch in MIYA angelegt. CSV-Daten zur separaten Buchhaltung bleiben verfügbar. PDF ist keine strukturierte E-Rechnung (XRechnung/ZUGFeRD). Keine doppelte Rechnung in MIYA ausstellen!</div>`;
}
function durationOf(r) {
  if(r.kind==='day')return 14;
  if(r.kind==='weekend')return 38; // contractual time, independent of DST switch
  return Math.round((new Date(r.ends_at)-new Date(r.starts_at))/3600000);
}
function bookingModal() {
 const candidate=state.selected < today()?today():state.selected;
 const options=pageAdmin ? `<div class="field"><label for="forUser">Buchung für</label><select id="forUser" name="forUser" required>${state.people.filter(p=>p.active && p.display_name?.length>=2).map(p=>`<option value="${p.id}">${esc(p.display_name)}${p.role==='admin'?' (Vicky)':''}</option>`).join('')}</select></div>` : '';
 return `<div class="overlay" id="booking-overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="booking-title"><div class="modalheader"><div><div class="eyebrow">Neue Reservierung</div><h2 id="booking-title">Ganze Praxis buchen</h2><p>Tarif, Datum und ggf. Stunden auswählen.</p></div><button class="btn outline tiny" data-action="close-modal" aria-label="Schließen">✕</button></div>
 ${notice()}<form id="create-booking">${options}<div class="field"><label for="kind">Buchungsart</label><select id="kind" name="kind"><option value="hourly">Stundenweise · ${money(rate('hourly'))} / h</option><option value="day">Ganztägig · ${money(rate('day'))}</option><option value="weekend">Wochenende · ${money(rate('weekend'))}</option></select></div>
 <div class="field"><label for="bookDay">Datum (Wochenende: Samstag)</label><input id="bookDay" name="day" type="date" min="${today()}" max="${addDays(today(),730)}" value="${candidate}" required></div>
 <div id="hour-controls" class="fieldgrid"><div class="field"><label for="startTime">Beginn</label><select id="startTime" name="startTime">${Array.from({length:14},(_,i)=>pad(i+8)+':00').map(time=>`<option value="${time}">${time} Uhr</option>`).join('')}</select></div><div class="field"><label for="hours">Dauer</label><select name="hours" id="hours">${Array.from({length:14},(_,i)=>i+1).map(v=>`<option value="${v}">${v} ${v===1?'Stunde':'Stunden'}</option>`).join('')}</select></div></div>
 <div class="quote"><span>Gesamtpreis brutto</span><strong id="live-quote">${money(rate('hourly'))}</strong></div><p class="small muted" id="book-hint">Volle Stunden zwischen 08:00 und 22:00 Uhr.</p><div class="modal-actions"><button type="button" class="btn outline" data-action="close-modal">Abbrechen</button><button type="submit" class="btn" ${state.loading?'disabled':''}>Verbindlich reservieren</button></div></form></div></div>`;
}
function updateQuote() {
 const form=$('#create-booking');if(!form)return;
 const kind=form.kind.value;
 const hourly=kind==='hourly';
 $('#hour-controls').hidden=!hourly;
 
 const hr=Number(form.hours.value),start=Number(form.startTime.value.slice(0,2));
 const valid= !hourly || (Number.isInteger(hr) && hr>=1 && hr<=14 && start+hr<=22);
 $('#live-quote').textContent=valid?money(hourly?rate('hourly')*hr:rate(kind)):'Ungültige Dauer';
 $('#book-hint').textContent=kind==='weekend'?'Beginn Samstag 08:00 Uhr, Ende Sonntag 22:00 Uhr.':kind==='day'?'Ganzer Tag von 08:00 bis 22:00 Uhr.':valid?'Volle Stunden zwischen 08:00 und 22:00 Uhr.':'Der Zeitraum endet nach 22:00 Uhr.';
 const btn=form.querySelector('[type="submit"]'); if(btn)btn.disabled=!valid||state.loading;
}
function render() {
  if(!ready)return;
  if(!state.session) {app.innerHTML=loginView();return;}
  const restricted=restrictedView();
  if(restricted) {app.innerHTML=restricted;return;}
  app.innerHTML=shell();
  if(state.overlay)updateQuote();
}
function toast(message) {
  state.message=message; state.error=''; render();
}
async function wrap(job, success=null) {
  if(state.loading)return;
  state.loading=true;state.error='';state.message='';
  try {await job();if(success)state.message=success;} catch(e) {state.error=problem(e);} finally {state.loading=false;render();}
}
async function reload() {
  await fetchProfile();
  if(state.profile?.active && (!pageAdmin || state.profile?.role==='admin')) await fetchData();
}
function csvSafe(cell) {
  // Excel formula injection mitigation, including leading whitespace and control chars.
  let s=t(cell).replace(/[\r\n\t]/g, ' ');
  if(/^\s*[=+@\-]/.test(s)) s="'"+s;
  return `"${s.replace(/"/g,'""')}"`;
}
function downloadCsv(filename,header,rows) {
  const csv='\ufeff'+[header,...rows].map(row=>row.map(csvSafe).join(';')).join('\r\n')+'\r\n';
  const link=document.createElement('a'),blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const href=URL.createObjectURL(blob);link.href=href;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(href),1500);
}
function exportMonthly(summary) {
  const rows=state.monthly;
  const month=state.month.slice(0,7);
  if(summary){
    const totals=new Map();
    for(const r of rows){const item=totals.get(r.profile_id)||{name:r.display_name,email:r.email,hours:0,count:0,cents:0};item.count++;item.cents+=r.gross_cents;item.hours+=durationOf(r);totals.set(r.profile_id,item);}
    downloadCsv(`Hebammen-Lounge-MIYA-Summen-${month}.csv`,['Kollegin','E-Mail','Buchungen','Nutzungsstunden','Brutto EUR'],[...totals.values()].map(x=>[x.name,x.email,x.count,x.hours,(x.cents/100).toFixed(2).replace('.',',')]));
  } else {
    downloadCsv(`Hebammen-Lounge-Einzelbuchungen-${month}.csv`,['Buchungs-ID','Kollegin','E-Mail','Tarif','Beginn Berlin','Ende Berlin','Brutto EUR'],rows.map(r=>[r.booking_id,r.display_name,r.email,title(r.kind),`${formatDate(r.starts_at)} ${formatTime(r.starts_at)}`,`${formatDate(r.ends_at)} ${formatTime(r.ends_at)}`,(r.gross_cents/100).toFixed(2).replace('.',',')]));
  }
}
async function invokeInvoices(action){
  if(!state.session)throw new Error('Bitte anmelden.');
  if((state.session.expires_at||0)<Date.now()/1000+75)await refreshSession();
  const response=await fetch(`${url}/functions/v1/close-month`,{
    method:'POST',headers:{'apikey':key,'Authorization':`Bearer ${state.session.access_token}`,'Content-Type':'application/json'},
    body:JSON.stringify({month:state.month,action})
  });
  let result={};try{result=await response.json();}catch{}
  if(!response.ok)throw new Error(result.error||'Rechnungsversand ist fehlgeschlagen.');
  return result;
}
async function downloadInvoice(id){
  const item=state.invoices.find(x=>x.id===id);
  if(!item?.pdf_path)throw new Error('Keine archivierte PDF-Datei gefunden.');
  if((state.session.expires_at||0)<Date.now()/1000+75)await refreshSession();
  const target=`${url}/storage/v1/object/authenticated/lounge-invoices/${item.pdf_path.split('/').map(encodeURIComponent).join('/')}`;
  const response=await fetch(target,{headers:{'apikey':key,'Authorization':`Bearer ${state.session.access_token}`}});
  if(!response.ok)throw new Error('PDF-Download ist nicht verfügbar.');
  const blob=await response.blob(),href=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=href;a.download=`Rechnung-${item.invoice_number}.pdf`;a.click();setTimeout(()=>URL.revokeObjectURL(href),2000);
}
async function actionClick(event) {
  const btn=event.target.closest('[data-action]'); if(!btn)return;
  const a=btn.dataset.action, v=btn.dataset.value;
  if(a==='section'){state.section=v;state.error='';state.message='';render();}
  else if(a==='month-prev'||a==='month-next'||a==='month-now'){
    state.month=a==='month-now'?firstMonth(today()):addMonths(state.month,a==='month-prev'?-1:1);
    state.selected=state.month;await wrap(async()=>fetchData());
  } else if(a==='day'){state.selected=v;render();}
  else if(a==='open-book'){state.overlay=true;state.error='';render();}
  else if(a==='close-modal'){state.overlay=false;state.error='';render();}
  else if(a==='change-email'){state.otpEmail='';state.otpSent=false;state.error='';render();}
  else if(a==='reload')await wrap(reload);
  else if(a==='logout'){
    if(state.session?.access_token){try{await postAuth('logout',{},state.session.access_token);}catch{}}
    saveSession(null);state.profile=null;state.otpSent=false;state.error='';state.message='';render();
  } else if(a==='cancel'){
    if(!confirm('Diese Reservierung wirklich stornieren?'))return;
    await wrap(async()=>{await rpc('cancel_reservation',{p_id:v});await fetchData();},'Reservierung storniert.');
  } else if(a==='set-active' && pageAdmin){
    const target=state.people.find(p=>p.id===v);
    if(!target||!confirm(`${target.display_name||target.email} ${btn.dataset.active==='true'?'freigeben':'sperren'}?`))return;
    await wrap(async()=>{await rpc('admin_set_active',{p_user_id:v,p_active:btn.dataset.active==='true'});await fetchData();},'Zugang aktualisiert.');
  } else if(a==='block-day' && pageAdmin){
    if(!confirm(`Gesamte Praxis am ${dayLabel(state.selected)} von 08–22 Uhr sperren?`))return;
    await wrap(async()=>{await rpc('admin_block_day',{p_day:state.selected,p_reason:'Interne Sperrung'});await fetchData();},'Praxis für den Tag gesperrt.');
  } else if(a==='close-month' && pageAdmin){
    if(!confirm(`Monat ${monthLabel(state.month)} endgültig abschließen und alle vorbereiteten Rechnungen per E-Mail versenden? Die Rechnungen werden im Portal erstellt, nicht in MIYA.`))return;
    await wrap(async()=>{const r=await invokeInvoices('close');await fetchData();state.message=`Monat abgeschlossen. ${r.sent} Rechnung(en) an WEB.DE übergeben. Bitte Versandstatus kontrollieren.`;});
  } else if(a==='continue-invoices' && pageAdmin){
    if(!confirm('Ausstehende Monatsrechnungen jetzt versenden?'))return;
    await wrap(async()=>{const r=await invokeInvoices('continue');await fetchData();state.message=`${r.sent} weitere Rechnung(en) an WEB.DE übergeben. Status kontrollieren.`;});
  } else if(a==='retry-invoice' && pageAdmin){
    if(!confirm('Nur nach Prüfung: fehlgeschlagene E-Mail noch einmal senden?'))return;
    await wrap(async()=>{await rpc('admin_retry_failed_invoice',{p_id:v});await invokeInvoices('continue');await fetchData();},'Erneuter Versand angestoßen. Status kontrollieren.');
  } else if(a==='download-invoice' && pageAdmin){
    await wrap(async()=>{await downloadInvoice(v);});
  } else if(a==='export-detail' && pageAdmin) exportMonthly(false);
  else if(a==='export-summary' && pageAdmin) exportMonthly(true);
}
async function submit(event) {
 const form=event.target;if(!form.id)return;
 if(!['send-otp','verify-otp','save-name','save-billing','create-booking'].includes(form.id))return;
 event.preventDefault();
 if(form.id==='send-otp') {
   const email=t(new FormData(form).get('email')).trim().toLowerCase();
   await wrap(async()=>{await postAuth('otp',{email,create_user:true});state.otpEmail=email;state.otpSent=true;},'E-Mail versendet. Bitte den Anmeldelink öffnen.');
 } else if(form.id==='verify-otp') {
   const token=t(new FormData(form).get('token')).trim();
   await wrap(async()=>{
     const response=await postAuth('verify',{email:state.otpEmail,token,type:'email'});
     if(!response.access_token || !response.refresh_token) throw new Error('Anmeldung unvollständig.');
     saveSession({...response,expires_at:Math.floor(Date.now()/1000)+response.expires_in});
     await reload();
   });
 } else if(form.id==='save-name') {
   await wrap(async()=>{await rpc('update_my_name',{p_name:t(new FormData(form).get('name'))});await reload();},'Name gespeichert.');
 } else if(form.id==='save-billing') {
   const f=new FormData(form);
   await wrap(async()=>{await rpc('update_my_billing',{p_name:t(f.get('name')),p_street:t(f.get('street')),p_postal_code:t(f.get('postal')),p_city:t(f.get('city'))});await reload();},'Rechnungsanschrift gespeichert.');
 } else if(form.id==='create-booking') {
   const f=new FormData(form),kind=t(f.get('kind')),day=t(f.get('day'));
   if(kind==='weekend' && weekday(day)!==6){state.error='Für ein Wochenende bitte einen Samstag auswählen.';render();return;}
   const hr=Number(f.get('hours')),start=t(f.get('startTime'));
   if(kind==='hourly' && (Number(start.slice(0,2))+hr>22)){state.error='Die Stundenbuchung darf nicht nach 22 Uhr enden.';render();return;}
   const args={p_kind:kind,p_day:day,p_start_time:kind==='hourly'?`${start}:00`:null,p_hours:kind==='hourly'?hr:null,p_for_user:pageAdmin?t(f.get('forUser')):null};
   await wrap(async()=>{await rpc('book_practice',args);state.overlay=false;state.month=firstMonth(day);state.selected=day;await fetchData();},'Praxis erfolgreich reserviert.');
 }
}
document.addEventListener('click',(event)=>{actionClick(event).catch(e=>{state.error=problem(e);render();});});
document.addEventListener('submit',(event)=>{submit(event).catch(e=>{state.error=problem(e);render();});});
document.addEventListener('change',(event)=>{if(event.target.closest('#create-booking'))updateQuote();});
start();
})();
