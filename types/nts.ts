export interface NTSApiResponse {
  metadata: {
    resultset: {
      count: number;
      offset: number;
      limit: number;
    };
  };
  results: Episode[];
  links: Link[];
}

export interface ShowResponse {
  status: string;
  updated: string;
  name: string;
  description: string;
  description_html: string;
  external_links: string[];
  moods: Mood[];
  genres: Genre[];
  location_short: string | null;
  location_long: string | null;
  intensity: string | null;
  media: Media;
  show_alias: string;
  timeslot: string;
  frequency: string;
  brand: Record<string, unknown>;
  type: string;
  nextBroadcastStart: string;
  nextBroadcastEnd: string;
  artistsNotPresent: any[];
  artistsPresent: Artist[];
  videos: any[];
  episodes: Episode[];
}

export interface Artist {
  name: string;
  path: string;
  featuredAs: string;
  discogsArtistId: number;
}

export interface Episode {
  status: string;
  updated: string;
  name: string;
  description: string;
  description_html: string;
  external_links: string[];
  moods: Mood[];
  genres: Genre[];
  location_short: string | null;
  location_long: string | null;
  intensity: string | null;
  media: Media;
  episode_alias: string;
  show_alias: string;
  broadcast: string;
  mixcloud: string | null;
  audio_sources: AudioSource[];
  brand: Record<string, unknown>;
  embeds?: Record<string, unknown>;
  links?: Link[];
}

export interface Mood {
  id: string;
  value: string;
}

export interface Genre {
  id: string;
  value: string;
}

export interface Media {
  background_large: string;
  background_medium_large: string;
  background_medium: string;
  background_small: string;
  background_thumb: string;
  picture_large: string;
  picture_medium_large: string;
  picture_medium: string;
  picture_small: string;
  picture_thumb: string;
}

export interface AudioSource {
  url: string;
  source: string;
}

export interface Link {
  rel: string;
  href: string;
  type: string;
}
