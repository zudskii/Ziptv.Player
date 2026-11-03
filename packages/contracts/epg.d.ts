import type { ChannelDto } from './catalog';

// ---------------------------------------------------------------------------
// EPG — programme guide (XMLTV)
// ---------------------------------------------------------------------------

export interface ProgrammeDto {
  /** Stable id within the guide generation (used as React key / deep link). */
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  /** ISO instants. */
  start: string;
  end: string;
  categories: string[];
  icon: string | null;
  /** Human episode label, e.g. "S2 E5". */
  episode: string | null;
  rating: string | null;
  /** Past programme that can be watched from the channel archive. */
  catchup: boolean;
}

export interface NowNextDto {
  now: ProgrammeDto | null;
  next: ProgrammeDto | null;
}

/** GET /epg/now?sourceId= — now/next for every linked channel of a source. */
export interface NowNextListDto {
  sourceId: string;
  catalogVersion: string;
  generatedAt: string;
  /** Keyed by channel key; channels without a guide are absent. */
  items: Record<string, NowNextDto>;
}

/** GET /epg/channels/:sourceId/:key — schedule of one channel (mini guide). */
export interface ChannelScheduleDto {
  sourceId: string;
  key: string;
  from: string;
  to: string;
  programmes: ProgrammeDto[];
}

/** GET /epg/guide — TV Guide grid rows. */
export interface GuideRowDto {
  channel: ChannelDto;
  programmes: ProgrammeDto[];
}

export interface GuideDto {
  sourceId: string;
  catalogVersion: string;
  from: string;
  to: string;
  /** Channels matching the filter (for virtual scrolling). */
  total: number;
  offset: number;
  rows: GuideRowDto[];
}

export interface EpgSearchItemDto {
  sourceId: string;
  sourceName: string;
  channel: ChannelDto;
  programme: ProgrammeDto;
}

export interface EpgSearchResultDto {
  query: string;
  items: EpgSearchItemDto[];
}

// --- Guides (EPG sources) -------------------------------------------------------------------

export type GuideOrigin = 'playlist' | 'xtream' | 'manual';

export interface GuideSourceDto {
  id: string;
  name: string;
  origin: GuideOrigin;
  /** Host of the XMLTV URL (the URL itself may contain credentials). */
  host: string;
  /** Sources whose channels use this guide. */
  sourceIds: string[];
  sync: {
    status: 'idle' | 'queued' | 'running' | 'failed';
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    nextSyncAt: string | null;
    error: string | null;
  };
  stats: {
    channels: number;
    keptChannels: number;
    programmes: number;
    from: string | null;
    to: string | null;
  };
  createdAt: string;
}

export interface AddGuideRequest {
  url: string;
  name?: string;
  /** Sources to use this guide for (defaults to all of the user's sources). */
  sourceIds?: string[];
}

export interface UpdateGuideRequest {
  name?: string;
  sourceIds?: string[];
}

/** A channel of a guide, for the manual mapping picker. */
export interface GuideChannelOptionDto {
  guideId: string;
  guideName: string;
  id: string;
  name: string;
  icon: string | null;
}

export interface SetEpgMappingRequest {
  sourceId: string;
  channelKey: string;
  guideId: string;
  epgChannelId: string;
}

export interface ChannelEpgLinkDto {
  sourceId: string;
  channelKey: string;
  link: {
    guideId: string;
    guideName: string;
    epgChannelId: string;
    epgChannelName: string;
    match: 'manual' | 'tvg-id' | 'name';
  } | null;
}

// --- operator catalog EPG (Phase 9) ------------------------------------------------------------

export interface OperatorGuideDto {
  id: string;
  name: string;
  /** Host of the XMLTV URL (the URL itself is stored encrypted and never shown again). */
  host: string;
  status: 'active' | 'paused';
  /** Lower first when two guides could serve the same channel automatically. */
  priority: number;
  syncIntervalHours: number;
  sync: { status: 'idle' | 'queued' | 'running' | 'failed'; lastAttemptAt: string | null; lastSuccessAt: string | null; nextAt: string | null; error: string | null };
  stats: { channels: number; programmes: number; from: string | null; to: string | null };
  /** Master channels currently mapped to this guide. */
  mappedChannels: number;
  createdAt: string;
}

export interface CreateOperatorGuideRequest {
  name: string;
  url: string;
  priority?: number;
  syncIntervalHours?: number;
}

export interface UpdateOperatorGuideRequest {
  name?: string;
  url?: string;
  status?: 'active' | 'paused';
  priority?: number;
  syncIntervalHours?: number;
}

/**
 * ok: a schedule for the next 24 h without big gaps · unmapped: no guide channel · no_data: mapped,
 * but nothing scheduled in the next 24 h · ends_soon: the schedule runs out within 12 h · gaps:
 * more than an hour without programmes in the next 24 h.
 */
export type EpgCoverageStatus = 'ok' | 'unmapped' | 'no_data' | 'ends_soon' | 'gaps';

export interface EpgCoverageDto {
  generatedAt: string;
  summary: Record<EpgCoverageStatus, number>;
  channels: {
    channelId: string;
    name: string;
    status: EpgCoverageStatus;
    mapping: { guideId: string; guideName: string; epgChannelId: string; method: 'auto' | 'manual' } | null;
    programmes24h: number;
    scheduleEndsAt: string | null;
    gapMinutes24h: number;
  }[];
}

export interface OperatorGuideChannelDto {
  guideId: string;
  id: string;
  names: string[];
  icon: string | null;
}

export interface SetChannelEpgRequest {
  guideId: string;
  epgChannelId: string;
}

/** `GET /api/v1/operator/guide?channels=` — what is on now and next on operator channels. */
export interface OperatorNowNextDto {
  channelId: string;
  now: OperatorProgrammeDto | null;
  next: OperatorProgrammeDto | null;
}

export interface OperatorProgrammeDto {
  title: string;
  subtitle: string | null;
  start: string;
  stop: string;
}
