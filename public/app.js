const $ = selector => document.querySelector(selector);
const state = { memories: [], stats: null, config: null, view: localStorage.getItem('pumas-view') === 'timeline' ? 'timeline' : 'grid', page: 'memories', detail: null, slide: 0, editor: null, saving: false };
const dateFormat = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat('es-MX', { month: 'short', year: 'numeric', timeZone: 'UTC' });
function dateLabel(date) { return dateFormat.format(new Date(`${date}T12:00:00Z`)); }
function shortDate(date) { return monthFormat.format(new Date(`${date}T12:00:00Z`)); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]); }
function icon(name) { return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`; }
function bytes(size) { return size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(1)} GB` : size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`; }
function resultOf(memory) { return memory.pumas_score == null ? 'Sin marcador' : memory.pumas_score > memory.rival_score ? 'Victoria' : memory.pumas_score < memory.rival_score ? 'Derrota' : 'Empate'; }
function scoreOf(memory) { return memory.pumas_score == null ? '' : `Pumas ${memory.pumas_score} : ${memory.rival_score} ${memory.opponent}`; }
async function request(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, headers: options.body && !(options.body instanceof Blob) ? { 'Content-Type': 'application/json', ...options.headers } : options.headers }); }
  catch { throw new Error('No se pudo conectar con la aplicación. Comprueba que sigue abierta.'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'No se pudo completar la operación.');
  return body;
}
let toastTimer;
function toast(message, isError = false) { const element = $('#toast'); element.textContent = message; element.classList.toggle('error', isError); element.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('show'), 4200); }
function coverOf(memory) { return memory.media.find(item => item.id === memory.cover_media_id) || memory.media[0]; }
function coverImage(memory) { const cover = coverOf(memory); return cover && (cover.mime.startsWith('image/') ? cover.url : cover.thumbnailUrl); }
function card(memory) {
  const cover = coverOf(memory), image = coverImage(memory);
  const count = memory.media.length;
  return `<button class="memory-card" data-id="${memory.id}" aria-label="Abrir recuerdo: ${escapeHtml(memory.title)}"><div class="card-image ${image ? '' : 'no-image'}">${image ? `<img src="${image}" alt="" loading="lazy">` : ''}<span class="card-type">${icon(memory.location === 'stadium' ? 'pin' : 'photo')} ${memory.location === 'stadium' ? 'EN EL ESTADIO' : 'DESDE CASA'}</span></div><div class="card-body"><span class="card-date">${escapeHtml(dateLabel(memory.match_date))}</span><h3>${escapeHtml(memory.title)}</h3><p>${escapeHtml(memory.description || `Pumas vs ${memory.opponent}`)}</p><div class="card-meta"><span>${escapeHtml(memory.opponent)} · ${resultOf(memory)}</span>${memory.pumas_score != null ? `<span class="score">${memory.pumas_score} : ${memory.rival_score}</span>` : `<span class="card-media-count">${icon(cover?.mime.startsWith('video/') ? 'play' : 'photo')} ${count}</span>`}</div></div></button>`;
}
function selectedFilters() { return { q: $('#searchInput').value.trim().toLocaleLowerCase(), year: $('#yearFilter').value, date: $('#dateFilter').value, opponent: $('#opponentFilter').value, location: $('#locationFilter').value, result: $('#resultFilter').value }; }
function filteredMemories() { const f = selectedFilters(); return state.memories.filter(m => (!f.q || `${m.title} ${m.description}`.toLocaleLowerCase().includes(f.q)) && (!f.year || m.match_date.startsWith(f.year)) && (!f.date || m.match_date === f.date) && (!f.opponent || m.opponent === f.opponent) && (!f.location || m.location === f.location) && (!f.result || (f.result === 'pending' ? m.pumas_score == null : resultOf(m).toLowerCase() === ({ win: 'victoria', draw: 'empate', loss: 'derrota' })[f.result]))); }
function updateFilterOptions() {
  const years = [...new Set(state.memories.map(m => m.match_date.slice(0, 4)))].sort().reverse();
  const rivals = [...new Set(state.memories.map(m => m.opponent))].sort((a,b) => a.localeCompare(b, 'es'));
  const yearValue = $('#yearFilter').value, rivalValue = $('#opponentFilter').value;
  $('#yearFilter').innerHTML = '<option value="">Todos los años</option>' + years.map(year => `<option value="${year}">${year}</option>`).join('');
  $('#opponentFilter').innerHTML = '<option value="">Todos los rivales</option>' + rivals.map(rival => `<option value="${escapeHtml(rival)}">${escapeHtml(rival)}</option>`).join('');
  $('#yearFilter').value = years.includes(yearValue) ? yearValue : '';
  $('#opponentFilter').value = rivals.includes(rivalValue) ? rivalValue : '';
}
function renderMemories() {
  const filtered = filteredMemories(), hasAny = state.memories.length > 0;
  const activeFilters = Object.values(selectedFilters()).some(Boolean);
  $('#clearFilters').classList.toggle('hidden', !activeFilters);
  $('#emptyState').classList.toggle('hidden', hasAny);
  $('#noResults').classList.toggle('hidden', !hasAny || filtered.length > 0);
  $('#listHeading').textContent = activeFilters ? 'Resultados de tu búsqueda' : 'Todos los recuerdos';
  $('#memoryCount').textContent = `${filtered.length} ${filtered.length === 1 ? 'momento guardado' : 'momentos guardados'}`;
  const list = $('#memoryList'); list.className = `memory-list ${state.view}-view`;
  if (state.view === 'grid') list.innerHTML = filtered.map(card).join('');
  else { let year = ''; list.innerHTML = filtered.map(memory => { const next = memory.match_date.slice(0, 4); const heading = next === year ? '' : `<div class="timeline-year">${next}</div>`; year = next; return heading + card(memory); }).join(''); }
  $('#gridButton').classList.toggle('active', state.view === 'grid'); $('#timelineButton').classList.toggle('active', state.view === 'timeline');
}
function barRows(items) { const max = Math.max(...items.map(i => i.count), 1); return items.length ? items.map(i => `<div class="bar-row"><span>${escapeHtml(i.name || i.year)}</span><div class="bar-track"><div class="bar-fill" style="width:${i.count / max * 100}%"></div></div><strong>${i.count}</strong></div>`).join('') : '<p class="empty-panel-copy">Todavía no hay datos.</p>'; }
function renderHistory() {
  const s = state.stats; if (!s) return;
  if (!s.total) { $('#historyContent').innerHTML = `<div class="history-empty"><div class="history-empty-icon">P</div><h3>Tu historia está por comenzar.</h3><p>El primer recuerdo que guardes aparecerá aquí como el inicio de tu recorrido.</p><button id="historyCreate" class="primary-button">${icon('plus')} Crear mi primer recuerdo</button></div>`; return; }
  $('#historyContent').innerHTML = `<div class="history-lead"><div><span>PARTIDOS EN TU HISTORIA</span><p>Cada uno, una emoción distinta.</p></div><strong>${s.total}</strong></div><div class="stat-grid"><div class="stat-card highlight"><span>En el estadio</span><strong>${s.stadium}</strong></div><div class="stat-card"><span>Desde casa</span><strong>${s.home}</strong></div><div class="stat-card"><span>Victorias</span><strong>${s.win}</strong></div><div class="stat-card"><span>Empates / derrotas</span><strong>${s.draw} <small style="font-size:17px;color:#a6b0bb">/</small> ${s.loss}</strong></div></div><div class="history-panels"><div class="history-panel"><h3>Rivales más vistos</h3>${barRows(s.rivals)}</div><div class="history-panel"><h3>Recuerdos por año</h3>${barRows(s.years)}</div></div><div class="history-ends"><button class="history-end" data-id="${s.first.id}"><span>EL PRIMER RECUERDO</span><strong>${escapeHtml(s.first.title)}</strong><small>${escapeHtml(dateLabel(s.first.date))}</small></button><button class="history-end" data-id="${s.last.id}"><span>EL MÁS RECIENTE</span><strong>${escapeHtml(s.last.title)}</strong><small>${escapeHtml(dateLabel(s.last.date))}</small></button></div>`;
}
async function reload() { const [memories, stats, config] = await Promise.all([request('/api/memories'), request('/api/stats'), request('/api/config')]); state.memories = memories; state.stats = stats; state.config = config; updateFilterOptions(); renderMemories(); renderHistory(); $('#loadingState').classList.add('hidden'); }
function setPage(page) { state.page = page; $('#memoriesPage').classList.toggle('active', page === 'memories'); $('#historyPage').classList.toggle('active', page === 'history'); document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page)); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function showDetailMedia() {
  const m = state.detail, item = m.media[state.slide], host = $('#detailMediaTarget');
  if (!item) { host.className = 'detail-media empty'; host.innerHTML = ''; return; }
  host.className = 'detail-media';
  host.innerHTML = `${item.mime.startsWith('video/') ? `<video src="${item.url}" controls playsinline preload="metadata" ${item.thumbnailUrl ? `poster="${item.thumbnailUrl}"` : ''}></video><a class="video-fallback" href="${item.url}" download="${escapeHtml(item.filename)}">Descargar video si no se reproduce</a>` : `<img src="${item.url}" alt="${escapeHtml(item.filename)}">`}${m.media.length > 1 ? `<button class="carousel-button prev" data-slide="prev" aria-label="Anterior">${icon('chevron')}</button><button class="carousel-button next" data-slide="next" aria-label="Siguiente">${icon('chevron')}</button><span class="media-index">${state.slide + 1} / ${m.media.length}</span>` : ''}`;
  document.querySelectorAll('.media-strip button').forEach((button, index) => button.classList.toggle('active', index === state.slide));
}
async function openDetail(id) {
  try { state.detail = await request(`/api/memories/${id}`); state.slide = Math.max(0, state.detail.media.findIndex(item => item.id === state.detail.cover_media_id)); renderDetail(); $('#detailDialog').showModal(); }
  catch (error) { toast(error.message, true); }
}
function renderDetail() {
  const m = state.detail;
  $('#detailBody').innerHTML = `<div class="detail-body-scroll"><div class="detail-hero"><span class="detail-kicker">${escapeHtml(dateLabel(m.match_date).toUpperCase())}</span><h2>${escapeHtml(m.title)}</h2><div class="detail-chips"><span class="detail-chip">${icon(m.location === 'stadium' ? 'pin' : 'photo')} ${m.location === 'stadium' ? 'En el estadio' : 'Desde casa'}</span><span class="detail-chip">Pumas vs ${escapeHtml(m.opponent)}</span>${m.pumas_score != null ? `<span class="detail-chip score">${escapeHtml(scoreOf(m))} · ${resultOf(m)}</span>` : ''}</div></div><div id="detailMediaTarget" class="detail-media"></div>${m.media.length > 1 ? `<div class="media-strip">${m.media.map((item, index) => `<button data-index="${index}" aria-label="Ver archivo ${index + 1}" class="${index === state.slide ? 'active' : ''}">${item.mime.startsWith('image/') || item.thumbnailUrl ? `<img src="${item.thumbnailUrl || item.url}" alt="">` : icon('play')}</button>`).join('')}</div>` : ''}<div class="detail-description">${escapeHtml(m.description)}</div></div>`;
  showDetailMedia();
}
function disposeEditor() { if (state.editor) state.editor.items.forEach(item => { if (item.preview) URL.revokeObjectURL(item.preview); if (item.thumbPreview) URL.revokeObjectURL(item.thumbPreview); }); state.editor = null; }
function openEditor(memory = null) {
  disposeEditor();
  state.editor = { id: memory?.id || null, items: (memory?.media || []).map(item => ({ ...item, kind: 'existing', key: item.id })), removedIds: [], coverKey: memory?.cover_media_id || memory?.media[0]?.id || null, dirty: false };
  $('#memoryForm').reset(); $('#editorTitle').textContent = memory ? 'Editar recuerdo' : 'Nuevo recuerdo'; $('#saveButton').textContent = memory ? 'Guardar cambios' : 'Guardar recuerdo';
  $('#titleInput').value = memory?.title || ''; $('#dateInput').value = memory?.match_date || ''; $('#opponentInput').value = memory?.opponent || ''; $('#descriptionInput').value = memory?.description || ''; $('#pumasScore').value = memory?.pumas_score ?? ''; $('#rivalScore').value = memory?.rival_score ?? '';
  $(`#memoryForm input[name="location"][value="${memory?.location || 'stadium'}"]`).checked = true;
  $('#saveProgress').textContent = ''; $('#fileInput').value = ''; renderEditorMedia(); $('#editorDialog').showModal(); $('#titleInput').focus();
}
function closeEditor(force = false) {
  if (state.saving && !force) return;
  if (!force && state.editor?.dirty && !window.confirm('Hay cambios sin guardar. ¿Quieres cerrar el formulario?')) return;
  $('#editorDialog').close(); disposeEditor();
}
async function createVideoThumb(item) {
  const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.preload = 'metadata'; video.src = item.preview;
  try {
    await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Vista previa no disponible')), 9000); video.onloadeddata = () => { clearTimeout(timeout); resolve(); }; video.onerror = () => { clearTimeout(timeout); reject(new Error('Vista previa no disponible')); }; });
    if (video.duration > 1) { video.currentTime = Math.min(1, video.duration / 3); await new Promise(resolve => { const timeout = setTimeout(resolve, 1000); video.onseeked = () => { clearTimeout(timeout); resolve(); }; }); }
    const ratio = Math.min(1, 640 / video.videoWidth, 400 / video.videoHeight), canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(video.videoWidth * ratio)); canvas.height = Math.max(1, Math.round(video.videoHeight * ratio)); canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    item.thumbBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
    if (item.thumbBlob) { item.thumbPreview = URL.createObjectURL(item.thumbBlob); if (state.editor?.items.includes(item)) renderEditorMedia(); }
  } catch { /* MOV or unsupported codec: original stays available for download. */ }
  finally { video.removeAttribute('src'); video.load(); }
}
function addFiles(files) {
  const editor = state.editor; if (!editor) return;
  let rejected = 0;
  for (const file of files) {
    const extension = file.name.split('.').at(-1)?.toLowerCase();
    if (!['jpg','jpeg','png','webp','mp4','mov'].includes(extension) || file.size > state.config.maxFileBytes || file.size === 0) { rejected++; continue; }
    const item = { kind: 'new', key: crypto.randomUUID(), file, filename: file.name, mime: file.type || (['mp4','mov'].includes(extension) ? 'video/mp4' : 'image/jpeg'), size: file.size, preview: URL.createObjectURL(file) };
    editor.items.push(item); if (!editor.coverKey) editor.coverKey = item.key;
    if (['mp4','mov'].includes(extension)) createVideoThumb(item);
  }
  if (rejected) toast(`${rejected} ${rejected === 1 ? 'archivo omitido' : 'archivos omitidos'}: formato o tamaño no admitido.`, true);
  if (files.length > rejected) editor.dirty = true;
  renderEditorMedia(); $('#fileInput').value = '';
}
function renderEditorMedia() {
  const editor = state.editor; if (!editor) return;
  $('#mediaCount').textContent = `${editor.items.length} ${editor.items.length === 1 ? 'archivo' : 'archivos'}`;
  $('#mediaEditorList').innerHTML = editor.items.map((item, index) => {
    const image = item.kind === 'existing' ? (item.mime.startsWith('image/') ? item.url : item.thumbnailUrl) : (item.mime.startsWith('image/') ? item.preview : item.thumbPreview);
    return `<div class="media-edit-item" data-key="${item.key}"><div class="media-edit-thumb">${image ? `<img src="${image}" alt="">` : icon('play')}</div><div class="media-edit-info"><strong>${escapeHtml(item.filename)}</strong><span>${item.mime.startsWith('video/') ? 'Video' : 'Fotografía'} · ${bytes(item.size)}</span></div><div class="media-edit-actions"><button type="button" class="small-action ${editor.coverKey === item.key ? 'active' : ''}" data-media-action="cover" title="Elegir como portada" aria-label="Elegir ${escapeHtml(item.filename)} como portada">★</button><button type="button" class="small-action" data-media-action="up" title="Mover antes" aria-label="Mover antes" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" class="small-action" data-media-action="down" title="Mover después" aria-label="Mover después" ${index === editor.items.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="small-action remove" data-media-action="remove" title="Quitar" aria-label="Quitar archivo">×</button></div></div>`;
  }).join('');
}
function manageMedia(event) {
  const button = event.target.closest('[data-media-action]'); if (!button) return;
  const editor = state.editor, index = editor.items.findIndex(item => item.key === button.closest('[data-key]').dataset.key); if (index < 0) return;
  const item = editor.items[index], action = button.dataset.mediaAction;
  if (action === 'cover') editor.coverKey = item.key;
  if (action === 'up' && index > 0) [editor.items[index - 1], editor.items[index]] = [editor.items[index], editor.items[index - 1]];
  if (action === 'down' && index < editor.items.length - 1) [editor.items[index + 1], editor.items[index]] = [editor.items[index], editor.items[index + 1]];
  if (action === 'remove') { if (item.kind === 'existing' && !window.confirm(`¿Quitar “${item.filename}” de este recuerdo? Se eliminará al guardar los cambios.`)) return; editor.items.splice(index, 1); if (item.kind === 'existing') editor.removedIds.push(item.id); else { URL.revokeObjectURL(item.preview); if (item.thumbPreview) URL.revokeObjectURL(item.thumbPreview); } if (editor.coverKey === item.key) editor.coverKey = editor.items[0]?.key || null; }
  editor.dirty = true; renderEditorMedia();
}
function uploadFile(memoryId, item, index, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('POST', `/api/memories/${memoryId}/media`); xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.filename)); xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
    xhr.upload.onprogress = event => { if (event.lengthComputable) $('#saveProgress').textContent = `Subiendo ${index} de ${total} · ${Math.round(event.loaded / event.total * 100)}%`; };
    xhr.onload = () => { let body; try { body = JSON.parse(xhr.responseText); } catch { body = {}; } xhr.status >= 200 && xhr.status < 300 ? resolve(body) : reject(new Error(body.error || 'No se pudo subir el archivo.')); };
    xhr.onerror = () => reject(new Error('La conexión falló al subir el archivo.')); xhr.send(item.file);
  });
}
async function saveMemory(event) {
  event.preventDefault(); if (state.saving || !state.editor) return;
  const editor = state.editor;
  const title = $('#titleInput').value.trim(), match_date = $('#dateInput').value, opponent = $('#opponentInput').value.trim();
  const pumas_score = $('#pumasScore').value, rival_score = $('#rivalScore').value;
  if (!title || !match_date || !opponent) { toast('Completa el título, la fecha y el rival.', true); return; }
  if ((pumas_score === '') !== (rival_score === '')) { toast('Completa ambos goles o deja el marcador vacío.', true); return; }
  const body = { title, match_date, opponent, description: $('#descriptionInput').value.trim(), location: $('input[name="location"]:checked').value, pumas_score, rival_score };
  state.saving = true; $('#saveButton').disabled = true;
  try {
    const wasEditing = Boolean(editor.id);
    $('#saveProgress').textContent = 'Guardando datos…';
    const saved = await request(editor.id ? `/api/memories/${editor.id}` : '/api/memories', { method: editor.id ? 'PUT' : 'POST', body: JSON.stringify(body) }); editor.id = saved.id;
    for (const id of [...editor.removedIds]) { await request(`/api/media/${id}`, { method: 'DELETE' }); editor.removedIds = editor.removedIds.filter(value => value !== id); }
    const pending = editor.items.filter(item => item.kind === 'new'); let uploaded = 0;
    for (const item of pending) {
      const response = await uploadFile(editor.id, item, ++uploaded, pending.length);
      if (item.thumbBlob) await fetch(`/api/media/${response.id}/thumbnail`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: item.thumbBlob }).catch(() => {});
      item.kind = 'existing'; item.id = response.id; item.url = response.url; item.thumbnailUrl = item.thumbBlob ? `/thumb/${response.id}` : null; delete item.file;
    }
    $('#saveProgress').textContent = 'Ordenando archivos…';
    await request(`/api/memories/${editor.id}/order`, { method: 'PUT', body: JSON.stringify({ ids: editor.items.map(item => item.id) }) });
    await request(`/api/memories/${editor.id}/cover`, { method: 'PUT', body: JSON.stringify({ mediaId: editor.items.find(item => item.key === editor.coverKey)?.id || null }) });
    editor.dirty = false; closeEditor(true); await reload(); toast(wasEditing ? 'Recuerdo actualizado.' : 'Recuerdo guardado.');
  } catch (error) { toast(error.message, true); $('#saveProgress').textContent = 'Revisa el error y vuelve a intentar. Lo ya subido está guardado.'; }
  finally { state.saving = false; $('#saveButton').disabled = false; }
}
function clearFilters() { $('#searchInput').value = ''; ['yearFilter','dateFilter','opponentFilter','locationFilter','resultFilter'].forEach(id => $(`#${id}`).value = ''); renderMemories(); }
async function deleteCurrent() {
  if (!state.detail) return;
  const id = state.detail.id; $('#confirmDelete').disabled = true;
  try { await request(`/api/memories/${id}`, { method: 'DELETE' }); $('#confirmDialog').close(); $('#detailDialog').close(); state.detail = null; await reload(); toast('Recuerdo eliminado.'); }
  catch (error) { toast(error.message, true); }
  finally { $('#confirmDelete').disabled = false; }
}
function wire() {
  document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.page)));
  $('#newMemoryButton').onclick = $('#emptyCreateButton').onclick = $('#mobileNew').onclick = () => openEditor();
  $('#gridButton').onclick = () => { state.view = 'grid'; localStorage.setItem('pumas-view', state.view); renderMemories(); };
  $('#timelineButton').onclick = () => { state.view = 'timeline'; localStorage.setItem('pumas-view', state.view); renderMemories(); };
  $('#searchInput').addEventListener('input', renderMemories);
  ['yearFilter','dateFilter','opponentFilter','locationFilter','resultFilter'].forEach(id => $(`#${id}`).addEventListener('change', renderMemories));
  $('#clearFilters').onclick = $('#noResultsClear').onclick = clearFilters;
  $('#memoryList').addEventListener('click', event => { const card = event.target.closest('[data-id]'); if (card) openDetail(card.dataset.id); });
  $('#historyContent').addEventListener('click', event => { if (event.target.closest('#historyCreate')) return openEditor(); const card = event.target.closest('[data-id]'); if (card) openDetail(card.dataset.id); });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.dataset.close === 'editorDialog' ? closeEditor() : $(`#${button.dataset.close}`).close()));
  $('#editorDialog').addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
  $('#memoryForm').addEventListener('input', () => { if (state.editor) state.editor.dirty = true; });
  $('#memoryForm').addEventListener('submit', saveMemory);
  $('#fileInput').addEventListener('change', event => addFiles(event.target.files));
  const drop = $('#dropZone'); drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragging'); }); drop.addEventListener('dragleave', () => drop.classList.remove('dragging')); drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('dragging'); addFiles(event.dataTransfer.files); });
  $('#mediaEditorList').addEventListener('click', manageMedia);
  $('#detailBack').onclick = () => $('#detailDialog').close();
  $('#detailBody').addEventListener('click', event => { const arrow = event.target.closest('[data-slide]'); if (arrow) { state.slide = (state.slide + (arrow.dataset.slide === 'next' ? 1 : -1) + state.detail.media.length) % state.detail.media.length; showDetailMedia(); } const thumb = event.target.closest('[data-index]'); if (thumb) { state.slide = Number(thumb.dataset.index); showDetailMedia(); } });
  $('#editMemory').onclick = async () => { const id = state.detail.id; $('#detailDialog').close(); try { openEditor(await request(`/api/memories/${id}`)); } catch (error) { toast(error.message, true); } };
  $('#deleteMemory').onclick = () => $('#confirmDialog').showModal(); $('#cancelDelete').onclick = () => $('#confirmDialog').close(); $('#confirmDelete').onclick = deleteCurrent;
  document.addEventListener('keydown', event => { if (!$('#detailDialog').open || $('#confirmDialog').open || state.detail?.media.length < 2) return; if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { state.slide = (state.slide + (event.key === 'ArrowRight' ? 1 : -1) + state.detail.media.length) % state.detail.media.length; showDetailMedia(); } });
}
$('#todayLabel').textContent = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date()).toUpperCase();
wire(); reload().catch(error => { $('#loadingState').textContent = 'No se pudieron cargar tus recuerdos. Recarga la página para volver a intentar.'; toast(error.message, true); });
