import { execFile } from 'child_process';
import fs from 'fs';
import { loadConfig } from '../config';
import {
  ComposeFileNotFoundError,
  ComposeServiceError,
  ComposeTimeoutError,
} from '../errors';
import type { ComposeServiceInfo } from './types';

function execCompose(
  args: string[],
  timeoutMs?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const cfg = loadConfig();
    const timeout = timeoutMs ?? cfg.defaultTimeout;

    const child = execFile('docker', ['compose', ...args], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          reject(new ComposeTimeoutError(args.join(' '), timeout));
          return;
        }
        reject(new ComposeServiceError(
          args.join(' '),
          stderr.trim() || err.message,
        ));
        return;
      }
      resolve(stdout.trim());
    });

    if (child.stdin) child.stdin.end();
  });
}

function validateComposeFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new ComposeFileNotFoundError(filePath);
  }
}

export async function composeUp(
  composeFile: string,
  services?: string[],
  detach?: boolean,
): Promise<string> {
  validateComposeFile(composeFile);
  const args = ['-f', composeFile, 'up'];
  if (detach) args.push('-d');
  if (services) args.push(...services);
  return execCompose(args);
}

export async function composeDown(
  composeFile: string,
  volumes?: boolean,
  services?: string[],
): Promise<string> {
  validateComposeFile(composeFile);
  const args = ['-f', composeFile, 'down'];
  if (volumes) args.push('-v');
  if (services) args.push(...services);
  return execCompose(args);
}

export async function composeBuild(
  composeFile: string,
  services?: string[],
): Promise<string> {
  validateComposeFile(composeFile);
  const args = ['-f', composeFile, 'build'];
  if (services) args.push(...services);
  return execCompose(args);
}

export async function composeLogs(
  composeFile: string,
  services?: string[],
  tail?: number,
): Promise<string> {
  validateComposeFile(composeFile);
  const args = ['-f', composeFile, 'logs'];
  if (tail !== undefined) args.push('--tail', String(tail));
  if (services) args.push(...services);
  return execCompose(args);
}

export async function composePs(
  composeFile: string,
): Promise<ComposeServiceInfo[]> {
  validateComposeFile(composeFile);
  const raw = await execCompose(['-f', composeFile, 'ps', '--format', 'json']);
  if (!raw) return [];

  const lines = raw.split('\n').filter(Boolean);
  return lines.map(line => {
    try {
      const parsed = JSON.parse(line);
      return {
        name: parsed.Name || parsed.name || '',
        image: parsed.Image || parsed.image || '',
        state: parsed.State || parsed.state || '',
        ports: parsed.Ports || parsed.ports || '',
        status: parsed.Status || parsed.status || '',
      };
    } catch {
      return null;
    }
  }).filter((s): s is ComposeServiceInfo => s !== null);
}
