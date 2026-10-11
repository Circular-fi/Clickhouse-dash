const strict = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// The documentation of a function (app_explorer_doc.js): the text that ClickHouse sends (a small subset of Markdown) is shown without HTML. It is
// run on a minimal fake DOM, with the real renderer. What it promises: raw HTML stays text, a link exists only when the server's switch is on and
// only to the documentation host (never a scheme, never another host), a link opens in a new tab without the opener, and the structure
// (headings, bullets, fences, bold, code) is made of elements the page styles.
const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual: (actual, expected, message) => strict.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message),
});

class FakeNode {
  constructor(tag, text = null) { this.tag = tag; this.text = text; this.children = []; this.className = ''; this.href = null; this.target = null; this.rel = null; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...nodes) { this.children = nodes; }
  get textContent() { return this.text ?? this.children.map((child) => child.textContent).join(''); }
  find(tag) { return this.children.flatMap((child) => (child.tag === tag ? [child] : []).concat(child.text === null ? child.find(tag) : [])); }
  tags() { return this.children.map((child) => child.tag); }
}
const document = { createElement: (tag) => new FakeNode(tag), createTextNode: (text) => new FakeNode('#text', String(text)) };
const h = (tag, props, ...children) => {
  const el = new FakeNode(tag);
  if (props?.class) el.className = props.class;
  for (const child of children) el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  return el;
};

let doc;
let model;

test.before(async () => {
  model = { functionsCatalog: { markdown_links_enabled: false } };
  const run = await esm.load({
    root,
    globals: { document },
    stubs: {
      'app_dom.js': { h },
      'app_explorer_store.js': { model, clear: (el) => el.replaceChildren() },
      'app_highlight.js': { highlight: { renderInto: (el, text) => { el.text = text; } } },
    },
  });
  doc = await run.import('app_explorer_doc.js');
});

function render(markdown, { links = false } = {}) {
  model.functionsCatalog = { markdown_links_enabled: links };
  const root = new FakeNode('div');
  doc.appendFunctionDocSection(root, 'Description', markdown);
  return root.children[0].children[1];  // the .functionDoc__markdown body of the section
}

test('a link is plain text while the server switch is off: the label stays, no element is made for the address', () => {
  const body = render('See [`Array(T)`](/sql-reference/data-types/array) for more.');
  assert.equal(body.find('a').length, 0);
  assert.equal(body.textContent, 'See Array(T) for more.');
  assert.equal(body.find('code').length, 1, 'the label is inline code with or without the link');
});

test('with the switch on, a link goes to the documentation host only and opens in a new tab without the opener', () => {
  const body = render('[a](/sql-reference/a) [b](./sql-reference/b) [c](//evil.test/x) [d](https://evil.test/) [e](javascript:alert(1)) [f](data:text/html,x) [g]( /ok )', { links: true });
  const links = body.find('a');
  assert.deepEqual(links.map((a) => a.href), ['https://clickhouse.com/docs/sql-reference/a', 'https://clickhouse.com/docs/sql-reference/b', 'https://clickhouse.com/docs/ok']);
  for (const a of links) {
    assert.equal(a.target, '_blank');
    assert.equal(a.rel, 'noopener noreferrer');
  }
  // The refused ones keep their label as text (the address of the third is cut at its first closing parenthesis, as the renderer reads it).
  assert.ok(body.textContent.includes('c d e) f'), body.textContent);
});

test('raw HTML in the text stays text: the only elements are the ones the renderer makes', () => {
  const body = render('<img src=x onerror=alert(1)> **bold** and `code` <script>alert(2)</script>');
  const made = new Set(body.children.flatMap((p) => p.children.map((child) => child.tag)));
  assert.deepEqual([...made].sort(), ['#text', 'code', 'strong']);
  assert.ok(body.textContent.includes('<img src=x onerror=alert(1)>') && body.textContent.includes('<script>alert(2)</script>'));
});

test('headings, bullets, paragraphs and fences make their elements; a fence that is never closed still ends', () => {
  const body = render(['# Title', '## Sub', '### Third', 'first line', 'second line', '', '- one', '* two', '', '```sql', 'SELECT 1', '  FROM t', '```', 'after', '```', 'SELECT unfinished'].join('\n'));
  assert.deepEqual(body.tags(), ['h3', 'h3', 'h4', 'p', 'ul', 'pre', 'p', 'pre']);
  assert.equal(body.children[3].textContent, 'first line second line', 'the lines of a paragraph are joined');
  assert.deepEqual(body.children[4].children.map((li) => li.textContent), ['one', 'two']);
  const [fenced, unfinished] = [body.children[5], body.children[7]];
  assert.equal(fenced.children[0].className, 'language-sql');
  assert.equal(fenced.textContent, 'SELECT 1\n  FROM t', 'the code is kept as written');
  assert.equal(unfinished.textContent, 'SELECT unfinished');
});

test('the documentation is split by its headings: syntax, arguments, returned value, examples, see also', () => {
  const parts = doc.splitFunctionDocumentation(['Adds numbers.', '', '## Syntax', 'plus(a, b)', '', '**Arguments**:', '- a', '', 'Returned value', 'the sum', '', '### Examples', 'SELECT 1', '', 'See also', '- minus'].join('\n'));
  assert.deepEqual(parts, { description: 'Adds numbers.', syntax: 'plus(a, b)', arguments: '- a', returns: 'the sum', examples: 'SELECT 1', seeAlso: '- minus' });
  assert.equal(doc.splitFunctionDocumentation(null).description, '');
});

test('an empty section adds nothing to the page', () => {
  const root = new FakeNode('div');
  doc.appendFunctionDocSection(root, 'Syntax', '  \n ');
  assert.equal(root.children.length, 0);
});
