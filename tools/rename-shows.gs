// Moves and renames TV show episodes in Øjì's Drive according to show-plan.json.
// Run runPlan(). It processes as many files as it can in ~5 minutes and remembers
// where it stopped, so just run it again until the log says DONE.
const PLAN_URL = 'https://oji-barry.github.io/movie-collection/tools/show-plan.json';
const SHOWS_FOLDER = '1WYtTmy-ZqWfj3KEITl__EaZDYnegRUIA';
const LIMIT_MS = 5 * 60 * 1000;
const BATCH = 25;

function runPlan() {
  const props = PropertiesService.getScriptProperties();
  const plan = JSON.parse(UrlFetchApp.fetch(PLAN_URL + '?t=' + Date.now()).getContentText());
  const ops = plan.ops;
  let i = Number(props.getProperty('next') || 0);
  let errors = JSON.parse(props.getProperty('errors') || '[]');
  const cache = {};
  const start = Date.now();
  while (i < ops.length && Date.now() - start < LIMIT_MS) {
    const batch = ops.slice(i, i + BATCH);
    let failed = processBatch_(batch, props, cache);
    if (failed.length) {
      Utilities.sleep(3000);
      const retry = processBatch_(failed.map(f => f.op), props, cache);
      retry.forEach(f => { if (errors.length < 40) errors.push(f.op.id + ' ' + f.msg); });
    }
    i += batch.length;
    props.setProperty('next', String(i));
  }
  props.setProperty('errors', JSON.stringify(errors));
  if (i < ops.length) {
    Logger.log('PROGRESS ' + i + ' / ' + ops.length + ' — run again to continue. Errors so far: ' + errors.length);
  } else {
    writeResult_(plan, props, errors);
    Logger.log('DONE ' + i + ' / ' + ops.length + '. Errors: ' + errors.length);
    errors.forEach(e => Logger.log('ERROR ' + e));
  }
}

function processBatch_(ops, props, cache) {
  const headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  const targets = ops.map(op => ensurePath_(op.r, op.p, props, cache));
  const got = UrlFetchApp.fetchAll(ops.map(op => ({
    url: 'https://www.googleapis.com/drive/v3/files/' + op.id + '?fields=parents,name',
    headers: headers, muteHttpExceptions: true
  })));
  const reqs = ops.map((op, k) => {
    let parents = '';
    try { parents = (JSON.parse(got[k].getContentText()).parents || []).filter(p => p !== targets[k]).join(','); } catch (e) {}
    const url = 'https://www.googleapis.com/drive/v3/files/' + op.id + '?addParents=' + targets[k] + (parents ? '&removeParents=' + parents : '');
    return { url: url, method: 'patch', contentType: 'application/json', payload: JSON.stringify(op.t === 'f' ? { name: op.n } : {}), headers: headers, muteHttpExceptions: true };
  });
  const res = UrlFetchApp.fetchAll(reqs);
  const failed = [];
  res.forEach((r, k) => { if (r.getResponseCode() !== 200) failed.push({ op: ops[k], msg: r.getResponseCode() + ' ' + r.getContentText().slice(0, 120) }); });
  return failed;
}

function ensurePath_(rootId, path, props, cache) {
  let parentId = rootId;
  for (let k = 0; k < path.length; k++) {
    const raw = rootId + '/' + path.slice(0, k + 1).join('/');
    const key = 'F:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw, Utilities.Charset.UTF_8));
    let id = cache[key] || props.getProperty(key);
    if (!id) {
      const parent = DriveApp.getFolderById(parentId);
      const it = parent.getFoldersByName(path[k]);
      id = it.hasNext() ? it.next().getId() : parent.createFolder(path[k]).getId();
      props.setProperty(key, id);
    }
    cache[key] = id;
    parentId = id;
  }
  return parentId;
}

function writeResult_(plan, props, errors) {
  const out = { showFolders: {}, errors: errors, finished: new Date().toISOString() };
  Object.keys(plan.showFolders).forEach(sid => {
    const sf = plan.showFolders[sid];
    out.showFolders[sid] = ensurePath_(sf.r, [sf.n], props, {});
  });
  const shows = DriveApp.getFolderById(SHOWS_FOLDER);
  const old = shows.getFilesByName('show-folders.json');
  while (old.hasNext()) old.next().setTrashed(true);
  shows.createFile('show-folders.json', JSON.stringify(out, null, 1), 'application/json');
}

function resetPlan() {
  PropertiesService.getScriptProperties().deleteAllProperties();
  Logger.log('Progress cleared');
}
