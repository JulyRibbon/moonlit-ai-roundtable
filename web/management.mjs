export function modelLabel(bridge) {
  const metadata = bridge?.identity?.metadata ?? {};
  const selection = metadata.modelSelection ?? {};
  const used = selection.lastUsed ?? selection.next ?? selection;
  const model = metadata.model?.modelId
    ?? metadata.model
    ?? metadata.modelId
    ?? metadata.modelName
    ?? used.model
    ?? used.id
    ?? null;
  const provider = metadata.model?.providerId ?? metadata.provider ?? used.provider ?? null;
  if (!model && !provider) return '模型未知';
  if (provider && model && !String(model).includes(provider)) return `${provider}/${model}`;
  return String(model ?? provider);
}

export function shortSessionRef(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return '会话未知';
  if (text.length <= 22) return text;
  return `${text.slice(0, 10)}…${text.slice(-8)}`;
}

export function filterTranscript(messages, { query = '', seatId = '', nameFor = (id) => id } = {}) {
  const needle = query.trim().toLowerCase();
  return messages.filter((message) => {
    if (seatId && (message.from === 'owner' ? 'owner' : message.seatId) !== seatId) return false;
    if (!needle) return true;
    const author = message.from === 'owner' ? '机主' : nameFor(message.seatId);
    return `${author} ${message.seatId ?? ''} ${message.text ?? ''}`.toLowerCase().includes(needle);
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function createManagementUI({
  model,
  api,
  refreshSnapshot,
  pushNotice,
  reportError,
  seatName,
  seatColor,
  sortedMessages,
} = {}) {
  let draftSeats = [];
  let savingSettings = false;
  let clearing = false;
  let resettingCounters = false;
  const resetting = new Set();
  const dialogs = {
    settings: document.getElementById('settings-dialog'),
    records: document.getElementById('records-dialog'),
    help: document.getElementById('help-dialog'),
  };
  const settingsForm = document.getElementById('settings-form');
  const settingsMembers = document.getElementById('settings-members');
  const recordQuery = document.getElementById('record-query');
  const recordSeat = document.getElementById('record-seat');
  const recordList = document.getElementById('record-list');
  const recordSummary = document.getElementById('record-summary');

  function openDialog(name) {
    const dialog = dialogs[name];
    if (dialog && !dialog.open) dialog.showModal();
  }

  function closeDialog(name) {
    dialogs[name]?.close();
  }

  function settings() {
    return model.snapshot?.settings ?? {
      ownerName: '机主',
      maxAttempts: model.snapshot?.schedule?.maxAttempts ?? 3,
      contextMessages: 8,
      seatOrder: [],
      seats: [],
    };
  }

  function renderSettingsMembers() {
    const fragment = document.createDocumentFragment();
    draftSeats.forEach((seat, index) => {
      const row = el('div', 'settings-member');
      row.dataset.seatId = seat.seatId;
      const name = document.createElement('input');
      name.type = 'text';
      name.maxLength = 32;
      name.required = true;
      name.value = seat.displayName;
      name.setAttribute('aria-label', `${seat.seatId} 昵称`);
      name.addEventListener('input', () => { seat.displayName = name.value; });
      const color = document.createElement('input');
      color.type = 'color';
      color.value = seat.color;
      color.setAttribute('aria-label', `${seat.seatId} 代表颜色`);
      color.addEventListener('input', () => { seat.color = color.value; });
      const up = el('button', 'compact-button', '上移');
      up.type = 'button';
      up.disabled = index === 0;
      up.addEventListener('click', () => {
        [draftSeats[index - 1], draftSeats[index]] = [draftSeats[index], draftSeats[index - 1]];
        renderSettingsMembers();
      });
      const down = el('button', 'compact-button', '下移');
      down.type = 'button';
      down.disabled = index === draftSeats.length - 1;
      down.addEventListener('click', () => {
        [draftSeats[index], draftSeats[index + 1]] = [draftSeats[index + 1], draftSeats[index]];
        renderSettingsMembers();
      });
      row.append(name, el('span', 'settings-member-id', seat.seatId), color, up, down);
      fragment.append(row);
    });
    settingsMembers.replaceChildren(fragment);
  }

  function openSettings() {
    const current = settings();
    document.getElementById('setting-owner-name').value = current.ownerName;
    document.getElementById('setting-max-attempts').value = current.maxAttempts;
    document.getElementById('setting-context-messages').value = current.contextMessages;
    const byId = new Map(current.seats.map((seat) => [seat.seatId, seat]));
    draftSeats = current.seatOrder.map((seatId) => ({ ...byId.get(seatId) })).filter((seat) => seat.seatId);
    renderSettingsMembers();
    openDialog('settings');
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (savingSettings) return;
    savingSettings = true;
    const submit = settingsForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api('/api/settings', {
        method: 'POST',
        body: {
          ownerName: document.getElementById('setting-owner-name').value,
          maxAttempts: Number(document.getElementById('setting-max-attempts').value),
          contextMessages: Number(document.getElementById('setting-context-messages').value),
          seatOrder: draftSeats.map((seat) => seat.seatId),
          seats: draftSeats.map((seat) => ({
            seatId: seat.seatId,
            displayName: seat.displayName,
            color: seat.color,
          })),
        },
      });
      await refreshSnapshot();
      closeDialog('settings');
      pushNotice('房间设置已保存。次数从下一轮生效，昵称与顺序已应用。', 'info');
    } catch (error) {
      reportError('保存房间设置失败', error);
    } finally {
      savingSettings = false;
      submit.disabled = false;
    }
  }

  function renderRecordSeatOptions() {
    const selected = recordSeat.value;
    const seats = settings().seatOrder;
    const fragment = document.createDocumentFragment();
    const all = el('option', '', '全部成员');
    all.value = '';
    fragment.append(all);
    const owner = el('option', '', settings().ownerName);
    owner.value = 'owner';
    fragment.append(owner);
    for (const seatId of seats) {
      const option = el('option', '', seatName(seatId));
      option.value = seatId;
      fragment.append(option);
    }
    recordSeat.replaceChildren(fragment);
    recordSeat.value = seats.includes(selected) || selected === 'owner' ? selected : '';
  }

  function renderRecords() {
    const all = sortedMessages();
    const filtered = filterTranscript(all, {
      query: recordQuery.value,
      seatId: recordSeat.value,
      nameFor: (seatId) => seatId === 'owner' ? settings().ownerName : seatName(seatId),
    });
    const visible = filtered.slice(-200);
    recordSummary.textContent = `匹配 ${filtered.length} / ${all.length} 条${visible.length < filtered.length ? '，仅显示最近 200 条' : ''}`;
    const fragment = document.createDocumentFragment();
    for (const message of visible) {
      const item = el('article', 'record-item');
      item.style.setProperty('--seat-color', message.from === 'owner' ? 'var(--owner)' : seatColor(message.seatId));
      const head = el('header', 'record-item-head');
      const author = message.from === 'owner' ? settings().ownerName : seatName(message.seatId);
      head.append(el('span', '', `${author} · #${message.roomSeq ?? '—'}`));
      head.append(el('time', '', message.createdAt ? new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false }) : ''));
      item.append(head, el('div', 'record-item-text', message.text));
      fragment.append(item);
    }
    if (visible.length === 0) fragment.append(el('p', 'modal-note', '没有匹配的记录。'));
    recordList.replaceChildren(fragment);
  }

  function openRecords() {
    renderRecordSeatOptions();
    renderRecords();
    openDialog('records');
  }

  async function exportRecords(kind) {
    try {
      const response = await api(`/api/export.${kind}`, { raw: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadBlob(await response.blob(), `ai-room-${model.roomId ?? 'room'}-${stamp}.${kind}`);
    } catch (error) {
      reportError('导出聊天记录失败', error);
    }
  }

  async function exportCounters() {
    try {
      const response = await api('/api/counters', { raw: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadBlob(await response.blob(), `ai-room-${model.roomId ?? 'room'}-counters-${stamp}.json`);
    } catch (error) {
      reportError('导出计数失败', error);
    }
  }

  async function resetCounters() {
    if (resettingCounters) return;
    if (model.snapshot?.running || model.snapshot?.schedule?.awaiting) {
      pushNotice('请先暂停并等待当前回合结束，再重置计数。', 'warn');
      return;
    }
    if (!window.confirm('确定重置当前计数吗？系统会先自动备份，再开启新计数轮次。\n\n不会删除字幕、attempt 审计或原生会话，也不会自动开始聊天。')) return;
    resettingCounters = true;
    try {
      const result = await api('/api/counters/reset', { method: 'POST', body: {} });
      await refreshSnapshot();
      renderRecords();
      pushNotice(`计数已备份并重置，进入第 ${result.round} 个计数轮次。备份：${result.backupPath}`, 'info');
    } catch (error) {
      reportError('重置计数失败', error);
    } finally {
      resettingCounters = false;
    }
  }

  async function clearRecords() {
    if (clearing) return;
    const count = sortedMessages().length;
    if (!window.confirm(`确定清空 ${count} 条房间字幕吗？系统会先自动备份 JSONL。\n\n不会删除任何客户端的原生会话，也不会删除事件和 attempt 审计。`)) return;
    clearing = true;
    try {
      const result = await api('/api/transcript/clear', { method: 'POST', body: {} });
      await refreshSnapshot();
      renderRecords();
      pushNotice(`已备份并清空 ${result.clearedCount} 条字幕。备份：${result.backupPath}`, 'info');
    } catch (error) {
      reportError('清空聊天记录失败', error);
    } finally {
      clearing = false;
    }
  }

  async function resetSeat(seatId) {
    if (resetting.has(seatId)) return;
    if (model.snapshot?.running || model.snapshot?.schedule?.awaiting) {
      pushNotice('请先暂停并等待当前回合结束，再切换新会话。', 'warn');
      return;
    }
    if (!window.confirm(`确定让 ${seatName(seatId)} 启用新的原生会话吗？\n\n旧会话与房间字幕都会保留；切换后不会自动开始聊天。`)) return;
    resetting.add(seatId);
    try {
      const result = await api(`/api/seats/${encodeURIComponent(seatId)}/session`, { method: 'POST', body: {} });
      await refreshSnapshot();
      if (result.persistenceError) {
        pushNotice(`${seatName(seatId)} 已切换新会话，但配置写回失败：${result.persistenceError}`, 'warn');
      } else {
        pushNotice(`${seatName(seatId)} 已切换到新会话 ${shortSessionRef(result.nativeSessionRef)}，旧会话已保留。`, 'info');
      }
    } catch (error) {
      reportError(`${seatName(seatId)} 新会话创建失败`, error);
    } finally {
      resetting.delete(seatId);
    }
  }

  function bind() {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-close]');
      if (!button) return;
      event.preventDefault();
      document.getElementById(button.dataset.close)?.close();
    });
    settingsForm.addEventListener('submit', saveSettings);
    recordQuery.addEventListener('input', renderRecords);
    recordSeat.addEventListener('change', renderRecords);
    document.getElementById('record-export-md').addEventListener('click', () => exportRecords('md'));
    document.getElementById('record-export-json').addEventListener('click', () => exportRecords('json'));
    document.getElementById('record-export-counters').addEventListener('click', exportCounters);
    document.getElementById('record-reset-counters').addEventListener('click', resetCounters);
    document.getElementById('record-clear').addEventListener('click', clearRecords);
  }

  return {
    bind,
    openSettings,
    openRecords,
    openHelp: () => openDialog('help'),
    renderRecords,
    resetSeat,
    modelLabel,
    shortSessionRef,
  };
}
