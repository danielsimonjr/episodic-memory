import { describe, it, expect } from 'vitest';
import { markdownToHtml } from '../src/markdown-html.js';
import { formatConversationAsHTML } from '../src/show.js';

/** Remove whitespace between tags and unify the two apostrophe forms, so a test compares structure. */
function norm(html: string): string {
  return html.replace(/>\s+</g, '><').replace(/&#39;/g, '&#039;').trim();
}

function render(md: string): string {
  return norm(markdownToHtml(md));
}

describe('markdownToHtml - blocks', () => {
  it('renders ATX headings and strips a closing run only after a space', () => {
    expect(render('# One')).toBe('<h1>One</h1>');
    expect(render('###### Six')).toBe('<h6>Six</h6>');
    expect(render('## Two ##')).toBe('<h2>Two</h2>');
    expect(render('# h#')).toBe('<h1>h#</h1>');
    expect(render('#nospace')).toBe('<p>#nospace</p>');
  });

  it('renders a paragraph and keeps the newline between its lines', () => {
    expect(render('a\nb')).toBe('<p>a\nb</p>');
  });

  it('renders a hard break from two trailing spaces and from a trailing backslash', () => {
    expect(render('a  \nb')).toBe('<p>a<br>b</p>');
    expect(render('a\\\nb')).toBe('<p>a<br>b</p>');
  });

  it('renders a thematic break', () => {
    expect(render('a\n\n---\n\nb')).toBe('<p>a</p><hr><p>b</p>');
    expect(render('* * *')).toBe('<hr>');
  });

  it('does not support setext headings', () => {
    expect(render('Title\n---')).toBe('<p>Title</p><hr>');
  });

  it('renders a fenced code block verbatim and escaped, with a filtered language class', () => {
    expect(render('```js\nconst a = 1 < 2;\n**x** <b>\n```')).toBe(
      '<pre><code class="language-js">const a = 1 &lt; 2;\n**x** &lt;b&gt;\n</code></pre>',
    );
    expect(render('~~~\nplain\n~~~')).toBe('<pre><code>plain\n</code></pre>');
    expect(render('```js"onx\nx\n```')).toBe('<pre><code class="language-jsonx">x\n</code></pre>');
  });

  it('runs an unterminated fence to the end of the input', () => {
    expect(render('```\na\nb')).toBe('<pre><code>a\nb\n</code></pre>');
  });

  it('lets a fence interrupt a paragraph', () => {
    expect(render('**Result:**\n```\nok\n```')).toBe(
      '<p><strong>Result:</strong></p><pre><code>ok\n</code></pre>',
    );
  });

  it('renders a blockquote with lazy continuation', () => {
    expect(render('> a\nb')).toBe('<blockquote><p>a\nb</p></blockquote>');
    expect(render('> # h')).toBe('<blockquote><h1>h</h1></blockquote>');
  });

  it('renders tight bullet and ordered lists', () => {
    expect(render('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(render('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    expect(render('3. a\n4. b')).toBe('<ol start="3"><li>a</li><li>b</li></ol>');
  });

  it('renders a loose list with paragraphs in each item', () => {
    expect(render('- a\n\n- b')).toBe('<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  });

  it('nests a list only at the content column of the parent item', () => {
    expect(render('1. a\n   - b')).toBe('<ol><li>a<ul><li>b</li></ul></li></ol>');
    expect(render('- a\n  - b')).toBe('<ul><li>a<ul><li>b</li></ul></li></ul>');
  });

  it('renders a fence inside an indented list item', () => {
    expect(render('1. Run:\n   ```bash\n   cmd\n   ```')).toBe(
      '<ol><li>Run:<pre><code class="language-bash">cmd\n</code></pre></li></ol>',
    );
  });

  it('closes a list at an unindented fence', () => {
    expect(render('- **key:** v\n```json\n{}\n```')).toBe(
      '<ul><li><strong>key:</strong> v</li></ul><pre><code class="language-json">{}\n</code></pre>',
    );
  });

  it('continues a list item lazily', () => {
    expect(render('- a\nlazy')).toBe('<ul><li>a\nlazy</li></ul>');
  });

  it('starts a list inside a paragraph only for a bullet or an ordered item at 1', () => {
    expect(render('text\n2. two')).toBe('<p>text\n2. two</p>');
    expect(render('text\n- two')).toBe('<p>text</p><ul><li>two</li></ul>');
    expect(render('text\n1. one')).toBe('<p>text</p><ol><li>one</li></ol>');
  });

  it('renders a table with alignment, short and long rows, and an escaped pipe', () => {
    expect(render('| a | b | c |\n|:--|--:|:-:|\n| 1 | x \\| y |\n| 4 | 5 | 6 | 7 |')).toBe(
      '<table><thead><tr><th align="left">a</th><th align="right">b</th><th align="center">c</th></tr></thead>' +
        '<tbody><tr><td align="left">1</td><td align="right">x | y</td><td align="center"></td></tr>' +
        '<tr><td align="left">4</td><td align="right">5</td><td align="center">6</td></tr></tbody></table>',
    );
  });

  it('treats a delimiter row with the wrong cell count as a paragraph', () => {
    expect(render('| a | b |\n|---|\n| 1 | 2 |')).not.toContain('<table');
  });

  it('normalises CRLF input', () => {
    expect(render('# a\r\n\r\nb\r\nc')).toBe('<h1>a</h1><p>b\nc</p>');
  });
});

describe('markdownToHtml - inline', () => {
  it('renders code spans, including a backtick inside a double-backtick span', () => {
    expect(render('use `a < b` now')).toBe('<p>use <code>a &lt; b</code> now</p>');
    expect(render('`` a`b ``')).toBe('<p><code>a`b</code></p>');
    expect(render('`open')).toBe('<p>`open</p>');
  });

  it('renders emphasis and nested emphasis', () => {
    expect(render('**b** and *i* and __u__ and _v_')).toBe(
      '<p><strong>b</strong> and <em>i</em> and <strong>u</strong> and <em>v</em></p>',
    );
    expect(render('**a *b* c**')).toBe('<p><strong>a <em>b</em> c</strong></p>');
    expect(render('***x***')).toBe('<p><em><strong>x</strong></em></p>');
  });

  it('does not treat intraword underscores or spaced stars as emphasis', () => {
    expect(render('snake_case_word')).toBe('<p>snake_case_word</p>');
    expect(render('2 * 3 * 4')).toBe('<p>2 * 3 * 4</p>');
    expect(render('\\*not em\\*')).toBe('<p>*not em*</p>');
  });

  it('does not support strikethrough', () => {
    for (const t of ['~/.claude/a and ~/.claude/b', 'foo~ and ~bar', 'x ~a~ y', '~~x~~']) {
      expect(render(t)).not.toContain('<del>');
    }
  });

  it('renders links with a title and inline content in the text', () => {
    expect(render('[`x` y](https://a.b/c "T")')).toBe(
      '<p><a href="https://a.b/c" title="T"><code>x</code> y</a></p>',
    );
  });

  it('links a bare http(s) URL and leaves trailing punctuation outside', () => {
    expect(render('see https://a.b/c.')).toBe('<p>see <a href="https://a.b/c">https://a.b/c</a>.</p>');
    expect(render('(https://a.b/x_(y))')).toBe(
      '<p>(<a href="https://a.b/x_(y)">https://a.b/x_(y)</a>)</p>',
    );
  });

  it('does not link www. hosts or bare emails', () => {
    expect(render('www.a.b')).not.toContain('<a ');
    expect(render('a@b.c')).not.toContain('<a ');
  });

  it('escapes raw HTML everywhere', () => {
    expect(render('<script>alert(1)</script>')).not.toContain('<script');
    expect(render('x <img onerror=x> y')).toContain('&lt;img onerror=x&gt;');
    expect(render('<div>\nhi\n</div>')).not.toContain('<div');
  });
});

describe('markdownToHtml - URL safety', () => {
  const unsafe = [
    '[x](javascript:alert(1))',
    '[x]( JaVaScRiPt:alert(1))',
    '[x](java\tscript:alert(1))',
    '[x](&#106;avascript:alert(1))',
    '[x](&#x6A;avascript:alert(1))',
    '[x](javascript&colon;alert(1))',
    '[x](java&#09;script:alert(1))',
    '[x](%6Aavascript:alert(1))',
    '[x](\x01javascript:alert(1))',
    '[x](vbscript:x)',
    '[x](data:text/html,x)',
    '![a](data:text/html,x)',
    '<javascript:alert(1)>',
    '<vbscript:x>',
  ];
  for (const input of unsafe) {
    it(`emits no href or src for ${JSON.stringify(input)}`, () => {
      const out = markdownToHtml(input);
      expect(out).not.toMatch(/href=|src=/);
    });
  }

  const safe = ['[x](https://a)', '[x](HTTPS://a)', '[x](/rel)', '[x](#frag)', '[x](mailto:a@b.c)'];
  for (const input of safe) {
    it(`emits a link for ${JSON.stringify(input)}`, () => {
      expect(markdownToHtml(input)).toMatch(/<a href="/);
    });
  }

  it('keeps a quote inside the href attribute', () => {
    const out = markdownToHtml('[x](http://a/"onmouseover=1)');
    expect(out).not.toMatch(/"\s*onmouseover/);
    expect(out).toMatch(/&quot;|%22/);
  });

  it('escapes a title', () => {
    expect(markdownToHtml('[x](http://a "t\\"i>tle")')).toContain('title="t&quot;i&gt;tle"');
  });

  it('renders the code of a fence literally, links and all', () => {
    expect(render('```\n[x](javascript:1) **b**\n```')).toBe(
      '<pre><code>[x](javascript:1) **b**\n</code></pre>',
    );
  });
});

describe('markdownToHtml - hostile input', () => {
  const inputs: Array<[string, string]> = [
    ['200k stars', '*'.repeat(200_000)],
    ['200k brackets', '['.repeat(200_000)],
    ['200k backticks', '`'.repeat(200_000)],
    ['200k underscores', '_'.repeat(200_000)],
    ['a line of 10k >', '>'.repeat(10_000)],
    ['10k quote lines', '> \n'.repeat(10_000)],
    ['2000 nested list lines', Array.from({ length: 2000 }, (_, i) => ' '.repeat(i * 2) + '- a').join('\n')],
    ['1 MB paragraph', 'a'.repeat(1_000_000)],
    ['50k table rows', '| a | b |\n|---|---|\n' + '| a | b |\n'.repeat(50_000)],
  ];
  for (const [name, input] of inputs) {
    it(`renders ${name} quickly and with a sane size`, () => {
      const t = performance.now();
      const out = markdownToHtml(input);
      expect(performance.now() - t).toBeLessThan(3000);
      expect(out.length).toBeGreaterThan(0);
      expect(out.length).toBeLessThan(input.length * 8 + 100);
    });
  }

  // Each adversary doubles in size; a quadratic scan takes about 4x longer, a linear one about 2x.
  const adversaries: Array<[string, (n: number) => string]> = [
    ['brackets', n => '['.repeat(n)],
    ['empty link tails', n => '[](('.repeat(Math.floor(n / 4))],
    [
      'backtick runs of growing width',
      n => {
        let s = '';
        for (let w = 1; s.length < n; w += 1) s += '`'.repeat(w) + 'a ';
        return s;
      },
    ],
  ];
  for (const [name, make] of adversaries) {
    it(`scales linearly on ${name}`, () => {
      // The fastest of three runs: load from parallel test workers only adds time, so the minimum is stable.
      const time = (n: number) => {
        const input = make(n);
        let best = Infinity;
        for (let k = 0; k < 3; k += 1) {
          const t = performance.now();
          markdownToHtml(input);
          best = Math.min(best, performance.now() - t);
        }
        return best;
      };
      time(10_000);
      const small = Math.max(time(100_000), 1);
      expect(time(200_000)).toBeLessThan(small * 4 + 50);
    });
  }

  it('caps the padding cells of a wide table of short rows', () => {
    const header = '|' + 'a|'.repeat(1000);
    const delim = '|' + '-|'.repeat(1000);
    expect(markdownToHtml(header + '\n' + delim + '\n' + '|\n'.repeat(10_000)).length).toBeLessThan(1_000_000);
  });

  it('never throws on any string', () => {
    for (const s of ['', '\0', '\\', '[', '](', '```', '| |', '> ', '1.', '-', '*a**b*', '[a](', '\uD800']) {
      expect(() => markdownToHtml(s)).not.toThrow();
    }
  });
});

describe('markdownToHtml - Codex transcript through show', () => {
  // A copy of the codexJsonl() fixture of test/show.test.ts; that file stays unchanged.
  function codexJsonl(): string {
    return [
      {
        timestamp: '2026-05-12T18:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '019e4c75-d5bf-7c71-9df7-77f5fb86b711',
          cwd: '/Users/jesse/Documents/GitHub/example-project',
          cli_version: '0.130.0',
          model_provider: 'openai',
          git: { branch: 'codex-support' },
        },
      },
      {
        timestamp: '2026-05-12T18:00:01.000Z',
        type: 'turn_context',
        payload: { cwd: '/Users/jesse/Documents/GitHub/example-project', model: 'gpt-5.2' },
      },
      {
        timestamp: '2026-05-12T18:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please inspect the config loader.' }] },
      },
      {
        timestamp: '2026-05-12T18:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"sed -n 1,80p src/config.ts"}',
          call_id: 'call_config',
        },
      },
    ]
      .map(line => JSON.stringify(line))
      .join('\n');
  }

  it('renders headings, labels, inline code and the argument list', () => {
    const html = norm(formatConversationAsHTML(codexJsonl()));
    expect(html).toContain('<h1>Conversation</h1>');
    expect(html).toContain('<strong>Tool Use:</strong><code>exec_command</code>');
    expect(html).toContain('<li><strong>cmd:</strong> sed -n 1,80p src/config.ts</li>');
    expect(html).toContain('<hr>');
    expect(html).toContain('{#call_config}');
  });
});

describe('markdownToHtml - review findings', () => {
  it('lets a table interrupt a paragraph', () => {
    expect(render('text\n| a | b |\n| - | - |\n| 1 | 2 |').startsWith('<p>text</p><table>')).toBe(true);
  });

  it('ends a table body at a heading or a quote', () => {
    expect(render('| a | b |\n|---|---|\n| 1 | 2 |\n# H | x')).toContain('</table><h1>H | x</h1>');
    expect(render('| a | b |\n|---|---|\n| 1 | 2 |\n> q | x')).toContain('</table><blockquote>');
  });

  it('does not join a lazy line to a fence inside a quote', () => {
    expect(render('> ```js\n> x = 1\nlazy text').endsWith('</blockquote><p>lazy text</p>')).toBe(true);
  });

  it('keeps a list with an empty item tight, and a blank line still makes it loose', () => {
    expect(markdownToHtml('- a\n-\n- c')).not.toContain('<p>');
    expect(markdownToHtml('- a\n\n- c')).toContain('<p>a</p>');
  });

  it('keeps lines apart past the depth cap', () => {
    const md = Array.from({ length: 10 }, (_, k) => ' '.repeat(k * 2) + `- L${k + 1}`).join('\n');
    expect(markdownToHtml(md)).toContain('L8\n- L9\n- L10');
  });

  it('links a long destination', () => {
    const dest = 'https://a.b/' + 'a'.repeat(3000);
    expect(render(`[x](${dest})`).startsWith(`<p><a href="${dest}">`)).toBe(true);
  });

  it('decodes &amp; once in a destination', () => {
    expect(markdownToHtml('[x](https://a.b/?x=1&amp;y=2)')).toContain('href="https://a.b/?x=1&amp;y=2"');
  });

  it('allows a relative destination with % or &, and still denies an encoded scheme', () => {
    expect(markdownToHtml('[x](file%20name.pdf)')).toContain('href="file%20name.pdf"');
    expect(markdownToHtml('[x](a&b.html)')).toContain('href="a&amp;b.html"');
    expect(markdownToHtml('[x](%6Aavascript:alert(1))')).not.toMatch(/href=/);
  });

  it('closes emphasis in the right order when the kinds overlap', () => {
    expect(markdownToHtml('**a _b** c_')).toContain('<strong>a _b</strong> c_');
  });

  it('emits only allowed tags and safe hrefs for seeded random input', () => {
    // mulberry32: a fixed seed keeps the run deterministic.
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const parts = [
      '[', ']', '(', ')', '<', '>', '"', "'", '&', '&#106;', '&colon;', '\\', '`', '*', '_', '#', '>', '-', '1.',
      '|', '\n', ' ', '\t', 'javascript:', 'JaVaScRiPt:', 'data:', 'http://a', 'https://b', 'mailto:c', 'x', 'onerror=',
      '<script>', '```', '~~~', '![', '%6A', '\u0001',
    ];
    const allowed = new Set([
      'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li', 'table',
      'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'em', 'a',
    ]);
    for (let n = 0; n < 2000; n += 1) {
      let md = '';
      const len = 1 + Math.floor(rand() * 40);
      for (let k = 0; k < len; k += 1) md += parts[Math.floor(rand() * parts.length)];
      const out = markdownToHtml(md);
      for (const m of out.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
        expect(allowed.has(m[1])).toBe(true);
        const attrs = m[2].replace(/\s(href|title|class|align|start)="[^"]*"/g, '');
        expect(attrs.trim()).toBe('');
      }
      for (const m of out.matchAll(/href="([^"]*)"/g)) {
        const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(m[1].replace(/&amp;/g, '&'));
        expect(scheme === null || ['http', 'https', 'mailto'].includes(scheme[1].toLowerCase())).toBe(true);
      }
    }
  });
});
