window.PY_TRACER_SRC = `

import sys as _sys, time as _time

class _TooManySteps(Exception): pass
class _TimeLimit(Exception): pass

_steps = []
_output = []
_lastFlat = {}
_frameIds = {}
_frameCounter = [0]
_startTime = _time.time()
_STEP_BUDGET = 20000
_pending = {}  # id(frame) -> (frame, line, label)

def _get_frame_id(frame):
    fid = id(frame)
    if fid not in _frameIds:
        _frameCounter[0] += 1
        _frameIds[fid] = _frameCounter[0]
    return _frameIds[fid]

def _fmt(v, depth=0, seen=None):
    if seen is None: seen = frozenset()
    try:
        if v is None: return 'None'
        if isinstance(v, bool): return str(v)
        if isinstance(v, (int, float, complex)): return repr(v)
        if isinstance(v, str):
            s = v if len(v) <= 80 else v[:77] + '...'
            return repr(s)
        oid = id(v)
        if oid in seen: return '(circular)'
        if isinstance(v, (list, tuple)):
            if depth > 2: return '[...]' if isinstance(v, list) else '(...)'
            items = [_fmt(x, depth + 1, seen | {oid}) for x in list(v)[:25]]
            extra = ', …' if len(v) > 25 else ''
            ob, cb = ('[', ']') if isinstance(v, list) else ('(', ')')
            return ob + ', '.join(items) + extra + cb
        if isinstance(v, dict):
            if depth > 2: return '{...}'
            items = ['%s: %s' % (_fmt(k, depth + 1, seen | {oid}), _fmt(val, depth + 1, seen | {oid})) for k, val in list(v.items())[:25]]
            extra = ', …' if len(v) > 25 else ''
            return '{' + ', '.join(items) + extra + '}'
        if isinstance(v, (set, frozenset)):
            if depth > 2: return '{...}'
            items = [_fmt(x, depth + 1, seen | {oid}) for x in list(v)[:25]]
            return '{' + ', '.join(items) + '}' if items else ('frozenset()' if isinstance(v, frozenset) else 'set()')
        if callable(v):
            name = getattr(v, '__name__', 'func')
            return '<function %s>' % name
        if hasattr(v, '__dict__'):
            cls = type(v).__name__
            try:
                items = ['%s=%s' % (k, _fmt(val, depth + 1, seen | {oid})) for k, val in vars(v).items() if not k.startswith('_')]
                return '%s(%s)' % (cls, ', '.join(items))
            except Exception:
                return '<%s object>' % cls
        return repr(v)
    except Exception:
        return '<unrepr>'

def _is_function_frame(frame):
    return bool(frame.f_code.co_flags & 0x02)  # CO_NEWLOCALS

def _collect_frames(frame):
    frames = []
    f = frame
    while f is not None and f.f_code.co_filename == '<user>':
        fid = _get_frame_id(f)
        name = f.f_code.co_name
        if name == '<module>':
            name = '模块 (module)'
        elif not _is_function_frame(f):
            name = name + ' (class 定义)'
        order = [k for k in f.f_locals.keys() if not k.startswith('__') or k == '__entry_result__']
        vars_ = {}
        for k in order:
            vars_[k] = _fmt(f.f_locals[k])
        frames.append({'id': fid, 'name': name, 'vars': vars_, 'order': order})
        f = f.f_back
    return frames

def _record(frame, label, kind):
    if len(_steps) >= _STEP_BUDGET:
        raise _TooManySteps()
    if len(_steps) % 200 == 0 and _time.time() - _startTime > 8:
        raise _TimeLimit()
    frames = _collect_frames(frame)
    flat = {}
    for fr in frames:
        for k in fr['order']:
            flat['%s:%s' % (fr['id'], k)] = fr['vars'][k]
    changed = [k for k in flat if _lastFlat.get(k) != flat[k]]
    _lastFlat.clear()
    _lastFlat.update(flat)
    _steps.append({
        'line': frame.f_lineno,
        'label': label[:160],
        'kind': kind,
        'frames': frames,
        'changed': changed,
        'outputLen': len(_output),
    })

def _finalize(fid):
    entry = _pending.pop(fid, None)
    if entry is not None:
        pframe, pline, plabel = entry
        _record(pframe, plabel, 'stmt')

def _line_text(lineno):
    try:
        return _SOURCE_LINES[lineno - 1].strip()
    except Exception:
        return ''

_unwinding = set()

def _tracer(frame, event, arg):
    if frame.f_code.co_filename != '<user>':
        return None
    fid = id(frame)
    if event == 'call':
        name = frame.f_code.co_name
        if name != '<module>' and _is_function_frame(frame):
            argnames = frame.f_code.co_varnames[:frame.f_code.co_argcount]
            args_display = ', '.join('%s=%s' % (a, _fmt(frame.f_locals.get(a))) for a in argnames)
            _record(frame, '调用 %s(%s)' % (name, args_display), 'call')
        return _tracer
    if event == 'line':
        _unwinding.discard(fid)
        _finalize(fid)
        text = _line_text(frame.f_lineno)
        _pending[fid] = (frame, frame.f_lineno, text or ('第 %d 行' % frame.f_lineno))
        return _tracer
    if event == 'return':
        _finalize(fid)
        name = frame.f_code.co_name
        was_unwinding = fid in _unwinding
        _unwinding.discard(fid)
        if name != '<module>' and _is_function_frame(frame) and not was_unwinding:
            _record(frame, '返回 %s' % _fmt(arg), 'return')
        return _tracer
    if event == 'exception':
        _finalize(fid)
        _unwinding.add(fid)
        exc_type, exc_val, exc_tb = arg
        _record(frame, '异常: %s: %s' % (exc_type.__name__, exc_val), 'throw')
        return _tracer
    return _tracer

class _Stdout:
    def __init__(self, level):
        self.buf = ''
        self.level = level
    def write(self, s):
        if not s:
            return 0
        self.buf += s
        while '\n' in self.buf:
            line, self.buf = self.buf.split('\n', 1)
            _output.append({'text': line, 'level': self.level})
        return len(s)
    def flush(self):
        pass

def _run(source, entry_expr):
    global _SOURCE_LINES
    full_source = source
    if entry_expr:
        full_source = source + '\n__entry_result__ = (' + entry_expr + ')\n'
    _SOURCE_LINES = full_source.split('\n')
    g = {'__name__': '__main__'}
    error = None
    out = _Stdout('log')
    err = _Stdout('error')
    _sys.stdout = out
    _sys.stderr = err
    _sys.settrace(_tracer)
    try:
        code = compile(full_source, '<user>', 'exec')
        exec(code, g)
        if entry_expr and '__entry_result__' in g:
            print('=>', repr(g['__entry_result__']))
    except _TooManySteps:
        error = 'STEP_LIMIT'
    except _TimeLimit:
        error = 'TIME_LIMIT'
    except SyntaxError as e:
        error = 'SYNTAX: %s (line %s)' % (e.msg, e.lineno)
    except Exception as e:
        tb = e.__traceback__
        eline = None
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == '<user>':
                eline = tb.tb_lineno
            tb = tb.tb_next
        error = 'RUNTIME: %s: %s' % (type(e).__name__, e)
        if eline:
            error += ' (line %d)' % eline
    finally:
        _sys.settrace(None)
        for fid in list(_pending.keys()):
            try:
                _finalize(fid)
            except Exception:
                pass
        if out.buf:
            _output.append({'text': out.buf, 'level': 'log'})
        if err.buf:
            _output.append({'text': err.buf, 'level': 'error'})
        _sys.stdout = _sys.__stdout__
        _sys.stderr = _sys.__stderr__
    return {'steps': _steps, 'output': _output, 'error': error}
`;
