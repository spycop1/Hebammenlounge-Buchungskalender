/**
 * Admin-only month close + transactional invoice dispatch.
 * Deploy as Supabase Edge Function, verify_jwt=true (never public/unauthenticated).
 * All vendor secrets and service credentials remain server-side.
 * NOTE: PDF is NOT a structured EN-16931 E-Rechnung (see README). Legal review required.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1';
import nodemailer from 'npm:nodemailer@^9';

const projectUrl = Deno.env.get('SUPABASE_URL') || '';
const publicKey = Deno.env.get('SUPABASE_ANON_KEY') ||
  JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default || '';
// WEB.DE SMTP credentials are Supabase Edge Function secrets, NEVER exposed to GitHub Pages.
const smtpUser = Deno.env.get('WEBDE_SMTP_USER') || '';
const smtpPassword = Deno.env.get('WEBDE_SMTP_PASSWORD') || '';
const smtpHost = 'smtp.web.de';
const smtpPort = 465; // implicit TLS; Supabase blocks outbound port 587
const allowedOrigin = Deno.env.get('INVOICE_ALLOWED_ORIGIN') || '';
const server = createClient(projectUrl, serviceKey, { auth: { persistSession:false, autoRefreshToken:false } });

function cors(req: Request) {
  const origin = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': origin && origin === allowedOrigin ? origin : 'null',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}
function output(req: Request, body: unknown, code=200) {
 return new Response(JSON.stringify(body),{status:code,headers:{...cors(req),'Content-Type':'application/json; charset=utf-8'}});
}
function safe(value: unknown): string { return String(value ?? '').replace(/[\u0000-\u001f]/g,' ').trim(); }
function local(date: string|Date) {return new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(date));}
function localTime(date: string) {return new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(date));}
function eur(cents: number) {return (cents/100).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' EUR';}
function cleanPDF(value: unknown) {
 // Embedded PDF core font has WinAnsi encoding; replace characters outside it.
 return safe(value).replace(/[\u2010-\u2015]/g,'-').replace(/[\u2018\u2019]/g,"'").replace(/[\u201C\u201D]/g,'"')
 .replace(/[\u2022]/g,'*').replace(/[^\u0020-\u007E\u00A0-\u00FF\u20AC]/g,'?');
}
function dateFromInvoice(date: string) { // SQL DATE -> DD.MM.YYYY, without accidental UTC timezone shifting
 return `${date.slice(8,10)}.${date.slice(5,7)}.${date.slice(0,4)}`;
}

type Inv = {
 id:string; invoice_number:string;invoice_date:string;month:string;recipient_email:string;
 recipient_snapshot:{name:string;street:string;postal:string;city:string};
 issuer_snapshot:{name:string;street:string;postal:string;city:string;tax_number:string;iban:string;payment_days:number;tax_exemption_note:string};
 lines_snapshot:{kind:string;starts_at:string;ends_at:string;gross_cents:number}[];
 gross_cents:number;net_cents:number;vat_cents:number;vat_mode:string;
};

async function pdfFor(invoice: Inv): Promise<Uint8Array> {
 const doc=await PDFDocument.create();
 const regular=await doc.embedFont(StandardFonts.Helvetica);
 const bold=await doc.embedFont(StandardFonts.HelveticaBold);
 const pageSize:[number,number]=[595.28,841.89];
 let page=doc.addPage(pageSize), y=pageSize[1]-54;
 const ink=rgb(0.23,0.29,0.25),muted=rgb(0.43,0.45,0.43);
 const draw=(s:unknown,size=10,heavy=false,x=52)=>{
   const content=cleanPDF(s);
   page.drawText(content,{x,y,size,font:heavy?bold:regular,color:heavy?ink:muted});y-=size+7;
 };
 const addPage=()=>{page=doc.addPage(pageSize);y=pageSize[1]-56;draw(`Rechnung ${invoice.invoice_number} - Fortsetzung`,11,true);y-=10;};
 function wrapLine(text:string, maxWidth:number, heavy=false, size=10) {
   const font=heavy?bold:regular;
   let line='';const chunks:string[]=[];
   for(const w of cleanPDF(text).split(/\s+/)) {
     if(!w)continue;
     const candidate=line?`${line} ${w}`:w;
     if(font.widthOfTextAtSize(candidate,size)>maxWidth && line){chunks.push(line);line=w;}
     else line=candidate;
   }
   if(line)chunks.push(line);
   for(const chunk of chunks){if(y<70)addPage();draw(chunk,size,heavy);}
 }
 draw('Hebammen Lounge',18,true); y-=6;
 draw(invoice.issuer_snapshot.name,10,true);
 draw(invoice.issuer_snapshot.street);
 draw(`${invoice.issuer_snapshot.postal} ${invoice.issuer_snapshot.city}`);
 y-=24;
 draw('Rechnung an:',9,true);
 draw(invoice.recipient_snapshot.name,11,true);
 draw(invoice.recipient_snapshot.street);
 draw(`${invoice.recipient_snapshot.postal} ${invoice.recipient_snapshot.city}`);
 draw(invoice.recipient_email,9);
 y-=25;
 draw('RECHNUNG',16,true);
 draw(`Rechnungsnummer: ${invoice.invoice_number}`,10,true);
 draw(`Rechnungsdatum: ${dateFromInvoice(invoice.invoice_date)}`);
 draw(`Leistungsmonat: ${invoice.month.slice(5,7)}/${invoice.month.slice(0,4)}`);
 y-=14;
 page.drawLine({start:{x:52,y:y+7},end:{x:543,y:y+7},thickness:1,color:ink});
 draw('Leistung / Nutzungszeitraum',10,true);
 for(const line of invoice.lines_snapshot) {
   if(y<98)addPage();
   const desc=line.kind==='hourly'?'Stundenweise Praxisnutzung':line.kind==='day'?'Tagesnutzung Praxis':'Wochenendnutzung Praxis';
   wrapLine(`${desc}: ${localTime(line.starts_at)} bis ${localTime(line.ends_at)}`,450,false,9);
   draw(`Brutto: ${eur(line.gross_cents)}`,9,false,62);
   y-=4;
 }
 if(y<170)addPage();
 y-=10;page.drawLine({start:{x:52,y:y+7},end:{x:543,y:y+7},thickness:1,color:ink});
 if(invoice.vat_mode==='standard19'){
   draw(`Netto: ${eur(invoice.net_cents)}`,10);
   draw(`Umsatzsteuer 19 %: ${eur(invoice.vat_cents)}`,10);
 } else {
   wrapLine(invoice.issuer_snapshot.tax_exemption_note,485,false,9);
 }
 draw(`Rechnungsbetrag brutto: ${eur(invoice.gross_cents)}`,12,true);
 y-=14;
 if(invoice.issuer_snapshot.iban)wrapLine(`Bankverbindung (IBAN): ${invoice.issuer_snapshot.iban}`,480,false,9);
 draw(`Zahlungsziel: ${invoice.issuer_snapshot.payment_days} Tage ab Rechnungsdatum`,9);
 draw(`Steuernummer/USt-IdNr.: ${invoice.issuer_snapshot.tax_number}`,9);
 const pages=doc.getPages();for(let n=0;n<pages.length;n++){
   pages[n].drawText(`Hebammen Lounge  |  ${invoice.invoice_number}  |  Seite ${n+1} / ${pages.length}`,
     {x:52,y:30,size:8,font:regular,color:muted});
 }
 return doc.save();
}
// Only the WEB.DE account owner may send using this transport.
// Create per invoice, close in finally; no long-lived connections across invocations.
function smtpTransport() {
 return nodemailer.createTransport({
   host:smtpHost, port:smtpPort, secure:true,
   requireTLS:true,
   auth:{user:smtpUser,pass:smtpPassword},
   tls:{servername:smtpHost,minVersion:'TLSv1.2',rejectUnauthorized:true},
   connectionTimeout:12000,greetingTimeout:10000,socketTimeout:20000,
   pool:false,
 });
}
function smtpDefinitelyRejected(e:unknown) {
 const err=e as {code?:string;responseCode?:number};
 return err?.code==='EAUTH' ||
  (typeof err?.responseCode==='number' && err.responseCode>=500 && err.responseCode<=599);
}
function smtpErrorLabel(e:unknown) {
 const err=e as {code?:string;responseCode?:number};
 const code=String(err?.code||'SMTP_ERROR').replace(/[^A-Z0-9_-]/gi,'').slice(0,36);
 const response=typeof err?.responseCode==='number'?` (${err.responseCode})`:'';
 // Never store raw SMTP exception messages: they may include credentials/recipients.
 return `WEB.DE SMTP ${code}${response}. Verbindung und WEB.DE-Postfach prüfen.`;
}
async function finish(id:string,status:'sent'|'failed'|'review',pdfPath:string|null,providerId:string|null,err:string|null){
 const {error}=await server.rpc('worker_finish_invoice',{
   p_id:id,p_status:status,p_pdf_path:pdfPath,p_provider_id:providerId,p_error:err,
 }); if(error)throw error;
}
async function processOne(invoice:Inv):Promise<'sent'|'failed'|'review'> {
 const path=`${invoice.month.slice(0,7)}/${invoice.invoice_number}.pdf`;
 let pdf:Uint8Array;
 try {
   pdf=await pdfFor(invoice);
   const {error}=await server.storage.from('lounge-invoices').upload(path,pdf,{
     upsert:false,contentType:'application/pdf',cacheControl:'0'
   });
   if(error && !/already exists|duplicate|resource already exists/i.test(error.message)) throw error;
 } catch(e) {
   await finish(invoice.id,'failed',null,null,`PDF/Archiv fehlgeschlagen: ${safe((e as Error)?.message).slice(0,210)}`);
   return 'failed';
 }
 // SMTP hands mail to WEB.DE. Acceptance does NOT guarantee arrival in the inbox.
 // Unknown SMTP outcomes (including timeout after DATA) must NOT be retried blindly.
 const transport=smtpTransport();
 try {
   const info=await transport.sendMail({
     from:{name:'Hebammen Lounge',address:smtpUser},
     to:invoice.recipient_email,
     subject:`Hebammen Lounge - Rechnung ${invoice.invoice_number}`,
     text:`Hallo,\n\nanbei deine Rechnung ${invoice.invoice_number} für die Praxisnutzung im Monat ${invoice.month.slice(5,7)}/${invoice.month.slice(0,4)} über ${eur(invoice.gross_cents)}.\n\nViele Grüße\nHebammen Lounge`,
     attachments:[{
       filename:`Rechnung-${invoice.invoice_number}.pdf`,
       content:pdf,
       contentType:'application/pdf',
     }],
     disableFileAccess:true,disableUrlAccess:true,
   });
   const accepted=(info.accepted||[]).some((address:string)=>address.toLowerCase()===invoice.recipient_email.toLowerCase());
   if(!accepted){
     await finish(invoice.id,'review',path,null,'SMTP hat die Zieladresse nicht eindeutig angenommen. Bitte Postfach prüfen.');
     return 'review';
   }
   await finish(invoice.id,'sent',path,typeof info.messageId==='string'?info.messageId.slice(0,160):null,null);
   return 'sent';
 } catch (e) {
   const definitelyRejected=smtpDefinitelyRejected(e);
   // A definite SMTP 5xx/auth rejection can be retried later after correcting settings.
   // Socket errors/timeouts are ambiguous, even if they occur after the mail was accepted.
   try { await finish(invoice.id,definitelyRejected?'failed':'review',path,null,
     definitelyRejected?smtpErrorLabel(e):'SMTP-Versand möglicherweise erfolgt. WEB.DE-Gesendet/Posteingang manuell prüfen, nicht automatisch erneut senden.'); } catch {}
   return definitelyRejected?'failed':'review';
 } finally {
   transport.close();
 }

}

Deno.serve(async (req:Request) => {
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors(req)});
 if(req.method!=='POST')return output(req,{error:'POST erforderlich.'},405);
 if(!allowedOrigin || req.headers.get('Origin')!==allowedOrigin)return output(req,{error:'Aufrufquelle nicht erlaubt.'},403);
 if(!smtpUser.endsWith('@web.de')||!smtpPassword||!serviceKey||!publicKey||!projectUrl)
   return output(req,{error:'Rechnungsversand ist serverseitig noch nicht eingerichtet.'},503);
 const jwt=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
 if(!jwt)return output(req,{error:'Bitte anmelden.'},401);
 // Validate the logged-in user BEFORE any service-role operation.
 const userClient=createClient(projectUrl,publicKey,{global:{headers:{Authorization:`Bearer ${jwt}`}},
   auth:{persistSession:false,autoRefreshToken:false}});
 const {data:{user},error:authError}=await userClient.auth.getUser(jwt);
 if(authError||!user)return output(req,{error:'Anmeldung ungültig.'},401);
 let body:{month?:unknown; action?:unknown}={};
 try{body=await req.json();}catch{return output(req,{error:'JSON erwartet.'},400);}
 const month=String(body.month||'');
 if(!/^20\d{2}-(0[1-9]|1[0-2])-01$/.test(month))return output(req,{error:'Bitte einen vollständigen Monat wählen.'},400);
 const action=body.action==='continue'?'continue':'close';
 // RPC includes authorizing role checks. Continue does not create a new closure.
 const {data:existing,error:readError}=await userClient.rpc('admin_month_invoices',{p_month:month});
 if(readError)return output(req,{error:'Nur Vicky darf Monatsrechnungen versenden.'},403);
 if(action==='close'){
   const {error}=await userClient.rpc('admin_prepare_month',{p_month:month});
   if(error)return output(req,{error:safe(error.message).slice(0,300)},400);
 } else if(!Array.isArray(existing) || existing.length===0){
   // Zero-invoice month cannot send anything; require an explicit close to proceed.
   return output(req,{error:'Noch keine ausstehenden Rechnungen.'},400);
 }
 const result={sent:0,failed:0,review:0,processed:0};
 // Bounded batches; admin can continue until pending = 0. Different requests claim distinct invoices.
 for(let n=0;n<10;n++){
   const {data:id,error:claimError}=await server.rpc('worker_claim_invoice',{p_month:month});
   if(claimError)return output(req,{error:'Rechnungswarteschlange nicht erreichbar.',...result},500);
   if(!id)break;
   const {data:invoice,error:invoiceError}=await server.from('invoices').select('*').eq('id',id).single();
   if(invoiceError||!invoice)return output(req,{error:'Rechnungsdaten fehlen. Manuelle Prüfung erforderlich.',...result},500);
   const status=await processOne(invoice as Inv);
   result[status]++;result.processed++;
   if(n<9)await new Promise(r=>setTimeout(r,650)); // respect provider rate limits
 }
 const {data:rows}=await userClient.rpc('admin_month_invoices',{p_month:month});
 const statuses=(rows||[]).reduce((acc:Record<string,number>,r:{status:string})=>{
   acc[r.status]=(acc[r.status]||0)+1;return acc;
 },{});
 return output(req,{ok:true,closed:true,...result,statuses});
});
