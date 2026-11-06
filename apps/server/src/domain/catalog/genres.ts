import { normalizeForSearch } from '../shared/text.js';

/**
 * Genre normalisation (Phase 15.4). Providers write genres however they like — "Action, Adventure",
 * "Боевик", "Acción / Aventura", "Sci-Fi & Fantasy" — and many M3U lists have none, only a category
 * such as "EN | Action Movies". Both are mapped onto one small canonical set, so a filter works
 * across sources and languages. Pure: no I/O.
 *
 * Matching is by whole words of the normalised text (case- and accent-insensitive), so "Drama"
 * matches "drama" and "melodrama" maps to romance, but "Dramatic Moments" does not become drama.
 * Unknown words are ignored; the provider's own text stays on the item (`genres`).
 */
export const GENRE_IDS = [
  'action',
  'adventure',
  'animation',
  'biography',
  'comedy',
  'crime',
  'documentary',
  'drama',
  'family',
  'fantasy',
  'history',
  'horror',
  'kids',
  'music',
  'mystery',
  'reality',
  'romance',
  'scifi',
  'sport',
  'thriller',
  'war',
  'western',
] as const;

export type GenreId = (typeof GENRE_IDS)[number];

/**
 * Synonyms per genre: single words or multi-word phrases, written as they look after
 * `normalizeForSearch` (lower case, no accents). English, Georgian, Russian and the most common
 * provider languages (Spanish, Portuguese, French, German, Italian, Turkish).
 */
const SYNONYMS: Record<GenreId, readonly string[]> = {
  action: ['action', 'боевик', 'боевики', 'экшен', 'экшн', 'მძაფრსიუჟეტიანი', 'ექშენი', 'accion', 'acao', 'aksiyon', 'azione'],
  adventure: ['adventure', 'adventures', 'приключения', 'приключенческий', 'სათავგადასავლო', 'თავგადასავალი', 'aventura', 'aventuras', 'aventure', 'abenteuer', 'macera', 'avventura'],
  animation: ['animation', 'animated', 'anime', 'cartoon', 'cartoons', 'мультфильм', 'мультфильмы', 'мультики', 'анимация', 'аниме', 'ანიმაცია', 'ანიმაციური', 'მულტფილმი', 'მულტფილმები', 'animacion', 'animacao', 'zeichentrick', 'animasyon', 'animazione', 'dessin anime'],
  biography: ['biography', 'biographical', 'biopic', 'биография', 'биографический', 'ბიოგრაფიული', 'biografia', 'biographie', 'biyografi'],
  comedy: ['comedy', 'comedies', 'комедия', 'комедии', 'კომედია', 'კომედიები', 'comedia', 'comedie', 'komodie', 'komedi', 'commedia'],
  crime: ['crime', 'criminal', 'gangster', 'криминал', 'криминальный', 'კრიმინალური', 'კრიმინალი', 'crimen', 'crimes', 'krimi', 'suc', 'poliziesco', 'policier'],
  documentary: ['documentary', 'documentaries', 'docu', 'docs', 'документальный', 'документальные', 'документалистика', 'დოკუმენტური', 'documental', 'documentario', 'documentaire', 'dokumentation', 'dokumentarfilm', 'belgesel'],
  drama: ['drama', 'dramas', 'драма', 'драмы', 'დრამა', 'drame', 'dram'],
  family: ['family', 'семейный', 'семейные', 'საოჯახო', 'familia', 'familiar', 'famille', 'familie', 'aile', 'famiglia'],
  fantasy: ['fantasy', 'фэнтези', 'фентези', 'ფენტეზი', 'fantasia', 'fantastique', 'fantastik'],
  history: ['history', 'historical', 'исторический', 'исторические', 'история', 'ისტორიული', 'historia', 'historico', 'historique', 'historie', 'tarih', 'storico'],
  horror: ['horror', 'ужасы', 'ужас', 'хоррор', 'საშინელებათა', 'საშინელება', 'terror', 'horreur', 'korku', 'orrore'],
  kids: ['kids', 'children', 'childrens', 'детский', 'детские', 'детям', 'для детей', 'საბავშვო', 'ბავშვებისთვის', 'infantil', 'infantiles', 'enfants', 'kinder', 'cocuk', 'bambini'],
  music: ['music', 'musical', 'musicals', 'concert', 'музыка', 'музыкальный', 'мюзикл', 'концерт', 'მუსიკა', 'მუსიკალური', 'მიუზიკლი', 'musica', 'musique', 'musik', 'muzik', 'muzikal'],
  mystery: ['mystery', 'mysteries', 'detective', 'детектив', 'детективы', 'мистика', 'დეტექტივი', 'მისტიკა', 'misterio', 'mystere', 'gizem', 'giallo'],
  reality: ['reality', 'reality show', 'reality tv', 'talk show', 'game show', 'реалити', 'реалити шоу', 'ток шоу', 'რეალითი', 'telerrealidad'],
  romance: ['romance', 'romantic', 'romcom', 'мелодрама', 'мелодрамы', 'романтика', 'романтический', 'რომანტიკული', 'მელოდრამა', 'romantico', 'romantique', 'romantik', 'melodram', 'melodrama', 'romantizm'],
  scifi: ['sci fi', 'scifi', 'science fiction', 'фантастика', 'научная фантастика', 'фантастический', 'ფანტასტიკა', 'ფანტასტიკური', 'ciencia ficcion', 'ficcao cientifica', 'science fiction', 'bilim kurgu', 'fantascienza'],
  sport: ['sport', 'sports', 'спорт', 'спортивный', 'სპორტი', 'სპორტული', 'deporte', 'deportes', 'esporte', 'spor'],
  thriller: ['thriller', 'thrillers', 'suspense', 'триллер', 'триллеры', 'თრილერი', 'gerilim'],
  war: ['war', 'military', 'военный', 'военные', 'война', 'ომის', 'სამხედრო', 'guerra', 'guerre', 'krieg', 'kriegsfilm', 'savas'],
  western: ['western', 'westerns', 'вестерн', 'вестерны', 'ვესტერნი', 'oeste', 'kovboy'],
};

/** Words that say nothing about the genre and appear around it in category names ("EN | Action Movies HD"). */
const NOISE = new Set(['movie', 'movies', 'film', 'films', 'vod', 'hd', 'fhd', 'uhd', '4k', 'new', 'top', 'best', 'кино', 'фильм', 'фильмы', 'სერიალი', 'ფილმი', 'ფილმები']);

/** phrase (space-separated words) → genre; longest phrases are tried first. */
const PHRASES: { words: string[]; genre: GenreId }[] = Object.entries(SYNONYMS)
  .flatMap(([genre, synonyms]) => synonyms.map((phrase) => ({ words: words(phrase), genre: genre as GenreId })))
  .sort((a, b) => b.words.length - a.words.length);

function words(text: string): string[] {
  return normalizeForSearch(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !NOISE.has(word));
}

/**
 * Canonical genres of an item, from its provider genres and categories, in `GENRE_IDS` order.
 * `["Action, Adventure"]` → `['action', 'adventure']`; `["EN | Sci-Fi & Fantasy"]` →
 * `['fantasy', 'scifi']`; `["Боевик"]` → `['action']`; `["Netflix"]` → `[]`.
 */
export function canonicalGenres(...texts: readonly (readonly string[])[]): GenreId[] {
  const found = new Set<GenreId>();
  for (const list of texts) {
    for (const text of list) {
      const tokens = words(text);
      for (let start = 0; start < tokens.length; start++) {
        for (const phrase of PHRASES) {
          if (phrase.words.length > tokens.length - start) continue;
          if (phrase.words.every((word, offset) => tokens[start + offset] === word)) found.add(phrase.genre);
        }
      }
    }
  }
  return GENRE_IDS.filter((id) => found.has(id));
}

export function isGenreId(value: string): value is GenreId {
  return (GENRE_IDS as readonly string[]).includes(value);
}
