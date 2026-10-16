/**
 * The embedded single-page UI. Self-contained (inline CSS/JS, no external
 * assets) so it works offline and cannot pull anything unexpected — this is a
 * security tool as much as a convenience.
 *
 * Contract relied on by tests (apps/webui/test + tests/webui.spec.ts):
 * `h1` text is exactly "dom2pdf", the page contains "/api/convert" and
 * "Convert to PDF", and these ids keep working with the same show/hide
 * mechanism: #form #submit #btnLabel #status #url #mode #format #tolerant
 * #keepTogether #result #pages #size #duration #modeOut #warnings #fidelity
 * #open #download #error #errcode #errmsg #errhint #forensics — plus the
 * fidelity line wording ("Fidelity: mean SSIM", "not a pixel-perfectness
 * claim") and the "fidelity ok" / "fidelity warn" class pair.
 *
 * Theme: dark by default, follows prefers-color-scheme for light mode; all
 * colors live in CSS custom properties.
 */
export function renderUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dom2pdf — local converter</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect width='24' height='24' rx='6' fill='%232563eb'/><path d='M7.5 6.5h6.5l3 3v8a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z' fill='none' stroke='white' stroke-width='1.5' stroke-linejoin='round'/><path d='M9 12.5h6M9 15.5h4' stroke='white' stroke-width='1.5' stroke-linecap='round'/></svg>">
<style>
  :root {
    color-scheme: light dark;
    --bg: #0a1120;
    --panel: #101a2c;
    --panel-2: #0c1523;
    --line: #223352;
    --text: #e8eef8;
    --muted: #93a7c4;
    --faint: #6d80a3;
    --accent: #3b82f6;
    --accent-deep: #1d4ed8;
    --accent-soft: rgba(59, 130, 246, .16);
    --ok: #22c55e;
    --ok-text: #6ee7a0;
    --ok-soft: rgba(34, 197, 94, .12);
    --bad: #ef4444;
    --bad-text: #fca5a5;
    --bad-soft: rgba(239, 68, 68, .12);
    --warn: #f59e0b;
    --warn-text: #fcd34d;
    --warn-soft: rgba(245, 158, 11, .12);
    --shadow: 0 14px 36px rgba(2, 8, 20, .45);
    --radius: 16px;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f3f6fb;
      --panel: #ffffff;
      --panel-2: #f7f9fc;
      --line: #e3e9f2;
      --text: #16213a;
      --muted: #55678a;
      --faint: #7e8daa;
      --accent-soft: rgba(59, 130, 246, .10);
      --ok-text: #15803d;
      --bad-text: #b91c1c;
      --warn-text: #b45309;
      --ok-soft: rgba(34, 197, 94, .10);
      --bad-soft: rgba(239, 68, 68, .08);
      --warn-soft: rgba(245, 158, 11, .12);
      --shadow: 0 10px 30px rgba(22, 33, 58, .08);
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    min-height: 100vh;
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    background-color: var(--bg);
    background-image:
      radial-gradient(900px 460px at 12% -8%, var(--accent-soft), transparent 60%),
      radial-gradient(700px 400px at 92% -4%, rgba(96, 165, 250, .10), transparent 55%);
    color: var(--text);
  }
  .wrap { max-width: 780px; margin: 0 auto; padding: 0 20px; }

  /* ---- hero ---- */
  .hero { padding: 44px 0 6px; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .mark {
    width: 42px; height: 42px; border-radius: 12px; flex: none;
    display: grid; place-items: center; color: #fff;
    background: linear-gradient(135deg, var(--accent), var(--accent-deep));
    box-shadow: 0 8px 20px rgba(37, 99, 235, .38);
  }
  .mark svg { width: 22px; height: 22px; }
  h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -.02em; }
  .tagline { margin: 2px 0 0; font-size: 13px; font-weight: 600; color: var(--accent); letter-spacing: .01em; }
  .sub { margin: 16px 0 26px; color: var(--muted); max-width: 62ch; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: .9em; background: rgba(148, 163, 184, .16); border: 1px solid var(--line);
    padding: 1px 6px; border-radius: 6px;
  }

  /* ---- cards ---- */
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 22px;
    margin-bottom: 18px;
  }
  #result, #error { display: none; }
  #result.show, #error.show { display: block; animation: rise .28s ease both; }
  @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  .section-label {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .1em; color: var(--faint); margin: 6px 0 -4px;
  }

  /* ---- form ---- */
  form { display: grid; gap: 14px; }
  label.field { display: grid; gap: 7px; font-size: 13px; font-weight: 600; color: var(--muted); }
  .input-wrap { position: relative; display: block; }
  .input-wrap > svg {
    position: absolute; left: 13px; top: 50%; transform: translateY(-50%);
    width: 16px; height: 16px; color: var(--faint); pointer-events: none;
  }
  input, select {
    font: inherit; width: 100%; color: var(--text);
    background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 10px; padding: 11px 12px;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  #url { padding-left: 38px; }
  input:hover, select:hover { border-color: rgba(59, 130, 246, .5); }
  input:focus-visible, select:focus-visible {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(59, 130, 246, .28);
  }
  input::placeholder { color: var(--faint); }
  select { appearance: auto; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

  .opt {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 13px 15px; background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 12px; cursor: pointer;
    transition: border-color .15s ease;
  }
  .opt:hover { border-color: rgba(59, 130, 246, .55); }
  .opt-text strong { display: block; font-size: 14px; font-weight: 600; color: var(--text); }
  .opt-text span { display: block; font-size: 12.5px; color: var(--muted); margin-top: 2px; }
  .switch {
    appearance: none; -webkit-appearance: none; flex: none; margin: 0;
    width: 42px; height: 24px; border-radius: 999px; border: 0; padding: 0;
    background: rgba(148, 163, 184, .38); position: relative; cursor: pointer;
    transition: background .15s ease;
  }
  .switch::after {
    content: ""; position: absolute; top: 3px; left: 3px;
    width: 18px; height: 18px; border-radius: 50%; background: #fff;
    box-shadow: 0 1px 3px rgba(2, 8, 20, .45); transition: transform .15s ease;
  }
  .switch:checked { background: var(--accent); }
  .switch:checked::after { transform: translateX(18px); }
  .switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: none; }

  .btn {
    margin-top: 6px; width: 100%; font: inherit; font-weight: 650;
    letter-spacing: .01em; color: #fff; border: 0; border-radius: 12px;
    padding: 13px 18px; cursor: pointer;
    background: linear-gradient(180deg, var(--accent), var(--accent-deep));
    box-shadow: 0 10px 24px rgba(37, 99, 235, .35);
    transition: transform .12s ease, box-shadow .12s ease, opacity .15s ease;
  }
  .btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 14px 28px rgba(37, 99, 235, .42); }
  .btn:active:not(:disabled) { transform: translateY(0); }
  .btn:disabled { opacity: .78; cursor: progress; }
  .btn[aria-busy="true"]::before {
    content: ""; display: inline-block; width: 14px; height: 14px;
    margin-right: 9px; vertical-align: -2px; border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, .35); border-top-color: #fff;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status { min-height: 18px; text-align: center; font-size: 13px; color: var(--muted); }
  .status:empty { min-height: 6px; }

  /* ---- result ---- */
  #result { border-color: rgba(34, 197, 94, .38); }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
  .badge { display: inline-flex; align-items: center; gap: 9px; font-size: 15.5px; font-weight: 700; }
  .badge .ico {
    width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
    background: var(--ok-soft); color: var(--ok); flex: none;
  }
  .badge .ico svg { width: 14px; height: 14px; }
  #error .badge .ico { background: var(--bad-soft); color: var(--bad); }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .stat {
    background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 12px; padding: 11px 13px; min-width: 0;
  }
  .stat b { display: block; font-size: 21px; font-weight: 700; letter-spacing: -.02em; overflow: hidden; text-overflow: ellipsis; }
  .stat span {
    display: block; font-size: 10.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .08em; color: var(--faint); margin-top: 2px;
  }
  .fidelity { display: flex; align-items: flex-start; gap: 9px; margin-top: 16px; font-size: 13.5px; color: var(--muted); }
  .fidelity:empty { display: none; }
  .fidelity::before {
    content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%;
    background: var(--faint); margin-top: 6px;
  }
  .fidelity.ok { color: var(--ok-text); }
  .fidelity.ok::before { background: var(--ok); }
  .fidelity.warn { color: var(--warn-text); }
  .fidelity.warn::before { background: var(--warn); }
  .warnings { color: var(--warn-text); font-size: 13.5px; margin: 12px 0 0; padding-left: 18px; }
  .warnings:empty { display: none; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 18px; }
  .actions a {
    text-decoration: none; font-weight: 650; font-size: 14px;
    padding: 10px 18px; border-radius: 10px; transition: transform .12s ease, filter .12s ease;
  }
  .actions a:hover { transform: translateY(-1px); filter: brightness(1.06); }
  #open { color: #fff; background: linear-gradient(180deg, var(--ok), #15803d); box-shadow: 0 8px 20px rgba(22, 163, 74, .32); }
  #download { color: var(--text); background: var(--panel-2); border: 1px solid var(--line); }

  /* ---- error ---- */
  #error { border-color: rgba(239, 68, 68, .42); }
  .code {
    font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: .05em; color: var(--bad-text);
    background: var(--bad-soft); border: 1px solid rgba(239, 68, 68, .4);
    border-radius: 999px; padding: 6px 12px;
  }
  #errmsg { margin-top: 14px; font-size: 14.5px; }
  #errhint {
    margin-top: 12px; padding: 11px 13px; font-size: 13.5px;
    color: var(--warn-text); background: var(--warn-soft);
    border: 1px solid rgba(245, 158, 11, .38); border-radius: 10px;
  }
  #errhint:empty { display: none; }
  .forensics {
    margin-top: 12px; padding: 12px 14px; max-height: 260px; overflow: auto;
    font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap; word-break: break-word;
    color: var(--warn-text); background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 10px;
  }
  .forensics:empty { display: none; }

  footer { padding: 4px 0 48px; color: var(--faint); font-size: 12.5px; line-height: 1.7; }

  @media (max-width: 640px) {
    .wrap { padding: 0 14px; }
    .hero { padding-top: 30px; }
    h1 { font-size: 24px; }
    .grid { grid-template-columns: 1fr; }
    .stats { grid-template-columns: repeat(2, 1fr); }
    .card { padding: 18px 16px; }
    .opt { align-items: flex-start; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<header class="hero wrap">
  <div class="brand">
    <span class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M7.5 4.5h6.5l4 4v11a1 1 0 0 1-1 1H7.5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/>
        <path d="M14 4.5v4h4"/><path d="M9 13h6"/><path d="M9 16.5h4"/>
      </svg>
    </span>
    <div>
      <h1>dom2pdf</h1>
      <p class="tagline">HTML → PDF, verified</p>
    </div>
  </div>
  <p class="sub">Local converter — paste a target URL, get a PDF. The full security policy applies: only <code>http(s)</code>, public destinations by default. Nothing leaves this machine.</p>
</header>

<main class="wrap">
  <form id="form" class="card">
    <div class="section-label">Target</div>
    <label class="field" for="url">Target URL
      <span class="input-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M10.5 13.5a4.5 4.5 0 0 0 6.36 0l2.12-2.12a4.5 4.5 0 0 0-6.36-6.36l-1.2 1.2"/>
          <path d="M13.5 10.5a4.5 4.5 0 0 0-6.36 0l-2.12 2.12a4.5 4.5 0 0 0 6.36 6.36l1.2-1.2"/>
        </svg>
        <input id="url" type="url" required placeholder="https://example.com" autocomplete="off" spellcheck="false">
      </span>
    </label>

    <div class="section-label">Output</div>
    <div class="grid">
      <label class="field" for="mode">Mode
        <select id="mode">
          <option value="document">document (print CSS, paper-fit)</option>
          <option value="screen">screen (paper-fit output policy)</option>
        </select>
      </label>
      <label class="field" for="format">Paper format
        <select id="format">
          <option value="">browser default (A4)</option>
          <option value="A4">A4</option>
          <option value="Letter">Letter</option>
          <option value="Legal">Legal</option>
          <option value="A3">A3</option>
          <option value="A5">A5</option>
        </select>
      </label>
    </div>

    <div class="section-label">Reliability &amp; layout</div>
    <label class="opt" title="Some sites keep requests open forever (streaming assets, long polling); without this the readiness deadline waits on them and fails.">
      <span class="opt-text">
        <strong>Tolerant readiness</strong>
        <span>Don't wait for images/network idle — for sites with hanging assets</span>
      </span>
      <input id="tolerant" class="switch" type="checkbox">
    </label>
    <label class="opt" title="Keeps page-fitting tables, images, and code blocks whole across page breaks, never clips a table row at a page edge, and repeats overridden table headers.">
      <span class="opt-text">
        <strong>Keep objects whole across page breaks</strong>
        <span>Tables, images, and code blocks don't split at page edges; overridden table headers repeat</span>
      </span>
      <input id="keepTogether" class="switch" type="checkbox">
    </label>

    <button id="submit" class="btn" type="submit"><span id="btnLabel">Convert to PDF</span></button>
    <div class="status" id="status" aria-live="polite"></div>
  </form>

  <section class="card" id="result" aria-live="polite">
    <div class="card-head">
      <span class="badge">
        <span class="ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>
        </span>
        Converted
      </span>
    </div>
    <div class="stats">
      <div class="stat"><b id="pages">–</b><span>pages</span></div>
      <div class="stat"><b id="size">–</b><span>size</span></div>
      <div class="stat"><b id="duration">–</b><span>duration</span></div>
      <div class="stat"><b id="modeOut">–</b><span>mode</span></div>
    </div>
    <div class="fidelity" id="fidelity"></div>
    <ul class="warnings" id="warnings"></ul>
    <div class="actions">
      <a id="open" href="#" target="_blank" rel="noopener">Open PDF</a>
      <a id="download" href="#" class="secondary" download="dom2pdf.pdf">Download PDF</a>
    </div>
  </section>

  <section class="card" id="error" role="alert">
    <div class="card-head">
      <span class="badge">
        <span class="ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>
        </span>
        Conversion failed
      </span>
      <span class="code" id="errcode">ERROR</span>
    </div>
    <div id="errmsg"></div>
    <div class="hint" id="errhint"></div>
    <pre class="forensics" id="forensics"></pre>
  </section>

  <footer>
    Runs on 127.0.0.1 with the same policy as the library: private/loopback
    targets need the server started with <code>--allow-loopback</code> /
    <code>--allow-private-network</code>. Nothing leaves this machine.
  </footer>
</main>
<script>
(function () {
  var form = document.getElementById("form");
  var btn = document.getElementById("submit");
  var btnLabel = document.getElementById("btnLabel");
  var statusLine = document.getElementById("status");
  var result = document.getElementById("result");
  var error = document.getElementById("error");
  var openLink = document.getElementById("open");
  var downloadLink = document.getElementById("download");
  var currentUrl = null;
  var ticker = null;

  function bytesHuman(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  function show(resultData) {
    error.classList.remove("show");
    document.getElementById("pages").textContent = String(resultData.report.pdf.pageCount);
    document.getElementById("size").textContent = bytesHuman(resultData.report.pdf.byteLength);
    document.getElementById("duration").textContent = (resultData.report.durationMs / 1000).toFixed(2) + "s";
    document.getElementById("modeOut").textContent = resultData.report.mode;
    var list = document.getElementById("warnings");
    list.innerHTML = "";
    resultData.report.warnings.forEach(function (w) {
      var li = document.createElement("li");
      li.textContent = "[" + w.code + "] " + w.message;
      list.appendChild(li);
    });
    var fid = document.getElementById("fidelity");
    var fidelity = resultData.report.fidelity;
    if (!fidelity) {
      fid.textContent = "";
      fid.className = "fidelity";
    } else if (fidelity.status === "measured") {
      var lastPage = fidelity.sampledPages.length > 0
        ? fidelity.sampledPages[fidelity.sampledPages.length - 1]
        : 0;
      var scope = lastPage <= 1 ? "page 1" : "pages 1–" + lastPage;
      fid.textContent = "Fidelity: mean SSIM " + Number(fidelity.score).toFixed(3) +
        " vs the source page (threshold " + Number(fidelity.threshold).toFixed(2) + ", " + scope +
        ") — a visual comparison, not a pixel-perfectness claim";
      fid.className = "fidelity " + (fidelity.score >= fidelity.threshold ? "ok" : "warn");
    } else {
      fid.textContent = "Fidelity: skipped — " + (fidelity.reason || "no reason reported");
      fid.className = "fidelity warn";
    }
    if (currentUrl !== null) URL.revokeObjectURL(currentUrl);
    var blob = Uint8Array.from(atob(resultData.pdf), function (c) { return c.charCodeAt(0); });
    currentUrl = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    openLink.href = currentUrl;
    downloadLink.href = currentUrl;
    var host = "dom2pdf";
    try { host = new URL(document.getElementById("url").value).hostname || "dom2pdf"; } catch (e) { /* keep default */ }
    downloadLink.download = host + "-" + new Date().toISOString().slice(0, 10) + ".pdf";
    result.classList.add("show");
    statusLine.textContent = "";
  }

  // Playwright's failure text embeds ANSI color codes (call-log styling);
  // in plain text they render as garbage glyphs, so strip them for display.
  function stripAnsi(s) {
    return String(s).replace(/\\u001b\\[[0-9;]*m/g, "");
  }

  function showError(code, message, details) {
    result.classList.remove("show");
    document.getElementById("errcode").textContent = code;
    document.getElementById("errmsg").textContent = stripAnsi(message);
    var hint = "";
    if (code === "BLOCKED_URL" && /loopback|private/i.test(message)) {
      hint = "Testing a local page? Restart the server with --allow-loopback (and --allow-private-network for RFC1918 targets).";
    }
    if (code === "READINESS_TIMEOUT") {
      hint = "The page never settled — some sites keep requests open forever (streaming assets, long polling). Tick “Tolerant readiness” and retry.";
    }
    document.getElementById("errhint").textContent = hint;
    document.getElementById("forensics").textContent = forensicsText(details);
    error.classList.add("show");
    statusLine.textContent = "";
  }

  // Summarizes the failure-forensics bundle (details.diagnostics) the server
  // always collects: uncaught page errors, console errors/warnings, and
  // failed requests at the moment of failure. The screenshot and DOM are in
  // the bundle too but stay out of this summary.
  function forensicsText(details) {
    var bundle = details && details.diagnostics;
    if (!bundle) return "";
    var lines = [];
    var pageErrors = bundle.pageErrors || [];
    if (pageErrors.length > 0) {
      lines.push("Uncaught page errors:");
      pageErrors.slice(0, 8).forEach(function (e) { lines.push("  ! " + e); });
    }
    var consoleLines = (bundle.console || []).filter(function (c) {
      return c.type === "error" || c.type === "warning";
    });
    if (consoleLines.length > 0) {
      lines.push("Console errors/warnings:");
      consoleLines.slice(0, 8).forEach(function (c) { lines.push("  ! [" + c.type + "] " + c.text); });
    }
    var failed = (bundle.requests || []).filter(function (r) {
      return typeof r.failureText === "string" || (typeof r.status === "number" && r.status >= 400);
    });
    if (failed.length > 0) {
      lines.push("Failed requests:");
      failed.slice(0, 8).forEach(function (r) {
        var parts = [];
        if (typeof r.status === "number") parts.push(String(r.status));
        if (typeof r.failureText === "string") parts.push(r.failureText);
        parts.push(r.url);
        lines.push("  ! " + parts.join(" "));
      });
    }
    if (lines.length === 0) return "";
    return "Forensics at failure" + (bundle.url ? " (page was at " + bundle.url + ")" : "") + ":\\n" + lines.join("\\n");
  }

  function startBusy() {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btnLabel.textContent = "Converting…";
    statusLine.textContent = "Working — Chromium warms up on the first run; heavy pages can take a while.";
    var startedAt = Date.now();
    ticker = setInterval(function () {
      var seconds = Math.round((Date.now() - startedAt) / 1000);
      statusLine.textContent = "Converting… " + seconds + "s — the browser renders the page as a real print job.";
    }, 1000);
  }

  function stopBusy() {
    if (ticker !== null) { clearInterval(ticker); ticker = null; }
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btnLabel.textContent = "Convert to PDF";
    statusLine.textContent = "";
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    startBusy();
    result.classList.remove("show");
    error.classList.remove("show");
    fetch("/api/convert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: document.getElementById("url").value,
        mode: document.getElementById("mode").value,
        format: document.getElementById("format").value || undefined,
        tolerant: document.getElementById("tolerant").checked,
        keepTogether: document.getElementById("keepTogether").checked
      })
    }).then(function (res) {
      return res.json().then(function (body) {
        return { ok: res.ok, body: body };
      });
    }).then(function (out) {
      if (out.ok && out.body.pdf) {
        show(out.body);
      } else {
        var err = out.body && out.body.error ? out.body.error : { code: "HTTP", message: "unexpected response" };
        showError(err.code || "ERROR", err.message || "conversion failed", err.details);
      }
    }).catch(function (e) {
      showError("NETWORK", String(e));
    }).finally(function () {
      stopBusy();
    });
  });
})();
</script>
</body>
</html>
`;
}
