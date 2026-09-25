import type { PlaybackEngineName } from '@ziptv/contracts';

import type { EngineFactory } from './types';

export type EngineLoader = (name: PlaybackEngineName) => Promise<EngineFactory>;

/**
 * Engines are code-split: hls.js (~400 kB), mpegts.js and dash.js are only downloaded when a
 * channel actually needs them, keeping the initial bundle small.
 */
export const loadEngine: EngineLoader = async (name) => {
  switch (name) {
    case 'hls':
      return (await import('./hls-engine')).createHlsEngine;
    case 'mpegts':
      return (await import('./mpegts-engine')).createMpegtsEngineFactory('mpegts');
    case 'flv':
      return (await import('./mpegts-engine')).createMpegtsEngineFactory('flv');
    case 'dash':
      return (await import('./dash-engine')).createDashEngine;
    case 'native':
      return (await import('./native-engine')).createNativeEngine;
  }
};

export { EngineError, type EngineHandle, type QualityLevel } from './types';
