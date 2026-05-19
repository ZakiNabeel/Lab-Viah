// Google Maps Places v1 venue finder — used by the Booking Agent.
// Finds 3 halal-friendly meeting venues (cafe / restaurant / family-friendly)
// in the user's city for the first-meeting workflow.
// See MASTERPLAN §5.7 (Booking Agent), §9 (tool registry — mapsFindVenue has
// 2× retry, fallback to hardcoded list) and ANTIGRAVITY.md §3 (trace contract).
// Missing API key, non-200, or < count results all trigger the fallback path,
// which is the demo's visible Antigravity recovery event.

import { z } from 'zod';
import { env } from '../config.js';
import { logger } from '../utils/logger.js';
import { recover, type TraceBus } from '../agents/_shared/trace.js';

// =========================================================
// Public types
// =========================================================

export type MapsFindVenueInput = {
  city: string;
  area?: string;
  count?: number;
  query?: string;
};

export type Venue = {
  name: string;
  address: string;
  area: string;
  city: string;
  rating: number | null;
  priceLevel: 1 | 2 | 3 | null;
  category: 'cafe' | 'restaurant' | 'family_restaurant' | 'fallback';
  source: 'maps_places' | 'fallback';
  placeId: string | null;
  mapsUrl: string;
};

export type MapsFindVenueResult = {
  venues: Venue[];
  usedFallback: boolean;
  attempts: number;
};

// =========================================================
// Zod schema for the Places API v1 response shape
// =========================================================

const PlaceSchema = z.object({
  id: z.string().optional(),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  shortFormattedAddress: z.string().optional(),
  rating: z.number().optional(),
  // Places API v1 returns priceLevel as a string enum.
  priceLevel: z.string().optional(),
  googleMapsUri: z.string().optional(),
  types: z.array(z.string()).optional(),
});

const PlacesResponseSchema = z.object({
  places: z.array(PlaceSchema).optional(),
});

type PlacesResponse = z.infer<typeof PlacesResponseSchema>;

// =========================================================
// Hardcoded fallback venues — real, verifiable places
// =========================================================

type FallbackVenueData = Omit<Venue, 'source' | 'category' | 'mapsUrl' | 'placeId'>;

const FALLBACK_VENUES: Record<string, FallbackVenueData[]> = {
  Karachi: [
    { name: "Xander's Cafe", address: 'Phase 6, DHA, Karachi', area: 'DHA Phase 6', city: 'Karachi', rating: 4.3, priceLevel: 2 },
    { name: 'Esquires Coffee', address: 'Clifton Block 9, Karachi', area: 'Clifton', city: 'Karachi', rating: 4.2, priceLevel: 2 },
    { name: 'OPTP - Original Pizza & The Place', address: 'Phase 5, DHA, Karachi', area: 'DHA Phase 5', city: 'Karachi', rating: 4.1, priceLevel: 2 },
  ],
  Lahore: [
    { name: 'Cafe Aylanto', address: 'MM Alam Road, Gulberg III, Lahore', area: 'MM Alam Road', city: 'Lahore', rating: 4.4, priceLevel: 2 },
    { name: 'Butlers Chocolate Cafe', address: 'MM Alam Road, Gulberg, Lahore', area: 'Gulberg', city: 'Lahore', rating: 4.3, priceLevel: 2 },
    { name: 'Cafe Zouk', address: 'MM Alam Road, Lahore', area: 'MM Alam Road', city: 'Lahore', rating: 4.2, priceLevel: 2 },
  ],
  Islamabad: [
    { name: 'Tuscany Courtyard', address: 'F-6 Markaz, Islamabad', area: 'F-6', city: 'Islamabad', rating: 4.4, priceLevel: 2 },
    { name: 'Howdy', address: 'Kohsar Market, F-7, Islamabad', area: 'F-7', city: 'Islamabad', rating: 4.3, priceLevel: 2 },
    { name: 'Burning Brownie', address: 'F-7 Markaz, Islamabad', area: 'F-7', city: 'Islamabad', rating: 4.2, priceLevel: 2 },
  ],
  Multan: [
    { name: 'Cafe Bistro', address: 'Cantt, Multan', area: 'Cantt', city: 'Multan', rating: 4.1, priceLevel: 2 },
    { name: 'Saleem Fabrics Cafe', address: 'Cantt, Multan', area: 'Cantt', city: 'Multan', rating: 4.0, priceLevel: 2 },
    { name: 'Bun Kabab House', address: 'Hussain Agahi, Multan', area: 'Hussain Agahi', city: 'Multan', rating: 4.2, priceLevel: 1 },
  ],
  Dubai: [
    { name: 'Arabian Tea House', address: 'Al Fahidi Historical District, Dubai', area: 'Al Fahidi', city: 'Dubai', rating: 4.5, priceLevel: 2 },
    { name: 'Logma', address: 'Boxpark, Al Wasl Road, Dubai', area: 'Boxpark', city: 'Dubai', rating: 4.3, priceLevel: 2 },
    { name: 'Operation Falafel', address: 'Downtown Dubai', area: 'Downtown', city: 'Dubai', rating: 4.2, priceLevel: 2 },
  ],
};

// =========================================================
// Helpers
// =========================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildQuery(input: MapsFindVenueInput): string {
  if (input.query) return input.query;
  const locationPart = input.area ? `${input.area}, ${input.city}` : input.city;
  return `family-friendly halal cafe in ${locationPart}`;
}

function normalisePriceLevel(raw: string | undefined): 1 | 2 | 3 | null {
  if (!raw) return null;
  // Places API v1 uses string enum values like "PRICE_LEVEL_INEXPENSIVE" etc.
  if (raw === 'PRICE_LEVEL_INEXPENSIVE') return 1;
  if (raw === 'PRICE_LEVEL_MODERATE') return 2;
  if (raw === 'PRICE_LEVEL_EXPENSIVE' || raw === 'PRICE_LEVEL_VERY_EXPENSIVE') return 3;
  return null;
}

function inferCategory(types: string[] | undefined): 'cafe' | 'restaurant' | 'family_restaurant' {
  if (!types) return 'cafe';
  const joined = types.join(' ');
  if (/family_restaurant/i.test(joined)) return 'family_restaurant';
  if (/restaurant/i.test(joined)) return 'restaurant';
  return 'cafe';
}

function makeFallbackVenue(data: FallbackVenueData): Venue {
  return {
    ...data,
    source: 'fallback',
    category: 'fallback',
    placeId: null,
    mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.name + ' ' + data.city)}`,
  };
}

function getFallbackVenues(city: string, count: number): Venue[] {
  // Case-insensitive city lookup.
  const key = Object.keys(FALLBACK_VENUES).find(
    (k) => k.toLowerCase() === city.toLowerCase()
  );
  const list: FallbackVenueData[] = (key ? FALLBACK_VENUES[key] : undefined) ?? [];
  // If city is unknown, use Karachi as a generic fallback.
  const base: FallbackVenueData[] = list.length > 0 ? list : (FALLBACK_VENUES['Karachi'] ?? []);
  return base.slice(0, count).map(makeFallbackVenue);
}

// =========================================================
// Places API call — single attempt
// =========================================================

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.displayName',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.rating',
  'places.priceLevel',
  'places.id',
  'places.googleMapsUri',
  'places.types',
].join(',');
const ATTEMPT_TIMEOUT_MS = 8_000;

async function callPlacesApi(
  apiKey: string,
  textQuery: string,
  maxResultCount: number,
  regionCode: string
): Promise<PlacesResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

  try {
    const response = await fetch(PLACES_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({ textQuery, regionCode, maxResultCount }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new PlacesApiError(response.status, body);
    }

    const raw: unknown = await response.json();
    return PlacesResponseSchema.parse(raw);
  } finally {
    clearTimeout(timer);
  }
}

class PlacesApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`Places API HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'PlacesApiError';
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof PlacesApiError) {
    // 4xx are not transient — bad request or unauthorized.
    return err.status >= 500;
  }
  // Network throw or AbortError counts as transient.
  return true;
}

// =========================================================
// Parse raw places into Venue[]
// =========================================================

function parsePlaces(
  data: PlacesResponse,
  city: string
): Venue[] {
  const places = data.places ?? [];
  return places.map((p) => {
    const name = p.displayName?.text ?? 'Unknown Venue';
    const address = p.formattedAddress ?? p.shortFormattedAddress ?? city;
    const area = p.shortFormattedAddress ?? city;
    const rating = typeof p.rating === 'number' ? p.rating : null;
    const priceLevel = normalisePriceLevel(p.priceLevel);
    const category = inferCategory(p.types);
    const placeId = p.id ?? null;
    const mapsUrl =
      p.googleMapsUri ??
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name + ' ' + city)}`;

    const venue: Venue = {
      name,
      address,
      area,
      city,
      rating,
      priceLevel,
      category,
      source: 'maps_places',
      placeId,
      mapsUrl,
    };
    return venue;
  });
}

// =========================================================
// Main export
// =========================================================

export async function mapsFindVenue(
  input: MapsFindVenueInput,
  bus?: TraceBus
): Promise<MapsFindVenueResult> {
  const count = Math.min(input.count ?? 3, 5);
  const constructedQuery = buildQuery(input);
  const apiKey = env.GOOGLE_MAPS_API_KEY;
  const hasKey = Boolean(apiKey);
  const regionCode = input.city === 'Dubai' ? 'AE' : 'PK';

  bus?.emit({
    type: 'tool.call',
    tool: 'mapsFindVenue',
    args: {
      city: input.city,
      area: input.area,
      count,
      query: constructedQuery,
      attempts_planned: hasKey ? 2 : 0,
    },
    ts: Date.now(),
  });

  // No API key — skip straight to fallback.
  if (!hasKey || !apiKey) {
    if (bus) {
      recover(bus, 'Maps API key not configured', 'returning hardcoded venue list');
    }
    logger.info(
      { city: input.city, venueFromFallback: true, reason: 'no_api_key', venues: getFallbackVenues(input.city, count).map((v) => v.name) },
      'mapsFindVenue: venueFromFallback (no API key)'
    );
    const venues = getFallbackVenues(input.city, count);
    bus?.emit({
      type: 'tool.result',
      tool: 'mapsFindVenue',
      result: {
        venuesReturned: venues.length,
        usedFallback: true,
        attempts: 0,
        firstVenue: venues[0]?.name,
      },
      latency_ms: 0,
      ts: Date.now(),
    });
    return { venues, usedFallback: true, attempts: 0 };
  }

  // Attempt up to 2 times with 500ms backoff on transient errors.
  const start = Date.now();
  let lastError: unknown;
  let attempts = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;
    try {
      const data = await callPlacesApi(apiKey, constructedQuery, count, regionCode);
      const parsed = parsePlaces(data, input.city);

      if (parsed.length >= count) {
        // Full success — return exactly count venues.
        const venues = parsed.slice(0, count);
        bus?.emit({
          type: 'tool.result',
          tool: 'mapsFindVenue',
          result: {
            venuesReturned: venues.length,
            usedFallback: false,
            attempts,
            firstVenue: venues[0]?.name,
          },
          latency_ms: Date.now() - start,
          ts: Date.now(),
        });
        return { venues, usedFallback: false, attempts };
      }

      // API returned fewer results than requested — fill remainder from fallback.
      const shortfall = count - parsed.length;
      const backfill = getFallbackVenues(input.city, shortfall).slice(0, shortfall);
      const venues = [...parsed, ...backfill];
      const reason = `Places API returned only ${parsed.length} result${parsed.length !== 1 ? 's' : ''}, need ${count}`;
      if (bus) recover(bus, reason, 'backfilling with hardcoded venues');
      logger.info({ city: input.city, got: parsed.length, need: count }, 'mapsFindVenue: partial results, backfilling');
      bus?.emit({
        type: 'tool.result',
        tool: 'mapsFindVenue',
        result: {
          venuesReturned: venues.length,
          usedFallback: true,
          attempts,
          firstVenue: venues[0]?.name,
        },
        latency_ms: Date.now() - start,
        ts: Date.now(),
      });
      return { venues, usedFallback: true, attempts };
    } catch (err) {
      lastError = err;
      const transient = isTransient(err);
      logger.warn(
        { attempt, city: input.city, err: err instanceof Error ? err.message : String(err), transient },
        'mapsFindVenue: Places API attempt failed'
      );

      // Non-transient (4xx) — no point retrying.
      if (!transient) break;

      if (attempt < 2) {
        await sleep(500);
      }
    }
  }

  // Both attempts failed (or a 4xx fired) — use full fallback.
  const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
  const reason = buildFailureReason(lastError, attempts, errMsg);
  if (bus) recover(bus, reason, 'returning hardcoded venue list');
  const venues = getFallbackVenues(input.city, count);
  // Distinct `venueFromFallback` log line — grep-able for demo readouts so the
  // proposal copy doesn't claim "picked from Maps" when it came from the
  // hardcoded list. The Places API has been intermittently dead through the
  // hackathon weekend; recover events surface as Antigravity-style recoveries
  // in the trace UI rather than user-facing errors.
  logger.info(
    {
      city: input.city,
      attempts,
      err: errMsg,
      venueFromFallback: true,
      reason: 'places_api_failed',
      venues: venues.map((v) => v.name),
    },
    'mapsFindVenue: venueFromFallback (Places API failed after retries)'
  );
  bus?.emit({
    type: 'tool.result',
    tool: 'mapsFindVenue',
    result: {
      venuesReturned: venues.length,
      usedFallback: true,
      attempts,
      firstVenue: venues[0]?.name,
    },
    latency_ms: Date.now() - start,
    ts: Date.now(),
  });
  return { venues, usedFallback: true, attempts };
}

function buildFailureReason(err: unknown, attempts: number, errMsg: string): string {
  if (err instanceof PlacesApiError && err.status === 401) {
    return 'Places API returned 401 Unauthorized — check GOOGLE_MAPS_API_KEY';
  }
  if (err instanceof PlacesApiError && err.status === 400) {
    return `Places API returned 400 Bad Request: ${errMsg}`;
  }
  if (attempts === 1) {
    return `Places API attempt failed: ${errMsg}`;
  }
  return `Places API attempt 1 failed, attempt 2 failed: ${errMsg}`;
}
