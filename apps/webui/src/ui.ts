/**
 * The embedded single-page UI. Self-contained (inline CSS/JS, no external
 * assets) so it works offline and cannot pull anything unexpected — this is a
 * security tool as much as a convenience.
 */
export function renderUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dom2pdf — local converter</title>
<style>
  :root { color-scheme: light dark; --accent: #2563eb; --ok: #16a34a; --bad: #dc2626; --warn: #d97706; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0e1621; color: #e7eef7; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 20px 64px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .sub { color: #9fc3e8; margin: 0 0 24px; }
  form { display: grid; gap: 12px; background: #162232; border: 1px solid #24425e; border-radius: 12px; padding: 20px; }
  label { display: grid; gap: 4px; font-size: 13px; color: #9fc3e8; }
  input, select { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid #2c4a68; background: #0e1621; color: #e7eef7; }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .check { display: flex; align-items: center; gap: 8px; color: #e7eef7; }
  .check input { width: auto; }
  button { font: inherit; font-weight: 600; padding: 11px 16px; border: 0; border-radius: 8px; background: var(--accent); color: white; cursor: pointer; }
  button:disabled { opacity: .6; cursor: wait; }
  .card { margin-top: 20px; border-radius: 12px; padding: 16px 20px; border: 1px solid #24425e; background: #162232; display: none; }
  .card.show { display: block; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 8px 0; }
  .stat b { display: block; font-size: 20px; }
  .stat span { font-size: 12px; color: #9fc3e8; }
  .links { display: flex; gap: 12px; margin-top: 8px; }
  .links a { color: white; background: var(--ok); text-decoration: none; font-weight: 600; padding: 9px 14px; border-radius: 8px; }
  .links a.secondary { background: #2c4a68; }
  #error { border-color: var(--bad); }
  #error .code { display: inline-block; font: 600 12px ui-monospace, monospace; background: var(--bad); color: white; border-radius: 6px; padding: 2px 8px; margin-bottom: 8px; }
  .fidelity { font-size: 13px; margin: 2px 0 6px; color: #9fc3e8; }
  .fidelity.ok { color: #86efac; }
  .fidelity.warn { color: #fcd34d; }
  .forensics { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; color: #fcd34d; background: #0e1621; border: 1px solid #2c4a68; border-radius: 8px; padding: 10px 12px; margin-top: 10px; max-height: 240px; overflow: auto; }
  .hint { color: #fcd34d; font-size: 13px; margin-top: 8px; }
  .warnings { color: #fcd34d; font-size: 13px; margin: 4px 0 0; padding-left: 18px; }
  footer { margin-top: 28px; color: #6f8bab; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>dom2pdf</h1>
  <p class="sub">Local converter — paste a target URL, get a PDF. The full security policy applies: only <code>http(s)</code>, public destinations by default.</p>
  <form id="form">
    <label>Target URL
      <input id="url" type="url" required placeholder="https://example.com" autocomplete="off" spellcheck="false">
    </label>
    <div class="row">
      <label>Mode
        <select id="mode">
          <option value="document">document (print CSS, paper-fit)</option>
          <option value="screen">screen (paper-fit output policy)</option>
        </select>
      </label>
      <label>Paper format
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
    <label class="check" title="Some sites keep requests open forever (streaming assets, long polling); without this the readiness deadline waits on them and fails.">
      <input id="tolerant" type="checkbox">
      Tolerant readiness — don't wait for images/network idle (hanging-asset sites)
    </label>
    <button id="submit" type="submit">Convert to PDF</button>
  </form>

  <section class="card" id="result">
    <strong>Converted</strong>
    <div class="stats">
      <div class="stat"><b id="pages">–</b><span>pages</span></div>
      <div class="stat"><b id="size">–</b><span>size</span></div>
      <div class="stat"><b id="duration">–</b><span>duration</span></div>
      <div class="stat"><b id="modeOut">–</b><span>mode</span></div>
    </div>
    <ul class="warnings" id="warnings"></ul>
    <div class="fidelity" id="fidelity"></div>
    <div class="links">
      <a id="open" href="#" target="_blank" rel="noopener">Open PDF</a>
      <a id="download" href="#" class="secondary" download="dom2pdf.pdf">Download PDF</a>
    </div>
  </section>

  <section class="card" id="error">
    <span class="code" id="errcode">ERROR</span>
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
  var result = document.getElementById("result");
  var error = document.getElementById("error");
  var openLink = document.getElementById("open");
  var downloadLink = document.getElementById("download");
  var currentUrl = null;

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
  }

  function showError(code, message, details) {
    result.classList.remove("show");
    document.getElementById("errcode").textContent = code;
    document.getElementById("errmsg").textContent = message;
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

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    btn.disabled = true;
    btn.textContent = "Converting… (browser is warming up on the first run)";
    result.classList.remove("show");
    error.classList.remove("show");
    fetch("/api/convert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: document.getElementById("url").value,
        mode: document.getElementById("mode").value,
        format: document.getElementById("format").value || undefined,
        tolerant: document.getElementById("tolerant").checked
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
      btn.disabled = false;
      btn.textContent = "Convert to PDF";
    });
  });
})();
</script>
</body>
</html>
`;
}
