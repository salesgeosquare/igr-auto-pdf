let downloadQueue = [];
let isProcessing = false;
let sourceTabId = null;

// ─── Message Hub ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.action === 'enqueueDownloads') {
        const newLinks = message.links.filter(
            link => !downloadQueue.some(q => q.id === link.id)
        );
        downloadQueue = [...downloadQueue, ...newLinks];
        sourceTabId = sender.tab.id;
        console.log(`[IGR] Queue: ${downloadQueue.length} items`);

        if (!isProcessing && downloadQueue.length > 0) {
            isProcessing = true;
            processNext();
        }
    }

    if (message.action === 'triggerNextPage') {
        if (sender.tab?.id) {
            const tabId = sender.tab.id;
            setTimeout(async () => {
                console.log('[IGR] Clicking next-page link...');
                await clickInMainWorld(tabId, '[data-scraper-id="next-page-btn"]');
                // Wait for AJAX table refresh (IGR is slow — 6 seconds)
                // then tell content.js to scan the new page
                setTimeout(() => {
                    console.log('[IGR] Sending rescan to content script...');
                    chrome.tabs.sendMessage(tabId, { action: 'rescan' }).catch(() => { });
                }, 6000);
            }, 3000);
        }
    }

    if (message.action === 'stop') {
        downloadQueue = [];
        isProcessing = false;
        sendLog("Stopped by user.", "warn");
    }
});

// ─── Main Loop ────────────────────────────────────────────────────────────────
async function processNext() {
    if (downloadQueue.length === 0) {
        sendLog("✓ All documents downloaded!", "success");
        isProcessing = false;
        if (sourceTabId && await checkTabExists(sourceTabId)) {
            chrome.tabs.sendMessage(sourceTabId, { action: 'pageFinished' }).catch(() => { });
        }
        return;
    }

    const linkInfo = downloadQueue.shift();
    sendLog(`Row ${linkInfo.index + 1} of ${linkInfo.index + 1 + downloadQueue.length}: Processing...`, "info");
    console.log(`[IGR] → Row index ${linkInfo.index} | filename: ${linkInfo.filename}`);

    try {
        if (!sourceTabId || !(await checkTabExists(sourceTabId))) {
            sendLog("Source tab closed. Stopping.", "warn");
            isProcessing = false;
            return;
        }

        // ── STEP 1: Click the IndexII button for this row
        //    Use MAIN world so the click fires exactly as a real user click would.
        const selector = `input[onclick*="indexII$${linkInfo.index}"]`;
        sendLog(`Row ${linkInfo.index + 1}: Clicking button...`, "info");

        const clicked = await clickInMainWorld(sourceTabId, selector);
        if (!clicked) {
            sendLog(`Row ${linkInfo.index + 1}: Button not found. Skipping.`, "warn");
            setTimeout(processNext, 2000);
            return;
        }

        // ── STEP 2: Wait for the popup window.
        //    IGR government servers are SLOW — allow up to 45 seconds.
        sendLog(`Row ${linkInfo.index + 1}: Waiting for document popup (up to 45s)...`, "info");
        const newTab = await waitForNewTab(45000);

        if (!newTab) {
            sendLog(`Row ${linkInfo.index + 1}: No popup appeared in 45s. Skipping.`, "warn");
            setTimeout(processNext, await getDelay());
            return;
        }

        // ── STEP 3: Wait for the popup page to fully load
        sendLog(`Row ${linkInfo.index + 1}: Document opened. Loading...`, "info");
        const loaded = await waitForTabReady(newTab.id, 30000);

        if (loaded) {
            await sleep(4000); // Let the document render fully
            sendLog(`Row ${linkInfo.index + 1}: Saving PDF...`, "info");
            await printTabToPDF(newTab.id, linkInfo.filename);
            sendLog(`Row ${linkInfo.index + 1}: ✓ Saved!`, "success");
        } else {
            sendLog(`Row ${linkInfo.index + 1}: Page load timeout.`, "warn");
        }

        // ── STEP 4: Close the popup tab
        if (await checkTabExists(newTab.id)) {
            await chrome.tabs.remove(newTab.id).catch(() => { });
        }

    } catch (err) {
        sendLog(`Row ${linkInfo.index + 1} Error: ${err.message}`, "warn");
        console.error("[IGR] processNext error:", err);
    }

    // ── STEP 5: Wait a few seconds before the next row to let the server recover
    const delay = await getDelay();
    console.log(`[IGR] Waiting ${delay / 1000}s before next row...`);
    setTimeout(processNext, delay);
}

// ─── Click in MAIN world across ALL frames (buttons may live in a sub-frame) ──
async function clickInMainWorld(tabId, selector) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },   // allFrames: buttons may be in iframe
            world: 'MAIN',
            func: (sel) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.style.outline = "3px solid #6366f1";
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.click();
                    return true;
                }
                return false;
            },
            args: [selector]
        });
        return results?.some(r => r.result === true) ?? false;
    } catch (err) {
        console.error('[IGR] clickInMainWorld error:', err.message);
        return false;
    }
}

// ─── Wait for a new browser tab/window to be created ─────────────────────────
function waitForNewTab(timeout = 45000) {
    return new Promise((resolve) => {
        let done = false;

        const listener = (tab) => {
            if (done) return;
            done = true;
            chrome.tabs.onCreated.removeListener(listener);
            clearTimeout(timer);
            console.log(`[IGR] New tab detected: ${tab.id} | url: ${tab.pendingUrl || '(loading)'}`);
            resolve(tab);
        };

        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            chrome.tabs.onCreated.removeListener(listener);
            resolve(null);
        }, timeout);

        chrome.tabs.onCreated.addListener(listener);
    });
}

// ─── Wait for a tab to finish loading ────────────────────────────────────────
function waitForTabReady(tabId, timeout = 25000) {
    return new Promise((resolve) => {
        let done = false;

        const finish = (result) => {
            if (done) return;
            done = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            clearTimeout(timer);
            resolve(result);
        };

        const onUpdated = (id, info, tab) => {
            if (id === tabId && info.status === 'complete' && tab.url?.startsWith('http')) {
                finish(true);
            }
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
        const timer = setTimeout(() => finish(false), timeout);

        // Already ready?
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) return;
            if (tab?.status === 'complete' && tab.url?.startsWith('http')) finish(true);
        });
    });
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getDelay() {
    const data = await chrome.storage.local.get(['configDelay']);
    return Math.max(3000, data.configDelay || 4000);
}

function sendLog(message, logType = 'info') {
    chrome.runtime.sendMessage({ action: 'log', message, logType }).catch(() => { });
}

async function checkTabExists(tabId) {
    try { await chrome.tabs.get(tabId); return true; } catch { return false; }
}

async function printTabToPDF(tabId, filename) {
    if (!(await checkTabExists(tabId))) throw new Error("Tab gone");
    await chrome.debugger.attach({ tabId }, "1.3");
    try {
        const result = await chrome.debugger.sendCommand({ tabId }, "Page.printToPDF", {
            printBackground: true,
            displayHeaderFooter: false,
            paperWidth: 8.27,
            paperHeight: 11.69
        });
        if (!result?.data) throw new Error("No PDF data from server");

        await new Promise((resolve, reject) => {
            chrome.downloads.download({
                url: `data:application/pdf;base64,${result.data}`,
                filename: `IGR_PDFs/${filename}.pdf`,
                conflictAction: 'uniquify'
            }, (dlId) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(dlId);
            });
        });
    } finally {
        chrome.debugger.detach({ tabId }).catch(() => { });
    }
}
