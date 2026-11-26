// One-off helper: builds the Drive rename/move plan for TV shows.
// Load in the site page console: eval(await fetch('tools/plan.js?'+Date.now()).then(r=>r.text()))
(function () {
  const CARTOON = '1pKMkMbYEBMtO3BRBjUtO5VD-bN0cVmZo', ANIME = '1sjw7eip_hLt0OWH2SHaAXWTF300vFeFB', REVIEW = '1JFe87yBEIeeYdrK4QSq4tdH1Ye1joGVm';
  const pad = n => String(n).padStart(2, '0');
  const san = t => String(t).replace(/:\s*/g, ' - ').replace(/\//g, ' + ').replace(/[\\*?"<>|]/g, '').replace(/\s{2,}/g, ' ').trim();
  const contain = (a0, b0) => { const a = [...new Set(titleTokens(a0))], b = new Set(titleTokens(b0)); return a.length ? a.filter(w => b.has(w)).length / a.length : 1; };
  const normFile = f => f.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/\(\d\)$/, '').replace(/[^a-z0-9]/g, '');

  window.__plan = { ops: [], showFolders: {}, report: [] };
  window.__dups = {}; window.__names = {};

  window.__planShow = async function (show) {
    const root = (show.category || []).includes('Anime') ? ANIME : CARTOON;
    const details = await tmdbShowDetails(show);
    currentShow = show;
    if (details) await loadAllTmdbSeasons(details);
    const sw = showWordSet(show.title);
    const ownTok = n => titleTokens(n).filter(w => !sw.has(w));
    const base = san((show.tmdbQuery || show.title).replace(/\s*\(\d{4}\)\s*$/, ''));
    const year = details && details.first_air_date ? details.first_air_date.slice(0, 4) : show.year;
    const folder = `${base} (${year})`;
    __plan.showFolders[show.id] = { r: root, n: folder };

    const eps = [];
    for (const fid of show.folders) {
      const acc = []; await collectVideos(fid, [], acc, 0);
      const inc = show.include ? new RegExp(show.include, 'i') : null, exc = show.exclude ? new RegExp(show.exclude, 'i') : null;
      acc.forEach(f => { const full = f.path.join('/') + '/' + f.name; if (inc && !inc.test(full)) return; if (exc && exc.test(full)) return; eps.push(parseEpisode(f, '', show)); });
    }

    // Duplicates: numbered episodes need same numbers + similar titles; unnumbered need same file name or near-identical size
    const groups = new Map(), losers = new Set(), dupOf = new Map();
    for (const ep of eps) {
      const k = (!ep.extra && ep.e != null) ? `${ep.s}-${ep.e}-${ep.e2 || ''}-${ep.part || ''}` : 'x:' + (ep.name || ep.file).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!groups.has(k)) groups.set(k, []); groups.get(k).push(ep);
    }
    for (const [k, list] of groups) {
      list.sort((a, b) => b.size - a.size); const kept = [];
      for (const ep of list) {
        const twin = k.startsWith('x:')
          ? kept.find(q => normFile(q.file) === normFile(ep.file) || Math.abs(q.size - ep.size) / Math.max(q.size, 1) < 0.02)
          : kept.find(q => (ownTok(q.name).length && ownTok(ep.name).length)
              ? titleScore(ep.name, q.name) >= 0.5
              : Math.abs(q.size - ep.size) / Math.max(q.size, 1) < 0.15);
        if (twin) { losers.add(ep); dupOf.set(ep, twin); } else kept.push(ep);
      }
    }

    const used = new Set(), codeTaken = new Map(); let kept = 0, dup = 0;
    __dups[show.id] = []; __names[show.id] = [];
    for (const ep of eps.filter(e => losers.has(e))) {
      __plan.ops.push({ t: 'f', id: ep.id, r: REVIEW, p: ['Duplicate episodes', folder], n: ep.file });
      __dups[show.id].push(ep.file + ' == ' + dupOf.get(ep).file); dup++;
    }
    const order = eps.filter(e => !losers.has(e)).sort((a, b) => naturalCmp(a.path.join('/') + '/' + a.file, b.path.join('/') + '/' + b.file));
    for (const ep of order) {
      const ext = (ep.file.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
      const gkey = ep.extra ? 'extras' : (ep.s != null || ep.e != null) ? 's' : (ep.path.length ? 'f' : 's');
      let path, name;
      if (gkey === 's') {
        const sNum = ep.s ?? 1;
        const sd = details ? tmdbSeasonCache[details.id + '-' + sNum] : null;
        const t = tmdbEpisode(sd, ep);
        const own = ownTok(ep.name).length > 0;
        const useT = t && (!own || contain(ep.name, t.name) >= 0.85);
        const multi = t && /\s\/\s|;/.test(t.name);
        const partTag = ep.part || '';
        const fileNums = (show.numbering === 'file' || ep.explicit) && ep.e != null;
        let s, e, e2, title;
        if (fileNums) {
          s = sNum; e = ep.e; e2 = ep.e2;
          title = (useT && !multi && !ep.part && show.numbering !== 'file') ? t.name : (own ? ep.name : (t ? t.name : ''));
        } else if (useT && !codeTaken.has(`${t.season_number}-${t.episode_number}${partTag}`)) {
          s = t.season_number; e = t.episode_number; e2 = (ep.e2 && ep.e != null) ? e + (ep.e2 - ep.e) : null;
          title = (multi || ep.part) && own ? ep.name : t.name;
          codeTaken.set(`${s}-${e}${partTag}`, ep);
        } else { s = sNum; e = ep.e; e2 = ep.e2; title = own ? ep.name : ''; }
        if (!title) title = e != null ? `Episode ${e}` : (ep.name || ep.file.replace(/\.[a-z0-9]+$/i, ''));
        const code = e != null ? `S${pad(s)}E${pad(e)}${partTag}${e2 ? '-E' + pad(e2) : ''}` : `S${pad(s)}`;
        path = [folder, s === 0 ? 'Specials' : `Season ${pad(s)}`];
        name = `${base} - ${code} - ${san(title)}${ext}`;
      } else {
        const sub = gkey === 'extras' ? null : cleanFolderLabel(ep.path[ep.path.length - 1]);
        path = sub ? [folder, 'Extras', san(sub)] : [folder, 'Extras'];
        name = `${base} - ${san(ep.name || ep.file.replace(/\.[a-z0-9]+$/i, ''))}${ext}`;
      }
      let n = name, full = path.join('/') + '/' + n, k = 2;
      while (used.has(full.toLowerCase())) { n = name.replace(/(\.[a-z0-9]+)$/i, ` (${k++})$1`); full = path.join('/') + '/' + n; }
      used.add(full.toLowerCase());
      __plan.ops.push({ t: 'f', id: ep.id, r: root, p: path, n });
      __names[show.id].push(path.slice(1).join('/') + '/' + n + '  <=  ' + ep.file);
      kept++;
    }
    currentShow = null;
    const line = `${show.id} ${folder}: ${kept} kept, ${dup} dup`;
    __plan.report.push(line); return line;
  };
  window.__shows = movies.filter(m => m.isShow);
})();
