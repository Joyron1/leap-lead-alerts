<?php
/**
 * Plugin Name: Leap Lead Alerts
 * Description: Sends a PII-free Telegram alert (via Supabase) whenever the Leap Theory embedded form posts a lead. Network-activate once to cover every site in the network.
 * Version: 1.2
 * Network: true
 */
if ( ! defined( 'ABSPATH' ) ) exit;

add_action( 'wp_head', function () {
	if ( is_admin() ) return;
	?>
<script>
(function () {
  var ENDPOINT = 'https://tipuzwoirrzlibplmbji.supabase.co/functions/v1/lead-alert';
  var KEY = ''; // optional shared key; must match the ALERT_KEY secret in Supabase (leave empty if not set)
  var LEAD_RE = /\/api\/([a-z-]+\/)?([a-z-]*leads)\/?(\?|$)/i; // leads/, personal-loan-leads/, debt-relief/leads/ ...
  var seen = {};

  function safeParse(s) { try { return typeof s === 'string' ? JSON.parse(s) : (s || null); } catch (e) { return null; } }

  function report(p) {
    if (!p || !p.leadId || seen[p.leadId]) return;
    seen[p.leadId] = 1;
    p.domain = location.hostname;
    p.page = location.pathname;
    p.ts = new Date().toISOString();
    if (KEY) p.key = KEY;
    var body = JSON.stringify(p), sent = false;
    // 1) sendBeacon: queued by the browser itself, survives the redirect to the lender / tab close.
    //    text/plain keeps it a "simple" request (no CORS preflight).
    try { if (navigator.sendBeacon) sent = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' })); } catch (e) {}
    // 2) fallback: fetch with keepalive
    if (!sent) {
      try {
        fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: body, keepalive: true, mode: 'cors', credentials: 'omit' }).catch(function () {});
      } catch (e) {}
    }
  }

  // Build the minimal, PII-free payload from the widget's request + response.
  function handle(reqBody, resBody, source) {
    var req = safeParse(reqBody) || {};
    var res = safeParse(resBody) || {};
    var leadId = res.leadID || res.leadId || res.lead_id;
    if (!leadId) return;
    report({
      leadId: String(leadId),
      status: res.status || 'unknown',
      payout: res.payout != null ? res.payout : 0,
      payModel: res.payModel || '',
      isDeclined: res.isDeclined === true,
      state: req.state || req.address_state || '',
      loanAmount: req.loanAmount || '',        // e.g. 500
      loanRange: req.loanAmountRange || '',    // e.g. "100;500" = the button the visitor clicked
      source: source
    });
  }

  // 1) XMLHttpRequest (axios in the widget uses XHR)
  try {
    var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__leapUrl = String(u || ''); return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (body) {
      var x = this;
      if (LEAD_RE.test(x.__leapUrl || '')) {
        x.addEventListener('load', function () {
          try {
            if (x.status >= 200 && x.status < 300) {
              var res = (x.responseType === '' || x.responseType === 'text') ? x.responseText : x.response;
              handle(body, res, 'xhr');
            }
          } catch (e) {}
        });
      }
      return XS.apply(this, arguments);
    };
  } catch (e) {}

  // 2) fetch (in case the widget switches adapters)
  try {
    var F = window.fetch;
    if (F) window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var p = F.apply(this, arguments);
      if (LEAD_RE.test(url) && url.indexOf('supabase.co') === -1) {
        p.then(function (r) {
          try { if (r.ok) r.clone().text().then(function (t) { handle(init && init.body, t, 'fetch'); }); } catch (e) {}
        }).catch(function () {});
      }
      return p;
    };
  } catch (e) {}

  // 3) Backup: the widget's official hook (fires with leadId + amount; no status/state).
  //    Deduplicated server-side by leadId, so it only matters if 1)/2) missed the call.
  var tries = 0, t = setInterval(function () {
    tries++;
    var EF = window.EmbeddedForm;
    if (EF && typeof EF.addEventHandlers === 'function') {
      clearInterval(t);
      try {
        EF.addEventHandlers('postLead', function (e) {
          setTimeout(function () {   // give the primary hook a head start
            if (!e || !e.leadId) return;
            var amt = Number(e.amount) || 0;
            report({ leadId: String(e.leadId), status: amt > 0 ? 'accepted' : 'unknown', payout: amt, payModel: '', state: '', source: 'hook' });
          }, 1500);
        });
      } catch (err) {}
    } else if (tries > 300) clearInterval(t); // stop after ~60s (pages without the form)
  }, 200);
})();
</script>
	<?php
}, 1 );
