import { spawn } from 'node:child_process';

import type { MediaDecoder } from '../../application/ports/health.js';

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 64 * 1024;

/**
 * Decode check with ffprobe on a sample ZIPTV already downloaded. ffprobe reads only stdin
 * (`-protocol_whitelist pipe`): a hostile playlist or segment cannot make it fetch anything, so
 * the SSRF policy of the upstream client stays the only network path.
 */
export class FfprobeDecoder implements MediaDecoder {
  private available: boolean | null = null;

  constructor(private readonly binary: string) {}

  async inspect(sample: Buffer, signal: AbortSignal): Promise<{ ok: boolean; streams: string[]; error: string | null } | null> {
    if (this.available === false) return null;
    const result = await this.run(sample, signal);
    if (result === 'missing') {
      this.available = false;
      return null;
    }
    if (result === 'inconclusive') return null;
    this.available = true;
    return result;
  }

  private run(sample: Buffer, parent: AbortSignal): Promise<{ ok: boolean; streams: string[]; error: string | null } | 'missing' | 'inconclusive'> {
    return new Promise((resolve) => {
      const signal = AbortSignal.any([parent, AbortSignal.timeout(TIMEOUT_MS)]);
      const child = spawn(this.binary, ['-v', 'error', '-protocol_whitelist', 'pipe', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', '-i', 'pipe:0'], { stdio: ['pipe', 'pipe', 'pipe'], signal });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8');
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') resolve('missing');
        // Timed out / aborted (e.g. CPU starved): inconclusive, not a media failure.
        else if (error.name === 'AbortError') resolve('inconclusive');
        else resolve({ ok: false, streams: [], error: error.message });
      });
      child.on('close', (code, killedBy) => {
        if (code === null) {
          // Killed by our abort ('error' resolved it already) or crashed on the sample (e.g. SIGSEGV
          // on hostile media): a crash is a failed decode, and the promise must always settle.
          if (!signal.aborted) resolve({ ok: false, streams: [], error: `ffprobe terminated by ${killedBy ?? 'a signal'}` });
          return;
        }
        try {
          const parsed = JSON.parse(stdout || '{}') as { streams?: { codec_type?: string; codec_name?: string }[] };
          const streams = (parsed.streams ?? []).filter((stream) => stream.codec_type === 'video' || stream.codec_type === 'audio').map((stream) => `${stream.codec_type}:${stream.codec_name ?? '?'}`);
          resolve({ ok: streams.length > 0, streams, error: streams.length > 0 ? null : stderr.trim().split('\n')[0]?.slice(0, 200) || 'No audio/video stream' });
        } catch {
          resolve({ ok: false, streams: [], error: 'Unreadable ffprobe output' });
        }
      });
      // A broken pipe (ffprobe exits early on garbage) is not our failure.
      child.stdin.on('error', () => undefined);
      child.stdin.end(sample);
    });
  }
}
