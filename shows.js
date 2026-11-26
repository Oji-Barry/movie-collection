// ── TV shows: live season/episode lists from Google Drive + TMDB details ──────
// Each show in shows.json lists one or more Drive folders. When a show is
// opened, its folders are read live (so new episodes appear automatically),
// seasons and episode numbers are worked out from folder and file names, and
// episode names, stills and summaries come from TMDB.

const DRIVE_KEY = 'AIzaSyDfsODhvu3KOgFniJwbx9GetGHz5ES53Hs';
const VIDEO_EXT = /\.(mkv|avi|mp4|m4v|mov|wmv|mpe?g|ts|divx|flv|webm|ogm|rmvb|vob)$/i;
const EXTRA_RE = /\b(extras?|bonus|featurettes?|behind[ ._-]the[ ._-]scenes|backgrounds|example[ ._-]clips|deleted[ ._-]scenes|commentar(y|ies)|trailers?|promos?|shorties|interviews?|sneak[ ._-]peeks?)\b/i;

const showStructCache = {};   // show id -> {seasons:[...], total}
const tmdbShowCache = {};     // show id -> tmdb details (or null)
const tmdbSeasonCache = {};   // tmdbId-season -> season data (or null)
let currentShow = null;       // show object open in the banner
let currentEp = null;         // {k, j} selected episode
let openSeasons = new Set();

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── Drive ─────────────────────────────────────────────────────────────────────
async function driveList(folderId) {
  const out = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size)&pageSize=1000&key=${DRIVE_KEY}` + (pageToken ? `&pageToken=${pageToken}` : '');
    const r = await fetch(url);
    if (!r.ok) throw new Error('Drive ' + r.status);
    const d = await r.json();
    out.push(...(d.files || []));
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  return out;
}

async function collectVideos(folderId, path, acc, depth) {
  if (depth > 6) return;
  const items = await driveList(folderId);
  const subs = [];
  for (const f of items) {
    if (f.mimeType === 'application/vnd.google-apps.folder') subs.push(f);
    else if ((f.mimeType || '').startsWith('video/') || VIDEO_EXT.test(f.name)) {
      acc.push({ id: f.id, name: f.name, size: +f.size || 0, path });
    }
  }
  await Promise.all(subs.map(s => collectVideos(s.id, [...path, s.name], acc, depth + 1)));
}

// ── File name parsing ─────────────────────────────────────────────────────────
function seasonFromText(t) {
  const m = t.match(/season[ ._-]*(\d{1,2})|series[ ._-]*(\d{1,2})|(?:^|[^a-z0-9])s(\d{1,2})(?:[^a-z0-9e]|$)|volume[ ._-]*(\d{1,2})|vol\.?[ ._-]*(\d{1,2})/i);
  if (!m) return null;
  return +(m[1] || m[2] || m[3] || m[4] || m[5]);
}

function cleanEpName(n, showTitle) {
  let t = n.replace(VIDEO_EXT, '')
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
    .replace(/s\d{1,2}[ ._-]*e\d{1,3}([ ._-]*(e|-)\d{1,3})?/ig, ' ')
    .replace(/\b\d{1,2}x\d{1,3}\b/ig, ' ')
    .replace(/\b(xvid|divx|x264|x265|h264|h265|hevc|dvdrip|dvd|bdrip|brrip|bluray|web-?dl|webrip|hdtv|720p|1080p|480p|aac|ac3|mp3|snek|repack|proper)\b/ig, ' ')
    .replace(/[._]+/g, ' ');
  const words = (showTitle || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter(w => w.length > 2);
  if (words.length) {
    const re = new RegExp('^\\s*(the\\s+)?' + words.join('[\\s\\-]*'), 'i');
    t = t.replace(re, ' ');
  }
  t = t.replace(/^[\s\-–:#]*\d{1,3}[a-z]?\b[\s\-–:.]*/i, '').replace(/\s{2,}/g, ' ').replace(/^[\s\-–:]+|[\s\-–:]+$/g, '');
  return t.replace(/\b\w/g, c => c.toUpperCase()) || n.replace(VIDEO_EXT, '');
}

function parseEpisode(file, rootName, show) {
  const n = file.name.replace(VIDEO_EXT, '');
  const ctx = [rootName, ...file.path];
  const extra = [...file.path, n].some(x => EXTRA_RE.test(x));
  let s = null, e = null, e2 = null, m;
  if ((m = n.match(/s(\d{1,2})[ ._-]*e(\d{1,3})(?:[ ._-]*(?:e|-)[ ._-]*e?(\d{1,3}))?/i))) {
    s = +m[1]; e = +m[2]; e2 = m[3] ? +m[3] : null;
  } else if ((m = n.match(/(?:^|[^\d])(\d{1,2})x(\d{1,3})(?:\s*(?:&|-)\s*(?:\d{1,2}x)?(\d{1,3}))?/i))) {
    s = +m[1]; e = +m[2]; e2 = m[3] ? +m[3] : null;
  }
  if (s == null) {
    for (const p of [...ctx].reverse()) { const v = seasonFromText(p); if (v != null) { s = v; break; } }
  }
  if (e == null) {
    if ((m = n.match(/(?:\bep(?:isode)?\.?[ ._-]*|#)(\d{1,3})\b/i))) e = +m[1];
    else if ((m = n.match(/^(\d{1,4})(?:[a-z]\b|[^\d]|$)/i))) {
      const v = m[1];
      if (v.length >= 3 && (s == null || +v.slice(0, v.length - 2) === s)) { s = s ?? +v.slice(0, v.length - 2); e = +v.slice(-2); }
      else if (v.length <= 3) e = +v;
    } else if ((m = n.match(/[ ._-](\d{1,3})[ ._-]/))) e = +m[1];
  }
  return { id: file.id, size: file.size, file: file.name, path: file.path, s, e, e2, extra, name: cleanEpName(file.name, show.title) };
}

function naturalCmp(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }

async function buildShowStructure(show) {
  if (showStructCache[show.id]) return showStructCache[show.id];
  const key = 'showStruct:' + show.id + ':' + show.folders.join(',');
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (cached) { showStructCache[show.id] = cached; return cached; }
  } catch (e) {}

  const eps = [];
  for (const fid of show.folders) {
    const acc = [];
    await collectVideos(fid, [], acc, 0);
    acc.forEach(f => eps.push(parseEpisode(f, '', show)));
  }

  // Group into seasons
  const groups = new Map();
  const addTo = (key, label, num, ep) => {
    if (!groups.has(key)) groups.set(key, { key, label, num, eps: [] });
    groups.get(key).eps.push(ep);
  };
  for (const ep of eps) {
    if (ep.extra) addTo('extras', 'Extras', 999, ep);
    else if (ep.s != null) addTo('s' + ep.s, ep.s === 0 ? 'Specials' : 'Season ' + ep.s, ep.s, ep);
    else if (ep.path.length) addTo('f:' + ep.path[0], ep.path[0], 500, ep);
    else addTo('s1', 'Season 1', 1, ep);
  }

  const seasons = [...groups.values()].sort((a, b) => a.num - b.num || naturalCmp(a.label, b.label));
  for (const g of seasons) {
    // Duplicates (same season + episode from two folders): keep the larger file
    const best = new Map(), loose = [];
    for (const ep of g.eps) {
      if (ep.e == null || g.key === 'extras') { loose.push(ep); continue; }
      const k = ep.e + '-' + (ep.e2 || '');
      if (!best.has(k) || ep.size > best.get(k).size) best.set(k, ep);
    }
    g.eps = [...best.values(), ...loose].sort((a, b) =>
      (a.e ?? 1e9) - (b.e ?? 1e9) || naturalCmp(a.path.join('/') + a.file, b.path.join('/') + b.file));
    g.tmdbSeason = (g.key.startsWith('s') ? g.num : null);
  }
  const total = seasons.reduce((n, g) => n + g.eps.length, 0);
  const result = { seasons, total };
  showStructCache[show.id] = result;
  try { sessionStorage.setItem(key, JSON.stringify(result)); } catch (e) {}
  return result;
}

// ── TMDB ──────────────────────────────────────────────────────────────────────
async function tmdbShowDetails(show) {
  if (show.id in tmdbShowCache) return tmdbShowCache[show.id];
  let id = show.tmdbId;
  try {
    if (!id) {
      const tryQ = async y => {
        const r = await fetch(`https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(show.tmdbQuery || show.title)}${y ? `&first_air_date_year=${y}` : ''}&api_key=${TMDB_KEY}`);
        const d = await r.json();
        return d.results && d.results[0] ? d.results[0].id : null;
      };
      id = await tryQ(show.year) || await tryQ(null);
    }
    if (!id) { tmdbShowCache[show.id] = null; return null; }
    const r = await fetch(`https://api.themoviedb.org/3/tv/${id}?append_to_response=credits&api_key=${TMDB_KEY}`);
    const d = r.ok ? await r.json() : null;
    tmdbShowCache[show.id] = d;
    return d;
  } catch (e) { tmdbShowCache[show.id] = null; return null; }
}

async function tmdbSeason(tmdbId, n) {
  const k = tmdbId + '-' + n;
  if (k in tmdbSeasonCache) return tmdbSeasonCache[k];
  try {
    const r = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${n}?api_key=${TMDB_KEY}`);
    tmdbSeasonCache[k] = r.ok ? await r.json() : null;
  } catch (e) { tmdbSeasonCache[k] = null; }
  return tmdbSeasonCache[k];
}

function tmdbEpisode(seasonData, ep) {
  if (!seasonData || !seasonData.episodes || ep.e == null) return null;
  return seasonData.episodes.find(x => x.episode_number === ep.e) || null;
}

// ── Banner: show view ─────────────────────────────────────────────────────────
async function openShow(show) {
  currentShow = show; currentEp = null; openSeasons = new Set();
  const banner = document.getElementById('banner');
  banner.classList.add('show-mode');
  document.getElementById('bannerCovers').innerHTML = '<div class="poster-loading">Loading...</div>';
  document.getElementById('bannerInfo').innerHTML = '';
  document.getElementById('bannerActions').innerHTML = '';

  const [details] = await Promise.all([tmdbShowDetails(show), renderSeasonListShell()]);
  if (currentShow !== show) return;
  renderShowOverview(show, details);
  loadSeasons(show);
}

function renderSeasonListShell() { return Promise.resolve(); }

function showPoster(details, show) {
  if (show.image) return show.image;
  return details && details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null;
}

function renderShowOverview(show, details) {
  const poster = showPoster(details, show);
  document.getElementById('bannerBg').style.backgroundImage = poster ? `url('${poster}')` : '';
  document.getElementById('bannerCovers').innerHTML = poster
    ? `<img class="banner-cover" src="${poster}" alt="${esc(show.title)}" onclick="openLightbox('${poster}')">`
    : '<div class="poster-loading">No poster found</div>';
  const cast = details && details.credits && details.credits.cast ? details.credits.cast.slice(0, 4).map(c => c.name).join(', ') : '';
  const genres = (details && details.genres && details.genres.length ? details.genres.map(g => g.name) : show.genre || []).slice(0, 3);
  const plot = show.plot || (details && details.overview) || '';
  const years = details && details.first_air_date
    ? details.first_air_date.slice(0, 4) + (details.last_air_date && details.last_air_date.slice(0, 4) !== details.first_air_date.slice(0, 4) ? '–' + details.last_air_date.slice(0, 4) : '')
    : String(show.year || '');
  const struct = showStructCache[show.id];
  document.getElementById('bannerInfo').innerHTML = `
    <div class="banner-kicker">TV Series · ${esc(years)} · ${esc(show.rating || '')}</div>
    <div class="banner-title">${esc(show.title)}</div>
    ${cast ? `<div class="banner-cast">${esc(cast)}</div>` : ''}
    ${genres.length ? `<div class="banner-genres">${genres.map(g => `<span class="banner-genre-chip">${esc(g)}</span>`).join('')}</div>` : ''}
    ${plot ? `<div class="banner-plot-wrap"><div class="banner-plot show-plot" id="bannerPlotText">${esc(plot)}</div></div>` : ''}
    <div class="season-list" id="seasonList">${struct ? '' : '<div class="season-loading">Loading episodes from Drive…</div>'}</div>`;
  document.getElementById('bannerActions').innerHTML =
    (show.imdb ? `<a class="banner-link" href="${show.imdb}" target="_blank">View on IMDb ↗</a>` : '');
  if (struct) renderSeasonList(show);
}

async function loadSeasons(show) {
  try {
    await buildShowStructure(show);
  } catch (e) {
    const el = document.getElementById('seasonList');
    if (el && currentShow === show) el.innerHTML = `<div class="season-loading">Couldn't read this show's folders from Drive (${esc(e.message)}).</div>`;
    return;
  }
  if (currentShow !== show) return;
  renderSeasonList(show);
}

function renderSeasonList(show) {
  const el = document.getElementById('seasonList');
  const struct = showStructCache[show.id];
  if (!el || !struct) return;
  if (!struct.total) { el.innerHTML = '<div class="season-loading">No episodes found in this show\'s folders.</div>'; return; }
  el.innerHTML = struct.seasons.map((g, k) => `
    <div class="season${openSeasons.has(k) ? ' open' : ''}" id="season-${k}">
      <button class="season-head" onclick="toggleSeason(${k})">
        <span class="season-name">${esc(g.label)}</span>
        <span class="season-count">${g.eps.length} episode${g.eps.length !== 1 ? 's' : ''}</span>
        <span class="season-caret">▾</span>
      </button>
      <div class="ep-list" id="eplist-${k}">${openSeasons.has(k) ? episodeRows(g, k) : ''}</div>
    </div>`).join('');
}

function epCode(ep) {
  if (ep.e == null) return '';
  return 'E' + String(ep.e).padStart(2, '0') + (ep.e2 ? '–' + String(ep.e2).padStart(2, '0') : '');
}

function episodeRows(g, k) {
  const details = tmdbShowCache[currentShow.id];
  const sd = details && g.tmdbSeason != null ? tmdbSeasonCache[details.id + '-' + g.tmdbSeason] : null;
  return g.eps.map((ep, j) => {
    const t = tmdbEpisode(sd, ep);
    const sel = currentEp && currentEp.k === k && currentEp.j === j;
    return `<button class="ep-row${sel ? ' selected' : ''}" onclick="selectEpisode(${k},${j})">
      <span class="ep-num">${epCode(ep) || (j + 1)}</span>
      <span class="ep-name">${esc(t && t.name ? t.name : ep.name)}</span>
    </button>`;
  }).join('');
}

async function toggleSeason(k) {
  const show = currentShow;
  const g = showStructCache[show.id].seasons[k];
  const box = document.getElementById('season-' + k);
  if (openSeasons.has(k)) { openSeasons.delete(k); box.classList.remove('open'); return; }
  openSeasons.add(k); box.classList.add('open');
  document.getElementById('eplist-' + k).innerHTML = episodeRows(g, k);
  const details = await tmdbShowDetails(show);
  if (details && g.tmdbSeason != null) {
    await tmdbSeason(details.id, g.tmdbSeason);
    if (currentShow === show && openSeasons.has(k)) document.getElementById('eplist-' + k).innerHTML = episodeRows(g, k);
  }
}

async function selectEpisode(k, j) {
  const show = currentShow;
  const g = showStructCache[show.id].seasons[k];
  const ep = g.eps[j];
  currentEp = { k, j };
  const details = await tmdbShowDetails(show);
  const sd = details && g.tmdbSeason != null ? await tmdbSeason(details.id, g.tmdbSeason) : null;
  if (currentShow !== show) return;
  const t = tmdbEpisode(sd, ep);
  const title = t && t.name ? t.name : ep.name;
  const still = t && t.still_path ? `https://image.tmdb.org/t/p/w780${t.still_path}` : null;
  const poster = showPoster(details, show);

  document.getElementById('bannerCovers').innerHTML = still
    ? `<img class="banner-still" src="${still}" alt="${esc(title)}" onclick="openLightbox('${still}')">`
    : (poster ? `<img class="banner-cover" src="${poster}" alt="${esc(show.title)}">` : '<div class="poster-loading">No image</div>');

  const code = (g.tmdbSeason != null ? 'S' + String(g.tmdbSeason).padStart(2, '0') : esc(g.label) + ' · ') + (epCode(ep) || '');
  const air = t && t.air_date ? ' · ' + t.air_date : '';
  const plot = t && t.overview ? t.overview : '';
  const info = document.getElementById('bannerInfo');
  const list = document.getElementById('seasonList');
  info.innerHTML = `
    <div class="banner-kicker"><a href="javascript:void(0)" onclick="backToShow()">${esc(show.title)}</a> · ${code}${esc(air)}</div>
    <div class="banner-title ep-title">${esc(title)}</div>
    ${plot ? `<div class="banner-plot-wrap"><div class="banner-plot show-plot" id="bannerPlotText">${esc(plot)}</div></div>`
           : `<div class="ep-noplot">No episode summary found.</div>`}
    <div class="season-list" id="seasonList"></div>`;
  renderSeasonList(show);
  const sel = document.querySelector('.ep-row.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });

  const watchUrl = `watch.html?file=${encodeURIComponent(ep.id)}&title=${encodeURIComponent(title)}&sub=${encodeURIComponent(show.title + ' · ' + code.replace(/ · $/, ''))}`;
  document.getElementById('bannerActions').innerHTML = `
    <button class="edit-btn" onclick="backToShow()">← Show info</button>
    <a class="play-btn" href="${watchUrl}" target="_blank">▶ Play episode</a>`;
}

function backToShow() {
  currentEp = null;
  renderShowOverview(currentShow, tmdbShowCache[currentShow.id]);
}
