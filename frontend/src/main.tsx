import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { supabaseConfigError } from "@/integrations/supabase/client";
import "./index.css";

const rootEl = document.getElementById("root");

// Render a fatal-error screen using DOM APIs (textContent / setAttribute)
// instead of innerHTML so dynamic strings can never be interpreted as
// markup. The inputs here are always internal (Supabase config errors,
// caught Error objects) — but we treat them as untrusted on principle
// and to satisfy static-analysis XSS rules.
function renderFatal(message: string, detail?: string) {
  if (!rootEl) return;
  rootEl.textContent = "";

  const wrap = document.createElement("div");
  wrap.setAttribute(
    "style",
    "min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif;background:#fff;color:#111;",
  );

  const inner = document.createElement("div");
  inner.setAttribute("style", "max-width:640px;text-align:left;");

  const heading = document.createElement("h1");
  heading.setAttribute("style", "font-size:20px;margin:0 0 12px;");
  heading.textContent = "App failed to load";
  inner.appendChild(heading);

  const para = document.createElement("p");
  para.setAttribute("style", "margin:0 0 12px;line-height:1.5;");
  para.textContent = message;
  inner.appendChild(para);

  if (detail) {
    const pre = document.createElement("pre");
    pre.setAttribute(
      "style",
      "white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px;font-size:12px;overflow:auto;",
    );
    pre.textContent = detail;
    inner.appendChild(pre);
  }

  wrap.appendChild(inner);
  rootEl.appendChild(wrap);
}

try {
  if (supabaseConfigError) {
    renderFatal(supabaseConfigError);
  } else if (rootEl) {
    createRoot(rootEl).render(<App />);
  }
} catch (err) {
  const e = err as Error;
  renderFatal("An unexpected error occurred while starting the app.", `${e?.name ?? ""}: ${e?.message ?? String(err)}\n\n${e?.stack ?? ""}`);
  // eslint-disable-next-line no-console
  console.error("[main] render error", err);
}
