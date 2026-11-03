/** Persistence of the operator catalog's programme guides (Phase 9.7). */

export interface OperatorGuideRecord {
  id: string;
  name: string;
  /** Encrypted XMLTV URL. */
  url: string;
  urlHash: string;
  host: string;
  status: 'active' | 'paused';
  priority: number;
  generation: number;
  syncIntervalHours: number;
  sync: { status: 'idle' | 'queued' | 'running' | 'failed'; lastAttemptAt: Date | null; lastSuccessAt: Date | null; nextAt: Date | null; error: string | null; failures: number };
  stats: { channels: number; programmes: number; from: string | null; to: string | null };
  createdAt: Date;
  /** Set by a claim: the generation this run writes. */
  claimedGeneration?: number;
}

export interface OperatorProgrammeRecord {
  epgChannelId: string;
  start: Date;
  stop: Date;
  title: string;
  subtitle: string | null;
  description: string | null;
  categories: string[];
  icon: string | null;
}

export interface ChannelEpgRecord {
  channelId: string;
  guideId: string;
  epgChannelId: string;
  method: 'auto' | 'manual';
}

export interface OperatorEpgRepository {
  newId(): string;
  listGuides(): Promise<(OperatorGuideRecord & { mappedChannels: number })[]>;
  findGuide(id: string): Promise<OperatorGuideRecord | null>;
  createGuide(guide: { id: string; name: string; url: string; urlHash: string; host: string; priority: number; syncIntervalHours: number; now: Date }): Promise<OperatorGuideRecord>;
  updateGuide(id: string, patch: Partial<{ name: string; url: string; urlHash: string; host: string; status: 'active' | 'paused'; priority: number; syncIntervalHours: number }>, now: Date): Promise<OperatorGuideRecord | null>;
  deleteGuide(id: string): Promise<boolean>;
  requestSync(id: string, now: Date): Promise<void>;

  // sync runs
  claimDue(now: Date, owner: string, leaseUntil: Date): Promise<OperatorGuideRecord | null>;
  heartbeat(id: string, owner: string, leaseUntil: Date): Promise<boolean>;
  insertChannels(guideId: string, generation: number, channels: { id: string; names: string[]; icon: string | null }[]): Promise<void>;
  insertProgrammes(guideId: string, generation: number, programmes: OperatorProgrammeRecord[]): Promise<void>;
  deleteGeneration(guideId: string, generation: number): Promise<void>;
  /** Makes `generation` current if the run still owns the lease; deletes every other generation. */
  commitGeneration(guideId: string, owner: string, generation: number, stats: OperatorGuideRecord['stats']): Promise<boolean>;
  completeSync(guideId: string, owner: string, result: { status: 'idle' | 'failed'; error: string | null; lastSuccessAt?: Date; nextAt: Date; failures: number }): Promise<void>;

  // matching
  /** Alias keys (tvg_id / name) of active master channels. */
  channelAliases(): Promise<{ channelId: string; kind: 'name' | 'tvg_id' | 'manual'; key: string }[]>;
  activeChannels(): Promise<{ id: string; name: string }[]>;
  /** Channels of the current generation of every active guide (id, names). */
  currentGuideChannels(): Promise<{ guideId: string; priority: number; id: string; names: string[] }[]>;
  searchGuideChannels(query: { guideId?: string | undefined; text: string; limit: number }): Promise<{ guideId: string; id: string; names: string[]; icon: string | null }[]>;
  guideChannelExists(guideId: string, epgChannelId: string): Promise<boolean>;
  mappings(): Promise<ChannelEpgRecord[]>;
  setMapping(mapping: ChannelEpgRecord, now: Date): Promise<void>;
  /** Replaces the automatic mappings (manual ones are never touched). */
  replaceAutoMappings(mappings: ChannelEpgRecord[], now: Date): Promise<void>;
  deleteMapping(channelId: string): Promise<void>;

  // reading
  /** Programmes of mapped channels overlapping [from, to), current generations only. */
  programmesFor(channelIds: string[], from: Date, to: Date): Promise<(OperatorProgrammeRecord & { channelId: string })[]>;
  /** The last scheduled stop per mapped channel. */
  scheduleEnds(): Promise<Map<string, Date>>;
}
