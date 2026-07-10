// parsers.js — 讀取器管理 view:一頁列出所有廠商讀取器狀態、可多選上傳依廠商名稱自動歸位
(function () {
  const el = PmisApp.el;

  function fmtTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString();
  }

  async function render(content) {
    const isAdmin = !!(PmisApp.currentUser && PmisApp.currentUser.role === 'admin');
    content.appendChild(el('div', { class: 'page-title' }, '讀取器'));

    // ── 內建讀取器區(主要入口,擺最上面)──
    const bundledWrap = el('div', {});
    content.appendChild(bundledWrap);

    async function loadBundled() {
      let items;
      try { items = await Api.get('parsers/bundled'); }
      catch (e) {
        bundledWrap.innerHTML = '';
        bundledWrap.appendChild(el('div', { class: 'card', style: 'margin-bottom:16px' }, [
          el('div', { class: 'card-title' }, '內建讀取器'),
          el('div', { class: 'hint' }, '無法讀取內建讀取器:' + e.message)
        ]));
        return;
      }
      renderBundled(items || []);
    }

    function renderBundled(items) {
      bundledWrap.innerHTML = '';
      const list = el('div', {});
      if (!items.length) {
        list.appendChild(el('div', { class: 'hint', style: 'margin:0' }, '沒有內建讀取器。'));
      }
      for (const b of items) {
        const status = b.installed
          ? el('span', { class: 'status-pill submitted' }, '已安裝 · v' + (b.version || '-'))
          : el('span', { class: 'status-pill overdue' }, '未安裝');
        list.appendChild(el('div', { class: 'record-row' }, [
          el('span', { class: 'rec-main' }, b.vendorKey),
          status,
          el('span', { class: 'spacer' }),
          bundledAction(b)
        ]));
      }
      bundledWrap.appendChild(el('div', { class: 'card', style: 'margin-bottom:16px' }, [
        el('div', { class: 'card-title' }, '內建讀取器'),
        el('div', { class: 'hint', style: 'margin-top:0' },
          '系統內建的廠商讀取器,一鍵安裝即可使用(必要時自動建立同名廠商)。'),
        list
      ]));
    }

    function bundledAction(b) {
      if (!isAdmin) {
        return el('span', { class: 'hint', style: 'margin:0' }, b.installed ? '已安裝' : '');
      }
      const label = b.installed ? '重新安裝' : '安裝';
      const cls = b.installed ? 'btn btn-outline' : 'btn btn-primary';
      return el('button', { class: cls, type: 'button',
        onClick: (ev) => installBundled(b, ev.target) }, label);
    }

    async function installBundled(b, btn) {
      if (btn) btn.disabled = true;
      try {
        const r = await Api.post('parsers/install-bundled', { file: b.file });
        let msg = '已安裝 ' + (r.vendorKey || b.vendorKey);
        if (r.vendorCreated) msg += ',並已建立廠商';
        showToast(msg, 'success');
        await loadBundled();
        await load();
      } catch (e) {
        showToast('安裝失敗:' + e.message, 'error');
        if (btn) btn.disabled = false;
      }
    }

    // 上傳結果面板(逐檔顯示)
    const resultPanel = el('div', {});

    // 上傳區(admin 才顯示)
    if (isAdmin) {
      const fileInput = el('input', {
        type: 'file', accept: '.js', multiple: 'multiple', style: 'display:none'
      });
      fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files.length) doUpload(fileInput.files);
      });
      const uploadBtn = el('button', { class: 'btn btn-primary', type: 'button',
        onClick: () => { fileInput.value = ''; fileInput.click(); } }, '上傳讀取器(可多選)');
      content.appendChild(el('div', { class: 'toolbar' }, [uploadBtn, fileInput]));
      content.appendChild(el('div', { class: 'hint', style: 'margin-top:0' },
        '選擇一或多個 .pmisparser.js 讀取器;系統會依讀取器內的廠商名稱自動歸位到同名廠商。'));
      content.appendChild(resultPanel);

      async function doUpload(fileList) {
        const fd = new FormData();
        for (const f of fileList) fd.append('files', f);
        uploadBtn.disabled = true;
        try {
          const results = await Api.upload('parsers/bulk', fd);
          renderResults(results);
          const okCount = results.filter(r => r.ok).length;
          showToast(`上傳完成:成功 ${okCount} / ${results.length} 檔`, okCount ? 'success' : 'warn');
          await load();
        } catch (e) {
          showToast('上傳失敗:' + e.message, 'error');
        } finally {
          uploadBtn.disabled = false;
        }
      }

      function renderResults(results) {
        resultPanel.innerHTML = '';
        const list = el('div', {});
        for (const r of results) {
          let cls, text;
          if (r.ok) {
            cls = 'submitted';
            text = '✅ 已裝到「' + (r.vendorKey || '?') + '」';
          } else if (r.error && r.error.indexOf('unmatched') === 0) {
            cls = 'pending';
            text = '⚠ 對不到廠商:' + (r.vendorKey || r.filename) + '(請先新增同名廠商)';
          } else {
            cls = 'overdue';
            text = '❌ ' + (r.filename || '') + ':' + (r.error || '安裝失敗');
          }
          list.appendChild(el('div', { class: 'parser-result-row' }, [
            el('span', { class: 'status-pill ' + cls }, text),
            el('span', { class: 'parser-result-file' }, r.filename || '')
          ]));
        }
        resultPanel.appendChild(el('div', { class: 'card', style: 'margin-bottom:16px' }, [
          el('div', { class: 'card-title' }, '上傳結果'),
          list
        ]));
      }
    }

    // 狀態表 + 孤兒區容器
    const tableWrap = el('div', {});
    const orphanWrap = el('div', {});
    content.appendChild(tableWrap);
    content.appendChild(orphanWrap);

    async function load() {
      let data;
      try { data = await Api.get('parsers'); }
      catch (e) {
        tableWrap.innerHTML = '';
        tableWrap.appendChild(el('div', { class: 'hint' }, '無法讀取狀態:' + e.message));
        return;
      }
      renderTable(data.vendors || []);
      renderOrphans(data.orphans || []);
    }

    function renderTable(vendors) {
      tableWrap.innerHTML = '';
      const tbody = el('tbody', {});
      if (!vendors.length) {
        tbody.appendChild(el('tr', {}, [el('td', { class: 'empty-row', colspan: '3' }, '沒有廠商資料')]));
      }
      for (const v of vendors) {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, v.vendorName),
          el('td', {}, statusCell(v)),
          el('td', { class: 'actions' }, actionCell(v))
        ]));
      }
      tableWrap.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', {}, '廠商名稱'),
            el('th', {}, '狀態'),
            el('th', { style: 'width:120px' }, '')
          ])]),
          tbody
        ])
      ]));
    }

    function statusCell(v) {
      if (v.installed) {
        const fieldCount = (v.targetFields || []).length;
        return el('span', { class: 'status-pill submitted' },
          '已安裝 · v' + (v.version || '-') + ' · ' + fieldCount + ' 欄位 · ' + fmtTime(v.installedAt));
      }
      return el('span', { class: 'status-pill overdue' }, '未安裝');
    }

    function actionCell(v) {
      if (!isAdmin) return el('span', { class: 'hint', style: 'margin:0' }, '');
      if (v.installed) {
        return el('button', { class: 'btn btn-danger', type: 'button',
          onClick: () => remove(v) }, '移除');
      }
      return el('span', { class: 'hint', style: 'margin:0' }, '請於上方上傳讀取器');
    }

    async function remove(v) {
      const ok = await confirmDialog({
        title: '移除讀取器', message: `確定移除「${v.vendorName}」的讀取器?`, danger: true
      });
      if (!ok) return;
      try {
        await Api.delete('vendors/' + v.vendorId + '/parser');
        showToast('已移除讀取器', 'success');
        load();
      } catch (e) { showToast('移除失敗:' + e.message, 'error'); }
    }

    function renderOrphans(orphans) {
      orphanWrap.innerHTML = '';
      if (!orphans.length) return;
      const list = el('div', {});
      for (const o of orphans) {
        const fieldCount = (o.targetFields || []).length;
        list.appendChild(el('div', { class: 'record-row' }, [
          el('span', { class: 'rec-main' }, o.vendorKey),
          el('span', { class: 'hint', style: 'margin:0' },
            'v' + (o.version || '-') + ' · ' + fieldCount + ' 欄位'),
          el('span', { class: 'spacer' })
        ]));
      }
      orphanWrap.appendChild(el('div', { class: 'card', style: 'margin-top:16px' }, [
        el('div', { class: 'card-title' }, '孤兒讀取器(對不到廠商)'),
        el('div', { class: 'hint', style: 'margin-top:0' },
          '以下讀取器已安裝但對不到同名廠商,請新增同名廠商,或移除此讀取器。'),
        list
      ]));
    }

    loadBundled();
    load();
  }

  PmisApp.registerRoute('#/parsers', (content) => render(content));
})();
