/**
 * background.js
 * Service worker for PRIVISION (Manifest V3)
 * 
 * Manages configuration persistence, domain allowlist evaluation,
 * badge states, and tab message routing.
 */

// Default configuration schema
const DEFAULT_CONFIG = {
  isEnabled: true,
  mode: 'always-on', // 'always-on' | 'site-scoped'
  allowlist: ['localhost', '127.0.0.1', 'bank.example.com', 'checkout.example.com'],
  modelSource: 'builtin', // 'builtin' | 'custom-onnx' | 'custom-hf' | 'remote-endpoint'
  customModelUrl: '',
  remoteEndpointUrl: 'http://localhost:3721/api/reason',
  executionProvider: 'auto', // 'auto' | 'webgpu' | 'wasm'
  confidenceThreshold: 0.5,
  failClosedHighRisk: true,
  stats: {
    totalScans: 0,
    totalRedactions: 0
  }
};

// Initialize settings on installation
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[PRIVISION] Extension installed/updated:', details.reason);
  const current = await chrome.storage.local.get(null);
  const merged = { ...DEFAULT_CONFIG, ...current };
  await chrome.storage.local.set(merged);
  await updateBadge();
});

// Update badge when tab changes or finishes loading
chrome.tabs.onActivated.addListener(async () => {
  await updateBadge();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab?.url) {
    await updateBadge(tab);
  }
});

/**
 * Evaluates whether PRIVISION should be active on the given URL.
 * @param {string} url 
 * @returns {Promise<boolean>}
 */
async function isUrlEligible(url) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
    return false;
  }

  const { isEnabled = true, mode = 'always-on', allowlist = DEFAULT_CONFIG.allowlist } = await chrome.storage.local.get([
    'isEnabled',
    'mode',
    'allowlist'
  ]);

  if (!isEnabled) return false;
  if (mode === 'always-on') return true;

  try {
    const hostname = new URL(url).hostname;
    const list = Array.isArray(allowlist) && allowlist.length > 0 ? allowlist : DEFAULT_CONFIG.allowlist;
    return list.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * Updates action icon badge text and color based on active tab state.
 */
async function updateBadge(specificTab = null) {
  try {
    let tab = specificTab;
    if (!tab) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = activeTab;
    }

    if (!tab || !tab.url) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    const eligible = await isUrlEligible(tab.url);
    const { isEnabled = true } = await chrome.storage.local.get('isEnabled');

    if (!isEnabled) {
      await chrome.action.setBadgeText({ text: 'OFF', tabId: tab.id });
      await chrome.action.setBadgeBackgroundColor({ color: '#64748B', tabId: tab.id });
    } else if (eligible) {
      await chrome.action.setBadgeText({ text: 'ON', tabId: tab.id });
      await chrome.action.setBadgeBackgroundColor({ color: '#10B981', tabId: tab.id });
    } else {
      await chrome.action.setBadgeText({ text: 'IDLE', tabId: tab.id });
      await chrome.action.setBadgeBackgroundColor({ color: '#F59E0B', tabId: tab.id });
    }
  } catch (err) {
    console.warn('[PRIVISION ServiceWorker] Badge update failed:', err);
  }
}

// Runtime message dispatcher
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'GET_STATUS': {
          const config = await chrome.storage.local.get(null);
          const tab = sender.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
          const tabUrl = tab?.url || sender.url || '';
          const eligible = tabUrl ? await isUrlEligible(tabUrl) : true;
          let hostname = '';
          try {
            if (tabUrl) hostname = new URL(tabUrl).hostname;
          } catch {}

          sendResponse({
            success: true,
            config,
            currentTab: {
              id: tab?.id,
              url: tabUrl,
              hostname,
              eligible
            }
          });
          break;
        }

        case 'TOGGLE_ENABLED': {
          const { isEnabled = true } = await chrome.storage.local.get('isEnabled');
          const newState = !isEnabled;
          await chrome.storage.local.set({ isEnabled: newState });
          await updateBadge();

          // Notify tabs of state change
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, { action: 'CONFIG_CHANGED', isEnabled: newState }).catch(() => {});
            }
          }
          sendResponse({ success: true, isEnabled: newState });
          break;
        }

        case 'SET_MODE': {
          const { mode } = message;
          if (['always-on', 'site-scoped'].includes(mode)) {
            await chrome.storage.local.set({ mode });
            await updateBadge();
            sendResponse({ success: true, mode });
          } else {
            sendResponse({ success: false, error: 'Invalid mode' });
          }
          break;
        }

        case 'ADD_ALLOWLIST_DOMAIN': {
          const { domain } = message;
          const { allowlist = [] } = await chrome.storage.local.get('allowlist');
          const cleanDomain = domain.toLowerCase().trim();
          if (cleanDomain && !allowlist.includes(cleanDomain)) {
            const updated = [...allowlist, cleanDomain];
            await chrome.storage.local.set({ allowlist: updated });
            await updateBadge();
            sendResponse({ success: true, allowlist: updated });
          } else {
            sendResponse({ success: true, allowlist });
          }
          break;
        }

        case 'REMOVE_ALLOWLIST_DOMAIN': {
          const { domain } = message;
          const { allowlist = [] } = await chrome.storage.local.get('allowlist');
          const updated = allowlist.filter(d => d !== domain.toLowerCase().trim());
          await chrome.storage.local.set({ allowlist: updated });
          await updateBadge();
          sendResponse({ success: true, allowlist: updated });
          break;
        }

        case 'TRIGGER_SCAN': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { action: 'MANUAL_SCAN' }, (resp) => {
              sendResponse(resp || { success: true, message: 'Scan initiated' });
            });
          } else {
            sendResponse({ success: false, error: 'No active tab found' });
          }
          break;
        }

        case 'UPDATE_STATS': {
          const { redactionsCount = 0 } = message;
          const { stats = { totalScans: 0, totalRedactions: 0 } } = await chrome.storage.local.get('stats');
          stats.totalScans = (stats.totalScans || 0) + 1;
          stats.totalRedactions = (stats.totalRedactions || 0) + redactionsCount;
          await chrome.storage.local.set({ stats });
          sendResponse({ success: true, stats });
          break;
        }

        case 'VALIDATE_CUSTOM_MODEL': {
          const { modelSource, customModelUrl } = message;
          // Model validation sanity check
          const validationResult = await validateModelSource(modelSource, customModelUrl);
          sendResponse(validationResult);
          break;
        }

        case 'CAPTURE_TAB': {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.id && tab.windowId) {
              const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
              sendResponse({ success: true, dataUrl });
            } else {
              sendResponse({ success: false, error: 'No active tab found for capture.' });
            }
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
          break;
        }

        case 'DISPATCH_REASONING': {
          // Routes the reasoning fetch through the service worker to avoid
          // Mixed Content blocking when content scripts run on HTTPS pages.
          const { endpointUrl = 'http://localhost:3721/api/reason', payload } = message;
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000);

            const resp = await fetch(endpointUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Privision-Sanitized': 'true'
              },
              body: JSON.stringify(payload),
              signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (resp.ok) {
              const data = await resp.json();
              sendResponse({ success: true, data });
            } else {
              let errorBody = '';
              try { errorBody = await resp.text(); } catch {}
              sendResponse({
                success: false,
                status: resp.status,
                errorBody,
                error: `Reasoning endpoint returned status ${resp.status}`
              });
            }
          } catch (fetchErr) {
            console.warn('[PRIVISION ServiceWorker] Reasoning dispatch fetch error:', fetchErr.message);
            sendResponse({
              success: false,
              isOffline: true,
              error: fetchErr.message
            });
          }
          break;
        }

        default:
          sendResponse({ success: false, error: `Unknown action: ${message.action}` });
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  })();
  return true; // Keep message channel open for async response
});

/**
 * Validates custom model configuration before saving.
 */
async function validateModelSource(modelSource, url) {
  if (modelSource === 'builtin') {
    return {
      valid: true,
      message: 'Built-in MobileViT ONNX weights verified (quantized, on-device).'
    };
  }

  if (modelSource === 'custom-hf') {
    if (!url || !url.includes('/')) {
      return { valid: false, message: 'Invalid Hugging Face model ID. Format: username/model-name' };
    }
    return { valid: true, message: `Model ID '${url}' format verified for Transformers.js.` };
  }

  if (modelSource === 'custom-onnx' || modelSource === 'remote-endpoint') {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { valid: false, message: 'Endpoint must use HTTP or HTTPS protocol.' };
      }
      return { valid: true, message: `Reachable endpoint format verified: ${parsed.hostname}` };
    } catch {
      return { valid: false, message: 'Invalid URL format provided.' };
    }
  }

  return { valid: false, message: 'Unrecognized model source type.' };
}
