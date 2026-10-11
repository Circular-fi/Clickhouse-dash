// The shape of a JSON value: what a client of the answer depends on, without its values. An object is its keys, an array
// is the merge of the shapes of its elements (a key that any element has), a scalar is its type; null stands for "no value"
// and fits any type on the other side. compareShapes() lists what differs between the answer of a real server and the answer
// of the fake that a spec runs a page against.
export function shapeOf(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return value.length ? ['array', mergeShapes(value.map(shapeOf))] : ['array', 'empty'];
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf(value[key])]));
  return typeof value;
}

function mergeShapes(shapes) {
  return shapes.reduce((merged, shape) => mergeTwo(merged, shape));
}

function mergeTwo(a, b) {
  if (a === 'null' || a === 'empty') return b;
  if (b === 'null' || b === 'empty') return a;
  if (isObject(a) && isObject(b)) {
    const out = { ...a };
    for (const [key, shape] of Object.entries(b)) out[key] = key in out ? mergeTwo(out[key], shape) : shape;
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return ['array', mergeTwo(a[1], b[1])];
  return a;
}

const isObject = (shape) => shape !== null && typeof shape === 'object' && !Array.isArray(shape);

// Differences of `fake` from `real`, as "path: what" lines: a key only the real answer has, a key only the fake has, a
// type that differs.
export function compareShapes(real, fake, path = '$') {
  if (real === 'null' || fake === 'null' || real === 'empty' || fake === 'empty') return [];
  if (isObject(real) && isObject(fake)) {
    const out = [];
    for (const key of new Set([...Object.keys(real), ...Object.keys(fake)])) {
      if (!(key in fake)) out.push(`${path}.${key}: the real answer has it, the fake does not`);
      else if (!(key in real)) out.push(`${path}.${key}: the fake has it, the real answer does not`);
      else out.push(...compareShapes(real[key], fake[key], `${path}.${key}`));
    }
    return out;
  }
  if (Array.isArray(real) && Array.isArray(fake)) return compareShapes(real[1], fake[1], `${path}[]`);
  return JSON.stringify(real) === JSON.stringify(fake) ? [] : [`${path}: the real answer is ${JSON.stringify(real)}, the fake ${JSON.stringify(fake)}`];
}
