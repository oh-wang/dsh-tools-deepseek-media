// dsh-tools-deepseek-media — client half (Web GUI settings page).
//
// The browser artifact is not a plain ESM module: the host's client runner
// loads it through window.__ModuleLoader__.load({ id, factory }), with only
// `react` and `react/jsx-runtime` guaranteed in the module table. The file
// therefore starts with the loader call, uses jsx() calls instead of JSX
// syntax, inlines its locale dictionaries (no relative require), and returns
// { inject, apply } from the factory.
//
// The settings page registers one `settings.section` navigation entry (the
// official, third-party-supported extension point for a settings page) and
// talks to the host's /dsh-deepseek-media/* routes. The host never returns
// the key value, so the page only ever shows presence + source.

window.__ModuleLoader__.load({
  id: 'dsh-tools-deepseek-media',
  factory(require) {
    const React = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    // Services the client half needs from the host's browser context.
    const inject = ['slots', 'locale'];

    const NS = 'deepseekMedia';
    const STATUS_URL = '/dsh-deepseek-media/status';
    const CREDENTIALS_URL = '/dsh-deepseek-media/credentials';

    // Client dictionaries, inlined because the loader's module table only
    // guarantees react/react-jsx-runtime. Keys mirror the host-side surface.
    const DICTS = {
      en: {
        nav: 'DeepSeek media',
        title: 'DeepSeek media tools',
        intro: 'Configure the API key used by the deepseek_ocr, deepseek_asr and deepseek_tts agent tools.',
        keyStatus: 'API key',
        keyConfigured: 'Configured (source: {source})',
        keyMissing: 'Not configured — the three tools stay hidden until a key is set',
        keyPlaceholder: 'Paste a DeepSeek API key (sk-…)',
        save: 'Save key',
        clear: 'Clear stored key',
        saved: 'Key saved. The tools become available in new agent steps.',
        cleared: 'Stored key removed.',
        sourceFile: 'credential store',
        sourceEnv: 'environment variable',
        sourceFallback: 'fallback',
        privacy: 'The key is stored through the DSH credentials service; it is never logged and never returned by a tool.',
        doc: 'Billing: OCR per page, ASR per second of audio, TTS per 10k billable characters (CJK counts double).',
        errorPrefix: 'Request failed',
      },
      zh: {
        nav: 'DeepSeek 媒体',
        title: 'DeepSeek 媒体工具',
        intro: '配置 deepseek_ocr、deepseek_asr、deepseek_tts 三个 agent 工具使用的 API key。',
        keyStatus: 'API key',
        keyConfigured: '已配置（来源：{source}）',
        keyMissing: '未配置 —— 未设置 key 前三个工具不会出现在工具列表里',
        keyPlaceholder: '粘贴 DeepSeek API key（sk-…）',
        save: '保存 key',
        clear: '清除已存 key',
        saved: '已保存。新的 agent 步骤立即可用这三个工具。',
        cleared: '已清除存储的 key。',
        sourceFile: '凭据库',
        sourceEnv: '环境变量',
        sourceFallback: '兜底来源',
        privacy: 'key 通过 DSH 凭据服务存储，不会写入日志，也不会被任何工具返回。',
        doc: '计费说明：OCR 按页计费，ASR 按音频秒数计费，TTS 按万计费字符计费（汉字按 2 个字符计）。',
        errorPrefix: '请求失败',
      },
    };

    const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' };
    const buttonStyle = {
      font: 'inherit', fontSize: 13, padding: '5px 12px', borderRadius: 6,
      border: '0.5px solid var(--dsw-alias-border-l2)', cursor: 'pointer',
      background: 'var(--dsw-alias-fill-primary, transparent)', color: 'var(--dsw-alias-label-primary)',
    };
    const inputStyle = {
      font: 'inherit', fontSize: 13, padding: '5px 10px', borderRadius: 6, flex: 1, minWidth: 160,
      border: '0.5px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-fill-primary, transparent)', color: 'var(--dsw-alias-label-primary)',
    };

    function SettingsPanel({ t }) {
      const [status, setStatus] = React.useState(null);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);

      const refresh = React.useCallback(async () => {
        try {
          const response = await fetch(STATUS_URL, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setStatus(await response.json());
        } catch (error) {
          setNote(`${t('errorPrefix')}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, [t]);

      React.useEffect(() => { void refresh(); }, [refresh]);

      const post = React.useCallback(async (body, doneMessage) => {
        setBusy(true);
        setNote(null);
        try {
          const response = await fetch(CREDENTIALS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
          setStatus(payload);
          setDraft('');
          setNote(doneMessage);
        } catch (error) {
          setNote(`${t('errorPrefix')}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setBusy(false);
        }
      }, [t]);

      const configured = status?.configured === true;
      // describe().source is "file" | "env" | "fallback"; map to localized text.
      const sourceLabel = status?.source === 'file' ? t('sourceFile')
        : status?.source === 'env' ? t('sourceEnv')
        : status?.source === 'fallback' ? t('sourceFallback')
        : String(status?.source ?? '');

      return jsxs('div', {
        style: { maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, lineHeight: 1.5 },
        children: [
          jsx('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 }, children: t('title') }),
          jsx('p', { style: { margin: 0, color: 'var(--dsw-alias-label-tertiary)' }, children: t('intro') }),
          jsxs('div', {
            style: rowStyle,
            children: [
              jsx('span', { style: { fontWeight: 600 }, children: `${t('keyStatus')}:` }),
              configured
                ? jsx('span', {
                    style: { color: 'var(--dsw-alias-state-business-primary, #247bbf)' },
                    children: t('keyConfigured').replace('{source}', sourceLabel),
                  })
                : jsx('span', { style: { color: 'var(--dsw-alias-label-tertiary)' }, children: t('keyMissing') }),
            ],
          }),
          jsxs('div', {
            style: rowStyle,
            children: [
              jsx('input', {
                type: 'password',
                value: draft,
                placeholder: t('keyPlaceholder'),
                style: inputStyle,
                onChange: (event) => setDraft(event.target.value),
                disabled: busy,
              }),
              jsx('button', {
                type: 'button', style: buttonStyle, disabled: busy || draft.trim().length === 0,
                onClick: () => void post({ apiKey: draft.trim() }, t('saved')),
                children: t('save'),
              }),
              jsx('button', {
                type: 'button', style: buttonStyle, disabled: busy || !configured,
                onClick: () => void post({ apiKey: '' }, t('cleared')),
                children: t('clear'),
              }),
            ],
          }),
          note !== null && jsx('p', { style: { margin: 0 }, children: note }),
          jsx('p', { style: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }, children: t('privacy') }),
          jsx('p', { style: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }, children: t('doc') }),
        ],
      });
    }

    function apply(ctx) {
      // Own dictionary first, so bind() below resolves even before the page mounts.
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'deepseek-media: settings dictionary');

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'deepseek-media',
        order: 30,
        label: () => ctx.locale.bind(NS)('nav'),
        locale: NS,
        inject: () => ({ t: (key) => ctx.locale.bind(NS)(key) }),
      }, SettingsPanel));
    }

    return { inject, apply };
  },
});
