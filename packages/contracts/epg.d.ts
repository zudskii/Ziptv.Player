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
