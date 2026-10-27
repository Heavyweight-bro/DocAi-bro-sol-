// Minimal OpenAI Responses API stand-in. `plan` returns, per call, either {fail:true} or {text:'...'}.
import http from 'node:http';

export async function startMockOpenAI(plan) {
  let calls = 0;
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls += 1;
      try { bodies.push(JSON.parse(raw || '{}')); } catch { bodies.push({}); }
      const step = plan(calls, bodies[bodies.length - 1]);
      if (step.fail) {
        res.writeHead(step.status || 500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'mock failure', type: 'server_error' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `resp_${calls}`, object: 'response', status: 'completed', model: step.model || 'gpt-4o-mini',
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] }],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1`, calls: () => calls, bodies, close: () => new Promise((r) => server.close(r)) };
}
