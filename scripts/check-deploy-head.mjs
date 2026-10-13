import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Called inside the serialized production workflow immediately before a write.
// Do not fetch or check out a newer commit: only this run's validated SHA may ship.
export function checkDeployHead(expectedSha, runGit = args => execFileSync('git', args, {
  encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
})) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '')) throw new Error('Missing or invalid deployment commit SHA.');
  const checkoutSha = runGit(['rev-parse', 'HEAD']).trim();
  if (checkoutSha !== expectedSha) throw new Error('Checkout does not match this run\'s validated commit; refusing deployment.');
  // The production repository is public; no stored checkout token is required.
  const remote = runGit(['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).trim();
  if (remote !== `${expectedSha}\trefs/heads/main`) {
    throw new Error('This commit is no longer current main; refusing stale deployment. Start a new run on main.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkDeployHead(process.env.GITHUB_SHA);
    console.log('Validated commit is still current main.');
  } catch {
    // Git errors can include URLs or credential-helper output. Never print them.
    console.error('Deployment stopped: could not verify the checked commit is current main. Use a new main run; check repository access if it persists.');
    process.exitCode = 1;
  }
}
