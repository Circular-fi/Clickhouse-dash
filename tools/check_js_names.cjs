// Static check of the ES modules of src/static: a name that is read and declared nowhere (a function that a refactor moved or
// removed), and an import that nothing uses. It parses with the acorn that Node ships, so it needs
//   node --expose-internals tools/check_js_names.cjs src/static/app_*.js
// Exit code 1 and one line per finding. tests/harness/test_js_names_contract.py runs it.
// Undefined identifiers and unused imports of ES modules: node --expose-internals undef.cjs file.js...
const acorn = require('internal/deps/acorn/acorn/dist/acorn');
const walk = require('internal/deps/acorn/acorn-walk/dist/walk');
const fs = require('fs');
// What a browser gives a module besides the language: the names that the sources use.
const GLOBALS = new Set(['window','document','console','Math','JSON','Number','String','Object','Array','Map','Set','WeakMap','WeakSet','Promise','Symbol','Error','TypeError','RangeError','Date','RegExp','Intl','BigInt','Boolean','parseInt','parseFloat','isNaN','isFinite','undefined','NaN','Infinity','globalThis','setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','cancelAnimationFrame','queueMicrotask','performance','navigator','location','history','localStorage','sessionStorage','fetch','URL','URLSearchParams','AbortController','AbortSignal','Event','CustomEvent','KeyboardEvent','MouseEvent','PointerEvent','Element','HTMLElement','HTMLDialogElement','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement','HTMLButtonElement','HTMLCanvasElement','Node','NodeList','MutationObserver','ResizeObserver','IntersectionObserver','TextEncoder','TextDecoder','Uint8Array','Uint16Array','Uint32Array','Int8Array','Int16Array','Int32Array','Float32Array','Float64Array','ArrayBuffer','DataView','Blob','File','FileReader','FormData','Image','WebAssembly','Worker','Response','Request','Headers','Reflect','Proxy','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI','getComputedStyle','matchMedia','reportError','CSS','DOMParser','XMLSerializer','requestIdleCallback','cancelIdleCallback','structuredClone','atob','btoa','crypto','alert','confirm','prompt','screen','scrollTo','innerHeight','innerWidth','DOMException','ClipboardItem','CompressionStream','DecompressionStream','ReadableStream','WritableStream','TransformStream','Intl','arguments','Selection','Range','DocumentFragment','HTMLTemplateElement','SVGElement','CanvasRenderingContext2D','Path2D','OffscreenCanvas','ImageData','BroadcastChannel','MessageChannel','EventTarget','EventSource','Audio','PerformanceObserver','Option','CSSStyleSheet','StorageEvent','InputEvent','WheelEvent','FocusEvent','TouchEvent','DragEvent','ClipboardEvent','HTMLTableElement','HTMLAnchorElement','HTMLFormElement','Text','Comment','AggregateError','NodeFilter','DOMMatrix','IDBKeyRange','HTMLDetailsElement','SyntaxError','EvalError','URIError','ReferenceError','Function','Atomics','SharedArrayBuffer','BigInt64Array','BigUint64Array','Uint8ClampedArray','WeakRef','FinalizationRegistry','Iterator','escape','unescape','eval','isSecureContext','visualViewport','getSelection','open','close','print','focus','blur','postMessage','self','top','parent','frames','name','status','length','event']);
let bad = 0;
for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); } catch (e) { console.log(file, 'PARSE', e.message); bad++; continue; }
  // scopes
  class Scope { constructor(parent) { this.parent = parent; this.names = new Set(); } has(n) { for (let s = this; s; s = s.parent) if (s.names.has(n)) return true; return false; } }
  const root = new Scope(null);
  const declare = (scope, pattern) => {
    if (!pattern) return;
    switch (pattern.type) {
      case 'Identifier': scope.names.add(pattern.name); break;
      case 'ObjectPattern': for (const p of pattern.properties) declare(scope, p.type === 'RestElement' ? p.argument : p.value); break;
      case 'ArrayPattern': for (const e of pattern.elements) declare(scope, e); break;
      case 'AssignmentPattern': declare(scope, pattern.left); break;
      case 'RestElement': declare(scope, pattern.argument); break;
    }
  };
  const imported = new Map();
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') for (const s of node.specifiers) { root.names.add(s.local.name); imported.set(s.local.name, 0); }
  }
  const used = new Set();
  // hoist var/function declarations per function scope; let/const/class per block scope
  function visit(node, scope, fnScope) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Program': case 'BlockStatement': case 'StaticBlock': {
        const s = node.type === 'Program' ? scope : new Scope(scope);
        for (const st of node.body) {
          if (st.type === 'FunctionDeclaration') s.names.add(st.id.name);
          else if (st.type === 'ClassDeclaration') s.names.add(st.id.name);
          else if (st.type === 'VariableDeclaration') for (const d of st.declarations) declare(st.kind === 'var' ? fnScope : s, d.id);
          else if (st.type === 'ExportNamedDeclaration' && st.declaration) {
            const d = st.declaration;
            if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') s.names.add(d.id.name);
            else if (d.type === 'VariableDeclaration') for (const x of d.declarations) declare(s, x.id);
          }
        }
        // var declarations nested deeper
        hoistVars(node, fnScope);
        for (const st of node.body) visit(st, s, fnScope);
        return;
      }
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        const s = new Scope(scope);
        if (node.type === 'FunctionExpression' && node.id) s.names.add(node.id.name);
        for (const p of node.params) declare(s, p);
        s.names.add('arguments');
        for (const p of node.params) visit(p, s, s);
        if (node.body.type === 'BlockStatement') {
          const b = node.body;
          const bs = new Scope(s);
          for (const st of b.body) {
            if (st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') bs.names.add(st.id.name);
            else if (st.type === 'VariableDeclaration') for (const d of st.declarations) declare(st.kind === 'var' ? s : bs, d.id);
          }
          hoistVars(b, s);
          for (const st of b.body) visit(st, bs, s);
        } else visit(node.body, s, s);
        return;
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
        const s = new Scope(scope);
        const init = node.init || node.left;
        if (init && init.type === 'VariableDeclaration') for (const d of init.declarations) declare(init.kind === 'var' ? fnScope : s, d.id);
        for (const k of ['init', 'test', 'update', 'left', 'right', 'body']) if (node[k] && !(k === 'left' && node[k].type === 'VariableDeclaration') && !(k === 'init' && node[k].type === 'VariableDeclaration')) visit(node[k], s, fnScope);
        if (init && init.type === 'VariableDeclaration') for (const d of init.declarations) visit(d.init, s, fnScope);
        return;
      }
      case 'CatchClause': {
        const s = new Scope(scope);
        declare(s, node.param);
        visit(node.body, s, fnScope);
        return;
      }
      case 'ClassDeclaration': case 'ClassExpression': {
        const s = new Scope(scope);
        if (node.id) s.names.add(node.id.name);
        visit(node.superClass, scope, fnScope);
        for (const m of node.body.body) { if (m.computed) visit(m.key, s, fnScope); visit(m.value, s, fnScope); }
        return;
      }
      case 'VariableDeclaration': for (const d of node.declarations) { visitPattern(d.id, scope, fnScope); visit(d.init, scope, fnScope); } return;
      case 'Identifier': ref(node.name, scope, node); return;
      case 'MemberExpression': visit(node.object, scope, fnScope); if (node.computed) visit(node.property, scope, fnScope); return;
      case 'Property': if (node.computed) visit(node.key, scope, fnScope); visit(node.value, scope, fnScope); return;
      case 'PropertyDefinition': case 'MethodDefinition': if (node.computed) visit(node.key, scope, fnScope); visit(node.value, scope, fnScope); return;
      case 'LabeledStatement': visit(node.body, scope, fnScope); return;
      case 'BreakStatement': case 'ContinueStatement': case 'MetaProperty': return;
      case 'ImportDeclaration': return;
      case 'ExportNamedDeclaration':
        if (node.declaration) visit(node.declaration, scope, fnScope);
        for (const sp of node.specifiers || []) if (!node.source) ref(sp.local.name, scope, sp.local);
        return;
      case 'ExportDefaultDeclaration': visit(node.declaration, scope, fnScope); return;
      default:
        for (const k of Object.keys(node)) {
          if (k === 'type' || k === 'loc' || k === 'start' || k === 'end') continue;
          const v = node[k];
          if (Array.isArray(v)) for (const x of v) visit(x, scope, fnScope);
          else if (v && typeof v.type === 'string') visit(v, scope, fnScope);
        }
    }
  }
  function visitPattern(p, scope, fnScope) {
    if (!p) return;
    if (p.type === 'ObjectPattern') for (const x of p.properties) { if (x.computed) visit(x.key, scope, fnScope); visitPattern(x.type === 'RestElement' ? x.argument : x.value, scope, fnScope); }
    else if (p.type === 'ArrayPattern') for (const e of p.elements) visitPattern(e, scope, fnScope);
    else if (p.type === 'AssignmentPattern') { visitPattern(p.left, scope, fnScope); visit(p.right, scope, fnScope); }
    else if (p.type === 'RestElement') visitPattern(p.argument, scope, fnScope);
  }
  function hoistVars(node, fnScope) {
    walk.simple(node, { VariableDeclaration(d) { if (d.kind === 'var') for (const x of d.declarations) declare(fnScope, x.id); } }, { ...walk.base, FunctionDeclaration() {}, FunctionExpression() {}, ArrowFunctionExpression() {} });
  }
  function ref(name, scope, node) {
    if (imported.has(name)) used.add(name);
    if (scope.has(name) || GLOBALS.has(name)) { return; }
    bad++;
    console.log(`${file}:${node.loc.start.line}: undefined ${name}`);
  }
  visit(ast, root, root);
  for (const name of imported.keys()) if (!used.has(name)) { console.log(`${file}: unused import ${name}`); }
}
process.exit(bad ? 1 : 0);
