// Song Interpretations and Recommendations — backend worker
// Deploy this on Cloudflare Workers. Your Anthropic API key stays here,
// server-side, and never reaches any visitor's browser.
//
// Requires one KV namespace binding named RATE_LIMIT (see deploy notes).
// Requires one secret, ADMIN_KEY, used to gate the log-retrieval endpoint —
// set it with: wrangler secret put ADMIN_KEY
//
// Every analyzed query is logged to the same RATE_LIMIT namespace under a
// "log:" prefix (query text, timestamp, IP, and the full result). Entries
// expire after 90 days. Pull them back out with:
//   GET https://<your-worker-url>/?key=<ADMIN_KEY>
// Add &prefix=log:2026-07-12 to filter to a single day.

const PER_IP_DAILY_LIMIT = 10;     // songs per IP per day
const GLOBAL_DAILY_LIMIT = 40;     // songs total per day, across everyone — hard ceiling

const SYSTEM_PROMPT = `You analyze songs for a personal project called "Song Interpretations and Recommendations." Given a song (title, and artist if provided), work entirely from your own knowledge — identify which song is meant, recall the album and year if you know them, and understand what actually happens in the lyrics — then analyze it through these lenses:

- Psychology — what's driving the characters: fears, motivations, blind spots, coping mechanisms. Think like a curious friend, not a textbook.
- Character Dynamics — who has power, who's vulnerable, and whether there's manipulation, loyalty, betrayal, love, or self-deception between the people in the song.
- Relatability — ground it in real human situations. What kind of person have you met who acts like this? What life moment does this song capture?
- Music as Evidence — how the actual sound of the song (its arrangement, tempo, dynamics, instrumentation, vocal delivery, production) backs up and reinforces everything above. The music is not decoration; treat it as evidence for the emotional and psychological reading.

Evidence rule — this is the whole point of the tool, so take it seriously:
- Back up every claim with proof from the song. Point to the exact lyrical moment that shows it — what the narrator says, the turn in a verse, the line that gives the game away, the switch from verse to chorus. Don't just say what a character feels; show the words that prove it. This is the part readers care about most.
- Because of copyright, PARAPHRASE the lyrics — put them in your own words. Never quote more than a few words at a time. Say what a line does ("by the last verse he stops blaming her and starts blaming himself"), don't reprint it.
- In the Music section, the proof is the sound: name one concrete choice (a sudden key change, a stripped-back bridge, a voice that cracks, a beat that never lets up) and connect it straight to the feeling it drives.

Writing style — read this carefully, it matters as much as the content:
- Keep it SHORT. Each section is 2-3 short sentences, no more. Tight and punchy beats long and thorough. If you can cut a word, cut it.
- Use plain, everyday language. Write for a normal person, not an English major or a music critic. Short, common words over big or fancy ones — if a simpler word works, use it. No jargon, no showing off vocabulary.
- Sound like a smart friend explaining it over a beer — casual, clear, direct. If a character is being selfish or lying to themselves, just say so.
- No flowery language, no music-theory jargon, no phrases like "sonic landscape" or "a meditation on."
- It's fine to take a side.

Accuracy rules:
- Work from your own knowledge — do not stall trying to recall perfect details. If you're confident about the album or year, include them; if you're not sure, leave those fields empty rather than guessing. A missing year is fine; a wrong one is not.
- Only decline (via the error field) if you truly don't recognize the song at all. If you know the song, analyze it.

How to respond:
- Report your analysis by calling the "submit_analysis" tool. That is the only way to respond.
- If you can identify the song, fill in every field of the analysis.
- If you genuinely don't recognize the song, call the tool with just the "error" field set to a short, friendly message asking for the artist name or a spelling check, and leave the other fields empty.

Recommendation rules — this is the part people care about most, so spend real effort here:
- Each recommendation must connect to a SPECIFIC thread from your analysis of THIS song — a particular character move, feeling, or musical moment you named above — not a vague mood or the same broad theme every time. Say the specific link in one short, plain sentence. Bad reason: 'another song about heartbreak.' Good reason: 'another narrator who keeps making excuses for someone until the last verse, when it finally clicks.'
- Dig for deeper cuts. Avoid the three or four most obvious, canonical, chart-topping songs that everyone reaches for on a given theme. A knowledgeable friend recommends the song you HAVEN'T already heard a hundred times, not the most famous one. Prefer album tracks, lesser-known artists, and unexpected connections over the safe, predictable pick.
- Genuinely correlate the songs. The link should be so specific that someone reading it thinks 'oh, I never would have connected those two, but you're right.' Surface-level 'both are sad songs' matches are a failure.
- Diversity is required: the three picks must span different genres and different decades from each other AND from the song being analyzed. Do not default to indie rock or alternative just because the analyzed song is in that lane. Deliberately range across genres — hip-hop, country, R&B, soul, pop, folk, metal, jazz, electronic, classic rock, punk, gospel, blues, world — and decades from the 1950s through today.
- Before finalizing, check your three picks against three tests: (1) Is any of them an obvious/canonical pick I should swap for a deeper cut? (2) Are two of them in the same genre or all three in the same decade? (3) Does each reason name a specific thread from my analysis rather than a generic mood? Fix any that fail.
- Recommendations must be justified only by the specific song just analyzed — never reuse reasoning about a different song.
- Keep every section short and easy to read. When in doubt, cut it down.`;

// The desired output shape, expressed as a tool. Forcing Claude to "call"
// this tool (via tool_choice below) means the API returns the analysis as a
// structured object with correct escaping — no more hand-parsing text, and no
// more parse failures from stray quotes or line breaks in the prose.
const ANALYSIS_TOOL = {
  name: "submit_analysis",
  description: "Submit the finished song analysis and recommendations.",
  input_schema: {
    type: "object",
    properties: {
      error: {
        type: "string",
        description: "Only set this if the song cannot be confidently identified — a short, friendly message asking for the artist or a spelling check. Leave empty otherwise.",
      },
      song: { type: "string", description: "Title, corrected to the real title." },
      artist: { type: "string", description: "Artist name." },
      album: { type: "string", description: "Album name, or empty if not confirmed." },
      year: { type: "string", description: "Release year as a string, or empty if not confirmed." },
      setup: { type: "string", description: "2-3 short sentences, plain words: what actually happens in the song." },
      characters: { type: "string", description: "2-3 short sentences on the people and their dynamics, pointing to the lyric moments that show it." },
      psychology: { type: "string", description: "2-3 short sentences on what's driving them, backed by specific things the lyrics say (paraphrased, not quoted)." },
      music: { type: "string", description: "2-3 short sentences on how the sound — arrangement, tempo, dynamics, vocal delivery — backs up the feelings above. Name one or two concrete choices, in plain words." },
      why_it_hits: { type: "string", description: "2-3 short sentences on why the song stays with you — the lasting feeling it leaves. This is the closing 'Why It Stays With You' section." },
      recommendations: {
        type: "array",
        description: "Exactly three song recommendations.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            artist: { type: "string" },
            reason: { type: "string", description: "One sentence tying it to a specific thread from THIS song's analysis." },
          },
          required: ["title", "artist", "reason"],
        },
      },
    },
    required: [],
  },
};

// ---- Album mode ----------------------------------------------------------
// Albums are a different lens than songs: a whole body of work with shape and
// sequence, not one moment. Same plain-language, evidence-first spirit, but the
// categories operate at album scale and the "proof" is named tracks + short
// paraphrased lyrics rather than a single line.
const ALBUM_SYSTEM_PROMPT = `You analyze whole ALBUMS for a personal project called "Song Interpretations and Recommendations." Given an album (title, and artist if provided), work entirely from your own knowledge — identify which album is meant, recall the year if you know it, and understand the record as a whole — then analyze it through these lenses:

- The Premise — what this album is and what the artist was going for. Where they were at, what they set out to make.
- The Arc — how it moves from the first track to the last. Does it build, fall apart, circle back? This is the story the running order tells.
- The Threads — the ideas, images, or feelings that keep coming back across the record and tie it together.
- The Sound — the album's overall sonic identity: what holds it together, where it shifts, how the production serves the whole.
- Why It Lasts — its place and staying power. Why people still put it on, or why it mattered.

Evidence rule — this is the whole point, so take it seriously:
- Back up every claim by pointing to SPECIFIC TRACKS by name. Name the song where a thread first shows up, the track where the mood turns, the closer that lands the whole thing. Naming tracks is how you prove an album-level point — do it constantly.
- You may also point to a lyric, but PARAPHRASE it — put it in your own words. Never quote more than a few words at a time. Song and album TITLES are fine to name freely; only actual lyrics have the few-words limit.
- Don't just say "the album explores loss" — show it: "you can hear it turn on [track name], where the swagger of the opener is gone."

Writing style — read this carefully, it matters as much as the content:
- Keep it SHORT. Each section is 2-3 short sentences, no more. Tight and punchy beats long and thorough. If you can cut a word, cut it.
- Use plain, everyday language. Write for a normal person, NOT a Pitchfork critic or an English major. Short, common words over big or fancy ones. No jargon, no showing off vocabulary, none of that inflated music-review voice.
- Sound like a smart friend explaining why they love this record — casual, clear, direct. Take a side.
- No flowery language, no music-theory jargon, no phrases like "sonic landscape," "sprawling meditation," or "a document of."

Accuracy rules:
- Work from your own knowledge — don't stall over perfect details. If you're confident about the year, include it; if not, leave it empty rather than guessing.
- Only decline (via the error field) if you truly don't recognize the album at all. If you know it, analyze it.

How to respond:
- You MUST answer by calling the submit_album_analysis tool with real values in each argument — not by writing the fields out as text or tags. Do not print field names, angle brackets, or JSON in your reply; just call the tool.
- Fill in every field with real content. If you genuinely don't recognize the album, call the tool with only the "error" field set to a short, friendly message asking for the artist or a spelling check.

Recommendation rules — the payoff, so put real effort in:
- Recommend three ALBUMS to play next. Each must connect to a SPECIFIC thread from your analysis of THIS album — its arc, a recurring theme, its sound, a standout track — not a vague mood. Say the link in one short, plain sentence.
- Dig for deeper cuts. Skip the three or four most obvious, canonical picks everyone names. Recommend the record someone HASN'T already heard a hundred times.
- Range across genres and decades — don't stay in one lane. The tie is the feeling or the shape, never just the scene.
- Keep every section short and easy to read. When in doubt, cut it down.`;

const ALBUM_ANALYSIS_TOOL = {
  name: "submit_album_analysis",
  description: "Submit the finished album analysis and album recommendations.",
  input_schema: {
    type: "object",
    properties: {
      error: {
        type: "string",
        description: "Only set this if the album cannot be confidently identified — a short, friendly message asking for the artist or a spelling check. Leave empty otherwise.",
      },
      album: { type: "string", description: "Album title, corrected to the real title." },
      artist: { type: "string", description: "Artist name." },
      year: { type: "string", description: "Release year as a string, or empty if not confirmed." },
      premise: { type: "string", description: "2-3 short sentences, plain words: what this album is and what the artist was going for." },
      arc: { type: "string", description: "2-3 short sentences on how it moves from first track to last. Name the tracks that mark the turns." },
      threads: { type: "string", description: "2-3 short sentences on the ideas/images/feelings that recur across the record, pointing to specific tracks." },
      sound: { type: "string", description: "2-3 short sentences on the album's overall sound and what holds it together, in plain words." },
      why_it_lasts: { type: "string", description: "2-3 short sentences on its staying power and why people still play it. This is the closing 'Why It Lasts' section." },
      recommendations: {
        type: "array",
        description: "Exactly three ALBUM recommendations.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Album title." },
            artist: { type: "string" },
            reason: { type: "string", description: "One short, plain sentence tying this album to a specific thread from THIS album's analysis." },
          },
          required: ["title", "artist", "reason"],
        },
      },
    },
    required: [],
  },
};

function todayKey() {
  return new Date().toISOString().slice(0, 10); // e.g. "2026-07-10"
}

// A rolling memory of recommendations made recently, so the model can avoid
// suggesting the same handful over and over across separate searches. Songs
// and albums are tracked separately (different keys) so each stays varied on
// its own. Stored as a small KV key — one read + one write per analysis, cheap.
const RECENT_RECS_CAP = 45; // remember roughly the last 15 analyses' worth

function recentRecsKey(mode) {
  return mode === "album" ? "recent_recs_albums" : "recent_recs";
}

async function getRecentRecs(env, mode) {
  try {
    const raw = await env.RATE_LIMIT.get(recentRecsKey(mode));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function addRecentRecs(env, mode, recs) {
  try {
    const existing = await getRecentRecs(env, mode);
    const incoming = (recs || [])
      .map((r) => `${r.title} — ${r.artist}`)
      .filter(Boolean);
    // Newest first, de-duplicated, capped.
    const merged = [...incoming, ...existing];
    const seen = new Set();
    const deduped = [];
    for (const item of merged) {
      const k = item.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(item);
      if (deduped.length >= RECENT_RECS_CAP) break;
    }
    await env.RATE_LIMIT.put(recentRecsKey(mode), JSON.stringify(deduped), {
      expirationTtl: 60 * 60 * 24 * 30,
    });
  } catch {
    // Non-critical — never let this break the response.
  }
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

// Claude's JSON output can break in a few real-world ways: stray preamble
// text before/after the object, typographic "smart quotes" used as
// structural delimiters, literal line breaks or tabs left un-escaped inside
// a string value, un-escaped double quotes used inside prose (e.g. calling a
// word 'divine'), or a trailing comma before a closing brace/bracket. This
// walks the text once and fixes all of those before handing it to JSON.parse.
function sanitizeJsonText(raw) {
  // Strip markdown code fences.
  let text = raw.replace(/```json|```/g, "");

  // Normalize typographic quotes/apostrophes to straight ones.
  text = text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

  // Isolate just the {...} object — ignores any chit-chat Claude adds
  // before or after it (e.g. "Let me look that up" or a closing remark).
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  text = text.slice(start, end + 1);

  // Walk character-by-character. Two jobs while inside a string value:
  //  1. Escape raw control characters (a literal line break/tab is invalid
  //     JSON inside a string — it needs to be \n, \t, \r).
  //  2. Escape stray double quotes that are part of the prose rather than the
  //     closing delimiter. We decide by looking ahead: a " is only a real
  //     closing quote if the next meaningful character is , } ] or : —
  //     otherwise it's an inner quote and we escape it.
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < text.length && (text[j] === " " || text[j] === "\n" || text[j] === "\r" || text[j] === "\t")) j++;
        const nxt = text[j];
        if (j >= text.length || nxt === "," || nxt === "}" || nxt === "]" || nxt === ":") {
          inString = false; out += ch; continue; // genuine closing quote
        }
        out += '\\"'; continue;                   // inner prose quote — escape it
      }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') { inString = true; }
      out += ch;
    }
  }
  text = out;

  // Strip trailing commas before a closing } or ] — a common small slip.
  text = text.replace(/,\s*([}\]])/g, "$1");

  return text;
}

// Stores one record per query: the input the user typed and the full
// parsed result the model returned. Reuses the RATE_LIMIT KV namespace
// under a "log:" prefix so no extra binding is needed.
async function logQuery(env, { query, ip, location, mode, result }) {
  const entry = {
    query,
    ip,
    location: location || null,
    mode: mode || "song",
    timestamp: new Date().toISOString(),
    result,
  };
  const key = `log:${todayKey()}:${Date.now()}-${randomId()}`;
  try {
    // Logs are kept for 90 days, then age out automatically.
    await env.RATE_LIMIT.put(key, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 90 });
  } catch {
    // Never let a logging failure break the actual response to the user.
  }
}

// Public archive: GET /?browse=1 — returns previously-analyzed songs and
// albums so the site can show a browsable list. Deliberately strips IP
// addresses (those are private) and dedupes by mode+title+artist, keeping the
// newest analysis of each. Capped so the payload can't grow without bound.
async function handleBrowseGet(request, env, corsHeaders) {
  const BROWSE_CAP = 300;
  const raw = [];
  let cursor;
  do {
    const listResult = await env.RATE_LIMIT.list({ prefix: "log:", cursor });
    for (const k of listResult.keys) {
      const val = await env.RATE_LIMIT.get(k.name);
      if (!val) continue;
      try {
        raw.push(JSON.parse(val));
      } catch {
        // skip malformed entries
      }
    }
    cursor = listResult.cursor;
  } while (cursor);

  // Newest first, so the dedupe below keeps the most recent take on each item.
  raw.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  const seen = new Set();
  const songs = [];
  for (const e of raw) {
    const r = e.result;
    if (!r || r.error) continue;
    // Mode: prefer the entry's stored mode, fall back to the result's, then
    // infer from shape (album entries have no "song" field). Old song-only
    // entries predate the mode tag and default to song.
    const itemMode = e.mode || r.mode || (r.song ? "song" : (r.album && !r.song ? "album" : "song"));
    const title = itemMode === "album" ? r.album : r.song;
    if (!title) continue;
    const dedupeKey = `${itemMode}|${title.toLowerCase()}|${(r.artist || "").toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // Note: no IP, no raw query — only the public-safe analysis fields.
    if (itemMode === "album") {
      songs.push({
        mode: "album",
        album: r.album,
        artist: r.artist,
        year: r.year || null,
        premise: r.premise,
        arc: r.arc,
        threads: r.threads,
        sound: r.sound,
        why_it_lasts: r.why_it_lasts,
        recommendations: r.recommendations || [],
      });
    } else {
      songs.push({
        mode: "song",
        song: r.song,
        artist: r.artist,
        album: r.album || null,
        year: r.year || null,
        setup: r.setup,
        characters: r.characters,
        psychology: r.psychology,
        music: r.music,
        why_it_hits: r.why_it_hits,
        recommendations: r.recommendations || [],
      });
    }
    if (songs.length >= BROWSE_CAP) break;
  }

  // Already in newest-first (last-searched) order from the dedupe loop above.

  return json({ count: songs.length, songs }, 200, corsHeaders);
}

// Admin retrieval: GET /?key=YOUR_ADMIN_KEY (optionally &prefix=log:2026-07-12)
// Admin analytics: GET /?key=ADMIN_KEY&analytics=1 — a visual dashboard of
// approximate visitor locations (Cloudflare IP geolocation, city-level). Gated
// by ADMIN_KEY. Includes raw IPs in the recent-activity table, per request.
async function handleAnalyticsGet(request, env, corsHeaders) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response("Not authorized.", {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  // Gather all log entries.
  const entries = [];
  let cursor;
  do {
    const listResult = await env.RATE_LIMIT.list({ prefix: "log:", cursor });
    for (const k of listResult.keys) {
      const val = await env.RATE_LIMIT.get(k.name);
      if (!val) continue;
      try {
        entries.push(JSON.parse(val));
      } catch {
        // skip malformed
      }
    }
    cursor = listResult.cursor;
  } while (cursor);

  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)); // newest first

  // Aggregate.
  const byCountry = {};
  const byRegion = {};
  const byCity = {};
  const mapPoints = {}; // key -> {city, region, country, lat, lon, count}
  let withLoc = 0;

  for (const e of entries) {
    const loc = e.location || {};
    const country = loc.country || "Unknown";
    const region = loc.region || "Unknown";
    const city = loc.city || "Unknown";
    byCountry[country] = (byCountry[country] || 0) + 1;
    const regionLabel = region + (country !== "Unknown" ? ", " + country : "");
    byRegion[regionLabel] = (byRegion[regionLabel] || 0) + 1;
    const cityLabel =
      city + (region !== "Unknown" ? ", " + region : "") + (country !== "Unknown" ? ", " + country : "");
    byCity[cityLabel] = (byCity[cityLabel] || 0) + 1;
    if (loc.lat != null && loc.lon != null) {
      withLoc++;
      const pk = loc.lat.toFixed(3) + "," + loc.lon.toFixed(3);
      if (!mapPoints[pk]) {
        mapPoints[pk] = { city, region, country, lat: loc.lat, lon: loc.lon, count: 0 };
      }
      mapPoints[pk].count++;
    }
  }

  const uniqueIps = new Set(entries.map((e) => e.ip).filter(Boolean)).size;

  const sortDesc = (obj) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]);

  // Recent activity rows (cap 100) — includes raw IP per request.
  const recent = entries.slice(0, 100).map((e) => {
    const loc = e.location || {};
    const r = e.result || {};
    const title = e.mode === "album" ? r.album : r.song;
    return {
      when: e.timestamp,
      ip: e.ip || "unknown",
      where: [loc.city, loc.region, loc.country].filter(Boolean).join(", ") || "Unknown",
      mode: e.mode || "song",
      query: e.query || "",
      title: title || "",
    };
  });

  const payload = {
    total: entries.length,
    uniqueIps,
    withLoc,
    byCountry: sortDesc(byCountry),
    byRegion: sortDesc(byRegion).slice(0, 25),
    byCity: sortDesc(byCity).slice(0, 40),
    points: Object.values(mapPoints),
    recent,
  };

  // Embed data safely (avoid closing the script tag early).
  const dataJson = JSON.stringify(payload).replace(/</g, "\\u003c");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Song Lens — Visitor Analytics</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  :root{ --ink:#16215c; --bg:#0f1636; --card:#1b2450; --pop:#e8a11c; --blue:#6f83ff; --cream:#eef1ff; --muted:#9aa4d4; }
  *{box-sizing:border-box;}
  body{ margin:0; background:var(--bg); color:var(--cream); font-family:-apple-system,"Helvetica Neue",Arial,sans-serif; padding:28px 20px 60px;}
  h1{ font-size:22px; margin:0 0 2px;} .sub{ color:var(--muted); font-size:13px; margin:0 0 22px;}
  .wrap{ max-width:1000px; margin:0 auto;}
  .stats{ display:flex; gap:14px; flex-wrap:wrap; margin-bottom:22px;}
  .stat{ background:var(--card); border-radius:12px; padding:14px 18px; min-width:120px;}
  .stat .n{ font-size:26px; font-weight:700; color:var(--pop);}
  .stat .l{ font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-top:2px;}
  #map{ height:360px; border-radius:14px; margin-bottom:24px; border:2px solid var(--card);}
  .cols{ display:grid; grid-template-columns:1fr 1fr; gap:20px;}
  @media(max-width:720px){ .cols{ grid-template-columns:1fr;} }
  .panel{ background:var(--card); border-radius:12px; padding:16px 18px;}
  .panel h2{ font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 12px;}
  table{ width:100%; border-collapse:collapse; font-size:13px;}
  td{ padding:5px 4px; border-bottom:1px solid rgba(255,255,255,.07);}
  td.n{ text-align:right; color:var(--pop); font-variant-numeric:tabular-nums; width:52px;}
  .bar{ height:6px; background:var(--blue); border-radius:3px; margin-top:3px;}
  .full{ grid-column:1/-1;}
  .recent td{ font-size:12px; color:var(--cream);}
  .recent .ip{ color:var(--muted); font-family:monospace; font-size:11px;}
  .recent .tag{ font-size:9px; font-weight:700; padding:1px 6px; border-radius:5px;}
  .tag.song{ background:var(--blue); color:#fff;} .tag.album{ background:var(--pop); color:var(--ink);}
  .muted{ color:var(--muted);}
</style></head><body><div class="wrap">
  <h1>Song Lens — Visitor Analytics</h1>
  <p class="sub">Approximate, IP-based locations from Cloudflare. City-level, not exact. Refreshes on reload.</p>
  <div class="stats" id="stats"></div>
  <div id="map"></div>
  <div class="cols">
    <div class="panel"><h2>Top Cities</h2><table id="cities"></table></div>
    <div class="panel"><h2>Top Regions</h2><table id="regions"></table></div>
    <div class="panel full"><h2>By Country</h2><table id="countries"></table></div>
    <div class="panel full"><h2>Recent Activity (newest first)</h2><table class="recent" id="recent"></table></div>
  </div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const D = ${dataJson};
function esc(s){ const d=document.createElement('div'); d.textContent=(s==null?'':String(s)); return d.innerHTML; }
// Stats
document.getElementById('stats').innerHTML = [
  ['Total searches', D.total],
  ['Unique IPs', D.uniqueIps],
  ['With location', D.withLoc],
  ['Cities', D.byCity.length],
  ['Countries', D.byCountry.length],
].map(function(s){ return '<div class="stat"><div class="n">'+s[1]+'</div><div class="l">'+s[0]+'</div></div>'; }).join('');
// Tables
function fillTable(id, rows){
  var max = rows.length ? rows[0][1] : 1;
  document.getElementById(id).innerHTML = rows.map(function(r){
    var pct = Math.max(4, Math.round(r[1]/max*100));
    return '<tr><td>'+esc(r[0])+'<div class="bar" style="width:'+pct+'%"></div></td><td class="n">'+r[1]+'</td></tr>';
  }).join('') || '<tr><td class="muted">No data yet.</td></tr>';
}
fillTable('cities', D.byCity);
fillTable('regions', D.byRegion);
fillTable('countries', D.byCountry);
// Recent
document.getElementById('recent').innerHTML = D.recent.map(function(e){
  var t = new Date(e.when).toLocaleString();
  return '<tr>'+
    '<td class="muted">'+esc(t)+'</td>'+
    '<td><span class="tag '+(e.mode==='album'?'album':'song')+'">'+(e.mode==='album'?'LP':'7\\u2033')+'</span></td>'+
    '<td>'+esc(e.query)+'</td>'+
    '<td>'+esc(e.where)+'</td>'+
    '<td class="ip">'+esc(e.ip)+'</td>'+
  '</tr>';
}).join('') || '<tr><td class="muted">No activity yet.</td></tr>';
// Map (degrades gracefully if Leaflet fails to load)
try{
  if (window.L){
    var map = L.map('map',{worldCopyJump:true}).setView([25,0],2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{
      attribution:'&copy; OpenStreetMap &copy; CARTO', maxZoom:19
    }).addTo(map);
    var maxC = D.points.reduce(function(m,p){ return Math.max(m,p.count); },1);
    D.points.forEach(function(p){
      var radius = 6 + Math.round((p.count/maxC)*18);
      L.circleMarker([p.lat,p.lon],{
        radius:radius, color:'#e8a11c', fillColor:'#e8a11c', fillOpacity:.5, weight:1.5
      }).addTo(map).bindPopup('<b>'+esc([p.city,p.region,p.country].filter(Boolean).join(', '))+'</b><br>'+p.count+' search'+(p.count===1?'':'es'));
    });
  } else {
    document.getElementById('map').innerHTML = '<div style="padding:20px;color:#9aa4d4">Map unavailable (couldn\\'t load map library). Location tables below still work.</div>';
  }
}catch(err){
  document.getElementById('map').style.display='none';
}
</script></body></html>`;

  return new Response(html, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

// Last-resort recovery: if the tool call fails AND the JSON sanitizer fails,
// try to pull fields out of XML-style tagged text like
// "<premise>...</premise><arc>...</arc>...". This is exactly the shape Claude
// sometimes emits when it writes the structure as prose instead of calling the
// tool. Returns a partial result object, or null if nothing usable is found.
function recoverFromTaggedText(text, fields) {
  if (!text) return null;
  const out = {};
  let hits = 0;
  for (const f of fields) {
    const m = text.match(new RegExp("<" + f + "[^>]*>([\\s\\S]*?)<\\/" + f + ">", "i"));
    if (m && m[1].trim()) {
      out[f] = m[1].trim();
      hits++;
    }
  }
  // Recommendations often appear as a JSON array inside <recommendations>…</…>.
  const recM = text.match(/<recommendations[^>]*>([\s\S]*?)<\/recommendations>/i);
  if (recM) {
    const am = recM[1].match(/\[[\s\S]*\]/); // grab the [...] array
    if (am) {
      try {
        const arr = JSON.parse(am[0]);
        if (Array.isArray(arr)) { out.recommendations = arr; hits++; }
      } catch {
        // leave recommendations unset if it won't parse
      }
    }
  }
  return hits > 0 ? out : null;
}

async function handleAdminGet(request, env, corsHeaders) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return json({ error: "Not authorized." }, 401, corsHeaders);
  }

  const prefix = url.searchParams.get("prefix") || "log:";
  const entries = [];
  let cursor;
  do {
    const listResult = await env.RATE_LIMIT.list({ prefix, cursor });
    for (const k of listResult.keys) {
      const val = await env.RATE_LIMIT.get(k.name);
      if (val) {
        try {
          entries.push(JSON.parse(val));
        } catch {
          // skip malformed entries
        }
      }
    }
    cursor = listResult.cursor;
  } while (cursor);

  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)); // newest first

  return json({ count: entries.length, entries }, 200, corsHeaders);
}

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.has("browse")) {
        return handleBrowseGet(request, env, corsHeaders);
      }
      if (url.searchParams.has("analytics")) {
        return handleAnalyticsGet(request, env, corsHeaders);
      }
      return handleAdminGet(request, env, corsHeaders);
    }
    if (request.method !== "POST") {
      return json({ error: "This endpoint only accepts POST." }, 405, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Malformed request." }, 400, corsHeaders);
    }

    const query = (body.query || "").toString().trim();
    const mode = body.mode === "album" ? "album" : "song";
    const noun = mode === "album" ? "album" : "song";
    if (!query) {
      return json({ error: `Give me ${mode === "album" ? "an album" : "a song"} title (and artist, if you've got it).` }, 400, corsHeaders);
    }
    if (query.length > 120) {
      return json({ error: `That's too long — just the ${noun} title and artist, please.` }, 400, corsHeaders);
    }

    // ---- Rate limiting: per-IP + global daily caps, enforced server-side ----
    const day = todayKey();
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipKey = `ip:${ip}:${day}`;
    const globalKey = `global:${day}`;

    // Approximate visitor location, provided by Cloudflare (IP-based, coarse —
    // city/region level, not an exact address). Logged alongside the raw IP.
    const cf = request.cf || {};
    const location = {
      city: cf.city || null,
      region: cf.region || null,
      country: cf.country || null,
      lat: cf.latitude != null ? Number(cf.latitude) : null,
      lon: cf.longitude != null ? Number(cf.longitude) : null,
    };

    const [ipCountRaw, globalCountRaw] = await Promise.all([
      env.RATE_LIMIT.get(ipKey),
      env.RATE_LIMIT.get(globalKey),
    ]);
    const ipCount = parseInt(ipCountRaw || "0", 10);
    const globalCount = parseInt(globalCountRaw || "0", 10);

    if (globalCount >= GLOBAL_DAILY_LIMIT) {
      return json(
        { error: "This tool has hit its daily limit across all visitors. Try again tomorrow." },
        429,
        corsHeaders
      );
    }
    if (ipCount >= PER_IP_DAILY_LIMIT) {
      return json(
        { error: "You've hit today's limit for this tool. Try again tomorrow." },
        429,
        corsHeaders
      );
    }

    // Reserve the slot before calling the model, so parallel requests can't sneak past the cap.
    await Promise.all([
      env.RATE_LIMIT.put(ipKey, String(ipCount + 1), { expirationTtl: 60 * 60 * 26 }),
      env.RATE_LIMIT.put(globalKey, String(globalCount + 1), { expirationTtl: 60 * 60 * 26 }),
    ]);

    // Pull the recently-recommended items for THIS mode so we can ask the
    // model to avoid repeating them across separate searches.
    const recentRecs = await getRecentRecs(env, mode);
    let userContent =
      (mode === "album" ? "Album to analyze: " : "Song to analyze: ") + query;
    if (recentRecs.length > 0) {
      userContent +=
        `\n\nThe following ${mode === "album" ? "albums have" : "songs have"} already been recommended recently on this site. Do NOT recommend any of them again — pick different ${mode === "album" ? "albums" : "songs"} so visitors keep discovering new music:\n` +
        recentRecs.map((s) => "- " + s).join("\n");
    }

    // Pick the prompt + tool for this mode.
    const activePrompt = mode === "album" ? ALBUM_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const activeTool = mode === "album" ? ALBUM_ANALYSIS_TOOL : ANALYSIS_TOOL;
    const activeToolName = activeTool.name;

    // One call to Anthropic. Returns the parsed tool input, or null if the
    // model didn't produce a usable structured tool call this time.
    const callModel = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 35000);
      let res;
      try {
        res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-5",
            max_tokens: 2048,
            system: activePrompt,
            messages: [{ role: "user", content: userContent }],
            // No web search: Claude answers from its own knowledge. With no
            // server tool present we FORCE the analysis tool, which normally
            // guarantees a clean structured object.
            tools: [activeTool],
            tool_choice: { type: "tool", name: activeToolName },
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!res.ok) return { httpError: res.status };
      const data = await res.json();
      const blocks = data.content || [];
      const toolBlock = blocks.find(
        (b) => b.type === "tool_use" && b.name === activeToolName
      );
      if (toolBlock && toolBlock.input && typeof toolBlock.input === "object" && Object.keys(toolBlock.input).length > 0) {
        return { parsed: toolBlock.input };
      }
      // No clean tool call — hand back the raw text for fallback recovery.
      const textBlocks = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { text: textBlocks };
    };

    let parsed = null;
    let lastText = "";
    try {
      // First attempt.
      let out = await callModel();
      if (out.httpError) {
        return json({ error: "Upstream error while analyzing." }, 502, corsHeaders);
      }
      if (out.parsed) {
        parsed = out.parsed;
      } else {
        // The forced tool call didn't come back clean. Retry once — this alone
        // recovers the large majority of these cases.
        lastText = out.text || "";
        let retry = await callModel();
        if (retry.parsed) {
          parsed = retry.parsed;
        } else if (retry.text) {
          lastText = retry.text;
        }
      }
    } catch (e) {
      if (e && e.name === "AbortError") {
        return json({ error: "That took too long. Try again — it usually goes faster the second time." }, 504, corsHeaders);
      }
      return json({ error: "Couldn't reach the analysis service. Try again in a bit." }, 502, corsHeaders);
    }

    // Fallbacks if both attempts failed to yield a clean tool call:
    // 1) try to parse the text as JSON; 2) try to recover XML-style tagged
    // fields into their proper slots (never dump everything into one field).
    if (!parsed && lastText) {
      try {
        const cleaned = sanitizeJsonText(lastText);
        if (cleaned) parsed = JSON.parse(cleaned);
      } catch {
        parsed = null;
      }
    }
    if (!parsed && lastText) {
      const fields =
        mode === "album"
          ? ["error", "album", "artist", "year", "premise", "arc", "threads", "sound", "why_it_lasts"]
          : ["error", "song", "artist", "album", "year", "setup", "characters", "psychology", "music", "why_it_hits"];
      parsed = recoverFromTaggedText(lastText, fields);
    }

    if (!parsed) {
      return json({ error: "Got a response but couldn't read it. Try again." }, 502, corsHeaders);
    }

    // Tag the result with its mode so the frontend and the archive know how
    // to render it (song sections vs album sections).
    parsed.mode = mode;

    // The tool schema uses empty strings for unknown album/year; normalize
    // those to null so the frontend's "hide if empty" logic works cleanly.
    if (parsed.album === "") parsed.album = null;
    if (parsed.year === "") parsed.year = null;

    // If Claude couldn't identify the song/album, it sets the error field.
    // Surface that as an error response rather than an empty analysis.
    if (parsed.error && String(parsed.error).trim()) {
      return json({ error: String(parsed.error).trim() }, 200, corsHeaders);
    }

    // Remember these recommendations (per mode) so future searches vary.
    if (parsed && Array.isArray(parsed.recommendations)) {
      await addRecentRecs(env, mode, parsed.recommendations);
    }

    // Fire-and-forget logging — don't block or fail the response on this.
    await logQuery(env, { query, ip, location, mode, result: parsed });

    return json(parsed, 200, corsHeaders);
  },
};

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}