(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AppShelfRenderer = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  const REACT_IMPORTS = {
    react: "https://esm.sh/react@18.3.1",
    "react-dom": "https://esm.sh/react-dom@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
  };
  const SUPPORTED_IMPORTS = {
    "lucide-react": "https://esm.sh/lucide-react@1.11.0?bundle&external=react",
    recharts: "https://esm.sh/recharts@3.8.1?bundle&external=react,react-dom",
  };

  function renderRunnableApp(code) {
    if (isLikelyReactCanvasApp(code)) {
      const transformed = transformReactCanvasSource(code);
      return {
        type: "react",
        html: buildReactCanvasHtmlFromTransformed(transformed),
        warnings: transformed.warnings,
      };
    }

    return { type: "html", html: code || "<!doctype html><html><body></body></html>", warnings: [] };
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
    return buildReactCanvasHtmlFromTransformed(transformed);
  }

  function buildReactCanvasHtmlFromTransformed(transformed) {
    const candidateChecks = transformed.componentNames
      .map((name) => `(typeof ${name} !== "undefined" ? ${name} : null)`)
      .join(",\n        ");

    return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AI App Shelf React App</title>
    <script type="importmap">
      ${JSON.stringify({ imports: REACT_IMPORTS }, null, 6).replace(/<\/script/gi, "<\\/script")}
    </script>
    <script src="https://cdn.tailwindcss.com"></script>
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
    <script type="text/babel" data-presets="react">
      (async function bootAppShelfReactApp() {
        const appShelfImport = (specifier) => Function("s", "return import(s)")(specifier);
        const React = await appShelfImport("react");
        const ReactDOM = await appShelfImport("react-dom/client");
        const {
          Children, Fragment, StrictMode, Suspense, cloneElement, createContext, forwardRef,
          isValidElement, lazy, memo, startTransition, useCallback, useContext, useDebugValue,
          useDeferredValue, useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect,
          useMemo, useReducer, useRef, useState, useSyncExternalStore, useTransition
        } = React;

        function __appShelfPick(module, name, source) {
          if (!Object.prototype.hasOwnProperty.call(module, name)) {
            throw new Error('Import "' + name + '" was not exported by "' + source + '".');
          }
          return module[name];
        }

        function __appShelfDefault(module, source) {
          if (Object.prototype.hasOwnProperty.call(module, "default")) return module.default;
          throw new Error('Default import was not exported by "' + source + '".');
        }

${buildImportPrelude(transformed.imports)}

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
      })().catch(showAppShelfError);
    </script>
  </body>
</html>`;
  }

  function transformReactCanvasSource(source) {
    let code = String(source || "").trim();
    let defaultComponent = null;
    const warnings = [];
    const imports = [];

    code = stripImportStatements(code, warnings, imports);

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

    code = code.replace(/export\s+default\s+((?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*))\s*=>/g, (match, params) => {
      defaultComponent = "App";
      return `const App = ${params} =>`;
    });

    code = code.replace(/export\s+\*\s+from\s+["'][^"']+["'];?/g, (statement) => {
      warnings.push(`Unsupported export removed: ${compactStatement(statement)}`);
      return `/* Unsupported export removed by AI App Shelf: ${safeComment(statement)} */`;
    });

    code = code.replace(/export\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?/g, (statement) => {
      warnings.push(`Unsupported re-export removed: ${compactStatement(statement)}`);
      return `/* Unsupported re-export removed by AI App Shelf: ${safeComment(statement)} */`;
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
      imports,
      warnings: [...new Set(warnings)],
    };
  }

  function stripImportStatements(source, warnings, imports) {
    const lines = String(source || "").split(/\r?\n/);
    const kept = [];
    let importLines = null;

    for (const line of lines) {
      if (importLines) {
        importLines.push(line);
        if (endsImportStatement(line)) {
          keepOrWarnImport(importLines.join("\n"), kept, warnings, imports);
          importLines = null;
        }
        continue;
      }

      if (/^\s*import\b/.test(line)) {
        importLines = [line];
        if (endsImportStatement(line)) {
          keepOrWarnImport(importLines.join("\n"), kept, warnings, imports);
          importLines = null;
        }
        continue;
      }

      kept.push(line);
    }

    if (importLines) keepOrWarnImport(importLines.join("\n"), kept, warnings, imports);
    return kept.join("\n");
  }

  function endsImportStatement(line) {
    const trimmed = String(line || "").trim();
    return (
      /;\s*$/.test(trimmed) ||
      /^import\s+["'][^"']+["']\s*$/.test(trimmed) ||
      /\sfrom\s+["'][^"']+["']\s*$/.test(trimmed)
    );
  }

  function keepOrWarnImport(statement, kept, warnings, imports) {
    const normalized = compactStatement(statement);
    if (/^import\s+.+\s+from\s+["']react["'];?$/.test(normalized) || /^import\s+["']react["'];?$/.test(normalized)) {
      return;
    }

    const parsed = parseImportStatement(normalized);
    if (parsed && SUPPORTED_IMPORTS[parsed.source]) {
      imports.push(parsed);
      return;
    }

    warnings.push(`Unsupported import removed: ${normalized}`);
    kept.push(`/* Unsupported import removed by AI App Shelf: ${safeComment(statement)} */`);
  }

  function parseImportStatement(statement) {
    const sideEffect = statement.match(/^import\s+["']([^"']+)["'];?$/);
    if (sideEffect) return { source: sideEffect[1], named: [], defaultName: "", namespaceName: "", sideEffect: true };

    const match = statement.match(/^import\s+(.+?)\s+from\s+["']([^"']+)["'];?$/);
    if (!match) return null;

    const specifier = match[1].trim();
    const source = match[2];
    const parsed = { source, named: [], defaultName: "", namespaceName: "", sideEffect: false };

    if (/^\*\s+as\s+/.test(specifier)) {
      parsed.namespaceName = specifier.replace(/^\*\s+as\s+/, "").trim();
      return isIdentifier(parsed.namespaceName) ? parsed : null;
    }

    const namedStart = specifier.indexOf("{");
    if (namedStart >= 0) {
      const defaultPart = specifier.slice(0, namedStart).replace(/,$/, "").trim();
      if (defaultPart) {
        if (!isIdentifier(defaultPart)) return null;
        parsed.defaultName = defaultPart;
      }

      const namedPart = specifier.slice(namedStart);
      const closeIndex = namedPart.lastIndexOf("}");
      if (closeIndex < 0) return null;
      parsed.named = parseNamedImports(namedPart.slice(0, closeIndex + 1));
      if (!parsed.named) return null;
      return parsed;
    }

    if (!isIdentifier(specifier)) return null;
    parsed.defaultName = specifier;
    return parsed;
  }

  function parseNamedImports(value) {
    const inner = String(value || "").replace(/^\{/, "").replace(/\}$/, "").trim();
    if (!inner) return [];
    const names = [];

    for (const rawPart of inner.split(",")) {
      const part = rawPart.trim();
      if (!part) continue;
      const match = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!match) return null;
      names.push({ imported: match[1], local: match[2] || match[1] });
    }

    return names;
  }

  function buildImportPrelude(imports) {
    return (imports || [])
      .map((entry, index) => {
        const moduleName = `__appShelfModule${index}`;
        const lines = [
          `        const ${moduleName} = await appShelfImport(${JSON.stringify(SUPPORTED_IMPORTS[entry.source])});`,
        ];

        if (entry.namespaceName) lines.push(`        const ${entry.namespaceName} = ${moduleName};`);
        if (entry.defaultName) {
          lines.push(`        const ${entry.defaultName} = __appShelfDefault(${moduleName}, ${JSON.stringify(entry.source)});`);
        }
        for (const named of entry.named || []) {
          lines.push(
            `        const ${named.local} = __appShelfPick(${moduleName}, ${JSON.stringify(named.imported)}, ${JSON.stringify(
              entry.source
            )});`
          );
        }

        return lines.join("\n");
      })
      .join("\n");
  }

  function isIdentifier(value) {
    return /^[A-Za-z_$][\w$]*$/.test(String(value || ""));
  }

  function compactStatement(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function safeComment(value) {
    return compactStatement(value).replace(/\*\//g, "* /");
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
