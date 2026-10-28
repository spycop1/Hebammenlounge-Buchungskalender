"""Optional local smoke test. Requires Python playwright and Chromium.
Run from repository root: python tests/browser_smoke.py
Mocks the backend; it is NOT a live Supabase RLS test.
"""
import contextlib
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = 'https://test-project.supabase.co'
key = 'sb_publishable_' + 'test' * 15
u_col = '10000000-0000-4000-8000-000000000001'
u_admin = '10000000-0000-4000-8000-000000000002'
u_other = '10000000-0000-4000-8000-000000000003'

profiles = [
  dict(id=u_col,display_name='Sarah Beispiel',email='sarah@example.invalid',role='colleague',active=True,billing_name='Sarah Beispiel',billing_street='Musterweg 1',billing_postal_code='12345',billing_city='Beispielstadt'),
  dict(id=u_admin,display_name='Vicky Beispiel',email='vicky@example.invalid',role='admin',active=True,billing_name='Vicky Beispiel',billing_street='Musterweg 2',billing_postal_code='12345',billing_city='Beispielstadt'),
  dict(id=u_other,display_name='Anna Beispiel',email='anna@example.invalid',role='colleague',active=False,billing_name='',billing_street='',billing_postal_code='',billing_city=''),
]
res = [
  dict(id='20000000-0000-4000-8000-000000000001',profile_id=u_col,kind='hourly',starts_at='2026-11-05T07:00:00+00:00',ends_at='2026-11-05T09:00:00+00:00',gross_cents=3200,status='confirmed',note=''),
  dict(id='20000000-0000-4000-8000-000000000002',profile_id=u_admin,kind='day',starts_at='2026-11-06T07:00:00+00:00',ends_at='2026-11-06T21:00:00+00:00',gross_cents=12000,status='confirmed',note=''),
]
rates=[dict(kind='hourly',gross_cents=1600),dict(kind='day',gross_cents=12000),dict(kind='weekend',gross_cents=30000)]

class QuietHandler(SimpleHTTPRequestHandler):
 def log_message(self, *args): pass

@contextlib.contextmanager
def serve():
 handler=functools.partial(QuietHandler,directory=str(ROOT))
 server=ThreadingHTTPServer(('127.0.0.1', 0),handler)
 thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 try: yield f'http://127.0.0.1:{server.server_port}'
 finally: server.shutdown();server.server_close();thread.join(timeout=3)

def browser_case(browser,base,admin=False,unauthorized=False,mobile=False):
 context=browser.new_context(bypass_csp=True, viewport={'width':390 if mobile else 1280,'height':850})
 page=context.new_page()
 errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('console',lambda msg:errors.append(msg.text) if msg.type == 'error' else None)
 account = profiles[0] if not admin or unauthorized else profiles[1]
 session={'access_token':'mock-jwt','refresh_token':'mock-refresh', 'expires_at':4000000000, 'user':{'id':account['id']}}
 # about:blank has opaque origin; stub session storage to test the UI without a network navigation.
 page.set_content((ROOT / ('admin.html' if admin or unauthorized else 'index.html')).read_text(encoding='utf-8'))
 page.evaluate('''() => {const data = new Map();Object.defineProperty(window, 'sessionStorage', {configurable:true,value:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}})}''')
 page.evaluate(f"sessionStorage.setItem('hebammen_lounge_auth_v1', JSON.stringify({json.dumps(session)}))")

 sent_calls=[]
 def mock(route):
  url=route.request.url
  if url.endswith('/config.js'):
   return route.fulfill(status=200,content_type='application/javascript',body=f"window.LOUNGE_CONFIG={{supabaseUrl:'{HOST}', supabaseKey:'{key}'}}")
  if not url.startswith(HOST): return route.continue_()
  path=urlsplit(url).path
  query=parse_qs(urlsplit(url).query)
  def deliver(rows): return route.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps(rows))
  if path.endswith('/functions/v1/close-month'):
   sent_calls.append(json.loads(route.request.post_data))
   return deliver({'ok':True,'closed':True,'sent':1,'failed':0,'review':0,'processed':1,'statuses':{'sent':1}})
  if path.endswith('/profiles'):
   return deliver([p for p in profiles if p['id']==account['id']] if 'id' in query else profiles)
  if path.endswith('/tariffs'): return deliver(rates)
  if path.endswith('/invoice_months'):return deliver([])
  if path.endswith('/reservations'): return deliver(res if admin and not unauthorized else [r for r in res if r['profile_id']==account['id']])
  if path.endswith('/rpc/busy_slots'):return deliver([{'starts_at':r['starts_at'],'ends_at':r['ends_at']} for r in res])
  if path.endswith('/rpc/admin_month_invoices'):return deliver([])
  if path.endswith('/rpc/admin_monthly_bookings'):
   return deliver([dict(booking_id=r['id'],profile_id=r['profile_id'], display_name=next(p['display_name'] for p in profiles if p['id']==r['profile_id']),email=next(p['email'] for p in profiles if p['id']==r['profile_id']),kind=r['kind'],starts_at=r['starts_at'],ends_at=r['ends_at'],gross_cents=r['gross_cents']) for r in res])
  if path.endswith('/rpc/book_practice'): return deliver('20000000-0000-4000-8000-000000000099')
  if path.endswith('/rpc/admin_set_active'):return deliver(None)
  if path.endswith('/rpc/admin_block_day'):return deliver('20000000-0000-4000-8000-000000000098')
  if path.endswith('/rpc/cancel_reservation'):return deliver(None)
  return route.fulfill(status=404,content_type='application/json',body='{"message":"unmocked"}')

 page.route('**/config.js',mock)
 page.route(f'{HOST}/**',mock)
 page.add_script_tag(content=f"window.LOUNGE_CONFIG={{supabaseUrl:'{HOST}', supabaseKey:'{key}'}}")
 page.add_script_tag(content=(ROOT/'app.js').read_text())
 if unauthorized:
  page.get_by_text('Kein Admin-Zugang.').wait_for()
 elif admin:
  page.get_by_text('Alles im Blick, Vicky.').wait_for()
  page.locator('[data-action="section"][data-value="billing"]').click()
  page.get_by_text('Monatsauswertung.',exact=True).wait_for()
  assert '152,00' in page.locator('main').inner_text()
  # Closing an earlier completed month triggers server-side dispatch, never a browser mail API.
  page.on('dialog',lambda d:d.accept())
  page.locator('[data-action="month-prev"]').first.click()
  page.locator('[data-action="close-month"]').click()
  page.get_by_text('Monat abgeschlossen. 1 Rechnung(en) versendet.',exact=False).wait_for()
  assert len(sent_calls)==1 and sent_calls[0]['action']=='close',sent_calls
  page.locator('[data-action="section"][data-value="people"]').click()
  page.get_by_text('Anna Beispiel').wait_for()
 else:
  page.get_by_text('Dein Platz in der Lounge.').wait_for()
  page.locator('[data-action="section"][data-value="calendar"]').click()
  page.locator('[data-action="month-next"]').click()
  page.get_by_text('November 2026').wait_for()
  page.locator('[data-action="open-book"]').first.click()
  page.locator('#kind').select_option('hourly')
  page.locator('#startTime').select_option('18:00')
  page.locator('#hours').select_option('5')
  assert page.locator('#create-booking [type="submit"]').is_disabled()
  page.locator('#kind').select_option('day')
  assert '120,00' in page.locator('#live-quote').inner_text()
  assert page.locator('#hour-controls').is_hidden()
  page.locator('#bookDay').fill('2026-11-07')
  page.locator('#create-booking [type="submit"]').click()
  page.get_by_text('Praxis erfolgreich reserviert.').wait_for()
 if errors: raise AssertionError(f'Browser errors: {errors}')
 print(f"OK: {'admin' if admin else 'colleague'}{' unauthorized' if unauthorized else ''}{' mobile' if mobile else ''}")
 context.close()

if __name__=='__main__':
 with serve() as base, sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for args in [{'admin':False},{'admin':True},{'admin':True,'unauthorized':True},{'admin':False,'mobile':True}]: browser_case(browser,base,**args)
  browser.close()
 print('Smoke tests passed (mock backend only).')
