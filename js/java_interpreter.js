(function (root) {
  'use strict';

  const JP = (typeof require !== 'undefined') ? require('java-parser') : root.JavaParserLib;

  // ================= CST helpers =================
  function isToken(x) { return x && x.tokenType !== undefined; }
  function offsetOf(x) {
    if (x.location) return x.location.startOffset;
    return x.startOffset;
  }
  function allEntries(node) {
    const out = [];
    const ch = node.children || {};
    for (const k in ch) {
      for (const item of ch[k]) out.push({ key: k, item });
    }
    out.sort((a, b) => offsetOf(a.item) - offsetOf(b.item));
    return out;
  }
  function ruleChildren(node, key) { return (node.children && node.children[key]) || []; }
  function firstRule(node, key) { const a = ruleChildren(node, key); return a.length ? a[0] : null; }
  function tokenImage(node, key) { const a = ruleChildren(node, key); return a.length ? a[0].image : null; }
  function hasKey(node, key) { return !!(node.children && node.children[key] && node.children[key].length); }

  const PASS_THROUGH_STOP = new Set([
    // rules we handle explicitly and must NOT auto-unwrap past
    'block', 'literal', 'primary',
  ]);

  function unwrap(node) {
    while (node && !isToken(node)) {
      const entries = allEntries(node);
      if (entries.length === 1 && !isToken(entries[0].item)) {
        node = entries[0].item;
      } else {
        break;
      }
    }
    return node;
  }

  function srcOf(node, ctx) {
    const start = offsetOf(node);
    const end = node.location ? node.location.endOffset : node.endOffset;
    return ctx.code.slice(start, end + 1);
  }

  // ================= signals & errors =================
  class BreakSignal { constructor(label) { this.label = label; } }
  class ContinueSignal { constructor(label) { this.label = label; } }
  class ReturnSignal { constructor(value, type) { this.value = value; this.type = type; } }
  class UserThrown { constructor(value) { this.value = value; } }
  class InterpError extends Error {}
  class TooManyStepsError extends Error {}
  class TimeLimitError extends Error {}

  let frameCounter = 0;
  class Frame { constructor(name) { this.id = ++frameCounter; this.name = name; } }

  class Scope {
    constructor(parent, frame) { this.parent = parent; this.frame = frame; this.vars = new Map(); }
    declare(name, value, type, kind) { this.vars.set(name, { value, type, kind: kind || 'var' }); }
    find(name) {
      let s = this;
      while (s) { if (s.vars.has(name)) return s; s = s.parent; }
      return null;
    }
    get(name) {
      const s = this.find(name);
      if (!s) throw new InterpError(`变量 ${name} 未定义`);
      return s.vars.get(name);
    }
    set(name, value, type) {
      const s = this.find(name);
      if (!s) throw new InterpError(`变量 ${name} 未定义`);
      const entry = s.vars.get(name);
      entry.value = value;
      if (type) entry.type = type;
    }
    has(name) { return !!this.find(name); }
  }

  // ================= Java-flavored runtime types =================
  class JChar {
    constructor(code) { this.code = code; }
    toString() { return String.fromCharCode(this.code); }
  }
  class JArray {
    constructor(elemType, arr) { this.elemType = elemType; this.a = arr; }
    get length() { return this.a.length; }
  }
  class JObject {
    constructor(className, fields) { this.className = className; this.fields = fields || {}; }
  }
  class JArrayList {
    constructor(items) { this.items = items || []; }
    add(...a) { if (a.length === 2) { this.items.splice(a[0], 0, a[1]); return true; } this.items.push(a[0]); return true; }
    get(i) { return this.items[i]; }
    set(i, v) { const old = this.items[i]; this.items[i] = v; return old; }
    remove(i) {
      if (typeof i === 'number') return this.items.splice(i, 1)[0];
      const idx = this.items.findIndex((x) => jEquals(x, i));
      if (idx < 0) return false;
      this.items.splice(idx, 1);
      return true;
    }
    size() { return this.items.length; }
    isEmpty() { return this.items.length === 0; }
    contains(v) { return this.items.some((x) => jEquals(x, v)); }
    indexOf(v) { return this.items.findIndex((x) => jEquals(x, v)); }
    clear() { this.items.length = 0; }
    addAll(c) { const arr = c instanceof JArrayList ? c.items : c; for (const x of arr) this.items.push(x); return true; }
    toArray() { return new JArray(null, this.items.slice()); }
    iterator() { return this.items[Symbol.iterator](); }
    [Symbol.iterator]() { return this.items[Symbol.iterator](); }
  }
  class JLinkedList extends JArrayList {
    addFirst(v) { this.items.unshift(v); }
    addLast(v) { this.items.push(v); }
    removeFirst() { return this.items.shift(); }
    removeLast() { return this.items.pop(); }
    peekFirst() { return this.items[0]; }
    peekLast() { return this.items[this.items.length - 1]; }
    poll() { return this.items.shift(); }
    peek() { return this.items[0]; }
    push(v) { this.items.unshift(v); }
    pop() { return this.items.shift(); }
    offer(v) { this.items.push(v); return true; }
  }
  class JStack extends JArrayList {
    push(v) { this.items.push(v); return v; }
    pop() { if (!this.items.length) throw new UserThrown(new JObject('EmptyStackException', {})); return this.items.pop(); }
    peek() { if (!this.items.length) throw new UserThrown(new JObject('EmptyStackException', {})); return this.items[this.items.length - 1]; }
    empty() { return this.items.length === 0; }
  }
  function keyOf(k) {
    if (k instanceof JChar) return 'c:' + k.code;
    if (k === null) return 'null';
    if (typeof k === 'object' && k) return jFmt(k, 'auto');
    return typeof k + ':' + k;
  }
  class JMap {
    constructor() { this.m = new Map(); }
    put(k, v) { const kk = keyOf(k); const old = this.m.has(kk) ? this.m.get(kk).v : null; this.m.set(kk, { k, v }); return old; }
    get(k) { const e = this.m.get(keyOf(k)); return e ? e.v : null; }
    getOrDefault(k, d) { const e = this.m.get(keyOf(k)); return e ? e.v : d; }
    containsKey(k) { return this.m.has(keyOf(k)); }
    containsValue(v) { for (const e of this.m.values()) if (jEquals(e.v, v)) return true; return false; }
    remove(k) { const kk = keyOf(k); const e = this.m.get(kk); this.m.delete(kk); return e ? e.v : null; }
    size() { return this.m.size; }
    isEmpty() { return this.m.size === 0; }
    clear() { this.m.clear(); }
    keySet() { return new JLinkedHashSet(Array.from(this.m.values()).map((e) => e.k)); }
    values() { return new JArrayList(Array.from(this.m.values()).map((e) => e.v)); }
    entrySet() { return new JArrayList(Array.from(this.m.values()).map((e) => new JMapEntry(e.k, e.v))); }
    merge(k, v, fn) {
      const kk = keyOf(k);
      const cur = this.m.has(kk) ? this.m.get(kk).v : null;
      const nv = cur === null ? v : fn(cur, v);
      if (nv === null) this.m.delete(kk); else this.m.set(kk, { k, v: nv });
      return nv;
    }
    putIfAbsent(k, v) { const kk = keyOf(k); if (this.m.has(kk)) return this.m.get(kk).v; this.m.set(kk, { k, v }); return null; }
    forEach(fn) { for (const e of this.m.values()) fn(e.k, e.v); }
  }
  class JMapEntry { constructor(k, v) { this.k = k; this.v = v; } getKey() { return this.k; } getValue() { return this.v; } }
  class JSet {
    constructor(items) { this.m = new Map(); (items || []).forEach((x) => this.add(x)); }
    add(v) { const kk = keyOf(v); const isNew = !this.m.has(kk); this.m.set(kk, v); return isNew; }
    contains(v) { return this.m.has(keyOf(v)); }
    remove(v) { const kk = keyOf(v); const had = this.m.has(kk); this.m.delete(kk); return had; }
    size() { return this.m.size; }
    isEmpty() { return this.m.size === 0; }
    clear() { this.m.clear(); }
    addAll(c) { const arr = c instanceof JSet ? Array.from(c.m.values()) : (c.items || c); for (const x of arr) this.add(x); return true; }
    toArray() { return new JArray(null, Array.from(this.m.values())); }
    [Symbol.iterator]() { return this.m.values(); }
  }
  class JLinkedHashSet extends JSet {}
  class JTreeSet extends JSet {
    get sorted() { return Array.from(this.m.values()).sort(jCompare); }
    first() { return this.sorted[0]; }
    last() { const s = this.sorted; return s[s.length - 1]; }
    [Symbol.iterator]() { return this.sorted[Symbol.iterator](); }
  }
  class JTreeMap extends JMap {
    get sortedEntries() { return Array.from(this.m.values()).sort((a, b) => jCompare(a.k, b.k)); }
    keySet() { return new JLinkedHashSet(this.sortedEntries.map((e) => e.k)); }
    values() { return new JArrayList(this.sortedEntries.map((e) => e.v)); }
    entrySet() { return new JArrayList(this.sortedEntries.map((e) => new JMapEntry(e.k, e.v))); }
    firstKey() { return this.sortedEntries[0].k; }
    lastKey() { const s = this.sortedEntries; return s[s.length - 1].k; }
  }
  class JPriorityQueue {
    constructor(cmp) { this.items = []; this.cmp = cmp || jCompare; }
    add(v) { this.items.push(v); this.items.sort(this.cmp); return true; }
    offer(v) { return this.add(v); }
    poll() { return this.items.shift(); }
    peek() { return this.items[0]; }
    size() { return this.items.length; }
    isEmpty() { return this.items.length === 0; }
    [Symbol.iterator]() { return this.items[Symbol.iterator](); }
  }
  class JStringBuilder {
    constructor(init) { this.s = init !== undefined ? jToDisplayString(init) : ''; }
    append(v) { this.s += jToDisplayString(v); return this; }
    toString() { return this.s; }
    length() { return this.s.length; }
    charAt(i) { return new JChar(this.s.charCodeAt(i)); }
    reverse() { this.s = this.s.split('').reverse().join(''); return this; }
    deleteCharAt(i) { this.s = this.s.slice(0, i) + this.s.slice(i + 1); return this; }
    insert(i, v) { this.s = this.s.slice(0, i) + jToDisplayString(v) + this.s.slice(i); return this; }
    setCharAt(i, c) { this.s = this.s.slice(0, i) + jToDisplayString(c) + this.s.slice(i + 1); }
    substring(a, b) { return b === undefined ? this.s.slice(a) : this.s.slice(a, b); }
  }

  function jEquals(a, b) {
    if (a instanceof JChar && b instanceof JChar) return a.code === b.code;
    if (a instanceof JArray && b instanceof JArray) return a === b;
    if (a && a.equals) return a.equals(b);
    return a === b || (typeof a === 'number' && typeof b === 'number' && a === b);
  }
  function jCompare(a, b) {
    if (a instanceof JChar) a = a.code;
    if (b instanceof JChar) b = b.code;
    if (typeof a === 'string' || typeof b === 'string') return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  // ================= value formatting =================
  function javaDoubleStr(n) {
    if (Number.isNaN(n)) return 'NaN';
    if (n === Infinity) return 'Infinity';
    if (n === -Infinity) return '-Infinity';
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toFixed(1);
    return String(n);
  }

  function jToDisplayString(v) {
    if (v === null || v === undefined) return 'null';
    if (v instanceof JChar) return v.toString();
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return v;
    if (v instanceof JArray) return '[' + v.a.map((x) => short1(jFmt(x))).join(', ') + ']';
    if (v && typeof v.toString === 'function' && v.toString !== Object.prototype.toString) return v.toString();
    return jFmt(v);
  }

  function short1(s, n) { n = n || 60; s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function jFmt(v, depth, seen) {
    depth = depth || 0; seen = seen || new Set();
    if (v === null || v === undefined) return 'null';
    if (v instanceof JChar) return "'" + v.toString() + "'";
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (seen.has(v)) return '(circular)';
    if (v instanceof JArray) {
      if (depth > 3) return '[...]';
      seen.add(v);
      return '[' + v.a.map((x) => jFmt(x, depth + 1, seen)).join(', ') + ']';
    }
    if (v instanceof JMapEntry) return jFmt(v.k, depth + 1, seen) + '=' + jFmt(v.v, depth + 1, seen);
    if (v instanceof JMap) {
      if (depth > 3) return '{...}';
      const entries = v.sortedEntries || Array.from(v.m.values());
      return '{' + entries.map((e) => jFmt(e.k, depth + 1, seen) + '=' + jFmt(e.v, depth + 1, seen)).join(', ') + '}';
    }
    if (v instanceof JSet) {
      if (depth > 3) return '{...}';
      const items = v.sorted || Array.from(v.m.values());
      return '[' + items.map((x) => jFmt(x, depth + 1, seen)).join(', ') + ']';
    }
    if (v instanceof JArrayList) {
      if (depth > 3) return '[...]';
      return '[' + v.items.map((x) => jFmt(x, depth + 1, seen)).join(', ') + ']';
    }
    if (v instanceof JStringBuilder) return JSON.stringify(v.s);
    if (typeof v === 'function') return `ƒ ${v.__javaMeta ? v.__javaMeta.name : (v.name || 'method')}(${v.__javaMeta ? v.__javaMeta.params.map((p) => p.name).join(', ') : ''})`;
    if (v instanceof JObject) {
      if (depth > 3) return `${v.className}{...}`;
      if (v.className === 'ListNode') {
        const parts = [];
        let cur = v; let n = 0;
        while (cur && n < 40) { parts.push(jFmt(cur.fields.val, depth + 1, seen)); cur = cur.fields.next; n++; }
        return parts.join(' -> ') + (cur ? ' -> ...' : ' -> null');
      }
      const keys = Object.keys(v.fields);
      return `${v.className}{${keys.map((k) => `${k}=${jFmt(v.fields[k], depth + 1, seen)}`).join(', ')}}`;
    }
    return String(v);
  }

  // ================= numeric type promotion =================
  function normType(t) {
    if (t === 'byte' || t === 'short' || t === 'char') return t;
    return t;
  }
  function rank(t) {
    if (t === 'double') return 4;
    if (t === 'float') return 3;
    if (t === 'long') return 2;
    if (t === 'int' || t === 'char' || t === 'short' || t === 'byte') return 1;
    return 0;
  }
  function promote(t1, t2) {
    const types = ['boolean', 0, 'int', 'long', 'float', 'double'];
    const r = Math.max(rank(t1), rank(t2));
    return r === 4 ? 'double' : r === 3 ? 'float' : r === 2 ? 'long' : 'int';
  }
  function numOf(v) { return v instanceof JChar ? v.code : v; }
  function wrapInt(n) { return n | 0; }
  function coerceToType(v, t) {
    if (t === 'int') return wrapInt(Math.trunc(numOf(v)));
    if (t === 'long') return Math.trunc(numOf(v));
    if (t === 'char') return new JChar(numOf(v) & 0xffff);
    if (t === 'float' || t === 'double') return numOf(v) * 1.0;
    if (t === 'boolean') return !!v;
    return v;
  }
  function isNumericType(t) { return t === 'int' || t === 'long' || t === 'float' || t === 'double' || t === 'char' || t === 'short' || t === 'byte'; }
  // Best-effort fallback for values whose static type wasn't tracked (e.g. the
  // return of a built-in collection method like size()/poll(), where we don't
  // maintain per-method return-type metadata): infer int/double from the JS
  // value's own shape rather than refusing to treat it as numeric at all.
  function effectiveNumType(v, t) {
    if (isNumericType(t)) return t;
    if (v instanceof JChar) return 'char';
    if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
    return t;
  }

  function throwJava(ctx, className, message) {
    const obj = new JObject(className, { message: message === undefined ? null : message });
    throw new UserThrown(obj);
  }

  // ================= binary / unary ops =================
  function binOp(ctx, op, lv, lt, rv, rt) {
    if (op === '+' && (lt === 'String' || rt === 'String')) {
      return { v: jToDisplayString(lv) + jToDisplayString(rv), t: 'String' };
    }
    if (op === '==' || op === '!=') {
      let eq;
      if (isNumericType(lt) || isNumericType(rt) || lt === 'boolean' || rt === 'boolean') {
        eq = numOf(lv) === numOf(rv) || lv === rv;
      } else if (lt === 'String' && rt === 'String') {
        eq = lv === rv;
      } else {
        eq = lv === rv || (lv === null && rv === null);
      }
      return { v: op === '==' ? eq : !eq, t: 'boolean' };
    }
    if (op === '&&' || op === '||') {
      throw new InterpError('&&/|| 应在短路求值中处理');
    }
    if (op === 'instanceof') {
      return { v: instanceOfCheck(lv, rt), t: 'boolean' };
    }
    lt = effectiveNumType(lv, lt);
    rt = effectiveNumType(rv, rt);
    if (isNumericType(lt) && isNumericType(rt)) {
      const pt = promote(lt, rt);
      const a = numOf(lv), b = numOf(rv);
      switch (op) {
        case '<': return { v: a < b, t: 'boolean' };
        case '>': return { v: a > b, t: 'boolean' };
        case '<=': return { v: a <= b, t: 'boolean' };
        case '>=': return { v: a >= b, t: 'boolean' };
      }
      let r;
      switch (op) {
        case '+': r = a + b; break;
        case '-': r = a - b; break;
        case '*': r = a * b; break;
        case '/':
          if (b === 0 && (pt === 'int' || pt === 'long')) throwJava(ctx, 'ArithmeticException', '/ by zero');
          r = (pt === 'int' || pt === 'long') ? Math.trunc(a / b) : a / b;
          break;
        case '%':
          if (b === 0 && (pt === 'int' || pt === 'long')) throwJava(ctx, 'ArithmeticException', '/ by zero');
          r = a % b;
          break;
        case '&': return { v: (pt === 'boolean') ? (a && b) : ((a | 0) & (b | 0)), t: pt };
        case '|': return { v: (a | 0) | (b | 0), t: pt };
        case '^': return { v: (a | 0) ^ (b | 0), t: pt };
        case '<<': return { v: wrapInt((a | 0) << (b & 31)), t: 'int' };
        case '>>': return { v: (a | 0) >> (b & 31), t: pt };
        case '>>>': return { v: (a | 0) >>> (b & 31), t: 'int' };
        default: throw new InterpError('不支持的运算符 ' + op);
      }
      if (pt === 'int') r = wrapInt(r);
      return { v: r, t: pt };
    }
    if (lt === 'boolean' && rt === 'boolean') {
      switch (op) {
        case '&': return { v: lv && rv, t: 'boolean' };
        case '|': return { v: lv || rv, t: 'boolean' };
        case '^': return { v: lv !== rv, t: 'boolean' };
      }
    }
    throw new InterpError(`不支持的运算: ${lt} ${op} ${rt}`);
  }

  function instanceOfCheck(v, typeName) {
    if (v === null) return false;
    if (typeName === 'String') return typeof v === 'string';
    if (typeName === 'Integer' || typeName === 'Long' || typeName === 'Short' || typeName === 'Byte') return typeof v === 'number';
    if (typeName === 'Double' || typeName === 'Float') return typeof v === 'number';
    if (typeName === 'Boolean') return typeof v === 'boolean';
    if (typeName === 'Character') return v instanceof JChar;
    if (v instanceof JObject) return v.className === typeName || isSubclassOf(v.className, typeName);
    const ctorMap = { List: JArrayList, ArrayList: JArrayList, LinkedList: JLinkedList, Map: JMap, HashMap: JMap, Set: JSet, HashSet: JSet };
    if (ctorMap[typeName]) return v instanceof ctorMap[typeName];
    return false;
  }
  let CLASS_TABLE = {};
  function isSubclassOf(className, target) {
    let c = CLASS_TABLE[className];
    while (c) {
      if (c.name === target) return true;
      c = c.superName ? CLASS_TABLE[c.superName] : null;
    }
    return false;
  }

  // ================= step recording (shared shape with JS/Python engines) =================
  function collectFrames(scope) {
    const frames = [];
    let s = scope;
    let curFrame = null, curVars = null, curOrder = null;
    while (s) {
      if (s.frame !== curFrame) {
        if (curFrame) frames.push({ id: curFrame.id, name: curFrame.name, vars: curVars, order: curOrder });
        curFrame = s.frame; curVars = {}; curOrder = [];
      }
      for (const [k, entry] of s.vars) {
        if (entry.kind === 'builtin') continue;
        if (!(k in curVars)) { curVars[k] = jFmt(entry.value); curOrder.push(k); }
      }
      s = s.parent;
    }
    if (curFrame) frames.push({ id: curFrame.id, name: curFrame.name, vars: curVars, order: curOrder });
    return frames;
  }

  function recordStep(ctx, scope, node, label, kind) {
    if (ctx.steps.length >= ctx.stepBudget) throw new TooManyStepsError();
    if (ctx.steps.length % 200 === 0 && Date.now() - ctx.startTime > 8000) throw new TimeLimitError();
    const frames = collectFrames(scope);
    const flat = {};
    frames.forEach((f) => f.order.forEach((k) => { flat[f.id + ':' + k] = f.vars[k]; }));
    const changed = [];
    for (const key in flat) if (ctx.lastFlat[key] !== flat[key]) changed.push(key);
    ctx.lastFlat = flat;
    const line = node.location ? node.location.startLine : (node.startLine || 1);
    ctx.steps.push({
      line, label: short1(label, 160), kind: kind || 'stmt', frames, changed,
      outputLen: ctx.output.length,
    });
  }

  function short(s, n) { n = n || 90; s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // ================= type name extraction =================
  function typeNameOf(unannTypeOrSimilar) {
    if (!unannTypeOrSimilar) return 'Object';
    const text = [];
    (function walk(n) {
      if (isToken(n)) { text.push(n.image); return; }
      for (const e of allEntries(n)) walk(e.item);
    })(unannTypeOrSimilar);
    let s = text.join('');
    s = s.replace(/<.*?>/g, '');
    return s;
  }
  function baseTypeName(t) { return t.replace(/\[\]/g, ''); }
  function arrayDims(t) { const m = t.match(/(\[\])+$/); return m ? m[0].length / 2 : 0; }

  function defaultForType(t) {
    const base = baseTypeName(t);
    if (arrayDims(t) > 0) return null;
    switch (base) {
      case 'int': case 'long': case 'short': case 'byte': return 0;
      case 'double': case 'float': return 0.0;
      case 'boolean': return false;
      case 'char': return new JChar(0);
      default: return null;
    }
  }

  // ================= class registration =================
  function registerClass(node, isStatic) {
    // node: normalClassDeclaration
    const name = tokenImage(node, 'typeIdentifier') || tokenImage(firstRule(node, 'typeIdentifier'), 'Identifier');
    const nameNode = firstRule(node, 'typeIdentifier');
    const className = nameNode ? tokenImage(nameNode, 'Identifier') : name;
    let superName = null;
    const superclassRule = firstRule(node, 'superclass');
    if (superclassRule) superName = typeNameOf(superclassRule);
    const cls = { name: className, superName, fields: [], methods: {}, constructors: [], isStatic: !!isStatic, node };
    CLASS_TABLE[className] = cls;
    const body = firstRule(node, 'classBody');
    if (!body) return cls;
    for (const cbd of ruleChildren(body, 'classBodyDeclaration')) {
      registerClassBodyDecl(cbd, cls);
    }
    return cls;
  }

  function modsHaveStatic(modsArr) {
    return modsArr.some((m) => hasKey(m, 'Static') || allEntries(m).some((e) => isToken(e.item) && e.item.tokenType.name === 'Static'));
  }

  function registerClassBodyDecl(cbd, cls) {
    const cmd = firstRule(cbd, 'classMemberDeclaration');
    if (cmd) {
      const field = firstRule(cmd, 'fieldDeclaration');
      if (field) { registerField(field, cls); return; }
      const method = firstRule(cmd, 'methodDeclaration');
      if (method) { registerMethod(method, cls); return; }
      const nested = firstRule(cmd, 'classDeclaration');
      if (nested) {
        const ncd = firstRule(nested, 'normalClassDeclaration');
        if (ncd) registerClass(ncd, true);
        return;
      }
      return;
    }
    const ctor = firstRule(cbd, 'constructorDeclaration');
    if (ctor) { registerConstructor(ctor, cls); return; }
    const nestedInit = firstRule(cbd, 'staticInitializer');
    if (nestedInit) { cls.staticInit = firstRule(nestedInit, 'block'); return; }
  }

  function registerField(fieldNode, cls) {
    const unannType = firstRule(fieldNode, 'unannType');
    const t = typeNameOf(unannType);
    const isStatic = ruleChildren(fieldNode, 'fieldModifier').some((m) => allEntries(m).some((e) => isToken(e.item) && e.item.tokenType.name === 'Static'));
    const list = firstRule(fieldNode, 'variableDeclaratorList');
    for (const decl of ruleChildren(list, 'variableDeclarator')) {
      const idNode = firstRule(decl, 'variableDeclaratorId');
      const fname = tokenImage(idNode, 'Identifier');
      const extraDims = ruleChildren(idNode, 'dims').length;
      const initNode = firstRule(decl, 'variableInitializer');
      cls.fields.push({ name: fname, type: t + '[]'.repeat(extraDims), initNode, isStatic });
    }
  }

  function paramsOf(paramListNode) {
    const out = [];
    if (!paramListNode) return out;
    for (const p of ruleChildren(paramListNode, 'formalParameter')) {
      const reg = firstRule(p, 'variableParaRegularParameter');
      if (reg) {
        const t = typeNameOf(firstRule(reg, 'unannType'));
        const idNode = firstRule(reg, 'variableDeclaratorId');
        out.push({ name: tokenImage(idNode, 'Identifier'), type: t, dims: ruleChildren(idNode, 'dims').length });
        continue;
      }
      const varArgs = firstRule(p, 'variableArityParameter');
      if (varArgs) {
        const t = typeNameOf(firstRule(varArgs, 'unannType'));
        out.push({ name: tokenImage(varArgs, 'Identifier'), type: t + '[]', varargs: true });
      }
    }
    return out;
  }

  function registerMethod(methodNode, cls) {
    const mods = ruleChildren(methodNode, 'methodModifier');
    const isStatic = mods.some((m) => allEntries(m).some((e) => isToken(e.item) && e.item.tokenType.name === 'Static'));
    const header = firstRule(methodNode, 'methodHeader');
    const resultNode = firstRule(header, 'result');
    const returnType = resultNode && hasKey(resultNode, 'Void') ? 'void' : typeNameOf(resultNode);
    const declarator = firstRule(header, 'methodDeclarator');
    const mname = tokenImage(declarator, 'Identifier');
    const params = paramsOf(firstRule(declarator, 'formalParameterList'));
    const body = firstRule(methodNode, 'methodBody');
    const block = firstRule(body, 'block');
    const meta = { name: mname, params, returnType, body: block, isStatic, className: cls.name };
    (cls.methods[mname] = cls.methods[mname] || []).push(meta);
  }

  function registerConstructor(ctorNode, cls) {
    const declarator = firstRule(ctorNode, 'constructorDeclarator');
    const params = paramsOf(firstRule(declarator, 'formalParameterList'));
    const body = firstRule(ctorNode, 'constructorBody');
    cls.constructors.push({ params, body, className: cls.name });
  }

  function findOverload(list, argc) {
    if (!list || !list.length) return null;
    let best = list.find((m) => m.params.length === argc && !m.params.some((p) => p.varargs));
    if (best) return best;
    best = list.find((m) => m.params.some((p) => p.varargs) && argc >= m.params.length - 1);
    if (best) return best;
    return list[0];
  }

  function fieldTypeOf(className, fname) {
    let c = CLASS_TABLE[className];
    while (c) {
      const f = c.fields.find((x) => x.name === fname);
      if (f) return f.type;
      c = c.superName ? CLASS_TABLE[c.superName] : null;
    }
    return 'Object';
  }
  function findMethod(className, mname) {
    let c = CLASS_TABLE[className];
    while (c) {
      if (c.methods[mname]) return { list: c.methods[mname], ownerClass: c.name };
      c = c.superName ? CLASS_TABLE[c.superName] : null;
    }
    return null;
  }

  function instantiateUser(ctx, className, argRefs) {
    const cls = CLASS_TABLE[className];
    const obj = new JObject(className, {});
    initFields(ctx, obj, className);
    const ctor = findOverload(cls.constructors, argRefs.length);
    if (ctor) {
      callWithFrame(ctx, ctor.params, argRefs, obj, className, false, (scope) => {
        try { execBlock(ctor.body, scope, ctx, { className, thisObj: obj, isStatic: false }); } catch (e) { if (!(e instanceof ReturnSignal)) throw e; }
      }, ctor.body, className);
    }
    return obj;
  }

  function initFields(ctx, obj, className) {
    const chain = [];
    let c = CLASS_TABLE[className];
    while (c) { chain.unshift(c); c = c.superName ? CLASS_TABLE[c.superName] : null; }
    for (const cl of chain) {
      for (const f of cl.fields) {
        if (f.isStatic) continue;
        let v = defaultForType(f.type);
        let t = baseTypeName(f.type);
        if (f.initNode) {
          const fscope = new Scope(null, new Frame(cl.name));
          fscope.declare('this', obj, cl.name, 'builtin');
          const r = evalExpr(firstRule(f.initNode, 'expression') || f.initNode, fscope, ctx, { className: cl.name, thisObj: obj, isStatic: false });
          v = coerceMaybe(r.v, f.type); t = f.type;
        }
        obj.fields[f.name] = v;
      }
    }
  }
  function coerceMaybe(v, type) {
    const base = baseTypeName(type);
    if (arrayDims(type) > 0) return v;
    if (isNumericType(base)) return coerceToType(v, base);
    return v;
  }

  function callWithFrame(ctx, params, argRefs, thisObj, className, isStatic, runner, bodyNodeForStep) {
    const frame = new Frame(className);
    const scope = new Scope(null, frame);
    if (thisObj !== undefined && thisObj !== null) scope.declare('this', thisObj, className, 'builtin');
    params.forEach((p, i) => {
      let v = argRefs[i] ? argRefs[i].v : defaultForType(p.type);
      let t = p.type;
      if (p.varargs) {
        const rest = argRefs.slice(i).map((a) => a.v);
        v = new JArray(baseTypeName(p.type), rest); t = p.type;
      } else if (isNumericType(baseTypeName(p.type)) && arrayDims(p.type) === 0) {
        v = coerceToType(v, baseTypeName(p.type));
      }
      scope.declare(p.name, v, t, 'param');
    });
    return runner(scope);
  }

  // ================= literals =================
  function evalLiteral(node) {
    if (hasKey(node, 'integerLiteral')) {
      const tok = allEntries(firstRule(node, 'integerLiteral'))[0].item;
      const img = tok.image;
      const isLong = /[lL]$/.test(img);
      let clean = img.replace(/[lL]$/, '');
      let n;
      if (/^0[xX]/.test(clean)) n = parseInt(clean, 16);
      else if (/^0[bB]/.test(clean)) n = parseInt(clean.slice(2), 2);
      else if (/^0[0-7]+$/.test(clean)) n = parseInt(clean, 8);
      else n = parseInt(clean.replace(/_/g, ''), 10);
      return { v: isLong ? n : wrapInt(n), t: isLong ? 'long' : 'int' };
    }
    if (hasKey(node, 'floatingPointLiteral')) {
      const tok = allEntries(firstRule(node, 'floatingPointLiteral'))[0].item;
      const img = tok.image;
      const isFloat = /[fF]$/.test(img);
      const n = parseFloat(img.replace(/[fFdD]$/, '').replace(/_/g, ''));
      return { v: n, t: isFloat ? 'float' : 'double' };
    }
    if (hasKey(node, 'BooleanLiteral')) return { v: tokenImage(node, 'BooleanLiteral') === 'true', t: 'boolean' };
    if (hasKey(node, 'CharLiteral')) {
      const img = tokenImage(node, 'CharLiteral');
      const inner = img.slice(1, -1);
      return { v: new JChar(unescapeJavaChar(inner)), t: 'char' };
    }
    if (hasKey(node, 'TextBlock') || hasKey(node, 'StringLiteral')) {
      const key = hasKey(node, 'TextBlock') ? 'TextBlock' : 'StringLiteral';
      const img = tokenImage(node, key);
      return { v: unescapeJavaString(img.slice(key === 'TextBlock' ? 3 : 1, key === 'TextBlock' ? -3 : -1)), t: 'String' };
    }
    if (hasKey(node, 'Null')) return { v: null, t: 'null' };
    throw new InterpError('未知字面量');
  }
  function unescapeJavaChar(s) {
    if (s[0] !== '\\') return s.codePointAt(0);
    const c = s[1];
    const map = { n: 10, t: 9, r: 13, b: 8, f: 12, '0': 0, '\\': 92, "'": 39, '"': 34 };
    if (c === 'u') return parseInt(s.slice(2), 16);
    return map[c] !== undefined ? map[c] : s.codePointAt(1);
  }
  function unescapeJavaString(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') {
        const c = s[i + 1];
        if (c === 'n') { out += '\n'; i++; }
        else if (c === 't') { out += '\t'; i++; }
        else if (c === 'r') { out += '\r'; i++; }
        else if (c === '"') { out += '"'; i++; }
        else if (c === "'") { out += "'"; i++; }
        else if (c === '\\') { out += '\\'; i++; }
        else if (c === 'u') { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 5; }
        else { out += c; i++; }
      } else out += s[i];
    }
    return out;
  }

  const PREC = { '*': 13, '/': 13, '%': 13, '+': 12, '-': 12, '<<': 11, '>>': 11, '>>>': 11, '<': 10, '>': 10, '<=': 10, '>=': 10, instanceof: 10, '==': 9, '!=': 9, '&': 8, '^': 7, '|': 6, '&&': 5, '||': 4 };

  function shiftOpText(node) { return allEntries(node).map((e) => e.item.image).join(''); }

  // ---- References (assignable locations) ----
  function refGet(ref, ctx) {
    switch (ref.kind) {
      case 'value': return { v: ref.v, t: ref.t };
      case 'var': { const e = ref.scope.get(ref.name); return { v: e.value, t: e.type }; }
      case 'field': {
        if (ref.obj === null || ref.obj === undefined) throwJava(ctx, 'NullPointerException', null);
        const t = fieldTypeOf(ref.obj.className, ref.name);
        return { v: ref.obj.fields[ref.name], t };
      }
      case 'staticfield': return getStaticField(ref.className, ref.name);
      case 'index': {
        if (ref.arr === null || ref.arr === undefined) throwJava(ctx, 'NullPointerException', null);
        if (ref.i < 0 || ref.i >= ref.arr.a.length) throwJava(ctx, 'ArrayIndexOutOfBoundsException', 'Index ' + ref.i + ' out of bounds for length ' + ref.arr.a.length);
        return { v: ref.arr.a[ref.i], t: baseTypeName(ref.arr.elemType || 'Object') };
      }
      case 'class': throw new InterpError(`${ref.className} 不是一个值`);
      case 'pendingMember': case 'staticOrPending': return resolvePendingAsValue(ref, ctx);
      case 'bareOrClass': throw new InterpError(`未定义的变量 ${ref.name}`);
      default: throw new InterpError('无法读取该表达式');
    }
  }
  function refSet(ref, v, t, ctx) {
    switch (ref.kind) {
      case 'var': { ref.scope.set(ref.name, v, t); return; }
      case 'field': {
        if (ref.obj === null || ref.obj === undefined) throwJava(ctx, 'NullPointerException', null);
        ref.obj.fields[ref.name] = v; return;
      }
      case 'staticfield': setStaticField(ref.className, ref.name, v); return;
      case 'index': {
        if (ref.arr === null || ref.arr === undefined) throwJava(ctx, 'NullPointerException', null);
        if (ref.i < 0 || ref.i >= ref.arr.a.length) throwJava(ctx, 'ArrayIndexOutOfBoundsException', 'Index ' + ref.i + ' out of bounds for length ' + ref.arr.a.length);
        ref.arr.a[ref.i] = v; return;
      }
      case 'pendingMember': {
        if (ref.receiverVal === null || ref.receiverVal === undefined) throwJava(ctx, 'NullPointerException', null);
        if (ref.receiverVal instanceof JObject) { ref.receiverVal.fields[ref.name] = v; return; }
        throw new InterpError('该表达式不可赋值');
      }
      case 'staticOrPending': setStaticField(ref.className, ref.name, v); return;
      default: throw new InterpError('该表达式不可赋值');
    }
  }

  const STATIC_FIELDS = {};
  function getStaticField(className, name) {
    if (className === 'Integer') {
      if (name === 'MAX_VALUE') return { v: 2147483647, t: 'int' };
      if (name === 'MIN_VALUE') return { v: -2147483648, t: 'int' };
    }
    if (className === 'Long') {
      if (name === 'MAX_VALUE') return { v: Number.MAX_SAFE_INTEGER, t: 'long' };
      if (name === 'MIN_VALUE') return { v: -Number.MAX_SAFE_INTEGER, t: 'long' };
    }
    if (className === 'Double') {
      if (name === 'MAX_VALUE') return { v: Number.MAX_VALUE, t: 'double' };
      if (name === 'MIN_VALUE') return { v: Number.MIN_VALUE, t: 'double' };
      if (name === 'POSITIVE_INFINITY') return { v: Infinity, t: 'double' };
      if (name === 'NEGATIVE_INFINITY') return { v: -Infinity, t: 'double' };
      if (name === 'NaN') return { v: NaN, t: 'double' };
    }
    if (className === 'Math') {
      if (name === 'PI') return { v: Math.PI, t: 'double' };
      if (name === 'E') return { v: Math.E, t: 'double' };
    }
    if (className === 'System' && name === 'out') return { v: SYSTEM_OUT, t: 'PrintStream' };
    if (className === 'System' && name === 'err') return { v: SYSTEM_ERR, t: 'PrintStream' };
    const cls = CLASS_TABLE[className];
    if (cls) {
      let c = cls;
      while (c) {
        if (c.fields.some((f) => f.name === name)) {
          const key = c.name + '.' + name;
          if (!(key in STATIC_FIELDS)) STATIC_FIELDS[key] = defaultForType(c.fields.find((f) => f.name === name).type);
          return { v: STATIC_FIELDS[key], t: c.fields.find((f) => f.name === name).type };
        }
        c = c.superName ? CLASS_TABLE[c.superName] : null;
      }
    }
    throw new InterpError(`未知的静态字段 ${className}.${name}`);
  }
  function setStaticField(className, name, v) { STATIC_FIELDS[className + '.' + name] = v; }

  const SYSTEM_OUT = { __stream: 'out' };
  const SYSTEM_ERR = { __stream: 'err' };

  // ---- primaryPrefix / chain resolution ----
  function evalPrefix(node, scope, ctx, mctx) {
    if (hasKey(node, 'literal')) return { kind: 'value', ...evalLiteral(firstRule(node, 'literal')) };
    if (hasKey(node, 'This')) return { kind: 'value', v: mctx.thisObj, t: mctx.className };
    if (hasKey(node, 'parenthesisExpression')) {
      const inner = firstRule(node, 'parenthesisExpression');
      const exprNode = firstRule(inner, 'expression');
      return { kind: 'value', ...evalExpr(exprNode, scope, ctx, mctx) };
    }
    if (hasKey(node, 'newExpression')) return { kind: 'value', ...evalNewExpression(firstRule(node, 'newExpression'), scope, ctx, mctx) };
    if (hasKey(node, 'fqnOrRefType')) return evalFqn(firstRule(node, 'fqnOrRefType'), scope, ctx, mctx);
    if (hasKey(node, 'castExpression')) return { kind: 'value', ...evalCast(firstRule(node, 'castExpression'), scope, ctx, mctx) };
    if (hasKey(node, 'unaryExpression')) return { kind: 'value', ...evalExpr(firstRule(node, 'unaryExpression'), scope, ctx, mctx) };
    throw new InterpError('不支持的表达式前缀: ' + Object.keys(node.children || {}).join(','));
  }

  function evalFqn(node, scope, ctx, mctx) {
    const parts = [];
    const first = firstRule(node, 'fqnOrRefTypePartFirst');
    const commonFirst = firstRule(first, 'fqnOrRefTypePartCommon');
    parts.push(tokenImage(commonFirst, 'Identifier') || tokenImage(commonFirst, 'This'));
    for (const rest of ruleChildren(node, 'fqnOrRefTypePartRest')) {
      const common = firstRule(rest, 'fqnOrRefTypePartCommon');
      parts.push(tokenImage(common, 'Identifier'));
    }
    let ref = resolveFirstName(parts[0], scope, ctx, mctx);
    for (let i = 1; i < parts.length; i++) ref = accessMember(ref, parts[i], scope, ctx, mctx);
    return ref;
  }

  const KNOWN_STATIC_CLASSES = new Set(['Math', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Character', 'String', 'Arrays', 'Collections', 'System', 'Objects', 'List', 'Optional']);

  function resolveFirstName(name, scope, ctx, mctx) {
    if (scope.has(name)) { const e = scope.get(name); return { kind: 'var', scope, name }; }
    if (mctx.thisObj && Object.prototype.hasOwnProperty.call(mctx.thisObj.fields, name)) {
      return { kind: 'field', obj: mctx.thisObj, name };
    }
    if (CLASS_TABLE[mctx.className] && CLASS_TABLE[mctx.className].fields.some((f) => f.name === name && f.isStatic)) {
      return { kind: 'staticfield', className: mctx.className, name };
    }
    if (CLASS_TABLE[name] || KNOWN_STATIC_CLASSES.has(name)) return { kind: 'class', className: name };
    // Unresolved bare identifier: could be an unqualified self/static method call
    // (e.g. `backtrack(0)` calling a sibling method) or, if followed by `.member`,
    // actually a class reference we don't otherwise recognize. Deferred until we
    // see what follows.
    return { kind: 'bareOrClass', name, mctx };
  }

  function accessMember(ref, name, scope, ctx, mctx) {
    if (ref.kind === 'bareOrClass') return accessMember({ kind: 'class', className: ref.name }, name, scope, ctx, mctx);
    if (ref.kind === 'class') {
      if (ref.className === 'System' && name === 'out') return { kind: 'value', v: SYSTEM_OUT, t: 'PrintStream' };
      if (ref.className === 'System' && name === 'err') return { kind: 'value', v: SYSTEM_ERR, t: 'PrintStream' };
      return { kind: 'staticOrPending', className: ref.className, name };
    }
    const cur = refGet(ref, ctx);
    return { kind: 'pendingMember', receiverVal: cur.v, receiverType: cur.t, name };
  }

  function resolvePendingAsValue(ref, ctx) {
    if (ref.kind === 'pendingMember') {
      if (ref.receiverVal === null || ref.receiverVal === undefined) throwJava(ctx, 'NullPointerException', "Cannot read field \"" + ref.name + "\"");
      if (ref.name === 'length' && ref.receiverVal instanceof JArray) return { v: ref.receiverVal.a.length, t: 'int' };
      if (ref.receiverVal instanceof JObject) return { v: ref.receiverVal.fields[ref.name], t: fieldTypeOf(ref.receiverVal.className, ref.name) };
      throw new InterpError(`无法访问 ${ref.name}`);
    }
    if (ref.kind === 'staticOrPending') return getStaticField(ref.className, ref.name);
    return refGet(ref, ctx);
  }

  function evalNewExpression(node, scope, ctx, mctx) {
    if (hasKey(node, 'arrayCreationExpression')) return evalArrayCreation(firstRule(node, 'arrayCreationExpression'), scope, ctx, mctx);
    const uc = firstRule(node, 'unqualifiedClassInstanceCreationExpression');
    const typeNode = firstRule(uc, 'classOrInterfaceTypeToInstantiate');
    const className = typeNameOf(typeNode);
    const args = evalArgList(firstRule(uc, 'argumentList'), scope, ctx, mctx);
    return newInstanceGeneric(ctx, className, args);
  }

  function newInstanceGeneric(ctx, className, argRefs) {
    const argv = argRefs.map((a) => a.v);
    switch (className) {
      case 'ArrayList': return { v: new JArrayList(argv[0] instanceof JArrayList ? argv[0].items.slice() : (argv[0] instanceof JSet ? Array.from(argv[0].m.values()) : [])), t: 'ArrayList' };
      case 'LinkedList': return { v: new JLinkedList(argv[0] instanceof JArrayList ? argv[0].items.slice() : []), t: 'LinkedList' };
      case 'Stack': return { v: new JStack(), t: 'Stack' };
      case 'ArrayDeque': return { v: new JLinkedList(), t: 'ArrayDeque' };
      case 'HashMap': case 'LinkedHashMap': { const m = new JMap(); if (argv[0] instanceof JMap) argv[0].forEach((k, v) => m.put(k, v)); return { v: m, t: className }; }
      case 'TreeMap': { const m = new JTreeMap(); if (argv[0] instanceof JMap) argv[0].forEach((k, v) => m.put(k, v)); return { v: m, t: className }; }
      case 'HashSet': { const s = new JSet(argv[0] instanceof JArrayList ? argv[0].items : (argv[0] instanceof JSet ? Array.from(argv[0].m.values()) : [])); return { v: s, t: className }; }
      case 'LinkedHashSet': { const s = new JLinkedHashSet(argv[0] instanceof JArrayList ? argv[0].items : []); return { v: s, t: className }; }
      case 'TreeSet': { const s = new JTreeSet(argv[0] instanceof JArrayList ? argv[0].items : (argv[0] instanceof JSet ? Array.from(argv[0].m.values()) : [])); return { v: s, t: className }; }
      case 'PriorityQueue': { const cmp = argv.find((a) => typeof a === 'function'); return { v: new JPriorityQueue(cmp ? (x, y) => callFunctional(ctx, cmp, [x, y]).v : undefined), t: className }; }
      case 'StringBuilder': case 'StringBuffer': return { v: new JStringBuilder(argv[0]), t: className };
      case 'String': return { v: argv[0] !== undefined ? jToDisplayString(argv[0]) : '', t: 'String' };
      case 'Random': return { v: { __random: true, nextInt: (b) => Math.floor(Math.random() * (b || 2147483647)) }, t: 'Random' };
      default: {
        if (CLASS_TABLE[className]) return { v: instantiateUser(ctx, className, argRefs), t: className };
        if (/Exception$|Error$/.test(className)) {
          const msg = typeof argv[0] === 'string' ? argv[0] : (argv[0] !== undefined ? jToDisplayString(argv[0]) : null);
          return { v: new JObject(className, { message: msg }), t: className };
        }
        return { v: new JObject(className, {}), t: className };
      }
    }
  }

  function evalArrayCreation(node, scope, ctx, mctx) {
    let elemType = 'Object';
    if (hasKey(node, 'primitiveType')) elemType = typeNameOf(firstRule(node, 'primitiveType'));
    else if (hasKey(node, 'classOrInterfaceType')) elemType = typeNameOf(firstRule(node, 'classOrInterfaceType'));
    const withInit = firstRule(node, 'arrayCreationWithInitializerSuffix');
    if (withInit) {
      const init = firstRule(withInit, 'arrayInitializer');
      return { v: evalArrayInitializer(init, elemType, scope, ctx, mctx), t: elemType + '[]' };
    }
    const without = firstRule(node, 'arrayCreationExpressionWithoutInitializerSuffix');
    const dimExprs = ruleChildren(firstRule(without, 'dimExprs'), 'dimExpr');
    const sizes = dimExprs.map((d) => evalExpr(firstRule(d, 'expression'), scope, ctx, mctx).v | 0);
    const extraDims = ruleChildren(without, 'dims').length;
    function build(dimsLeft) {
      if (dimsLeft.length === 0) return defaultForType(elemType);
      const [n, ...rest] = dimsLeft;
      const arr = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = rest.length ? build(rest) : defaultForType(elemType);
      return new JArray(elemType, arr);
    }
    let result = build(sizes);
    for (let i = 0; i < extraDims; i++) result = new JArray(elemType, []);
    return { v: result, t: elemType + '[]'.repeat(sizes.length + extraDims) };
  }
  function evalArrayInitializer(node, elemType, scope, ctx, mctx) {
    const list = firstRule(node, 'variableInitializerList');
    const items = [];
    for (const vi of ruleChildren(list, 'variableInitializer')) {
      const nestedArr = firstRule(vi, 'arrayInitializer');
      if (nestedArr) items.push(evalArrayInitializer(nestedArr, elemType, scope, ctx, mctx));
      else {
        const r = evalExpr(firstRule(vi, 'expression'), scope, ctx, mctx);
        items.push(isNumericType(elemType) ? coerceToType(r.v, elemType) : r.v);
      }
    }
    return new JArray(elemType, items);
  }

  function evalCast(node, scope, ctx, mctx) {
    const rc = firstRule(node, 'referenceTypeCastExpression');
    const pc = firstRule(node, 'primitiveCastExpression');
    if (pc) {
      const t = typeNameOf(firstRule(pc, 'primitiveType'));
      const inner = firstRule(pc, 'unaryExpression');
      const r = evalExpr(inner, scope, ctx, mctx);
      return { v: coerceToType(r.v, t), t };
    }
    const typeName = typeNameOf(firstRule(rc, 'referenceType'));
    const inner = firstRule(rc, 'unaryExpressionNotPlusMinus') || firstRule(rc, 'lambdaExpression');
    const r = evalExpr(inner, scope, ctx, mctx);
    return { v: r.v, t: typeName };
  }

  function evalArgList(node, scope, ctx, mctx) {
    if (!node) return [];
    const out = [];
    for (const e of ruleChildren(node, 'expression')) out.push(evalExpr(e, scope, ctx, mctx));
    return out;
  }

  // ---- primary (prefix + suffix*) ----
  function evalPrimaryRef(node, scope, ctx, mctx) {
    const prefixNode = firstRule(node, 'primaryPrefix');
    let ref = evalPrefix(prefixNode, scope, ctx, mctx);
    for (const suf of ruleChildren(node, 'primarySuffix')) {
      ref = applySuffix(ref, suf, scope, ctx, mctx, node);
    }
    return ref;
  }

  function applySuffix(ref, suf, scope, ctx, mctx, primaryNode) {
    const mi = firstRule(suf, 'methodInvocationSuffix');
    if (mi) {
      const args = evalArgList(firstRule(mi, 'argumentList'), scope, ctx, mctx);
      return { kind: 'value', ...invokeOn(ref, args, ctx, scope, mctx) };
    }
    const aa = firstRule(suf, 'arrayAccessSuffix');
    if (aa) {
      const idx = evalExpr(firstRule(aa, 'expression'), scope, ctx, mctx).v | 0;
      const cur = resolvePendingAsValue(ref, ctx);
      if (cur.v === null || cur.v === undefined) throwJava(ctx, 'NullPointerException', null);
      return { kind: 'index', arr: cur.v, i: idx };
    }
    if (hasKey(suf, 'Dot') && hasKey(suf, 'Identifier')) {
      const name = tokenImage(suf, 'Identifier');
      return accessMember(ref, name, scope, ctx, mctx);
    }
    if (hasKey(suf, 'Dot') && hasKey(suf, 'This')) {
      return ref;
    }
    return ref;
  }

  function invokeOn(ref, args, ctx, scope, mctx) {
    if (ref.kind === 'bareOrClass') {
      const found = findMethod(ref.mctx.className, ref.name);
      if (!found) throw new InterpError(`未定义的方法 ${ref.name}`);
      const meta = findOverload(found.list, args.length);
      const thisObj = meta.isStatic ? null : ref.mctx.thisObj;
      return callUserMethod(ctx, meta, thisObj, args, found.ownerClass);
    }
    if (ref.kind === 'staticOrPending') return callStaticMethod(ref.className, ref.name, args, ctx, mctx);
    if (ref.kind === 'pendingMember') return callInstanceMethod(ref.receiverVal, ref.receiverType, ref.name, args, ctx, mctx);
    throw new InterpError('无法调用该表达式');
  }

  function argVals(args) { return args.map((a) => a.v); }

  function callInstanceMethod(recv, recvType, name, args, ctx, mctx) {
    if (recv === null || recv === undefined) throwJava(ctx, 'NullPointerException', `Cannot invoke "${name}()" because value is null`);
    if (recv === SYSTEM_OUT || recv === SYSTEM_ERR) return callPrintStream(recv, name, args, ctx);
    if (recv instanceof JObject) {
      if (name === 'getMessage' || name === 'getLocalizedMessage') return { v: recv.fields.message !== undefined ? recv.fields.message : null, t: 'String' };
      if (name === 'toString') return { v: jFmt(recv), t: 'String' };
      if (name === 'equals') return { v: jEquals(recv, args[0] && args[0].v), t: 'boolean' };
      if (name === 'hashCode') return { v: 0, t: 'int' };
      const found = findMethod(recv.className, name);
      if (!found) throw new InterpError(`${recv.className} 没有方法 ${name}`);
      const meta = findOverload(found.list, args.length);
      return callUserMethod(ctx, meta, recv, args, found.ownerClass);
    }
    if (typeof recv === 'string') return callStringMethod(recv, name, args, ctx);
    if (recv instanceof JChar) return callStringMethod(recv.toString(), name, args, ctx);
    if (recv instanceof JStringBuilder) return callBuiltinObjMethod(recv, name, args, ctx);
    if (recv instanceof JArrayList || recv instanceof JMap || recv instanceof JSet || recv instanceof JPriorityQueue) {
      return callBuiltinObjMethod(recv, name, args, ctx);
    }
    if (recv instanceof JMapEntry) {
      if (name === 'getKey') return { v: recv.getKey(), t: 'Object' };
      if (name === 'getValue') return { v: recv.getValue(), t: 'Object' };
    }
    if (recv instanceof JArray) {
      if (name === 'clone') return { v: new JArray(recv.elemType, recv.a.slice()), t: recvType };
    }
    if (typeof recv === 'number' || recv instanceof JChar) {
      if (name === 'equals') return { v: jEquals(numOf(recv), args[0] && numOf(args[0].v)), t: 'boolean' };
      if (name === 'compareTo') { const b = numOf(args[0].v); const a = numOf(recv); return { v: a < b ? -1 : a > b ? 1 : 0, t: 'int' }; }
      if (name === 'toString') return { v: String(numOf(recv)), t: 'String' };
      if (name === 'intValue') return { v: wrapInt(Math.trunc(numOf(recv))), t: 'int' };
      if (name === 'doubleValue') return { v: numOf(recv) * 1.0, t: 'double' };
      if (name === 'longValue') return { v: Math.trunc(numOf(recv)), t: 'long' };
    }
    if (typeof recv === 'boolean' && name === 'equals') return { v: recv === args[0].v, t: 'boolean' };
    if (typeof recv === 'function') return callFunctional(ctx, recv, argVals(args));
    throw new InterpError(`无法在 ${recvType || typeof recv} 上调用方法 ${name}`);
  }

  function callFunctional(ctx, fn, argv) {
    if (fn.__javaMeta) return callUserMethod(ctx, fn.__javaMeta, fn.__javaThis, argv.map((v) => ({ v, t: null })), fn.__javaMeta.className);
    return { v: fn(...argv), t: null };
  }

  function callStaticOrOwnMethod(className, name, args, ctx, mctx) {
    // used when a bare (unqualified) identifier turned out to be a method name resolved as class-context fallback
    return callStaticMethod(className, name, args, ctx, mctx);
  }

  function ensureOutBuf(ctx) { if (!ctx.outBuf) ctx.outBuf = { log: '', error: '' }; return ctx.outBuf; }
  function streamKey(stream) { return stream === SYSTEM_ERR ? 'error' : 'log'; }
  function streamWrite(ctx, stream, text) {
    const buf = ensureOutBuf(ctx);
    const key = streamKey(stream);
    buf[key] += text;
    let idx;
    while ((idx = buf[key].indexOf('\n')) >= 0) {
      ctx.output.push({ text: buf[key].slice(0, idx), level: key });
      buf[key] = buf[key].slice(idx + 1);
    }
  }
  function flushOutBuf(ctx) {
    if (!ctx.outBuf) return;
    if (ctx.outBuf.log) ctx.output.push({ text: ctx.outBuf.log, level: 'log' });
    if (ctx.outBuf.error) ctx.output.push({ text: ctx.outBuf.error, level: 'error' });
    ctx.outBuf.log = ''; ctx.outBuf.error = '';
  }

  function callPrintStream(stream, name, args, ctx) {
    if (name === 'println') { streamWrite(ctx, stream, (args.length ? jToDisplayString(args[0].v) : '') + '\n'); return { v: undefined, t: 'void' }; }
    if (name === 'print') { streamWrite(ctx, stream, args.length ? jToDisplayString(args[0].v) : ''); return { v: undefined, t: 'void' }; }
    if (name === 'printf' || name === 'format') { streamWrite(ctx, stream, javaFormat(args[0].v, args.slice(1).map((a) => a.v))); return { v: undefined, t: 'void' }; }
    throw new InterpError('System.out.' + name + ' 不支持');
  }
  function javaFormat(fmt, args) {
    let i = 0;
    return fmt.replace(/%(-?\d+)?(\.\d+)?([sdfb%n])/g, (m, width, prec, conv) => {
      if (conv === '%') return '%';
      if (conv === 'n') return '\n';
      let val = args[i++];
      let s;
      if (conv === 'd') s = String(Math.trunc(numOf(val)));
      else if (conv === 'f') s = numOf(val).toFixed(prec ? parseInt(prec.slice(1), 10) : 6);
      else if (conv === 'b') s = String(!!val);
      else s = jToDisplayString(val);
      if (width) {
        const w = parseInt(width, 10);
        if (w < 0) s = s.padEnd(-w); else s = s.padStart(w);
      }
      return s;
    });
  }

  function callStringMethod(s, name, args, ctx) {
    const a = argVals(args);
    switch (name) {
      case 'length': return { v: s.length, t: 'int' };
      case 'charAt': return { v: new JChar(s.charCodeAt(a[0])), t: 'char' };
      case 'substring': return { v: a.length > 1 ? s.substring(a[0], a[1]) : s.substring(a[0]), t: 'String' };
      case 'indexOf': return { v: s.indexOf(typeof a[0] === 'string' ? a[0] : String.fromCharCode(numOf(a[0])), a[1] || 0), t: 'int' };
      case 'lastIndexOf': return { v: s.lastIndexOf(typeof a[0] === 'string' ? a[0] : String.fromCharCode(numOf(a[0]))), t: 'int' };
      case 'contains': return { v: s.includes(jToDisplayString(a[0])), t: 'boolean' };
      case 'equals': return { v: typeof a[0] === 'string' && s === a[0], t: 'boolean' };
      case 'equalsIgnoreCase': return { v: typeof a[0] === 'string' && s.toLowerCase() === a[0].toLowerCase(), t: 'boolean' };
      case 'compareTo': return { v: s < a[0] ? -1 : (s > a[0] ? 1 : 0), t: 'int' };
      case 'toUpperCase': return { v: s.toUpperCase(), t: 'String' };
      case 'toLowerCase': return { v: s.toLowerCase(), t: 'String' };
      case 'trim': case 'strip': return { v: s.trim(), t: 'String' };
      case 'isEmpty': return { v: s.length === 0, t: 'boolean' };
      case 'isBlank': return { v: s.trim().length === 0, t: 'boolean' };
      case 'startsWith': return { v: s.startsWith(a[0]), t: 'boolean' };
      case 'endsWith': return { v: s.endsWith(a[0]), t: 'boolean' };
      case 'replace': return { v: s.split(typeof a[0] === 'string' ? a[0] : String.fromCharCode(numOf(a[0]))).join(typeof a[1] === 'string' ? a[1] : String.fromCharCode(numOf(a[1]))), t: 'String' };
      case 'replaceAll': return { v: s.replace(new RegExp(a[0], 'g'), a[1]), t: 'String' };
      case 'split': return { v: new JArray('String', s.split(new RegExp(a[0]))), t: 'String[]' };
      case 'toCharArray': return { v: new JArray('char', Array.from(s).map((c) => new JChar(c.charCodeAt(0)))), t: 'char[]' };
      case 'concat': return { v: s + a[0], t: 'String' };
      case 'hashCode': { let h = 0; for (let i = 0; i < s.length; i++) h = wrapInt(h * 31 + s.charCodeAt(i)); return { v: h, t: 'int' }; }
      case 'toString': return { v: s, t: 'String' };
      case 'chars': return { v: new JArrayList(Array.from(s).map((c) => c.charCodeAt(0))), t: 'IntStream' };
      case 'repeat': return { v: s.repeat(a[0]), t: 'String' };
      case 'matches': return { v: new RegExp('^(?:' + a[0] + ')$').test(s), t: 'boolean' };
      case 'codePointAt': return { v: s.codePointAt(a[0]), t: 'int' };
      default: throw new InterpError('String.' + name + ' 不支持');
    }
  }

  function callBuiltinObjMethod(obj, name, args, ctx) {
    const a = args.map((x) => x.v);
    if (name === 'iterator' || name === 'forEach') {
      if (name === 'forEach') {
        const items = obj instanceof JMap ? null : (obj.items || Array.from(obj.m ? obj.m.values() : []));
        if (obj instanceof JMap) { obj.forEach((k, v) => callFunctional(ctx, a[0], [k, v])); return { v: undefined, t: 'void' }; }
        for (const it of items) callFunctional(ctx, a[0], [it]);
        return { v: undefined, t: 'void' };
      }
    }
    if (name === 'toString') {
      const hasOwnToString = typeof obj.toString === 'function' && obj.toString !== Object.prototype.toString;
      return { v: hasOwnToString ? obj.toString() : jFmt(obj), t: 'String' };
    }
    if (name === 'sort') {
      const cmp = a[0];
      const arr = obj.items;
      arr.sort(cmp ? (x, y) => numOf(callFunctional(ctx, cmp, [x, y]).v) : jCompare);
      return { v: undefined, t: 'void' };
    }
    if (typeof obj[name] !== 'function') throw new InterpError(`${obj.constructor.name} 没有方法 ${name}`);
    const result = obj[name](...a);
    return { v: result, t: null };
  }

  function callStaticMethod(className, name, args, ctx, mctx) {
    const a = args.map((x) => x.v);
    switch (className) {
      case 'Math': return callMath(name, a);
      case 'Integer': return callIntegerStatic(name, a);
      case 'Long': return callLongStatic(name, a);
      case 'Double': return callDoubleStatic(name, a);
      case 'Float': return callDoubleStatic(name, a, 'float');
      case 'Boolean': if (name === 'parseBoolean') return { v: String(a[0]).toLowerCase() === 'true', t: 'boolean' }; break;
      case 'Character': return callCharacterStatic(name, a);
      case 'String': return callStringStatic(name, a);
      case 'Arrays': return callArraysStatic(name, a, ctx);
      case 'Collections': return callCollectionsStatic(name, a, ctx);
      case 'List': if (name === 'of') return { v: new JArrayList(a.slice()), t: 'List' }; break;
      case 'Set': if (name === 'of') return { v: new JSet(a.slice()), t: 'Set' }; break;
      case 'Map': if (name === 'of') { const m = new JMap(); for (let i = 0; i < a.length; i += 2) m.put(a[i], a[i + 1]); return { v: m, t: 'Map' }; } break;
      case 'Objects':
        if (name === 'equals') return { v: jEquals(a[0], a[1]), t: 'boolean' };
        if (name === 'isNull') return { v: a[0] === null, t: 'boolean' };
        if (name === 'nonNull') return { v: a[0] !== null, t: 'boolean' };
        if (name === 'requireNonNull') { if (a[0] === null) throwJava(ctx, 'NullPointerException', a[1] || null); return { v: a[0], t: null }; }
        break;
      case 'System':
        if (name === 'currentTimeMillis') return { v: Date.now(), t: 'long' };
        if (name === 'nanoTime') return { v: Date.now() * 1e6, t: 'long' };
        if (name === 'arraycopy') { const [src, sp, dst, dp, len] = a; for (let i = 0; i < len; i++) dst.a[dp + i] = src.a[sp + i]; return { v: undefined, t: 'void' }; }
        if (name === 'exit') return { v: undefined, t: 'void' };
        break;
    }
    // fall back: static call on a user class, or implicit self-class call
    const found = findMethod(className, name) || findMethod(mctx.className, name);
    if (found) {
      const meta = findOverload(found.list, args.length);
      const thisObj = meta.isStatic ? null : mctx.thisObj;
      return callUserMethod(ctx, meta, thisObj, args, found.ownerClass);
    }
    throw new InterpError(`未知的静态方法 ${className}.${name}`);
  }

  function callMath(name, a) {
    const fns = {
      abs: (x) => Math.abs(x), max: (x, y) => Math.max(x, y), min: (x, y) => Math.min(x, y),
      pow: (x, y) => Math.pow(x, y), sqrt: (x) => Math.sqrt(x), cbrt: (x) => Math.cbrt(x),
      floor: (x) => Math.floor(x), ceil: (x) => Math.ceil(x), round: (x) => Math.round(x),
      log: (x) => Math.log(x), log10: (x) => Math.log10(x), exp: (x) => Math.exp(x),
      random: () => Math.random(), sin: Math.sin, cos: Math.cos, tan: Math.tan,
      hypot: (x, y) => Math.hypot(x, y), signum: (x) => Math.sign(x),
      floorDiv: (x, y) => Math.floor(x / y), floorMod: (x, y) => ((x % y) + y) % y,
      toIntExact: (x) => wrapInt(x),
    };
    if (!fns[name]) throw new InterpError('Math.' + name + ' 不支持');
    let v = fns[name](...a.map(numOf));
    let t = 'double';
    if (name === 'abs' || name === 'max' || name === 'min' || name === 'floorDiv' || name === 'floorMod') {
      t = Number.isInteger(numOf(a[0])) ? 'int' : 'double';
      if (t === 'int') v = wrapInt(v);
    }
    if (name === 'round') { t = 'long'; v = Math.round(numOf(a[0])); }
    return { v, t };
  }
  function callIntegerStatic(name, a) {
    switch (name) {
      case 'parseInt': return { v: wrapInt(parseInt(a[0], a[1] || 10)), t: 'int' };
      case 'valueOf': return { v: typeof a[0] === 'string' ? parseInt(a[0], a[1] || 10) : wrapInt(numOf(a[0])), t: 'int' };
      case 'toString': return { v: String(numOf(a[0])), t: 'String' };
      case 'toBinaryString': return { v: (numOf(a[0]) >>> 0).toString(2), t: 'String' };
      case 'toHexString': return { v: (numOf(a[0]) >>> 0).toString(16), t: 'String' };
      case 'max': return { v: Math.max(numOf(a[0]), numOf(a[1])), t: 'int' };
      case 'min': return { v: Math.min(numOf(a[0]), numOf(a[1])), t: 'int' };
      case 'compare': return { v: numOf(a[0]) < numOf(a[1]) ? -1 : (numOf(a[0]) > numOf(a[1]) ? 1 : 0), t: 'int' };
      case 'sum': return { v: wrapInt(numOf(a[0]) + numOf(a[1])), t: 'int' };
      case 'bitCount': { let n = numOf(a[0]) >>> 0, c = 0; while (n) { c += n & 1; n >>>= 1; } return { v: c, t: 'int' }; }
      default: throw new InterpError('Integer.' + name + ' 不支持');
    }
  }
  function callLongStatic(name, a) {
    switch (name) {
      case 'parseLong': return { v: parseInt(a[0], 10), t: 'long' };
      case 'valueOf': return { v: numOf(a[0]), t: 'long' };
      case 'toString': return { v: String(numOf(a[0])), t: 'String' };
      case 'max': return { v: Math.max(numOf(a[0]), numOf(a[1])), t: 'long' };
      case 'min': return { v: Math.min(numOf(a[0]), numOf(a[1])), t: 'long' };
      default: throw new InterpError('Long.' + name + ' 不支持');
    }
  }
  function callDoubleStatic(name, a, ty) {
    const t = ty || 'double';
    switch (name) {
      case 'parseDouble': case 'parseFloat': return { v: parseFloat(a[0]), t };
      case 'valueOf': return { v: numOf(a[0]) * 1.0, t };
      case 'toString': return { v: javaDoubleStr(numOf(a[0])), t: 'String' };
      case 'isNaN': return { v: Number.isNaN(numOf(a[0])), t: 'boolean' };
      case 'compare': return { v: numOf(a[0]) < numOf(a[1]) ? -1 : (numOf(a[0]) > numOf(a[1]) ? 1 : 0), t: 'int' };
      default: throw new InterpError('Double.' + name + ' 不支持');
    }
  }
  function callCharacterStatic(name, a) {
    const c = a[0] instanceof JChar ? a[0].code : numOf(a[0]);
    const ch = String.fromCharCode(c);
    switch (name) {
      case 'isDigit': return { v: /[0-9]/.test(ch), t: 'boolean' };
      case 'isLetter': return { v: /[a-zA-Z]/.test(ch), t: 'boolean' };
      case 'isLetterOrDigit': return { v: /[a-zA-Z0-9]/.test(ch), t: 'boolean' };
      case 'isUpperCase': return { v: /[A-Z]/.test(ch), t: 'boolean' };
      case 'isLowerCase': return { v: /[a-z]/.test(ch), t: 'boolean' };
      case 'isWhitespace': case 'isSpaceChar': return { v: /\s/.test(ch), t: 'boolean' };
      case 'isAlphabetic': return { v: /[a-zA-Z]/.test(ch), t: 'boolean' };
      case 'toUpperCase': return { v: new JChar(ch.toUpperCase().charCodeAt(0)), t: 'char' };
      case 'toLowerCase': return { v: new JChar(ch.toLowerCase().charCodeAt(0)), t: 'char' };
      case 'getNumericValue': return { v: parseInt(ch, 36), t: 'int' };
      case 'toString': return { v: ch, t: 'String' };
      case 'valueOf': return { v: new JChar(c), t: 'char' };
      case 'compare': return { v: c - (a[1] instanceof JChar ? a[1].code : numOf(a[1])), t: 'int' };
      default: throw new InterpError('Character.' + name + ' 不支持');
    }
  }
  function callStringStatic(name, a) {
    switch (name) {
      case 'valueOf': {
        if (a[0] instanceof JArray) return { v: a[0].a.map((c) => c.toString()).join(''), t: 'String' };
        return { v: jToDisplayString(a[0]), t: 'String' };
      }
      case 'format': return { v: javaFormat(a[0], a.slice(1)), t: 'String' };
      case 'join': {
        const sep = a[0];
        const items = a.length === 2 && (a[1] instanceof JArrayList || a[1] instanceof JArray) ? (a[1].items || a[1].a) : a.slice(1);
        return { v: items.map((x) => jToDisplayString(x)).join(sep), t: 'String' };
      }
      default: throw new InterpError('String.' + name + ' 不支持');
    }
  }
  function callArraysStatic(name, a, ctx) {
    switch (name) {
      case 'sort': {
        if (a[1] !== undefined && typeof a[1] !== 'function') { const [arr, from, to] = a; const sub = arr.a.slice(from, to); sub.sort(jCompare); for (let i = 0; i < sub.length; i++) arr.a[from + i] = sub[i]; return { v: undefined, t: 'void' }; }
        const cmp = a[1];
        a[0].a.sort(cmp ? (x, y) => numOf(callFunctional(ctx, cmp, [x, y]).v) : jCompare);
        return { v: undefined, t: 'void' };
      }
      case 'asList': return { v: new JArrayList(a.length === 1 && a[0] instanceof JArray ? a[0].a.slice() : a.slice()), t: 'List' };
      case 'toString': return { v: a[0] === null ? 'null' : '[' + a[0].a.map((x) => jFmt(x)).join(', ') + ']', t: 'String' };
      case 'deepToString': return { v: jFmt(a[0]), t: 'String' };
      case 'fill': { const arr = a[0]; for (let i = 0; i < arr.a.length; i++) arr.a[i] = a[1]; return { v: undefined, t: 'void' }; }
      case 'copyOf': { const [arr, n] = a; const out = arr.a.slice(0, n); while (out.length < n) out.push(defaultForType(arr.elemType)); return { v: new JArray(arr.elemType, out), t: null }; }
      case 'copyOfRange': { const [arr, from, to] = a; const out = arr.a.slice(from, to); while (out.length < to - from) out.push(defaultForType(arr.elemType)); return { v: new JArray(arr.elemType, out), t: null }; }
      case 'equals': { const [x, y] = a; const eq = x === null || y === null ? x === y : (x.a.length === y.a.length && x.a.every((v, i) => jEquals(v, y.a[i]))); return { v: eq, t: 'boolean' }; }
      case 'binarySearch': { const [arr, key] = a; let lo = 0, hi = arr.a.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; const c = jCompare(arr.a[mid], key); if (c === 0) return { v: mid, t: 'int' }; if (c < 0) lo = mid + 1; else hi = mid - 1; } return { v: -(lo + 1), t: 'int' }; }
      case 'stream': return { v: new JArrayList(a[0].a.slice()), t: 'Stream' };
      default: throw new InterpError('Arrays.' + name + ' 不支持');
    }
  }
  function callCollectionsStatic(name, a, ctx) {
    switch (name) {
      case 'sort': { const cmp = a[1]; a[0].items.sort(cmp ? (x, y) => numOf(callFunctional(ctx, cmp, [x, y]).v) : jCompare); return { v: undefined, t: 'void' }; }
      case 'reverse': a[0].items.reverse(); return { v: undefined, t: 'void' };
      case 'max': return { v: a[0].items.reduce((m, x) => (jCompare(x, m) > 0 ? x : m)), t: null };
      case 'min': return { v: a[0].items.reduce((m, x) => (jCompare(x, m) < 0 ? x : m)), t: null };
      case 'emptyList': return { v: new JArrayList([]), t: 'List' };
      case 'unmodifiableList': return { v: a[0], t: 'List' };
      case 'singletonList': return { v: new JArrayList([a[0]]), t: 'List' };
      case 'shuffle': return { v: undefined, t: 'void' };
      case 'swap': { const [list, i, j] = a; const tmp = list.items[i]; list.items[i] = list.items[j]; list.items[j] = tmp; return { v: undefined, t: 'void' }; }
      case 'frequency': { const [list, v] = a; return { v: list.items.filter((x) => jEquals(x, v)).length, t: 'int' }; }
      default: throw new InterpError('Collections.' + name + ' 不支持');
    }
  }

  function callUserMethod(ctx, meta, thisObj, args, ownerClass) {
    ctx.callDepth = (ctx.callDepth || 0) + 1;
    if (ctx.callDepth > 400) { ctx.callDepth--; throw new InterpError('调用栈过深，可能存在无限递归'); }
    try {
      return callWithFrame(ctx, meta.params, args, meta.isStatic ? null : thisObj, meta.className || ownerClass, meta.isStatic, (scope) => {
        recordStep(ctx, scope, meta.body, `调用 ${meta.name}(${args.map((a) => jFmt(a.v)).join(', ')})`, 'call');
        let result = { v: undefined, t: 'void' };
        try {
          execBlock(meta.body, scope, ctx, { className: meta.className || ownerClass, thisObj: meta.isStatic ? null : thisObj, isStatic: meta.isStatic });
        } catch (e) {
          if (e instanceof ReturnSignal) result = { v: e.value, t: e.type };
          else throw e;
        }
        return result;
      });
    } finally {
      ctx.callDepth--;
    }
  }

  function toPrimary(node) {
    while (node && (isToken(node) ? false : node.name !== 'primary')) {
      const entries = allEntries(node);
      if (entries.length !== 1 || isToken(entries[0].item)) throw new InterpError('不是合法的赋值目标');
      node = entries[0].item;
    }
    if (!node || node.name !== 'primary') throw new InterpError('不是合法的赋值目标');
    return node;
  }

  function declaredTypeOfRef(ref, ctx) {
    switch (ref.kind) {
      case 'var': return ref.scope.get(ref.name).type;
      case 'field': return fieldTypeOf(ref.obj.className, ref.name);
      case 'staticfield': return fieldTypeOf(ref.className, ref.name);
      case 'index': return ref.arr.elemType;
      default: return null;
    }
  }

  function evalAssignmentNode(node, scope, ctx, mctx) {
    const opImg = ruleChildren(node, 'AssignmentOperator')[0].image;
    const lhsUnary = firstRule(node, 'unaryExpression');
    const rhsNode = firstRule(node, 'expression');
    const primaryNode = toPrimary(lhsUnary);
    const ref = evalPrimaryRef(primaryNode, scope, ctx, mctx);
    const rhs = evalExpr(rhsNode, scope, ctx, mctx);
    let newV, newT;
    if (opImg === '=') {
      const declT = declaredTypeOfRef(ref, ctx);
      newT = declT;
      if (declT && isNumericType(baseTypeName(declT)) && arrayDims(declT) === 0) newV = coerceToType(rhs.v, baseTypeName(declT));
      else newV = rhs.v;
    } else {
      const op = opImg.slice(0, -1);
      const cur = refGet(ref, ctx);
      let res;
      if (op === '+' && cur.t === 'String') res = { v: jToDisplayString(cur.v) + jToDisplayString(rhs.v), t: 'String' };
      else res = binOp(ctx, op, cur.v, cur.t, rhs.v, rhs.t);
      newV = isNumericType(cur.t) ? coerceToType(res.v, cur.t) : res.v;
      newT = cur.t;
    }
    refSet(ref, newV, newT, ctx);
    return { v: newV, t: newT };
  }

  function climbBinary(entries, scope, ctx, mctx) {
    const items = entries.map((e) => {
      if (isToken(e.item)) return { isOp: true, op: e.item.image };
      if (e.key === 'shiftOperator') return { isOp: true, op: shiftOpText(e.item) };
      return { isOp: false, node: e.item };
    });
    let pos = 0;
    function evalOperand(suppress) {
      const it = items[pos]; pos++;
      if (suppress) return { v: undefined, t: undefined };
      return evalExpr(it.node, scope, ctx, mctx);
    }
    function climb(minPrec, suppress) {
      let left = evalOperand(suppress);
      while (pos < items.length && items[pos].isOp && PREC[items[pos].op] >= minPrec) {
        const op = items[pos].op; pos++;
        if (op === 'instanceof') {
          const typeItem = items[pos]; pos++;
          if (suppress) { left = { v: undefined, t: undefined }; continue; }
          left = { v: instanceOfCheck(left.v, typeNameOf(typeItem.node)), t: 'boolean' };
          continue;
        }
        let rightSuppress = suppress;
        if (!suppress) {
          if (op === '&&' && !left.v) rightSuppress = true;
          if (op === '||' && left.v) rightSuppress = true;
        }
        const right = climb(PREC[op] + 1, rightSuppress);
        if (suppress) { left = { v: undefined, t: undefined }; continue; }
        if (op === '&&') { left = { v: !!(left.v && right.v), t: 'boolean' }; continue; }
        if (op === '||') { left = { v: !!(left.v || right.v), t: 'boolean' }; continue; }
        left = binOp(ctx, op, left.v, left.t, right.v, right.t);
      }
      return left;
    }
    return climb(0, false);
  }

  function evalConditional(node, scope, ctx, mctx) {
    const entries = allEntries(node);
    if (entries.length === 1) return evalExpr(entries[0].item, scope, ctx, mctx);
    const condNode = firstRule(node, 'binaryExpression');
    const cond = evalExpr(condNode, scope, ctx, mctx);
    const branches = ruleChildren(node, 'expression');
    return cond.v ? evalExpr(branches[0], scope, ctx, mctx) : evalExpr(branches[1], scope, ctx, mctx);
  }

  function evalBinaryExpr(node, scope, ctx, mctx) {
    const entries = allEntries(node);
    if (entries.length === 1) return evalExpr(entries[0].item, scope, ctx, mctx);
    if (hasKey(node, 'AssignmentOperator')) return evalAssignmentNode(node, scope, ctx, mctx);
    return climbBinary(entries, scope, ctx, mctx);
  }

  function coerceNeg(operand) {
    const t = isNumericType(operand.t) ? operand.t : 'int';
    const v = -numOf(operand.v);
    return { v: t === 'int' ? wrapInt(v) : v, t };
  }

  function evalUnary(node, scope, ctx, mctx) {
    const entries = allEntries(node);
    if (entries.length === 1) {
      const it = entries[0].item;
      if (isToken(it)) throw new InterpError('意外的一元表达式');
      return evalExpr(it, scope, ctx, mctx);
    }
    const first = entries[0], second = entries[1];
    if (isToken(first.item)) {
      const op = first.item.tokenType.name;
      if (op === 'PlusPlus' || op === 'MinusMinus') {
        const ref = evalPrimaryRef(toPrimary(second.item), scope, ctx, mctx);
        const cur = refGet(ref, ctx);
        const res = binOp(ctx, op === 'PlusPlus' ? '+' : '-', cur.v, cur.t, 1, 'int');
        const nv = coerceToType(res.v, cur.t);
        refSet(ref, nv, cur.t, ctx);
        return { v: nv, t: cur.t };
      }
      const operand = evalExpr(second.item, scope, ctx, mctx);
      if (op === 'Minus') return coerceNeg(operand);
      if (op === 'Plus') return operand;
      if (op === 'Not') return { v: !operand.v, t: 'boolean' };
      if (op === 'Tilde' || op === 'Complement') return { v: wrapInt(~numOf(operand.v)), t: 'int' };
      throw new InterpError('不支持的一元运算符 ' + op);
    }
    const op = second.item.tokenType.name;
    const ref = evalPrimaryRef(toPrimary(first.item), scope, ctx, mctx);
    const cur = refGet(ref, ctx);
    const res = binOp(ctx, op === 'PlusPlus' ? '+' : '-', cur.v, cur.t, 1, 'int');
    const nv = coerceToType(res.v, cur.t);
    refSet(ref, nv, cur.t, ctx);
    return { v: cur.v, t: cur.t };
  }

  function lambdaParamNames(node) {
    const names = [];
    (function walk(n) {
      if (isToken(n)) { if (n.tokenType.name === 'Identifier') names.push(n.image); return; }
      for (const e of allEntries(n)) walk(e.item);
    })(firstRule(node, 'lambdaParameters'));
    return names;
  }

  function evalLambda(node, scope, ctx, mctx) {
    const params = lambdaParamNames(node);
    const bodyNode = firstRule(node, 'lambdaBody');
    const exprBody = firstRule(bodyNode, 'expression');
    const blockBody = firstRule(bodyNode, 'block');
    const fn = function (...args) {
      const lscope = new Scope(scope, scope.frame);
      params.forEach((p, i) => lscope.declare(p, args[i], null, 'param'));
      if (exprBody) return evalExpr(exprBody, lscope, ctx, mctx).v;
      try { execBlock(blockBody, lscope, ctx, mctx); } catch (e) { if (e instanceof ReturnSignal) return e.value; throw e; }
      return undefined;
    };
    return { v: fn, t: 'Lambda' };
  }

  function evalExpr(node, scope, ctx, mctx) {
    if (isToken(node)) throw new InterpError('意外的 token: ' + node.tokenType.name);
    switch (node.name) {
      case 'expression': {
        const entries = allEntries(node);
        return evalExpr(entries[0].item, scope, ctx, mctx);
      }
      case 'conditionalExpression': return evalConditional(node, scope, ctx, mctx);
      case 'binaryExpression': return evalBinaryExpr(node, scope, ctx, mctx);
      case 'unaryExpression': case 'unaryExpressionNotPlusMinus': return evalUnary(node, scope, ctx, mctx);
      case 'primary': return refGet(evalPrimaryRef(node, scope, ctx, mctx), ctx);
      case 'lambdaExpression': return evalLambda(node, scope, ctx, mctx);
      case 'castExpression': return evalCast(node, scope, ctx, mctx);
      case 'referenceType': case 'classOrInterfaceType': return { v: typeNameOf(node), t: 'Class' };
      default: {
        const entries = allEntries(node);
        if (entries.length === 1 && !isToken(entries[0].item)) return evalExpr(entries[0].item, scope, ctx, mctx);
        throw new InterpError('不支持的表达式节点: ' + node.name);
      }
    }
  }

  // ================= statements =================
  function execBlock(blockNode, parentScope, ctx, mctx) {
    const scope = new Scope(parentScope, parentScope.frame);
    const stmts = ruleChildren(firstRule(blockNode, 'blockStatements'), 'blockStatement');
    for (const bs of stmts) execBlockStatement(bs, scope, ctx, mctx);
  }

  function execBlockStatement(bs, scope, ctx, mctx) {
    const lvd = firstRule(bs, 'localVariableDeclarationStatement');
    if (lvd) { execLocalVarDecl(firstRule(lvd, 'localVariableDeclaration'), scope, ctx, mctx); return; }
    const localClass = firstRule(bs, 'classDeclaration');
    if (localClass) { const ncd = firstRule(localClass, 'normalClassDeclaration'); if (ncd) registerClass(ncd, true); return; }
    const stmt = firstRule(bs, 'statement');
    if (stmt) execStatement(stmt, scope, ctx, mctx);
  }

  function execLocalVarDecl(node, scope, ctx, mctx) {
    const t = typeNameOf(firstRule(node, 'localVariableType'));
    const list = firstRule(node, 'variableDeclaratorList');
    for (const decl of ruleChildren(list, 'variableDeclarator')) {
      const idNode = firstRule(decl, 'variableDeclaratorId');
      const name = tokenImage(idNode, 'Identifier');
      const extraDims = ruleChildren(idNode, 'dims').length;
      const fullType = t + '[]'.repeat(extraDims);
      const initNode = firstRule(decl, 'variableInitializer');
      let v = defaultForType(fullType);
      if (initNode) {
        const arrInit = firstRule(initNode, 'arrayInitializer');
        if (arrInit) v = evalArrayInitializer(arrInit, baseTypeName(fullType), scope, ctx, mctx);
        else {
          const r = evalExpr(firstRule(initNode, 'expression'), scope, ctx, mctx);
          v = (isNumericType(baseTypeName(fullType)) && arrayDims(fullType) === 0) ? coerceToType(r.v, baseTypeName(fullType)) : r.v;
        }
      }
      scope.declare(name, v, fullType, 'var');
    }
    recordStep(ctx, scope, node, short(srcOf(node, ctx)), 'decl');
  }

  function execStatement(node, scope, ctx, mctx) {
    // `statement` node: either statementWithoutTrailingSubstatement, or a direct
    // alternative (ifStatement/whileStatement/doStatement/forStatement/labeledStatement/block)
    if (hasKey(node, 'block')) { execBlock(firstRule(node, 'block'), scope, ctx, mctx); return; }
    if (hasKey(node, 'ifStatement')) { execIf(firstRule(node, 'ifStatement'), scope, ctx, mctx); return; }
    if (hasKey(node, 'whileStatement')) { execWhile(firstRule(node, 'whileStatement'), scope, ctx, mctx); return; }
    if (hasKey(node, 'forStatement')) { execFor(firstRule(node, 'forStatement'), scope, ctx, mctx); return; }
    if (hasKey(node, 'labeledStatement')) { execLabeled(firstRule(node, 'labeledStatement'), scope, ctx, mctx); return; }
    const swts = firstRule(node, 'statementWithoutTrailingSubstatement');
    if (swts) { execSwts(swts, scope, ctx, mctx); return; }
    if (node.name === 'ifStatement') { execIf(node, scope, ctx, mctx); return; }
    if (node.name === 'whileStatement') { execWhile(node, scope, ctx, mctx); return; }
    if (node.name === 'forStatement') { execFor(node, scope, ctx, mctx); return; }
    if (node.name === 'block') { execBlock(node, scope, ctx, mctx); return; }
    if (node.name === 'statementWithoutTrailingSubstatement') { execSwts(node, scope, ctx, mctx); return; }
    throw new InterpError('不支持的语句: ' + Object.keys(node.children || {}).join(','));
  }

  function execSwts(node, scope, ctx, mctx) {
    if (hasKey(node, 'block')) { execBlock(firstRule(node, 'block'), scope, ctx, mctx); return; }
    if (hasKey(node, 'expressionStatement')) {
      const es = firstRule(node, 'expressionStatement');
      const se = firstRule(es, 'statementExpression');
      evalExpr(firstRule(se, 'expression'), scope, ctx, mctx);
      recordStep(ctx, scope, node, short(srcOf(node, ctx)), 'expr');
      return;
    }
    if (hasKey(node, 'returnStatement')) {
      const rs = firstRule(node, 'returnStatement');
      const exprNode = firstRule(rs, 'expression');
      const r = exprNode ? evalExpr(exprNode, scope, ctx, mctx) : { v: undefined, t: 'void' };
      recordStep(ctx, scope, node, `return ${exprNode ? short(srcOf(exprNode, ctx)) : ''} → ${jFmt(r.v)}`, 'return');
      throw new ReturnSignal(r.v, r.t);
    }
    if (hasKey(node, 'throwStatement')) {
      const ts = firstRule(node, 'throwStatement');
      const r = evalExpr(firstRule(ts, 'expression'), scope, ctx, mctx);
      recordStep(ctx, scope, node, `throw ${jFmt(r.v)}`, 'throw');
      throw new UserThrown(r.v);
    }
    if (hasKey(node, 'breakStatement')) { recordStep(ctx, scope, node, 'break', 'break'); throw new BreakSignal(breakLabel(node)); }
    if (hasKey(node, 'continueStatement')) { recordStep(ctx, scope, node, 'continue', 'continue'); throw new ContinueSignal(breakLabel(node)); }
    if (hasKey(node, 'tryStatement')) { execTry(firstRule(node, 'tryStatement'), scope, ctx, mctx); return; }
    if (hasKey(node, 'switchStatement')) { execSwitch(firstRule(node, 'switchStatement'), scope, ctx, mctx); return; }
    if (hasKey(node, 'doStatement')) { execDoWhile(firstRule(node, 'doStatement'), scope, ctx, mctx); return; }
    if (hasKey(node, 'assertStatement')) { recordStep(ctx, scope, node, 'assert', 'expr'); return; }
    if (hasKey(node, 'emptyStatement')) return;
    if (hasKey(node, 'yieldStatement')) {
      const ys = firstRule(node, 'yieldStatement');
      const r = evalExpr(firstRule(ys, 'expression'), scope, ctx, mctx);
      throw new ReturnSignal(r.v, r.t);
    }
    // ignore unrecognized simple statements rather than hard-fail the whole program
  }
  function breakLabel(node) {
    const idNode = ruleChildren(node, 'Identifier');
    return idNode.length ? idNode[0].image : undefined;
  }

  function execIf(node, scope, ctx, mctx) {
    const testNode = firstRule(node, 'expression');
    const test = evalExpr(testNode, scope, ctx, mctx);
    recordStep(ctx, scope, testNode, `if (${short(srcOf(testNode, ctx))}) → ${jFmt(test.v)}`, 'if');
    const stmts = ruleChildren(node, 'statement');
    if (test.v) execStatement(stmts[0], scope, ctx, mctx);
    else if (stmts[1]) execStatement(stmts[1], scope, ctx, mctx);
  }

  function execWhile(node, scope, ctx, mctx) {
    const testNode = firstRule(node, 'expression');
    const bodyNode = firstRule(node, 'statement');
    while (true) {
      const t = evalExpr(testNode, scope, ctx, mctx);
      recordStep(ctx, scope, testNode, `while (${short(srcOf(testNode, ctx))}) → ${jFmt(t.v)}`, 'loop-test');
      if (!t.v) break;
      try { execStatement(bodyNode, scope, ctx, mctx); }
      catch (e) { if (e instanceof BreakSignal && !e.label) break; if (e instanceof ContinueSignal && !e.label) continue; throw e; }
    }
  }
  function execDoWhile(node, scope, ctx, mctx) {
    const testNode = firstRule(node, 'expression');
    const bodyNode = firstRule(node, 'statement');
    while (true) {
      try { execStatement(bodyNode, scope, ctx, mctx); }
      catch (e) { if (e instanceof BreakSignal && !e.label) break; if (e instanceof ContinueSignal && !e.label) { } else if (!(e instanceof ContinueSignal)) throw e; }
      const t = evalExpr(testNode, scope, ctx, mctx);
      recordStep(ctx, scope, testNode, `do...while (${short(srcOf(testNode, ctx))}) → ${jFmt(t.v)}`, 'loop-test');
      if (!t.v) break;
    }
  }

  function execFor(node, scope, ctx, mctx) {
    const basic = firstRule(node, 'basicForStatement');
    if (basic) { execBasicFor(basic, scope, ctx, mctx); return; }
    const enh = firstRule(node, 'enhancedForStatement');
    execEnhancedFor(enh, scope, ctx, mctx);
  }

  function execBasicFor(node, scope, ctx, mctx) {
    const loopScope = new Scope(scope, scope.frame);
    const init = firstRule(node, 'forInit');
    if (init) {
      const lvd = firstRule(init, 'localVariableDeclaration');
      if (lvd) execLocalVarDecl(lvd, loopScope, ctx, mctx);
      else {
        for (const se of ruleChildren(firstRule(init, 'statementExpressionList'), 'statementExpression')) evalExpr(firstRule(se, 'expression'), loopScope, ctx, mctx);
      }
    }
    const testNode = firstRule(node, 'expression');
    const update = firstRule(node, 'forUpdate');
    const bodyNode = ruleChildren(node, 'statement')[0];
    while (true) {
      if (testNode) {
        const t = evalExpr(testNode, loopScope, ctx, mctx);
        recordStep(ctx, loopScope, testNode, `${short(srcOf(testNode, ctx))} → ${jFmt(t.v)}`, 'loop-test');
        if (!t.v) break;
      }
      try { execStatement(bodyNode, loopScope, ctx, mctx); }
      catch (e) { if (e instanceof BreakSignal && !e.label) break; if (!(e instanceof ContinueSignal && !e.label)) { if (!(e instanceof ContinueSignal)) throw e; } }
      if (update) {
        const exprs = ruleChildren(firstRule(update, 'statementExpressionList'), 'statementExpression');
        for (const se of exprs) evalExpr(firstRule(se, 'expression'), loopScope, ctx, mctx);
        if (exprs.length) recordStep(ctx, loopScope, exprs[exprs.length - 1], exprs.map((se) => short(srcOf(se, ctx))).join(', '), 'loop-update');
      }
    }
  }

  function iterableOf(v, ctx) {
    if (v instanceof JArray) return v.a;
    if (v instanceof JArrayList) return v.items;
    if (v instanceof JSet) return v.sorted || Array.from(v.m.values());
    if (v === null || v === undefined) throwJava(ctx, 'NullPointerException', null);
    if (v && v[Symbol.iterator]) return Array.from(v);
    throw new InterpError('无法遍历该值');
  }

  function execEnhancedFor(node, scope, ctx, mctx) {
    const lvd = firstRule(node, 'localVariableDeclaration');
    const t = typeNameOf(firstRule(lvd, 'localVariableType'));
    const varName = tokenImage(firstRule(firstRule(lvd, 'variableDeclaratorList'), 'variableDeclarator') ? firstRule(firstRule(firstRule(lvd, 'variableDeclaratorList'), 'variableDeclarator'), 'variableDeclaratorId') : null, 'Identifier');
    const iterExprNode = firstRule(node, 'expression');
    const iterVal = evalExpr(iterExprNode, scope, ctx, mctx);
    const items = iterableOf(iterVal.v, ctx);
    const bodyNode = firstRule(node, 'statement');
    for (const item of items) {
      const iterScope = new Scope(scope, scope.frame);
      iterScope.declare(varName, isNumericType(t) ? coerceToType(item, t) : item, t, 'var');
      recordStep(ctx, iterScope, node, `${t} ${varName} = ${jFmt(item)}`, 'loop-iter');
      try { execStatement(bodyNode, iterScope, ctx, mctx); }
      catch (e) { if (e instanceof BreakSignal && !e.label) break; if (e instanceof ContinueSignal && !e.label) continue; throw e; }
    }
  }

  function execLabeled(node, scope, ctx, mctx) {
    const label = tokenImage(node, 'Identifier');
    const stmt = firstRule(node, 'statement');
    try { execStatement(stmt, scope, ctx, mctx); }
    catch (e) {
      if ((e instanceof BreakSignal || e instanceof ContinueSignal) && e.label === label) return;
      throw e;
    }
  }

  function execTry(node, scope, ctx, mctx) {
    const mainBlock = firstRule(node, 'block');
    const catches = ruleChildren(firstRule(node, 'catches'), 'catchClause');
    const finallyNode = firstRule(node, 'finallyBlock') || firstRule(node, 'finally');
    const finallyBlock = finallyNode ? firstRule(finallyNode, 'block') : null;
    try {
      execBlock(mainBlock, scope, ctx, mctx);
    } catch (e) {
      if (e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal || e instanceof TooManyStepsError || e instanceof TimeLimitError) {
        if (finallyBlock) execBlock(finallyBlock, scope, ctx, mctx);
        throw e;
      }
      const excVal = e instanceof UserThrown ? e.value : new JObject(jsErrorClassName(e), { message: e.message });
      const excClassName = excVal instanceof JObject ? excVal.className : 'Exception';
      let handled = false;
      for (const cc of catches) {
        const param = firstRule(cc, 'catchFormalParameter');
        const types = catchTypeNames(param);
        if (types.some((t) => t === 'Exception' || t === 'Throwable' || t === 'RuntimeException' || isSubclassOfBuiltin(excClassName, t) || excClassName === t)) {
          const cscope = new Scope(scope, scope.frame);
          const pname = tokenImage(firstRule(param, 'variableDeclaratorId'), 'Identifier');
          cscope.declare(pname, excVal, types[0], 'var');
          recordStep(ctx, cscope, cc, `catch (${jFmt(excVal)})`, 'catch');
          handled = true;
          try { execBlock(firstRule(cc, 'block'), cscope, ctx, mctx); }
          finally { if (finallyBlock) execBlock(finallyBlock, scope, ctx, mctx); }
          return;
        }
      }
      if (!handled) {
        if (finallyBlock) execBlock(finallyBlock, scope, ctx, mctx);
        throw e;
      }
    }
    if (finallyBlock) execBlock(finallyBlock, scope, ctx, mctx);
  }
  function catchTypeNames(param) {
    const ct = firstRule(param, 'catchType');
    const first = typeNameOf(firstRule(ct, 'unannClassType') || ct);
    const rest = ruleChildren(ct, 'classType').map((c) => typeNameOf(c));
    return [first, ...rest].filter(Boolean);
  }
  function jsErrorClassName(e) {
    if (e instanceof InterpError) return 'RuntimeException';
    return 'RuntimeException';
  }
  const BUILTIN_EXC_HIERARCHY = {
    ArithmeticException: 'RuntimeException', NullPointerException: 'RuntimeException',
    ArrayIndexOutOfBoundsException: 'IndexOutOfBoundsException', IndexOutOfBoundsException: 'RuntimeException',
    ClassCastException: 'RuntimeException', NumberFormatException: 'IllegalArgumentException',
    IllegalArgumentException: 'RuntimeException', IllegalStateException: 'RuntimeException',
    UnsupportedOperationException: 'RuntimeException', EmptyStackException: 'RuntimeException',
    NoSuchElementException: 'RuntimeException', RuntimeException: 'Exception', Exception: 'Throwable',
  };
  function isSubclassOfBuiltin(name, target) {
    let c = name;
    while (c) { if (c === target) return true; c = BUILTIN_EXC_HIERARCHY[c]; }
    return isSubclassOf(name, target);
  }

  function execSwitch(node, scope, ctx, mctx) {
    const discNode = firstRule(node, 'expression');
    const disc = evalExpr(discNode, scope, ctx, mctx);
    recordStep(ctx, scope, discNode, `switch (${short(srcOf(discNode, ctx))}) → ${jFmt(disc.v)}`, 'switch');
    const block = firstRule(node, 'switchBlock');
    const groups = ruleChildren(block, 'switchBlockStatementGroup');
    const switchScope = new Scope(scope, scope.frame);
    let matched = false;
    try {
      for (const g of groups) {
        if (!matched) {
          const label = firstRule(g, 'switchLabel');
          if (hasKey(label, 'Default')) { /* handled in second pass */ }
          else {
            for (const cc of ruleChildren(label, 'caseConstant')) {
              const cv = evalExpr(firstRule(cc, 'conditionalExpression') ? cc : cc, switchScope, ctx, mctx);
              if (jEquals(cv.v, disc.v) || cv.v === disc.v) { matched = true; break; }
            }
          }
        }
        if (matched) for (const bs of ruleChildren(g, 'blockStatement')) execBlockStatement(bs, switchScope, ctx, mctx);
      }
      if (!matched) {
        let hitDefault = false;
        for (const g of groups) {
          const label = firstRule(g, 'switchLabel');
          if (hasKey(label, 'Default')) hitDefault = true;
          if (hitDefault) for (const bs of ruleChildren(g, 'blockStatement')) execBlockStatement(bs, switchScope, ctx, mctx);
        }
      }
    } catch (e) { if (!(e instanceof BreakSignal)) throw e; }
  }

  // ================= runner =================
  const BUILTIN_HELPERS = {
    ListNode: 'class ListNode { int val; ListNode next; ListNode() {} ListNode(int val) { this.val = val; } ListNode(int val, ListNode next) { this.val = val; this.next = next; } }',
    TreeNode: 'class TreeNode { int val; TreeNode left; TreeNode right; TreeNode() {} TreeNode(int val) { this.val = val; } TreeNode(int val, TreeNode left, TreeNode right) { this.val = val; this.left = left; this.right = right; } }',
  };
  const ENTRY_CLASS = '__Entry__';

  function describeThrown(v) {
    if (v instanceof JObject) return `${v.className}${v.fields.message !== null && v.fields.message !== undefined ? ': ' + v.fields.message : ''}`;
    return jFmt(v);
  }

  function friendlySyntaxError(e) {
    const m = /line:\s*(\d+),\s*column:\s*(\d+)/.exec(e.message || '');
    if (m) return `SYNTAX: 第 ${m[1]} 行附近存在语法错误（第 ${m[2]} 列）`;
    return 'SYNTAX: ' + String(e.message || e).split('\n')[0];
  }

  function runCode(source, entryExpr) {
    CLASS_TABLE = {};
    for (const k in STATIC_FIELDS) delete STATIC_FIELDS[k];
    const ctx = {
      code: source, steps: [], output: [], stepBudget: 20000, startTime: Date.now(),
      callDepth: 0, lastFlat: {}, error: null, outBuf: null,
    };

    let extra = '';
    for (const name in BUILTIN_HELPERS) {
      if (!new RegExp('\\bclass\\s+' + name + '\\b').test(source)) extra += '\n' + BUILTIN_HELPERS[name] + '\n';
    }
    const hasEntry = !!(entryExpr && entryExpr.trim());
    if (hasEntry) {
      extra += `\nclass ${ENTRY_CLASS} { static void run() { Object __entry_result__ = (${entryExpr.trim()}); System.out.println(__entry_result__); } }\n`;
    }
    const fullSource = source + extra;
    ctx.code = fullSource;

    let cst;
    try {
      cst = JP.parse(fullSource);
    } catch (e) {
      ctx.error = friendlySyntaxError(e);
      return { steps: [], output: [], error: ctx.error };
    }

    try {
      const compUnit = firstRule(cst, 'ordinaryCompilationUnit');
      for (const td of ruleChildren(compUnit, 'typeDeclaration')) {
        const cd = firstRule(td, 'classDeclaration');
        if (cd) {
          const ncd = firstRule(cd, 'normalClassDeclaration');
          if (ncd) registerClass(ncd, false);
        }
      }
    } catch (e) {
      ctx.error = 'SYNTAX: 无法解析类结构 (' + e.message + ')';
      return { steps: [], output: [], error: ctx.error };
    }

    try {
      if (hasEntry) {
        const found = findMethod(ENTRY_CLASS, 'run');
        callUserMethod(ctx, found.list[0], null, [], ENTRY_CLASS);
      } else {
        let mainMeta = null, mainClass = null;
        for (const cname in CLASS_TABLE) {
          const c = CLASS_TABLE[cname];
          if (c.methods.main) {
            const m = c.methods.main.find((mm) => mm.isStatic);
            if (m) { mainMeta = m; mainClass = cname; break; }
          }
        }
        if (!mainMeta) throw new InterpError('未找到 public static void main(String[] args) 方法。你可以添加 main 方法，或者在“调用表达式”里填写要调用的方法。');
        callUserMethod(ctx, mainMeta, null, [{ v: new JArray('String', []), t: 'String[]' }], mainClass);
      }
    } catch (e) {
      if (e instanceof TooManyStepsError) ctx.error = 'STEP_LIMIT';
      else if (e instanceof TimeLimitError) ctx.error = 'TIME_LIMIT';
      else if (e instanceof UserThrown) ctx.error = 'RUNTIME: ' + describeThrown(e.value);
      else if (e instanceof InterpError) ctx.error = 'RUNTIME: ' + e.message;
      else ctx.error = 'RUNTIME: ' + (e.message || String(e));
    }
    flushOutBuf(ctx);
    return { steps: ctx.steps, output: ctx.output, error: ctx.error };
  }

  const JavaRuntime = {
    runCode,
    JChar, JArray, JObject, JArrayList, JLinkedList, JStack, JMap, JMapEntry, JSet,
    JLinkedHashSet, JTreeSet, JTreeMap, JPriorityQueue, JStringBuilder, jFmt, jToDisplayString,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = JavaRuntime;
  root.JavaInterp = JavaRuntime;
})(typeof window !== 'undefined' ? window : globalThis);

