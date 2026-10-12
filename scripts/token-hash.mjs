import { createHash } from 'node:crypto';
// Hash a previously generated high-entropy host token; never pass it in argv.
if (process.argv.length !== 2 || process.stdin.isTTY) {
  console.error('Pipe a private token file to stdin: node scripts/token-hash.mjs < /private/path/token');
  process.exitCode = 1;
} else {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1024) { console.error('Token input too large'); process.exit(1); }
  }
  const token = input.trim();
  if (!/^[A-Za-z0-9_.-]{32,256}$/.test(token)) { console.error('Expected a 32–256 character high-entropy host token'); process.exitCode = 1; }
  else console.log(createHash('sha256').update(token).digest('hex'));
}
