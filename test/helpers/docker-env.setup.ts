import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Bypass legacy or broken credential helpers in ~/.docker/config.json while preserving ~/.docker/contexts
process.env['DOCKER_AUTH_CONFIG'] ??= '{"auths":{}}';

if (!process.env['DOCKER_HOST'] && !existsSync('/var/run/docker.sock')) {
  let detectedEndpoint: string | undefined;

  try {
    const output = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();

    if (output.startsWith('unix://') || output.startsWith('tcp://')) {
      detectedEndpoint = output;
    }
  } catch {
    // Fallback to common macOS container runtime socket locations
    const home = homedir();
    const candidates = [
      join(home, '.colima', 'default', 'docker.sock'),
      join(home, '.orbstack', 'run', 'docker.sock'),
      join(home, '.docker', 'run', 'docker.sock'),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found !== undefined) {
      detectedEndpoint = `unix://${found}`;
    }
  }

  if (detectedEndpoint !== undefined) {
    process.env['DOCKER_HOST'] = detectedEndpoint;
    if (
      (detectedEndpoint.includes('.colima') || detectedEndpoint.includes('.lima')) &&
      !process.env['TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE']
    ) {
      process.env['TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE'] = '/var/run/docker.sock';
    }
  }
}
