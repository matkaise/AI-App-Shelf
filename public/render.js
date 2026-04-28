(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AppShelfRenderer = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  function renderRunnableApp(code) {
    if (isLikelyReactCanvasApp(code)) {
      return { type: "react", html: buildReactCanvasHtml(code) };
    }

    return { type: "html", html: code || "<!doctype html><html><body></body></html>" };
  }

  function isLikelyReactCanvasApp(code) {
    const trimmed = String(code || "").trim();
    if (!trimmed) return false;
    if (/^\s*(?:<!doctype|<html|<head|<body)\b/i.test(trimmed)) return false;
    if (/^\s*</.test(trimmed) && !/\bclassName=|\{[^}]+\}/.test(trimmed)) return false;

    return /from\s+["']react["']|export\s+default\s+function|\buse(?:State|Memo|Effect|Ref|Callback|Reducer)\s*\(|\bclassName=|return\s*\(\s*</.test(
      trimmed
    );
  }

  function buildReactCanvasHtml(source) {
    const transformed = transformReactCanvasSource(source);
    const candidateChecks = transformed.componentNames
      .map((name) => `(typeof ${name} !== "undefined" ? ${name} : null)`)
      .join(",\n        ");

    return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AI App Shelf React App</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <style>
      html, body, #root { min-height: 100%; }
      body { margin: 0; }
      #app-shelf-error {
        margin: 16px;
        padding: 14px 16px;
        border: 1px solid #fecaca;
        border-radius: 8px;
        background: #fef2f2;
        color: #991b1b;
        font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <pre id="app-shelf-error" hidden></pre>
    <script>
      function showAppShelfError(error) {
        var target = document.getElementById("app-shelf-error");
        if (!target) return;
        target.hidden = false;
        target.textContent = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
      }

      window.addEventListener("error", function (event) {
        showAppShelfError(event.error || event.message);
      });

      window.addEventListener("unhandledrejection", function (event) {
        showAppShelfError(event.reason || "Unhandled promise rejection");
      });
    </script>
    <script type="text/babel" data-presets="env,react">
      const {
        Children, Fragment, StrictMode, Suspense, cloneElement, createContext, forwardRef,
        isValidElement, lazy, memo, startTransition, useCallback, useContext, useDebugValue,
        useDeferredValue, useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect,
        useMemo, useReducer, useRef, useState, useSyncExternalStore, useTransition
      } = React;

${escapeScriptContent(transformed.code)}

      const appShelfCandidates = [
        ${candidateChecks}
      ].filter(Boolean);
      const appShelfComponent = appShelfCandidates.find((candidate) => {
        return typeof candidate === "function" || (candidate && typeof candidate === "object");
      });

      if (!appShelfComponent) {
        throw new Error("No React component found. Export a default component or name it App.");
      }

      ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(appShelfComponent));
    </script>
  </body>
</html>`;
  }

  function transformReactCanvasSource(source) {
    let code = String(source || "").trim();
    let defaultComponent = null;

    code = code
      .replace(/^\s*import\s+(?:React\s*,\s*)?\{[^}]*\}\s+from\s+["']react["'];?\s*$/gm, "")
      .replace(/^\s*import\s+React\s+from\s+["']react["'];?\s*$/gm, "")
      .replace(/^\s*import\s+[^;\n]+;?\s*$/gm, (line) => {
        return `/* Unsupported import removed by AI App Shelf: ${line.replace(/\*\//g, "* /")} */`;
      });

    code = code.replace(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/, (match, name) => {
      defaultComponent = name;
      return `function ${name}(`;
    });

    code = code.replace(/export\s+default\s+function\s*\(/, () => {
      defaultComponent = "App";
      return "function App(";
    });

    code = code.replace(/export\s+default\s+([A-Za-z_$][\w$]*);?/g, (match, name) => {
      defaultComponent = name;
      return "";
    });

    code = code
      .replace(/export\s+(function|class)\s+/g, "$1 ")
      .replace(/export\s+(const|let|var)\s+/g, "$1 ")
      .replace(/export\s+\{[^}]*\};?/g, "");

    const componentNames = [];
    if (defaultComponent) componentNames.push(defaultComponent);
    for (const name of guessReactComponentNames(code)) componentNames.push(name);
    componentNames.push("App");

    return {
      code,
      componentNames: [...new Set(componentNames.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)))],
    };
  }

  function guessReactComponentNames(code) {
    const names = [];
    const patterns = [
      /\bfunction\s+([A-Z][A-Za-z0-9_$]*)\s*\(/g,
      /\b(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
      /\b(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*function\b/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(code))) names.push(match[1]);
    }

    return names;
  }

  function escapeScriptContent(value) {
    return String(value).replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  }

  return {
    renderRunnableApp,
    isLikelyReactCanvasApp,
    buildReactCanvasHtml,
    transformReactCanvasSource,
  };
});
