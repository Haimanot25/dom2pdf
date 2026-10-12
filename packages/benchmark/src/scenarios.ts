import type { ConvertOptions } from "pageforge-pdf";

/**
 * Deterministic benchmark scenarios.
 *
 * Every scenario generates **self-contained** HTML (inline CSS, no external
 * assets, no network) from fixed inputs, so repeated calls — and runs on
 * different machines — produce byte-identical documents. That is what makes
 * timings comparable across runs: the workload never varies.
 */
export interface BenchmarkScenario {
  /** Stable machine-readable name (used by `--scenarios`). */
  name: string;
  /** One-line human description. */
  description: string;
  /** Deterministic HTML; identical bytes on every call. */
  html(): string;
  /**
   * Options PageForge applies for this scenario. Comparators always use their
   * own defaults — engines render with their real-world settings, and the
   * report measures *time*, not output equivalence.
   */
  pageforgeOptions?: Omit<Partial<ConvertOptions>, "input" | "signal">;
}

const DOCUMENT_OPEN = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n";
const DOCUMENT_CLOSE = "\n</body>\n</html>\n";

function articleHtml(): string {
  return (
    DOCUMENT_OPEN +
    "<title>Simple article</title>\n<style>body{font-family:Georgia,serif;max-width:42em;margin:2rem auto;line-height:1.6}</style>\n" +
    "</head>\n<body>\n" +
    "<h1>Quarterly operations report</h1>\n" +
    "<p>This single-page article is the benchmark's smallest workload: a heading, a short table of contents, and a handful of paragraphs of plain prose. It exercises the fixed per-conversion overhead — browser context creation, input application, readiness checks, rendering, and PDF inspection — with almost no layout work.</p>\n" +
    "<h2>Highlights</h2>\n" +
    "<ul><li>Throughput held steady across the reporting period.</li>" +
    "<li>Median latency improved by a small margin versus the previous cycle.</li>" +
    "<li>No incidents were attributed to document generation.</li></ul>\n" +
    "<h2>Outlook</h2>\n" +
    "<p>The next cycle focuses on deterministic benchmarks, honest reporting, and repeatable measurements. Every number in this document is fixed text: two calls to the scenario generator produce byte-identical HTML, which is exactly what a benchmark needs.</p>\n" +
    "<p>Closing note: paginate me exactly once and move on.</p>" +
    DOCUMENT_CLOSE
  );
}

/** Fixed vocabulary — chosen for realistic word lengths, never randomized. */
const WORDS = [
  "render", "document", "browser", "page", "layout", "measure", "steady", "sample",
  "report", "packet", "buffer", "canvas", "margin", "column", "footer", "header",
  "index", "vector", "raster", "format", "scale", "output", "policy", "timing",
];

function sentence(seed: number): string {
  const count = 10 + (seed % 6);
  const words: string[] = [];
  for (let i = 0; i < count; i += 1) {
    words.push(WORDS[(seed * 7 + i * 3) % WORDS.length] as string);
  }
  const text = words.join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function longDocumentHtml(): string {
  const sections: string[] = [
    "<h1>Long-form reference document</h1>",
    "<p>One hundred and twenty deterministic paragraphs, sized to page through Chromium's print pagination several times without any external input.</p>",
  ];
  for (let i = 0; i < 120; i += 1) {
    sections.push(`<h2>Section ${i + 1}</h2>\n<p>${sentence(i)} ${sentence(i + 41)}</p>`);
  }
  return (
    DOCUMENT_OPEN +
    "<title>Long reference</title>\n<style>body{font-family:serif;line-height:1.5;margin:2em}h2{page-break-after:avoid}</style>\n" +
    "</head>\n<body>\n" +
    sections.join("\n") +
    DOCUMENT_CLOSE
  );
}

function printCssHtml(): string {
  const chapters = [
    "Definitions and scope",
    "Rendering pipeline",
    "Readiness phases",
    "Quality policies",
    "Security layers",
    "Benchmark method",
  ];
  const body = chapters
    .map(
      (title, index) =>
        `<section>\n<h2>${index + 1}. ${title}</h2>\n` +
        `<p>${sentence(index + 3)} ${sentence(index + 17)}</p>\n` +
        `<p>${sentence(index + 29)}</p>\n</section>`,
    )
    .join("\n");
  return (
    DOCUMENT_OPEN +
    '<title>Print stylesheet document</title>\n' +
    "<style>\n" +
    "@page{size:A4;margin:18mm 16mm;@top-center{content:'PageForge print-CSS fixture'}}\n" +
    "body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5pt;line-height:1.45}\n" +
    "section{page-break-inside:auto}\n" +
    "h2{page-break-after:avoid;color:#14304a}\n" +
    "section:nth-of-type(3){page-break-before:always}\n" +
    "table{border-collapse:collapse;width:100%;margin-top:.8em}\n" +
    "td,th{border:1px solid #99a;padding:.4em .6em;text-align:left}\n" +
    "</style>\n</head>\n<body>\n" +
    "<h1>Print-CSS operations manual</h1>\n" +
    "<table><thead><tr><th>Phase</th><th>Owner</th><th>Budget</th></tr></thead><tbody>" +
    "<tr><td>Navigation</td><td>engine</td><td>2s</td></tr>" +
    "<tr><td>Readiness</td><td>engine</td><td>5s</td></tr>" +
    "<tr><td>Render</td><td>engine</td><td>3s</td></tr>" +
    "</tbody></table>\n" +
    body +
    DOCUMENT_CLOSE
  );
}

function screenDashboardHtml(): string {
  const cards = Array.from({ length: 9 }, (_, index) => {
    const seed = index + 5;
    return `<article class="card"><h3>Metric ${index + 1}</h3><p class="value">${(seed * 137) % 900 + 100}</p><p>${sentence(seed)}</p></article>`;
  }).join("\n");
  return (
    DOCUMENT_OPEN +
    "<title>Screen dashboard</title>\n<style>\n" +
    "*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#0e1621;color:#e7eef7}\n" +
    ".layout{display:grid;grid-template-columns:220px 1fr;min-height:100vh}\n" +
    "nav{background:#162232;padding:20px 16px}nav a{display:block;color:#9fc3e8;padding:10px 8px;text-decoration:none;border-radius:6px}\n" +
    "main{padding:24px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}\n" +
    ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}\n" +
    ".card{background:#182738;border:1px solid #24425e;border-radius:10px;padding:16px}\n" +
    ".value{font-size:32px;font-weight:700;color:#5ce1b2;margin:4px 0 8px}\n" +
    ".banner{position:sticky;top:0;background:#1d3a57;padding:12px 16px;border-radius:8px;margin-bottom:16px}\n" +
    "</style>\n</head>\n<body>\n" +
    '<div class="layout">\n<aside><h2>PageForge</h2>' +
    "<a href=\"#\">Overview</a><a href=\"#\">Traffic</a><a href=\"#\">Latency</a><a href=\"#\">Errors</a></aside>\n" +
    "<main><div class=\"banner\">Live dashboard — screen mode measures the paper-fit pipeline.</div>\n" +
    "<header><h1>System overview</h1><span>last 24 hours</span></header>\n" +
    '<div class="grid">\n' +
    cards +
    "\n</div>\n</main>\n</div>" +
    DOCUMENT_CLOSE
  );
}

export const SCENARIOS: readonly BenchmarkScenario[] = [
  {
    name: "simple",
    description: "one-page article — fixed per-conversion overhead",
    html: articleHtml,
  },
  {
    name: "long-document",
    description: "120 deterministic paragraphs — pagination-dominated",
    html: longDocumentHtml,
  },
  {
    name: "print-css",
    description: "@page rules, forced breaks, tables — document-mode print pipeline",
    html: printCssHtml,
  },
  {
    name: "screen-dashboard",
    description: "CSS-grid dashboard rendered in screen (paper-fit) mode",
    html: screenDashboardHtml,
    pageforgeOptions: { mode: "screen" },
  },
];

export const SCENARIO_NAMES: readonly string[] = SCENARIOS.map((scenario) => scenario.name);
