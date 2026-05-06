/**
 * Tiny mustache/jinja-like templating used by the system-prompt
 * pipeline. Supports just enough syntax to render the Shakespeare-style
 * prompt template:
 *
 *   {{ var.path }}                            interpolation, dot-paths
 *   {% if expr %} ... {% else %} ... {% endif %}
 *   {% for item in list %} ... {% endfor %}
 *
 * Where `expr` is one of:
 *   var.path                — truthy check
 *   var.path === "literal"  — equality (only string literals supported)
 *   var.path !== "literal"  — inequality
 *
 * That covers the system-prompt template's needs. Anything more
 * elaborate is intentionally out of scope — we want a 200-line file
 * with no surprises, not a real templating engine.
 *
 * Behavior choices:
 *   - Missing variables resolve to the empty string (never throw).
 *   - HTML escaping is NOT applied — output goes into a system prompt,
 *     not HTML. Callers are responsible for escaping if their target
 *     differs.
 *   - Whitespace inside `{% %}` and `{{ }}` is trimmed.
 *   - Trailing newlines after `{% if %}` / `{% else %}` / `{% endif %}`
 *     are NOT consumed (Jinja's `{%- -%}` whitespace control isn't
 *     implemented). Authors should write template lines that read
 *     naturally with the literal newline preserved.
 *
 * The renderer is dependency-free and safe to call on user-supplied
 * templates (project/.nostr-station/system-prompt.md). No code
 * execution; the only operations are string interpolation, equality,
 * and iteration over arrays.
 */

export type Vars = Record<string, unknown>;

// ── Public API ────────────────────────────────────────────────────────────

export function renderPrompt(template: string, vars: Vars): string {
  const tokens = tokenize(template);
  const ast = parse(tokens);
  return renderNodes(ast, vars);
}

// ── Tokenizer ─────────────────────────────────────────────────────────────
//
// Splits the template into a flat array of:
//   { type: 'text', value }
//   { type: 'var',  expr }                — {{ … }}
//   { type: 'tag',  expr }                — {% … %}

interface TextToken { type: 'text'; value: string; }
interface VarToken  { type: 'var';  expr: string; }
interface TagToken  { type: 'tag';  expr: string; }
type Token = TextToken | VarToken | TagToken;

const TAG_RE = /(\{\{(.*?)\}\}|\{%(.*?)%\})/s;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let rest = src;
  while (rest.length > 0) {
    const m = TAG_RE.exec(rest);
    if (!m) {
      tokens.push({ type: 'text', value: rest });
      break;
    }
    if (m.index > 0) {
      tokens.push({ type: 'text', value: rest.slice(0, m.index) });
    }
    if (m[2] !== undefined) {
      tokens.push({ type: 'var', expr: m[2].trim() });
    } else {
      tokens.push({ type: 'tag', expr: m[3].trim() });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return tokens;
}

// ── Parser ────────────────────────────────────────────────────────────────
//
// Builds a tree of:
//   { type: 'text', value }
//   { type: 'var',  expr }
//   { type: 'if',   expr, then: Node[], else: Node[] }
//   { type: 'for',  itemName, listExpr, body: Node[] }

interface TextNode { type: 'text'; value: string; }
interface VarNode  { type: 'var';  expr: string; }
interface IfNode   { type: 'if';   expr: string; then: Node[]; else: Node[]; }
interface ForNode  { type: 'for';  itemName: string; listExpr: string; body: Node[]; }
type Node = TextNode | VarNode | IfNode | ForNode;

function parse(tokens: Token[]): Node[] {
  let i = 0;

  function parseUntil(...stopWords: string[]): { nodes: Node[]; stop: string } {
    const out: Node[] = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === 'tag') {
        const head = t.expr.split(/\s+/)[0];
        if (stopWords.includes(head)) {
          return { nodes: out, stop: head };
        }
        if (head === 'if') {
          i++;
          const expr = t.expr.replace(/^if\s+/, '');
          const thenPart = parseUntil('else', 'endif');
          let elsePart: Node[] = [];
          if (thenPart.stop === 'else') {
            i++; // consume the 'else' token
            const ep = parseUntil('endif');
            elsePart = ep.nodes;
          }
          i++; // consume the 'endif' token
          out.push({ type: 'if', expr, then: thenPart.nodes, else: elsePart });
          continue;
        }
        if (head === 'for') {
          // {% for item in list %}
          const m = t.expr.match(/^for\s+(\w+)\s+in\s+(.+)$/);
          if (!m) throw new Error(`bad {% for %} tag: ${t.expr}`);
          i++;
          const body = parseUntil('endfor');
          i++;
          out.push({ type: 'for', itemName: m[1], listExpr: m[2].trim(), body: body.nodes });
          continue;
        }
        throw new Error(`unknown tag: ${t.expr}`);
      }
      if (t.type === 'text') { out.push({ type: 'text', value: t.value }); i++; continue; }
      if (t.type === 'var')  { out.push({ type: 'var',  expr:  t.expr  }); i++; continue; }
    }
    return { nodes: out, stop: '' };
  }

  const result = parseUntil();
  return result.nodes;
}

// ── Evaluator ─────────────────────────────────────────────────────────────

function renderNodes(nodes: Node[], vars: Vars): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      out += n.value;
    } else if (n.type === 'var') {
      const v = resolvePath(vars, n.expr);
      out += v == null ? '' : String(v);
    } else if (n.type === 'if') {
      const truthy = evalCond(n.expr, vars);
      out += renderNodes(truthy ? n.then : n.else, vars);
    } else if (n.type === 'for') {
      const list = resolvePath(vars, n.listExpr);
      if (Array.isArray(list)) {
        for (const item of list) {
          out += renderNodes(n.body, { ...vars, [n.itemName]: item });
        }
      }
    }
  }
  return out;
}

/**
 * Resolve a dot-separated path through `vars`. Missing segments return
 * undefined. Array indices are not supported (we rely on the for-loop
 * primitive instead).
 */
function resolvePath(vars: Vars, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split('.');
  let cur: any = vars;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

const COND_EQ_RE  = /^(.+?)\s*===\s*"([^"]*)"$/;
const COND_NEQ_RE = /^(.+?)\s*!==\s*"([^"]*)"$/;

function evalCond(expr: string, vars: Vars): boolean {
  const eq = COND_EQ_RE.exec(expr);
  if (eq) {
    const lhs = resolvePath(vars, eq[1].trim());
    return String(lhs ?? '') === eq[2];
  }
  const neq = COND_NEQ_RE.exec(expr);
  if (neq) {
    const lhs = resolvePath(vars, neq[1].trim());
    return String(lhs ?? '') !== neq[2];
  }
  // Plain truthy check.
  const v = resolvePath(vars, expr.trim());
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true; // objects are truthy
}
