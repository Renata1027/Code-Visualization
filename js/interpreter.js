(function (root) {
  'use strict';

  const acorn = (typeof require !== 'undefined') ? require('acorn') : root.acorn;

  // ---------- signals & errors ----------
  class BreakSignal { constructor(label) { this.label = label; } }
  class ContinueSignal { constructor(label) { this.label = label; } }
  class ReturnSignal { constructor(value) { this.value = value; } }
  class UserThrown { constructor(value) { this.value = value; } }
  class InterpError extends Error {}
  class TooManyStepsError extends Error {}
  class TimeLimitError extends Error {}

  let frameCounter = 0;
  class Frame {
    constructor(name) { this.id = ++frameCounter; this.name = name; }
  }

  class Scope {
    constructor(parent, frame) {
      this.parent = parent;
      this.frame = frame;
      this.vars = new Map();
    }
    declare(name, value, kind) {
      this.vars.set(name, { value, kind: kind || 'var' });
    }
    has(name) {
      let s = this;
      while (s) { if (s.vars.has(name)) return true; s = s.parent; }
      return false;
    }
    get(name) {
      let s = this;
      while (s) {
        if (s.vars.has(name)) return s.vars.get(name).value;
        s = s.parent;
      }
      throw new InterpError(`${name} 未定义 (is not defined)`);
    }
    set(name, value) {
      let s = this;
      while (s) {
        if (s.vars.has(name)) { s.vars.get(name).value = value; return; }
        s = s.parent;
      }
      let g = this;
      while (g.parent) g = g.parent;
      g.declare(name, value, 'var');
    }
  }

  // ---------- value formatting ----------
  function short(s, n = 90) {
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function fmt(v, depth = 0, seen) {
    seen = seen || new Set();
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'string') return JSON.stringify(v);
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'function') {
      const meta = v.__interpMeta;
      if (meta) return `ƒ ${meta.name || '(anonymous)'}(${(meta.params || []).map(p => short(paramSrc(p), 20)).join(', ')})`;
      return `ƒ ${v.name || '(native)'}()`;
    }
    if (seen.has(v)) return '(circular)';
    if (Array.isArray(v)) {
      if (depth > 2) return '[...]';
      seen.add(v);
      const items = v.slice(0, 25).map(x => fmt(x, depth + 1, seen));
      const extra = v.length > 25 ? ', …' : '';
      return `[${items.join(', ')}${extra}]`;
    }
    if (v instanceof Map) {
      seen.add(v);
      const items = Array.from(v.entries()).slice(0, 15).map(([k, val]) => `${fmt(k, depth + 1, seen)} => ${fmt(val, depth + 1, seen)}`);
      return `Map(${v.size}) {${items.join(', ')}}`;
    }
    if (v instanceof Set) {
      seen.add(v);
      const items = Array.from(v.values()).slice(0, 15).map(x => fmt(x, depth + 1, seen));
      return `Set(${v.size}) {${items.join(', ')}}`;
    }
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (t === 'object') {
      if (depth > 2) return '{...}';
      seen.add(v);
      const keys = Object.keys(v);
      const items = keys.slice(0, 25).map(k => `${k}: ${fmt(v[k], depth + 1, seen)}`);
      const extra = keys.length > 25 ? ', …' : '';
      return `{${items.join(', ')}${extra}}`;
    }
    return String(v);
  }

  function paramSrc(p) {
    if (p.type === 'Identifier') return p.name;
    if (p.type === 'AssignmentPattern') return paramSrc(p.left) + ' = …';
    if (p.type === 'RestElement') return '...' + paramSrc(p.argument);
    if (p.type === 'ArrayPattern') return '[...]';
    if (p.type === 'ObjectPattern') return '{...}';
    return '?';
  }

  function srcOf(node, ctx) { return ctx.code.slice(node.start, node.end); }

  // ---------- frame collection for a step snapshot ----------
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
        if (!(k in curVars)) { curVars[k] = fmt(entry.value); curOrder.push(k); }
      }
      s = s.parent;
    }
    if (curFrame) frames.push({ id: curFrame.id, name: curFrame.name, vars: curVars, order: curOrder });
    return frames;
  }

  function recordStep(ctx, scope, node, label, kind) {
    if (ctx.steps.length >= ctx.stepBudget) throw new TooManyStepsError();
    if (ctx.steps.length % 200 === 0 && Date.now() - ctx.startTime > 6000) throw new TimeLimitError();
    const frames = collectFrames(scope);
    const flat = {};
    frames.forEach(f => f.order.forEach(k => { flat[f.id + ':' + k] = f.vars[k]; }));
    const changed = [];
    for (const key in flat) if (ctx.lastFlat[key] !== flat[key]) changed.push(key);
    for (const key in ctx.lastFlat) if (!(key in flat)) { /* var went out of scope */ }
    ctx.lastFlat = flat;
    ctx.steps.push({
      line: node.loc.start.line,
      endLine: node.loc.end.line,
      label: short(label, 160),
      kind: kind || 'stmt',
      frames,
      changed,
      outputLen: ctx.output.length,
      callDepth: frames.length,
    });
  }

  // ---------- expression evaluation ----------
  function evalArgs(argNodes, scope, ctx) {
    const out = [];
    for (const a of argNodes) {
      if (a.type === 'SpreadElement') out.push(...evalExpr(a.argument, scope, ctx));
      else out.push(evalExpr(a, scope, ctx));
    }
    return out;
  }

  function binOp(op, l, r) {
    switch (op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return l / r;
      case '%': return l % r;
      case '**': return l ** r;
      case '==': return l == r;
      case '!=': return l != r;
      case '===': return l === r;
      case '!==': return l !== r;
      case '<': return l < r;
      case '<=': return l <= r;
      case '>': return l > r;
      case '>=': return l >= r;
      case '&': return l & r;
      case '|': return l | r;
      case '^': return l ^ r;
      case '<<': return l << r;
      case '>>': return l >> r;
      case '>>>': return l >>> r;
      case 'in': return l in r;
      case 'instanceof': return l instanceof r;
      default: throw new InterpError('不支持的运算符 ' + op);
    }
  }

  const CONSOLE_MARKER = { __console: true };

  function evalExpr(node, scope, ctx) {
    switch (node.type) {
      case 'Literal':
        if (node.regex) return new RegExp(node.regex.pattern, node.regex.flags);
        return node.value;
      case 'Identifier':
        if (node.name === 'undefined') return undefined;
        return scope.get(node.name);
      case 'ThisExpression':
        return undefined;
      case 'ArrayExpression': {
        const arr = [];
        for (const el of node.elements) {
          if (el === null) arr.push(undefined);
          else if (el.type === 'SpreadElement') arr.push(...evalExpr(el.argument, scope, ctx));
          else arr.push(evalExpr(el, scope, ctx));
        }
        return arr;
      }
      case 'ObjectExpression': {
        const obj = {};
        for (const p of node.properties) {
          if (p.type === 'SpreadElement') {
            Object.assign(obj, evalExpr(p.argument, scope, ctx));
            continue;
          }
          const key = p.computed ? evalExpr(p.key, scope, ctx) : (p.key.name !== undefined ? p.key.name : p.key.value);
          if (p.value.type === 'FunctionExpression' || p.value.type === 'ArrowFunctionExpression') {
            obj[key] = makeFunction(p.value, scope, ctx, typeof key === 'string' ? key : null);
          } else {
            obj[key] = evalExpr(p.value, scope, ctx);
          }
        }
        return obj;
      }
      case 'TemplateLiteral': {
        let out = '';
        node.quasis.forEach((q, i) => {
          out += q.value.cooked;
          if (i < node.expressions.length) out += fmtTemplate(evalExpr(node.expressions[i], scope, ctx));
        });
        return out;
      }
      case 'BinaryExpression':
        return binOp(node.operator, evalExpr(node.left, scope, ctx), evalExpr(node.right, scope, ctx));
      case 'LogicalExpression': {
        const l = evalExpr(node.left, scope, ctx);
        if (node.operator === '&&') return l ? evalExpr(node.right, scope, ctx) : l;
        if (node.operator === '||') return l ? l : evalExpr(node.right, scope, ctx);
        if (node.operator === '??') return (l === null || l === undefined) ? evalExpr(node.right, scope, ctx) : l;
        throw new InterpError('不支持的逻辑运算符 ' + node.operator);
      }
      case 'UnaryExpression': {
        if (node.operator === 'typeof') {
          if (node.argument.type === 'Identifier' && !scope.has(node.argument.name)) return 'undefined';
          return typeof evalExpr(node.argument, scope, ctx);
        }
        if (node.operator === 'void') { evalExpr(node.argument, scope, ctx); return undefined; }
        if (node.operator === 'delete') {
          if (node.argument.type === 'MemberExpression') {
            const obj = evalExpr(node.argument.object, scope, ctx);
            const prop = node.argument.computed ? evalExpr(node.argument.property, scope, ctx) : node.argument.property.name;
            return delete obj[prop];
          }
          return true;
        }
        const v = evalExpr(node.argument, scope, ctx);
        switch (node.operator) {
          case '!': return !v;
          case '-': return -v;
          case '+': return +v;
          case '~': return ~v;
          default: throw new InterpError('不支持的一元运算符 ' + node.operator);
        }
      }
      case 'UpdateExpression': {
        const old = evalExpr(node.argument, scope, ctx);
        const nv = node.operator === '++' ? old + 1 : old - 1;
        assignTo(node.argument, nv, scope, ctx);
        return node.prefix ? nv : old;
      }
      case 'AssignmentExpression':
        return evalAssignment(node, scope, ctx);
      case 'ConditionalExpression':
        return evalExpr(node.test, scope, ctx) ? evalExpr(node.consequent, scope, ctx) : evalExpr(node.alternate, scope, ctx);
      case 'SequenceExpression': {
        let v;
        for (const e of node.expressions) v = evalExpr(e, scope, ctx);
        return v;
      }
      case 'MemberExpression': {
        const obj = evalExpr(node.object, scope, ctx);
        const prop = node.computed ? evalExpr(node.property, scope, ctx) : node.property.name;
        if (obj === undefined || obj === null) throw new InterpError(`无法读取 ${prop}（${short(srcOf(node.object, ctx))} 为 ${fmt(obj)}）`);
        return obj[prop];
      }
      case 'CallExpression': {
        let fn, thisArg;
        if (node.callee.type === 'MemberExpression') {
          const obj = evalExpr(node.callee.object, scope, ctx);
          const prop = node.callee.computed ? evalExpr(node.callee.property, scope, ctx) : node.callee.property.name;
          if (obj === CONSOLE_MARKER) {
            const args = evalArgs(node.arguments, scope, ctx);
            const line = args.map(a => typeof a === 'string' ? a : fmt(a)).join(' ');
            ctx.output.push({ text: line, level: (prop === 'error' || prop === 'warn') ? prop : 'log' });
            return undefined;
          }
          if (obj === undefined || obj === null) throw new InterpError(`无法调用 ${prop}（${short(srcOf(node.callee.object, ctx))} 为 ${fmt(obj)}）`);
          fn = obj[prop];
          thisArg = obj;
        } else {
          fn = evalExpr(node.callee, scope, ctx);
        }
        const args = evalArgs(node.arguments, scope, ctx);
        if (typeof fn !== 'function') {
          const nameHint = node.callee.type === 'Identifier' ? node.callee.name : short(srcOf(node.callee, ctx));
          throw new InterpError(`${nameHint} 不是函数 (is not a function)`);
        }
        if (fn.__interpMeta) {
          recordStep(ctx, scope, node, `调用 ${fn.__interpMeta.name || 'ƒ'}(${args.map(a => fmt(a)).join(', ')})`, 'call');
        }
        return fn.apply(thisArg, args);
      }
      case 'NewExpression': {
        const ctor = evalExpr(node.callee, scope, ctx);
        const args = evalArgs(node.arguments, scope, ctx);
        return new ctor(...args);
      }
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return makeFunction(node, scope, ctx, node.id ? node.id.name : null);
      case 'SpreadElement':
        return evalExpr(node.argument, scope, ctx);
      default:
        throw new InterpError('不支持的表达式类型: ' + node.type);
    }
  }

  function fmtTemplate(v) {
    if (typeof v === 'string') return v;
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'object') return fmt(v);
    return String(v);
  }

  function evalAssignment(node, scope, ctx) {
    let rightVal;
    if (node.operator === '=') {
      rightVal = evalExpr(node.right, scope, ctx);
      if (node.left.type === 'ArrayPattern' || node.left.type === 'ObjectPattern') {
        bindPattern(node.left, rightVal, scope, 'assign', ctx);
        return rightVal;
      }
    } else if (node.operator === '&&=' || node.operator === '||=' || node.operator === '??=') {
      const current = evalExpr(node.left, scope, ctx);
      if (node.operator === '&&=') { if (!current) return current; rightVal = evalExpr(node.right, scope, ctx); }
      else if (node.operator === '||=') { if (current) return current; rightVal = evalExpr(node.right, scope, ctx); }
      else { if (current !== null && current !== undefined) return current; rightVal = evalExpr(node.right, scope, ctx); }
    } else {
      const current = evalExpr(node.left, scope, ctx);
      const rv = evalExpr(node.right, scope, ctx);
      rightVal = binOp(node.operator.slice(0, -1), current, rv);
    }
    assignTo(node.left, rightVal, scope, ctx);
    return rightVal;
  }

  function assignTo(target, value, scope, ctx) {
    if (target.type === 'Identifier') { scope.set(target.name, value); return; }
    if (target.type === 'MemberExpression') {
      const obj = evalExpr(target.object, scope, ctx);
      const prop = target.computed ? evalExpr(target.property, scope, ctx) : target.property.name;
      obj[prop] = value;
      return;
    }
    if (target.type === 'ArrayPattern' || target.type === 'ObjectPattern') { bindPattern(target, value, scope, 'assign', ctx); return; }
    throw new InterpError('不支持的赋值目标: ' + target.type);
  }

  function bindPattern(pattern, value, scope, kind, ctx) {
    if (pattern.type === 'Identifier') {
      if (kind === 'assign') scope.set(pattern.name, value);
      else scope.declare(pattern.name, value, kind);
      return;
    }
    if (pattern.type === 'AssignmentPattern') {
      const v = value === undefined ? evalExpr(pattern.right, scope, ctx) : value;
      bindPattern(pattern.left, v, scope, kind, ctx);
      return;
    }
    if (pattern.type === 'ArrayPattern') {
      const arr = (value === null || value === undefined) ? [] : Array.from(value);
      pattern.elements.forEach((el, i) => {
        if (!el) return;
        if (el.type === 'RestElement') bindPattern(el.argument, arr.slice(i), scope, kind, ctx);
        else bindPattern(el, arr[i], scope, kind, ctx);
      });
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      const used = new Set();
      pattern.properties.forEach(p => {
        if (p.type === 'RestElement') {
          const rest = {};
          if (value) for (const k in value) if (!used.has(k)) rest[k] = value[k];
          bindPattern(p.argument, rest, scope, kind, ctx);
        } else {
          const key = p.computed ? evalExpr(p.key, scope, ctx) : (p.key.name !== undefined ? p.key.name : p.key.value);
          used.add(key);
          bindPattern(p.value, value ? value[key] : undefined, scope, kind, ctx);
        }
      });
      return;
    }
    if (pattern.type === 'MemberExpression') { assignTo(pattern, value, scope, ctx); return; }
    throw new InterpError('不支持的模式: ' + pattern.type);
  }

  function bindParams(params, args, scope, ctx) {
    params.forEach((p, i) => {
      if (p.type === 'RestElement') bindPattern(p.argument, args.slice(i), scope, 'param', ctx);
      else bindPattern(p, args[i], scope, 'param', ctx);
    });
  }

  function makeFunction(node, defScope, ctx, name) {
    const meta = {
      name: name || (node.id && node.id.name) || null,
      params: node.params,
      body: node.body,
      closureScope: defScope,
      isArrow: node.type === 'ArrowFunctionExpression',
      exprBody: node.body.type !== 'BlockStatement',
      node,
    };
    const fn = function (...args) { return invokeMeta(meta, args, ctx); };
    fn.__interpMeta = meta;
    try { Object.defineProperty(fn, 'name', { value: meta.name || 'anonymous' }); } catch (e) {}
    return fn;
  }

  function invokeMeta(meta, args, ctx) {
    ctx.callDepth = (ctx.callDepth || 0) + 1;
    if (ctx.callDepth > 400) { ctx.callDepth--; throw new InterpError('调用栈过深，可能存在无限递归 (max depth 400)'); }
    try {
      const frame = new Frame(meta.name || (meta.isArrow ? '(匿名箭头函数)' : '(匿名函数)'));
      const fnScope = new Scope(meta.closureScope, frame);
      bindParams(meta.params, args, fnScope, ctx);
      let result;
      if (meta.exprBody) {
        result = evalExpr(meta.body, fnScope, ctx);
        recordStep(ctx, fnScope, meta.body, `返回 ${fmt(result)}`, 'return');
      } else {
        try {
          hoistFunctions(meta.body.body, fnScope, ctx);
          for (const st of meta.body.body) execStatement(st, fnScope, ctx);
          result = undefined;
          recordStep(ctx, fnScope, meta.node, `函数结束（无 return） → undefined`, 'return');
        } catch (e) {
          if (e instanceof ReturnSignal) {
            result = e.value;
          } else throw e;
        }
      }
      return result;
    } finally {
      ctx.callDepth--;
    }
  }

  function hoistFunctions(body, scope, ctx) {
    for (const st of body) {
      if (st.type === 'FunctionDeclaration' && st.id) {
        scope.declare(st.id.name, makeFunction(st, scope, ctx, st.id.name), 'function');
      }
    }
  }

  // ---------- statement execution ----------
  function execStatement(node, scope, ctx) {
    switch (node.type) {
      case 'EmptyStatement':
        return;
      case 'Program':
      case 'BlockStatement': {
        const blockScope = new Scope(scope, scope.frame);
        hoistFunctions(node.body, blockScope, ctx);
        for (const st of node.body) execStatement(st, blockScope, ctx);
        return;
      }
      case 'ExpressionStatement': {
        evalExpr(node.expression, scope, ctx);
        recordStep(ctx, scope, node, short(srcOf(node, ctx)), 'expr');
        return;
      }
      case 'VariableDeclaration': {
        node.declarations.forEach(d => {
          const val = d.init ? evalExpr(d.init, scope, ctx) : undefined;
          bindPattern(d.id, val, scope, node.kind, ctx);
        });
        recordStep(ctx, scope, node, short(srcOf(node, ctx)), 'decl');
        return;
      }
      case 'FunctionDeclaration': {
        if (!scope.vars.has(node.id.name)) scope.declare(node.id.name, makeFunction(node, scope, ctx, node.id.name), 'function');
        return;
      }
      case 'IfStatement': {
        const test = evalExpr(node.test, scope, ctx);
        recordStep(ctx, scope, node.test, `if (${short(srcOf(node.test, ctx))}) → ${fmt(test)}`, 'if');
        if (test) execStatement(node.consequent, scope, ctx);
        else if (node.alternate) execStatement(node.alternate, scope, ctx);
        return;
      }
      case 'ForStatement': {
        const loopScope = new Scope(scope, scope.frame);
        if (node.init) {
          if (node.init.type === 'VariableDeclaration') execStatement(node.init, loopScope, ctx);
          else { evalExpr(node.init, loopScope, ctx); recordStep(ctx, loopScope, node.init, short(srcOf(node.init, ctx)), 'expr'); }
        }
        while (true) {
          if (node.test) {
            const tv = evalExpr(node.test, loopScope, ctx);
            recordStep(ctx, loopScope, node.test, `${short(srcOf(node.test, ctx))} → ${fmt(tv)}`, 'loop-test');
            if (!tv) break;
          }
          try {
            execStatement(node.body, loopScope, ctx);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (!(e instanceof ContinueSignal)) throw e;
          }
          if (node.update) {
            evalExpr(node.update, loopScope, ctx);
            recordStep(ctx, loopScope, node.update, short(srcOf(node.update, ctx)), 'loop-update');
          }
        }
        return;
      }
      case 'WhileStatement': {
        while (true) {
          const tv = evalExpr(node.test, scope, ctx);
          recordStep(ctx, scope, node.test, `while (${short(srcOf(node.test, ctx))}) → ${fmt(tv)}`, 'loop-test');
          if (!tv) break;
          try { execStatement(node.body, scope, ctx); }
          catch (e) { if (e instanceof BreakSignal) break; if (!(e instanceof ContinueSignal)) throw e; }
        }
        return;
      }
      case 'DoWhileStatement': {
        while (true) {
          try { execStatement(node.body, scope, ctx); }
          catch (e) { if (e instanceof BreakSignal) break; if (!(e instanceof ContinueSignal)) throw e; }
          const tv = evalExpr(node.test, scope, ctx);
          recordStep(ctx, scope, node.test, `do...while (${short(srcOf(node.test, ctx))}) → ${fmt(tv)}`, 'loop-test');
          if (!tv) break;
        }
        return;
      }
      case 'ForOfStatement': {
        const iterable = evalExpr(node.right, scope, ctx);
        for (const item of iterable) {
          const iterScope = new Scope(scope, scope.frame);
          if (node.left.type === 'VariableDeclaration') bindPattern(node.left.declarations[0].id, item, iterScope, node.left.kind, ctx);
          else assignTo(node.left, item, iterScope, ctx);
          recordStep(ctx, iterScope, node, `${short(srcOf(node.left, ctx))} = ${fmt(item)}`, 'loop-iter');
          try { execStatement(node.body, iterScope, ctx); }
          catch (e) { if (e instanceof BreakSignal) break; if (!(e instanceof ContinueSignal)) throw e; }
        }
        return;
      }
      case 'ForInStatement': {
        const obj = evalExpr(node.right, scope, ctx);
        for (const key in obj) {
          const iterScope = new Scope(scope, scope.frame);
          if (node.left.type === 'VariableDeclaration') bindPattern(node.left.declarations[0].id, key, iterScope, node.left.kind, ctx);
          else assignTo(node.left, key, iterScope, ctx);
          recordStep(ctx, iterScope, node, `${short(srcOf(node.left, ctx))} = ${fmt(key)}`, 'loop-iter');
          try { execStatement(node.body, iterScope, ctx); }
          catch (e) { if (e instanceof BreakSignal) break; if (!(e instanceof ContinueSignal)) throw e; }
        }
        return;
      }
      case 'BreakStatement':
        recordStep(ctx, scope, node, 'break', 'break');
        throw new BreakSignal(node.label && node.label.name);
      case 'ContinueStatement':
        recordStep(ctx, scope, node, 'continue', 'continue');
        throw new ContinueSignal(node.label && node.label.name);
      case 'ReturnStatement': {
        const val = node.argument ? evalExpr(node.argument, scope, ctx) : undefined;
        recordStep(ctx, scope, node, `return ${node.argument ? short(srcOf(node.argument, ctx)) : ''} → ${fmt(val)}`, 'return');
        throw new ReturnSignal(val);
      }
      case 'ThrowStatement': {
        const v = evalExpr(node.argument, scope, ctx);
        recordStep(ctx, scope, node, `throw ${fmt(v)}`, 'throw');
        throw new UserThrown(v);
      }
      case 'TryStatement': {
        try {
          execStatement(node.block, scope, ctx);
        } catch (e) {
          if (e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal || e instanceof TooManyStepsError || e instanceof TimeLimitError) {
            if (node.finalizer) execStatement(node.finalizer, scope, ctx);
            throw e;
          }
          if (node.handler) {
            const catchScope = new Scope(scope, scope.frame);
            const errVal = e instanceof UserThrown ? e.value : (e.message || String(e));
            if (node.handler.param) bindPattern(node.handler.param, errVal, catchScope, 'catch', ctx);
            recordStep(ctx, catchScope, node.handler, `catch (${fmt(errVal)})`, 'catch');
            execStatement(node.handler.body, catchScope, ctx);
          } else if (!node.finalizer) {
            throw e;
          }
        } finally {
          if (node.finalizer) execStatement(node.finalizer, scope, ctx);
        }
        return;
      }
      case 'SwitchStatement': {
        const disc = evalExpr(node.discriminant, scope, ctx);
        recordStep(ctx, scope, node, `switch (${short(srcOf(node.discriminant, ctx))}) → ${fmt(disc)}`, 'switch');
        const switchScope = new Scope(scope, scope.frame);
        let matched = false;
        try {
          for (const c of node.cases) {
            if (!matched) {
              if (c.test !== null) {
                const tv = evalExpr(c.test, switchScope, ctx);
                if (tv === disc) matched = true;
              }
            }
            if (matched) for (const st of c.consequent) execStatement(st, switchScope, ctx);
          }
          if (!matched) {
            let hitDefault = false;
            for (const c of node.cases) {
              if (c.test === null) hitDefault = true;
              if (hitDefault) for (const st of c.consequent) execStatement(st, switchScope, ctx);
            }
          }
        } catch (e) { if (!(e instanceof BreakSignal)) throw e; }
        return;
      }
      case 'LabeledStatement': {
        try { execStatement(node.body, scope, ctx); }
        catch (e) {
          if ((e instanceof BreakSignal || e instanceof ContinueSignal) && e.label === node.label.name) {
            if (e instanceof ContinueSignal) return;
            return;
          }
          throw e;
        }
        return;
      }
      default:
        throw new InterpError('不支持的语句类型: ' + node.type);
    }
  }

  // ---------- globals ----------
  function setupGlobals(scope, ctx) {
    const g = (name, value) => scope.declare(name, value, 'builtin');
    g('console', CONSOLE_MARKER);
    g('Math', Math);
    g('JSON', JSON);
    g('Object', Object);
    g('Array', Array);
    g('String', String);
    g('Number', Number);
    g('Boolean', Boolean);
    g('Map', Map);
    g('Set', Set);
    g('Date', Date);
    g('Error', Error);
    g('TypeError', TypeError);
    g('RangeError', RangeError);
    g('SyntaxError', SyntaxError);
    g('parseInt', parseInt);
    g('parseFloat', parseFloat);
    g('isNaN', isNaN);
    g('isFinite', isFinite);
    g('NaN', NaN);
    g('Infinity', Infinity);
  }

  function runProgram(ast, ctx) {
    const globalFrame = new Frame('全局 (global)');
    const globalScope = new Scope(null, globalFrame);
    setupGlobals(globalScope, ctx);
    hoistFunctions(ast.body, globalScope, ctx);
    for (const st of ast.body) execStatement(st, globalScope, ctx);
  }

  function runCode(code) {
    const ctx = {
      code,
      output: [],
      steps: [],
      stepBudget: 20000,
      startTime: Date.now(),
      callDepth: 0,
      lastFlat: {},
      error: null,
      truncated: false,
    };
    let ast;
    try {
      ast = acorn.parse(code, { ecmaVersion: 2021, sourceType: 'script', locations: true, allowReturnOutsideFunction: false });
    } catch (e) {
      ctx.error = `语法错误: ${e.message}`;
      return ctx;
    }
    try {
      runProgram(ast, ctx);
    } catch (e) {
      if (e instanceof TooManyStepsError) {
        ctx.truncated = true;
        ctx.error = `执行步数超过上限（${ctx.stepBudget}），可能存在死循环。已显示前 ${ctx.steps.length} 步。`;
      } else if (e instanceof TimeLimitError) {
        ctx.truncated = true;
        ctx.error = `执行超时（可能存在死循环）。已显示前 ${ctx.steps.length} 步。`;
      } else if (e instanceof UserThrown) {
        ctx.error = `未捕获的异常: ${fmt(e.value)}`;
      } else if (e instanceof InterpError) {
        ctx.error = `运行错误: ${e.message}`;
      } else if (e instanceof ReturnSignal) {
        // return at top level, ignore
      } else if (e instanceof BreakSignal || e instanceof ContinueSignal) {
        ctx.error = `运行错误: break/continue 不在循环内`;
      } else {
        ctx.error = `运行错误: ${e.message}`;
      }
    }
    return ctx;
  }

  const CodeViz = { runCode, fmt, short };
  if (typeof module !== 'undefined' && module.exports) module.exports = CodeViz;
  if (typeof root !== 'undefined') root.CodeViz = CodeViz;
})(typeof window !== 'undefined' ? window : globalThis);
